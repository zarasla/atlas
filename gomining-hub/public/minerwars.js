// Miner Wars: every league's live clan board, clan search across leagues, a week in any clan against
// plain mining, the best clans for your miners, points per second and multiplier odds, and spell prices.

import { clanFinder, minerWarsCycle, minerWarsVsSolo, pointsPerSecond } from '/lib/calc.js';
import { $, bold, btcFmt, el, empty, fieldNumber, getJson, num, stat, store, table, time, usdSmart } from './ui.js';

let shared;
const mw = { leagues: [], leagueId: Number(store.get('mwLeague')) || 1, board: null, clanId: Number(store.get('mwClan')) || null, timer: null };
const ZONE = { promotion: 'Promotion', safe: 'Safe', relegation: 'Relegation' };

export function initMinerWars(context) {
  shared = context;
  const you = $('mw-you');
  for (const name of ['powerTh', 'efficiencyWth', 'discountPct']) {
    const saved = store.get(`mwYou:${name}`);
    if (saved !== null) you.elements[name].value = saved;
  }
  you.addEventListener('input', (event) => {
    if (event.target.name && event.target.type !== 'checkbox') store.set(`mwYou:${event.target.name}`, event.target.value);
    renderYou();
  });
  you.addEventListener('submit', (event) => event.preventDefault());
  $('mw-league').addEventListener('change', (event) => selectLeague(Number(event.target.value)));
  $('mw-search').addEventListener('submit', (event) => { event.preventDefault(); search(event.target.elements.q.value); });
  renderClock();
  setInterval(renderClock, 30_000);
  loadLeagues();
  loadSpells();
}

// Called when the market data (payout and fees) arrives or the calculator changes.
export function refreshMinerWars() {
  renderYou();
}

async function loadLeagues() {
  try {
    const data = await getJson('/api/minerwars/leagues');
    mw.leagues = data.leagues;
    mw.cycle = data.cycle;
    const select = $('mw-league');
    select.replaceChildren(...mw.leagues.map((l) => new Option(l.name, String(l.id))));
    if (!mw.leagues.some((l) => l.id === mw.leagueId)) mw.leagueId = mw.leagues[0].id;
    select.value = String(mw.leagueId);
    renderOdds();
    await loadBoard();
  } catch (error) {
    $('mw-stats').replaceChildren(empty(`Miner Wars leagues are unavailable right now (${error.message}). They come back by themselves.`));
  }
}

function selectLeague(id, clanId = null) {
  mw.leagueId = id;
  mw.clanId = clanId;
  store.set('mwLeague', String(id));
  store.set('mwClan', clanId ? String(clanId) : '');
  $('mw-league').value = String(id);
  renderOdds();
  loadBoard();
}

async function loadBoard() {
  clearTimeout(mw.timer);
  const id = mw.leagueId;
  $('mw-board').setAttribute('aria-busy', 'true');
  try {
    const board = await getJson(`/api/minerwars/board?league=${id}`);
    if (id !== mw.leagueId) return;
    mw.board = board;
    if (!board.clans.some((c) => c.clanId === mw.clanId)) mw.clanId = null;
    renderBoard();
  } catch (error) {
    mw.board = null;
    $('mw-stats').replaceChildren(empty(`This league's board is unavailable right now (${error.message}).`));
    $('mw-board').replaceChildren();
  } finally {
    $('mw-board').setAttribute('aria-busy', 'false');
  }
  renderYou();
  // Boards change as rounds are won; look again every 10 minutes (the server caches as long).
  mw.timer = setTimeout(loadBoard, 10 * 60_000);
}

async function search(query) {
  const out = $('mw-results');
  if (String(query).trim().length < 2) { out.replaceChildren(el('p', 'fine', 'Type at least 2 characters.')); return; }
  out.replaceChildren(el('p', 'fine', 'Searching every league…'));
  try {
    const r = await getJson(`/api/minerwars/search?q=${encodeURIComponent(query.trim())}`);
    if (!r.count) { out.replaceChildren(el('p', 'fine', `No clan called “${query.trim()}” on any league board this cycle.`)); return; }
    const wrap = el('div', 'table-wrap');
    out.replaceChildren(el('p', 'fine', `${num(r.count)} clan${r.count === 1 ? '' : 's'} found${r.count > r.clans.length ? `, showing ${r.clans.length}` : ''}${r.unavailableLeagues ? ` (couldn't read ${r.unavailableLeagues.join(', ')})` : ''}. Choose one to open its league:`), wrap);
    table(wrap, ['Clan', 'League', 'Rank', 'Zone', 'Blocks', 'TH'], r.clans.map((c) => [c.name, c.leagueName, `#${c.position}`, ZONE[c.zone], num(c.blocks), num(c.powerTh, 0)]), {
      text: [1, 3],
      onRow: (i) => { selectLeague(r.clans[i].leagueId, r.clans[i].clanId); out.replaceChildren(); },
    });
  } catch (error) {
    out.replaceChildren(el('p', 'fine', error.message));
  }
}

function renderClock() {
  const cycle = minerWarsCycle();
  const left = Math.max(0, new Date(cycle.end) - Date.now());
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor((left % 86_400_000) / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  $('mw-clock').replaceChildren(document.createTextNode(`Cycle ${cycle.number} ends in`), bold(`${d}d ${h}h ${m}m`));
}

function renderBoard() {
  const { league, clans, cycle } = mw.board;
  $('mw-sub').textContent = `${league.name} · ${num(league.clans)} clans · cycle ${cycle.number} · updated ${time(mw.board.asOf ?? mw.board.updatedAt)}${mw.board.stale ? ' (GoMining is slow to answer: last good board)' : ''}`;
  const strip = el('div', 'stat-strip');
  strip.append(
    stat('Prize fund so far', btcFmt(league.btcFund), `${num(league.totalBlocks)} blocks mined`),
    stat('BTC per block', btcFmt(league.btcPerBlock), 'average so far, gross'),
    stat('League power', `${num(league.totalPowerTh, 0)} TH`, league.avgEfficiencyWth ? `avg ${num(league.avgEfficiencyWth, 2)} W/TH` : ' '),
    stat('Avg discount', league.avgDiscountPct === null ? '—' : `${num(league.avgDiscountPct, 2)}%`, 'weighted, all players'),
    stat('Multipliers', league.maxMultiplier ? `up to ×${league.maxMultiplier}` : '—', league.averageMultiplier ? `average ×${num(league.averageMultiplier, 2)}` : ' '),
    stat('Movement', league.promotedUpTo ? `top ${league.promotedUpTo} up` : '—', league.relegatedFrom ? `from #${league.relegatedFrom} down` : 'no relegation'),
  );
  $('mw-stats').replaceChildren(strip);
  table($('mw-board'), ['Rank', 'Clan', 'Zone', 'Blocks', 'Share', 'TH', 'BTC so far'], clans.map((c) => [
    `#${c.position}`, c.name, ZONE[c.zone], num(c.blocks), `${num(c.blockSharePct, 1)}%`, num(c.powerTh, 0), btcFmt(c.btcSoFar),
  ]), {
    text: [1, 2],
    highlight: (i) => clans[i].clanId === mw.clanId,
    cellClass: (i, c) => (c === 2 ? `zone-cell ${clans[i].zone}` : ''),
    onRow: (i) => { mw.clanId = clans[i].clanId; store.set('mwClan', String(mw.clanId)); renderBoard(); renderYou(); $('mw-vs-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); },
  });
}

const youValues = () => {
  const f = $('mw-you');
  return { powerTh: fieldNumber(f, 'powerTh'), efficiencyWth: fieldNumber(f, 'efficiencyWth'), discountPct: fieldNumber(f, 'discountPct') ?? 0, member: f.elements.member.checked };
};

function renderYou() {
  renderPps();
  renderVs();
  renderFinder();
}

function renderPps() {
  const { powerTh, efficiencyWth } = youValues();
  const box = $('mw-pps');
  if (!(powerTh > 0) || !(efficiencyWth > 0)) { box.replaceChildren(el('p', 'fine', 'Enter your TH and W/TH in the clan comparison above.')); return; }
  const line = el('p', 'impact');
  line.append('Your base score: ', bold(`${num(pointsPerSecond(powerTh, efficiencyWth), 2)} points per second`), ` (${num(powerTh, 2)} TH × 20 ÷ ${num(efficiencyWth, 1)} W/TH)`);
  box.replaceChildren(line);
}

function renderVs() {
  const out = $('mw-vs-out');
  const board = mw.board;
  const clan = board?.clans.find((c) => c.clanId === mw.clanId);
  if (!clan) {
    $('mw-vs-title').textContent = 'A week in a clan, or plain mining?';
    $('mw-vs-sub').textContent = 'Choose a clan on the board above (or find one by name)';
    out.replaceChildren();
    $('mw-vs-note').textContent = '';
    return;
  }
  $('mw-vs-title').textContent = `A week in ${clan.name}, or plain mining?`;
  $('mw-vs-sub').textContent = `#${clan.position} in ${board.league.name} · ${num(clan.powerTh, 0)} TH · ${num(clan.blocks)} blocks so far`;
  if (!shared.market) { out.replaceChildren(el('p', 'fine', 'Waiting for GoMining\'s payout data…')); return; }
  const v = youValues();
  if (!(v.powerTh > 0) || !(v.efficiencyWth > 0)) { out.replaceChildren(el('p', 'fine', 'Enter your TH and W/TH.')); return; }
  if (clan.blocksWeekProjected === null) { out.replaceChildren(el('p', 'fine', 'The cycle has only just started: there are no blocks to project from yet.')); return; }
  // Joining adds your own fair chance on top of the clan's pace: the league's weekly blocks × your share of league power.
  const league = board.league;
  const extra = v.member || !(league.totalPowerTh > 0) ? 0 : (league.blocksWeekProjected ?? 0) * (v.powerTh / (league.totalPowerTh + v.powerTh));
  const r = minerWarsVsSolo(shared.market.income, {
    powerTh: v.powerTh, efficiencyWth: v.efficiencyWth, discountPct: v.discountPct, joining: !v.member,
    clanBlocksWeek: clan.blocksWeekProjected + extra, btcPerBlock: board.league.btcPerBlock, clanPowerTh: clan.powerTh,
    leagueEfficiencyWth: board.league.avgEfficiencyWth, leagueDiscountPct: board.league.avgDiscountPct ?? undefined,
  });
  const col = (label, btc, win, sub) => { const box = el('div'); box.append(el('p', 'eyebrow', label), el('p', `calc-big${win ? ' win' : ''}`, btcFmt(btc)), el('p', 'calc-sub', sub)); return box; };
  const mwWins = r.better === 'minerWars';
  const mwSub = r.minerWars.flooredAtZero
    ? `Your share (${btcFmt(r.minerWars.grossBtc)}) is smaller than a week's maintenance (${btcFmt(r.minerWars.maintenanceBtc)}), so GoMining pays 0 and charges nothing more`
    : `${btcFmt(r.minerWars.grossBtc)} share − ${btcFmt(r.minerWars.maintenanceBtc)} maintenance ≈ ${usdSmart(r.minerWars.netUsd)}`;
  const verdict = el('div');
  verdict.append(el('p', 'eyebrow', 'Verdict'), el('p', `calc-big${mwWins ? ' win' : ''}`, mwWins ? 'Miner Wars' : 'Plain mining'),
    el('p', 'calc-sub', r.differencePct === null ? 'Plain mining loses money at these settings; Miner Wars never goes below 0' : `${r.differencePct >= 0 ? '+' : ''}${num(r.differencePct, 0)}% a week vs plain mining`));
  out.replaceChildren(
    col(`A week in ${clan.name}`, r.minerWars.netBtc, mwWins, `${num(r.sharePct, 2)}% of ~${num(clan.blocksWeekProjected + extra)} blocks. ${mwSub}`),
    col('Plain mining', r.solo.netBtc, !mwWins, `≈ ${usdSmart(r.solo.netUsd)} net a week`),
    verdict,
  );
  $('mw-vs-note').textContent = `At the clan's pace so far (${num(clan.blocks)} blocks in ${num(board.cycle.elapsedDays, 1)} days → ~${num(clan.blocksWeekProjected)} this week${extra ? `, plus ~${num(extra, 1)} for your own share of league power` : ""}) × ${btcFmt(board.league.btcPerBlock)} per block, shared by TH out of ${num(r.clanPowerTh, 0)} TH${v.member ? '' : ' (the clan plus yours)'}. GoMining takes a full week of maintenance on all your TH from your share, never below zero; reward above what Mining mode would pay is charged at the league's average ${num(board.league.avgEfficiencyWth ?? v.efficiencyWth, 2)} W/TH and ${num(board.league.avgDiscountPct ?? 0, 2)}% discount.${v.member ? '' : ` Joining costs one day of Mining mode reward (${btcFmt(r.minerWars.switchCostBtc)}), so the first week nets ${btcFmt(r.minerWars.firstWeekNetBtc)}.`} Plain mining uses your discount as entered (add your Mining mode discount to it). Rounds are weighted by multipliers GoMining can't announce in advance, so this treats them as equal. An estimate, not a promise.`;
}

function renderFinder() {
  const box = $('mw-finder');
  const board = mw.board;
  if (!board || !shared.market) { box.replaceChildren(empty('Waiting for the league board…')); return; }
  const v = youValues();
  if (!(v.powerTh > 0) || !(v.efficiencyWth > 0)) { box.replaceChildren(empty('Enter your TH and W/TH in the clan comparison above.')); return; }
  const r = clanFinder(shared.market.income, { board: board.clans, league: board.league, elapsedDays: board.cycle.elapsedDays, powerTh: v.powerTh, efficiencyWth: v.efficiencyWth, discountPct: v.discountPct, limit: 50 });
  $('mw-finder-sub').textContent = `${board.league.name}: ${num(v.powerTh, 2)} TH at ${num(v.efficiencyWth, 1)} W/TH, ${num(v.discountPct, 1)}% discount · plain mining ≈ ${r.soloNetBtc === null ? '—' : btcFmt(r.soloNetBtc)} a week`;
  if (!r.rows.length) { box.replaceChildren(empty(r.note ?? 'No clans to rank yet.')); return; }
  table(box, ['#', 'Clan', 'Zone', 'Blocks vs power', 'Your share', 'Blocks / wk', 'Net / week', 'vs mining'], r.rows.map((row, i) => [
    i + 1, row.name, ZONE[row.zone], row.blocksVsPower === null ? '—' : `×${num(row.blocksVsPower, row.blocksVsPower < 10 ? 1 : 0)}`, `${num(row.sharePct, 2)}%`, num(row.blocksWeek, 0),
    row.flooredAtZero ? '0 (floored)' : btcFmt(row.netBtc), row.vsSoloPct === null ? '—' : `${row.vsSoloPct >= 0 ? '+' : ''}${num(row.vsSoloPct, 0)}%`,
  ]), {
    text: [1, 2],
    highlight: (i) => r.rows[i].clanId === mw.clanId,
    cellClass: (i, c) => (c === 7 && r.rows[i].vsSoloPct !== null ? (r.rows[i].vsSoloPct >= 0 ? 'pos' : 'neg') : c === 3 && r.rows[i].blocksVsPower > 3 ? 'warn' : ''),
    onRow: (i) => { mw.clanId = r.rows[i].clanId; store.set('mwClan', String(mw.clanId)); renderBoard(); renderYou(); },
  });
}

function renderOdds() {
  const league = mw.leagues.find((l) => l.id === mw.leagueId);
  const box = $('mw-odds');
  if (!league?.multipliers?.length) { box.replaceChildren(empty('No multiplier odds published for this league.')); return; }
  $('mw-odds-sub').textContent = `${league.name}: GoMining's published odds of each round multiplier · average ×${num(league.averageMultiplier, 2)}`;
  table(box, ['Multiplier', 'Chance per round', 'About once every'], league.multipliers.map((m) => [
    `×${m.multiplier}`, `${num(m.probability * 100, m.probability < 0.01 ? 3 : 1)}%`, m.probability > 0 ? `${num(1 / m.probability, 0)} rounds` : '—',
  ]));
}

async function loadSpells() {
  const box = $('mw-spells');
  try {
    const { spells } = await getJson('/api/minerwars/spells');
    const effect = (s) => {
      const e = s.effect ?? {};
      if (s.type === 'powerUp') return `×${num(e.value ?? 0)} base PPS for the round`;
      if (s.type === 'clanPowerUp') return '+1 to +6.4 base PPS per activation for the whole clan';
      if (s.type === 'service') return 'PPS × 1,000 points, +0.3% discount a day in a row';
      const points = (e.value ?? 0) * (e.multiply ?? 1);
      if (s.type === 'instantBoost') return `${num(points)} points after ${e.activationDelayInSec ?? 3}s`;
      if (s.type === 'boost') return `${num(points)} points a second to round end`;
      if (s.type === 'echoBoost') return `${num(points)} × n points every ${Math.round((e.intervalInSec ?? 120) / 60)} min`;
      if (s.type === 'timewrap') return `${num(points)} points if the round ends within ${Math.round((e.durationInSec ?? 300) / 60)} min`;
      return s.description;
    };
    // GoMining's docs call the 10x and 100x tiers Super and Ultra.
    const tier = { basic: 'Basic', pro: 'Super', ultra: 'Ultra' };
    // Power-up prices scale with the player's base PPS (docs: Spells & Power-ups); the list shows the base price.
    const price = (s) => (s.priceGomining === null ? '—' : `${num(s.priceGomining, s.priceGomining < 1 ? 2 : 0)}${s.type === 'powerUp' ? ', rises with your PPS' : ''}`);
    table(box, ['Spell', 'Tier', 'GOMINING', 'Effect'], spells.map((s) => [s.name, tier[s.tier] ?? s.tier, price(s), effect(s)]), { text: [1, 2, 3] });
  } catch (error) {
    box.replaceChildren(empty(`Spell prices are unavailable right now (${error.message}).`));
  }
}
