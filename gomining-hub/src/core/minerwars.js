// HONKSQUAD in Miner Wars, from GoMining's public leaderboards (the same ones the app shows; no token):
//   POST /nft-game/clan-leaderboard/index-v2   clans in a league: position, blocks won, TH, prize fund
//   POST /nft-game/user-leaderboard/index      players in a league: alias, clan, blocks won, TH
//
// The clan board is small and refreshed every 10 minutes. The player board only comes 50 rows at a
// time (thousands of players per league), so the clan's member list is rebuilt in the background at
// most every 30 minutes and the last good list is served meanwhile. After a failure neither is asked
// for again until RETRY_MS has passed, so visitors can't make the server hammer GoMining.

import { minerWarsCycle } from './calc.js';

export const HONKSQUAD_CLAN_ID = 43680;
const PAGE = 50; // GoMining refuses larger pages
const MAX_PAGES = 200;
const CONCURRENCY = 4;
const BOARD_TTL_MS = 10 * 60 * 1000;
const MEMBERS_TTL_MS = 30 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
// League ids, top league first: Odyssey 1, Eclipse 3, Horizon 4, then Dune I to XXVII as 5 to 31
// (2 is unused). Checked on 3 Oct 2026: HONKSQUAD finished cycle 162 fifth in league 4 and was
// promoted into league 3, which the app shows as Eclipse with the same prize fund.
const LEAGUE_IDS = [1, 3, 4, ...Array.from({ length: 27 }, (_, i) => i + 5), 2];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII', 'XXIII', 'XXIV', 'XXV', 'XXVI', 'XXVII'];
export const leagueName = (id) => ({ 1: 'Odyssey', 2: 'League 2', 3: 'Eclipse', 4: 'Horizon' })[id] ?? (id >= 5 && id <= 31 ? `Dune ${ROMAN[id - 5]}` : `League ${id}`);

const num = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const round = (value, digits) => Number(value.toFixed(digits));
const text = (value, max) => String(value ?? '').slice(0, max);

export class MinerWarsService {
  constructor({ client, clanId = HONKSQUAD_CLAN_ID, boardTtlMs = BOARD_TTL_MS, membersTtlMs = MEMBERS_TTL_MS, now = Date.now } = {}) {
    this.client = client;
    this.clanId = clanId;
    this.boardTtlMs = boardTtlMs;
    this.membersTtlMs = membersTtlMs;
    this.now = now;
    this.leagueId = null;
    this.board = null;
    this.boardInflight = null;
    this.members = null;
    this.membersInflight = null;
  }

  post(path, leagueId, skip) {
    return this.client.request('POST', `/nft-game/${path}`, {
      auth: false,
      body: { calculatedAt: new Date(this.now()).toISOString(), pagination: { skip, limit: PAGE }, leagueId },
    }).then((response) => response?.data ?? response);
  }

  // Every page of a leaderboard, a few requests at a time. On the clan board `count` and the page size
  // only apply to the safe-zone list (promoted and relegated clans come whole on every page).
  async allPages(path, leagueId) {
    const first = await this.post(path, leagueId, 0);
    const pages = Math.min(Math.ceil(num(first?.count) / PAGE), MAX_PAGES);
    const rest = [];
    for (let page = 1; page < pages; page += CONCURRENCY) {
      const batch = [];
      for (let i = page; i < Math.min(page + CONCURRENCY, pages); i++) batch.push(this.post(path, leagueId, i * PAGE));
      rest.push(...await Promise.all(batch));
    }
    return [first, ...rest];
  }

  async clanBoard(leagueId) {
    const pages = await this.allPages('clan-leaderboard/index-v2', leagueId);
    const clans = new Map();
    for (const page of pages) {
      for (const [key, zone] of [['clansPromoted', 'promotion'], ['clansRemaining', 'safe'], ['clansRelegated', 'relegation']]) {
        for (const row of Array.isArray(page?.[key]) ? page[key] : []) {
          if (!row?.clanId || clans.has(row.clanId)) continue;
          clans.set(row.clanId, {
            clanId: row.clanId,
            name: text(row.clan?.name, 60).trim(),
            position: num(row.position),
            blocks: num(row.blocksMined),
            powerTh: round(num(row.nftPower), 1),
            zone,
          });
        }
      }
    }
    return { head: pages[0] ?? {}, clans: [...clans.values()].sort((a, b) => a.position - b.position) };
  }

  // Finds the clan's league (remembered between refreshes) and summarizes the board around it.
  async loadBoard() {
    const order = this.leagueId ? [this.leagueId, ...LEAGUE_IDS.filter((id) => id !== this.leagueId)] : LEAGUE_IDS;
    for (const leagueId of order) {
      const { head, clans } = await this.clanBoard(leagueId);
      const index = clans.findIndex((row) => row.clanId === this.clanId);
      if (index === -1) continue;
      if (this.leagueId !== leagueId) { this.members = null; this.membersErrorAt = null; }
      this.leagueId = leagueId;
      const totalBlocks = num(head.totalMinedBlocks);
      const btcFund = num(head.btcFund);
      const btcPerBlock = totalBlocks > 0 ? btcFund / totalBlocks : 0;
      const cycle = minerWarsCycle(this.now());
      const clan = clans[index];
      const scale = cycle.elapsedDays > 0.25 ? 7 / cycle.elapsedDays : null;
      const promotedUpTo = Math.max(0, ...clans.filter((row) => row.zone === 'promotion').map((row) => row.position));
      const relegatedFrom = Math.min(Infinity, ...clans.filter((row) => row.zone === 'relegation').map((row) => row.position));
      return {
        updatedAt: new Date(this.now()).toISOString(),
        cycle,
        league: {
          id: leagueId,
          name: leagueName(leagueId),
          clans: clans.length,
          totalBlocks,
          btcFund: round(btcFund, 8),
          btcPerBlock: round(btcPerBlock, 8),
          totalPowerTh: round(num(head.totalPower), 1),
          avgEfficiencyWth: head.weightedEnergyEfficiencyPerTh ? round(num(head.weightedEnergyEfficiencyPerTh), 2) : null,
          avgDiscountPct: head.weightedAvgDiscount ? round(num(head.weightedAvgDiscount) * 100, 2) : null,
          promotedUpTo: promotedUpTo || null,
          relegatedFrom: Number.isFinite(relegatedFrom) ? relegatedFrom : null,
        },
        clan: {
          ...clan,
          btcSoFar: round(clan.blocks * btcPerBlock, 8),
          blocksWeekProjected: scale ? Math.round(clan.blocks * scale) : null,
          btcWeekProjected: scale ? round(clan.blocks * scale * btcPerBlock, 8) : null,
          blockSharePct: totalBlocks ? round((clan.blocks / totalBlocks) * 100, 2) : null,
        },
        // Two clans either side, for "who's just ahead and behind".
        neighbours: clans.slice(Math.max(0, index - 2), index + 3),
        board: clans,
      };
    }
    throw new Error(`Clan ${this.clanId} is not on any Miner Wars league board right now`);
  }

  async loadMembers(leagueId) {
    const pages = await this.allPages('user-leaderboard/index', leagueId);
    const seen = new Set();
    const rows = [];
    for (const page of pages) {
      for (const row of Array.isArray(page?.participants) ? page.participants : []) {
        const id = row?.user?.userId;
        if (row?.clanId !== this.clanId || seen.has(id)) continue;
        seen.add(id);
        rows.push({
          alias: text(row.user?.alias, 40).trim() || 'Unnamed',
          leaguePosition: num(row.position),
          blocks: num(row.blocksMined),
          powerTh: round(num(row.nftPower), 1),
          boostsUsed: (Array.isArray(row.usedAbilities) ? row.usedAbilities : []).reduce((sum, a) => sum + num(a?.count), 0),
        });
      }
    }
    return { updatedAt: new Date(this.now()).toISOString(), leagueId, rows: rows.sort((a, b) => b.blocks - a.blocks || b.powerTh - a.powerTh) };
  }

  refreshMembers() {
    const leagueId = this.leagueId;
    if (!leagueId) return null;
    this.membersInflight ??= this.loadMembers(leagueId)
      .then((value) => { this.members = { at: this.now(), value }; })
      .then(() => { this.membersError = null; this.membersErrorAt = null; })
      .catch((error) => { this.membersError = error?.message ?? String(error); this.membersErrorAt = this.now(); })
      .finally(() => { this.membersInflight = null; });
    return this.membersInflight;
  }

  // { status: 'live' | 'unavailable', ...board, members: { status, updatedAt, rows } }.
  // `waitForMembers` (tests, MCP) waits for the member list instead of returning "loading".
  async get({ waitForMembers = false } = {}) {
    const boardDue = !this.board || this.now() - this.board.at >= this.boardTtlMs;
    const boardResting = !this.board && this.boardErrorAt && this.now() - this.boardErrorAt < RETRY_MS;
    if (boardDue && !boardResting) {
      this.boardInflight ??= this.loadBoard()
        .then((value) => { this.board = { at: this.now(), value }; this.boardError = null; this.boardErrorAt = null; })
        .catch((error) => { this.boardError = error?.message ?? String(error); this.boardErrorAt = this.now(); if (this.board) this.board.at = this.now(); })
        .finally(() => { this.boardInflight = null; });
      await this.boardInflight;
    }
    if (!this.board) return { status: 'unavailable', error: this.boardError, cycle: minerWarsCycle(this.now()) };

    const stale = !this.members || this.now() - this.members.at >= this.membersTtlMs;
    const resting = this.membersErrorAt && this.now() - this.membersErrorAt < RETRY_MS;
    if (stale && !resting) {
      const pending = this.refreshMembers();
      if (waitForMembers && pending) await pending;
    }
    const totalTh = this.members?.value.rows.reduce((sum, row) => sum + row.powerTh, 0) ?? 0;
    return {
      status: 'live',
      ...(this.boardError ? { warning: `Showing the last good board: ${this.boardError}` } : {}),
      ...this.board.value,
      members: this.members
        ? { status: 'live', updatedAt: this.members.value.updatedAt, count: this.members.value.rows.length, powerTh: round(totalTh, 1), rows: this.members.value.rows }
        : { status: this.membersInflight ? 'loading' : 'unavailable', ...(this.membersError ? { error: this.membersError } : {}), rows: [] },
    };
  }
}
