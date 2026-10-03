// Miner Wars from GoMining's public endpoints (the same ones the app shows; no token):
//   POST /nft-game/league/index                every league this cycle: name, level, clan slots and
//                                              the published odds of each round multiplier
//   POST /nft-game/clan-leaderboard/index-v2   clans in a league: position, blocks won, TH, zone,
//                                              prize fund, the league's weighted W/TH and discount
//
// Any league's board can be read, and clans can be found by name across all leagues. Boards are kept
// for 10 minutes and the league list for an hour; after a failure a part isn't asked for again for
// 10 minutes, and the last good answer is served meanwhile, so visitors can't make the server hammer
// GoMining.

import { expectedMultiplier, leagueDisplayName, minerWarsCycle } from './calc.js';
import { TtlCache } from './cache.js';

const PAGE = 50; // GoMining refuses larger pages
const MAX_PAGES = 40;
const CONCURRENCY = 4;
const BOARD_TTL_MS = 10 * 60 * 1000;
const LEAGUES_TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

const num = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const round = (value, digits) => Number(value.toFixed(digits));
const text = (value, max) => String(value ?? '').slice(0, max);

export class MinerWarsService {
  constructor({ client, now = Date.now, boardTtlMs = BOARD_TTL_MS, leaguesTtlMs = LEAGUES_TTL_MS, cache } = {}) {
    this.client = client;
    this.now = now;
    this.boardTtlMs = boardTtlMs;
    this.leaguesTtlMs = leaguesTtlMs;
    this.cache = cache ?? new TtlCache({ now, retryMs: RETRY_MS });
  }

  post(path, body) {
    return this.client.request('POST', `/nft-game/${path}`, { auth: false, body }).then((response) => response?.data ?? response);
  }

  // Every league this cycle, top league first. The app asks for the leagues as of the cycle start.
  leagues() {
    const cycle = minerWarsCycle(this.now());
    return this.cache.get(`leagues:${cycle.number}`, this.leaguesTtlMs, async () => {
      const data = await this.post('league/index', { calculatedAt: cycle.start });
      const rows = (Array.isArray(data?.array) ? data.array : []).filter((row) => Number.isInteger(row?.id) && !row.test);
      if (!rows.length) throw new Error('GoMining returned no Miner Wars leagues');
      return {
        cycle,
        leagues: rows
          .map((row) => {
            const multipliers = (Array.isArray(row.roundMultiplierConfig) ? row.roundMultiplierConfig : [])
              .filter((m) => m?.v > 0 && m?.p >= 0)
              .map((m) => ({ multiplier: m.v, probability: m.p }));
            return {
              id: row.id,
              name: leagueDisplayName(row.name),
              level: num(row.level),
              clanSlots: num(row.totalClansCount) || null,
              promotionToLeagueId: row.promotionToLeagueId ?? null,
              relegationToLeagueId: row.relegationToLeagueId ?? null,
              dynamicMovement: Boolean(row.isDynamicClansMovement),
              multipliers,
              maxMultiplier: multipliers.length ? Math.max(...multipliers.map((m) => m.multiplier)) : null,
              averageMultiplier: expectedMultiplier(row.roundMultiplierConfig),
            };
          })
          .sort((a, b) => a.level - b.level || a.id - b.id),
      };
    });
  }

  async league(leagueId) {
    const { leagues } = await this.leagues();
    const league = leagues.find((row) => row.id === leagueId);
    if (!league) throw Object.assign(new Error(`There is no Miner Wars league ${leagueId} this cycle`), { status: 404 });
    return league;
  }

  // Every page of the clan board, a few requests at a time. `count` and the page size only apply to
  // the safe-zone list: promoted and relegated clans come whole on every page.
  async clanPages(leagueId, cycle) {
    const body = (skip) => ({ calculatedAt: new Date(this.now()).toISOString(), pagination: { skip, limit: PAGE }, leagueId });
    const first = await this.post('clan-leaderboard/index-v2', body(0));
    const pages = Math.min(Math.ceil(num(first?.count) / PAGE), MAX_PAGES);
    const rest = [];
    for (let page = 1; page < pages; page += CONCURRENCY) {
      const batch = [];
      for (let i = page; i < Math.min(page + CONCURRENCY, pages); i++) batch.push(this.post('clan-leaderboard/index-v2', body(i * PAGE)));
      rest.push(...await Promise.all(batch));
    }
    return { cycle, pages: [first, ...rest] };
  }

  // One league's board this cycle: league totals, prize fund, BTC per block and every clan by position.
  board(leagueId) {
    const id = Number(leagueId);
    if (!Number.isInteger(id) || id <= 0) return Promise.reject(Object.assign(new Error('league must be a league id'), { status: 400 }));
    return this.cache.get(`board:${id}`, this.boardTtlMs, async () => {
      const league = await this.league(id);
      const cycle = minerWarsCycle(this.now());
      const { pages } = await this.clanPages(id, cycle);
      const clans = new Map();
      for (const page of pages) {
        for (const [key, zone] of [['clansPromoted', 'promotion'], ['clansRemaining', 'safe'], ['clansRelegated', 'relegation']]) {
          for (const row of Array.isArray(page?.[key]) ? page[key] : []) {
            if (!row?.clanId || clans.has(row.clanId)) continue;
            clans.set(row.clanId, {
              clanId: row.clanId,
              name: text(row.clan?.name, 60).trim() || 'Unnamed clan',
              position: num(row.position),
              blocks: num(row.blocksMined),
              powerTh: round(num(row.nftPower), 1),
              zone,
            });
          }
        }
      }
      const board = [...clans.values()].sort((a, b) => a.position - b.position);
      const head = pages[0] ?? {};
      const totalBlocks = num(head.totalMinedBlocks);
      const btcFund = num(head.btcFund);
      const promotedUpTo = Math.max(0, ...board.filter((row) => row.zone === 'promotion').map((row) => row.position));
      const relegatedFrom = Math.min(Infinity, ...board.filter((row) => row.zone === 'relegation').map((row) => row.position));
      const scale = cycle.elapsedDays > 0.25 ? 7 / cycle.elapsedDays : null;
      return {
        updatedAt: new Date(this.now()).toISOString(),
        cycle,
        league: {
          ...league,
          clans: board.length,
          totalBlocks,
          blocksWeekProjected: scale ? Math.round(totalBlocks * scale) : null,
          btcFund: round(btcFund, 8),
          btcPerBlock: totalBlocks > 0 ? round(btcFund / totalBlocks, 8) : 0,
          totalPowerTh: round(num(head.totalPower), 1),
          avgEfficiencyWth: head.weightedEnergyEfficiencyPerTh ? round(num(head.weightedEnergyEfficiencyPerTh), 2) : null,
          avgDiscountPct: head.weightedAvgDiscount ? round(num(head.weightedAvgDiscount) * 100, 2) : null,
          promotedUpTo: promotedUpTo || null,
          relegatedFrom: Number.isFinite(relegatedFrom) ? relegatedFrom : null,
        },
        clans: board.map((row) => ({
          ...row,
          blockSharePct: totalBlocks ? round((row.blocks / totalBlocks) * 100, 2) : 0,
          btcSoFar: totalBlocks ? round(row.blocks * (btcFund / totalBlocks), 8) : 0,
          blocksWeekProjected: scale ? Math.round(row.blocks * scale) : null,
        })),
      };
    });
  }

  // Clans whose name contains `query` (case-insensitive), across every league. Reads each league's
  // board through the same cache, a few leagues at a time.
  async search(query, { limit = 25 } = {}) {
    const wanted = String(query ?? '').trim().toLowerCase();
    if (wanted.length < 2) throw Object.assign(new Error('Type at least 2 characters of the clan name'), { status: 400 });
    const { leagues } = await this.leagues();
    const matches = [];
    const errors = [];
    for (let i = 0; i < leagues.length; i += CONCURRENCY) {
      const batch = leagues.slice(i, i + CONCURRENCY);
      const boards = await Promise.allSettled(batch.map((league) => this.board(league.id)));
      boards.forEach((outcome, k) => {
        if (outcome.status === 'rejected') { errors.push(batch[k].name); return; }
        for (const clan of outcome.value.clans) {
          if (clan.name.toLowerCase().includes(wanted)) matches.push({ ...clan, leagueId: batch[k].id, leagueName: batch[k].name });
        }
      });
    }
    // Exact names first, then by league (top first) and position.
    const level = new Map(leagues.map((league) => [league.id, league.level]));
    matches.sort((a, b) => (b.name.toLowerCase() === wanted) - (a.name.toLowerCase() === wanted) || level.get(a.leagueId) - level.get(b.leagueId) || a.position - b.position);
    return { query: wanted, count: matches.length, clans: matches.slice(0, limit), ...(errors.length ? { unavailableLeagues: errors } : {}) };
  }
}
