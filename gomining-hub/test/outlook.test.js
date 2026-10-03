import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { VIP_LEVELS, breakEvenBtcPrice, simpleEarn, vipStatus, difficultyImpact, halving, maintenanceDiscount, minerWarsCycle, minerWarsVsSolo, normalizeIncome, rewardsBreakdown } from '../src/core/calc.js';
import { GoMiningClient } from '../src/core/client.js';
import { ExternalService } from '../src/core/external.js';
import { MarketService } from '../src/core/market.js';
import { leagueName, MinerWarsService } from '../src/core/minerwars.js';
import { createServer } from '../src/mcp/server.js';
import { createApp } from '../src/web/server.js';
import { fakeFetch, income } from './fake-api.js';

// 0.04 USD at 80,000 USD/BTC = 50 sats per TH; electricity 0.0012 per W/TH, service 0.0089.
const market = normalizeIncome(income);

test('break-even BTC price per W/TH', () => {
  const be = breakEvenBtcPrice(market);
  const at15 = be.rows.find((r) => r.efficiencyWth === 15);
  // (0.0012 * 15 + 0.0089) / 0.0000005 BTC = 53,800 USD
  assert.equal(at15.breakEvenBtcUsd, 53800);
  assert.equal(at15.headroomPct, 48.7);
  assert.equal(be.rows.length, 9);
  assert.equal(breakEvenBtcPrice(market, { discountPct: 10 }).rows.find((r) => r.efficiencyWth === 15).breakEvenBtcUsd, 48420);
});

test('difficulty adjustment impact on sats per TH', () => {
  const impact = difficultyImpact(market, { estimatedChangePct: 2.5, estimatedDate: '2026-10-10T00:00:00.000Z' }, { powerTh: 16 });
  assert.equal(impact.satsPerThAfter, 48.78);
  assert.equal(impact.payoutChangePct, -2.44);
  assert.equal(impact.satsPerDayChange, -19.5);
  assert.equal(difficultyImpact(market, null), null);
});

test('halving countdown from block height', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  const h = halving(915000, { avgBlockMinutes: 10, satsPerThDay: 50, now });
  assert.equal(h.nextHalvingHeight, 1050000);
  assert.equal(h.blocksLeft, 135000);
  assert.equal(h.daysLeft, 938);
  assert.equal(h.subsidyBtcNow, 3.125);
  assert.equal(h.subsidyBtcAfter, 1.5625);
  assert.equal(h.satsPerThAfter, 25);
  assert.equal(halving(null), null);
});

test('maintenance discount builder: GOMINING coverage tiers, VIP and Service Button add up', () => {
  // 16 TH at 15 W/TH: (0.018 + 0.0089) * 16 = 0.4304 USD a day.
  const base = { powerTh: 16, efficiencyWth: 15, gominingUsd: 0.5 };
  const none = maintenanceDiscount(market, base);
  assert.equal(none.dailyMaintenanceUsd, 0.4304);
  assert.equal(none.tokenPct, 0);
  assert.equal(none.next.gominingNeeded, 16); // 18 days * 0.4304 / 0.5
  assert.equal(none.gominingForMax, 310); // 360 days
  const some = maintenanceDiscount(market, { ...base, gominingHeld: 100, vipPct: 1.5, serviceButton: true });
  assert.equal(some.coverageDays, 116);
  assert.equal(some.tokenPct, 6);
  assert.equal(some.totalPct, 10.5);
  const level = maintenanceDiscount(market, { ...base, vipLevel: 'Diamond I' });
  assert.equal(level.vipPct, 3);
  assert.equal(level.vipLevel, 'Diamond I');
  assert.equal(level.reinvestBonusPct, 10);
  assert.equal(VIP_LEVELS.length, 21);
  const max = maintenanceDiscount(market, { ...base, gominingHeld: 1e6, vipPct: 9, serviceButton: true });
  assert.equal(max.tokenPct, 20);
  assert.equal(max.vipPct, 6);
  assert.equal(max.totalPct, 29);
  assert.equal(max.next, null);
});

test('rewards include maintenance cost in USD and GOMINING', () => {
  const day = rewardsBreakdown(market, { powerTh: 16, efficiencyWth: 15, discountPct: 10, gominingUsd: 0.5 }).periods.day;
  assert.equal(day.feesUsd, 0.3874);
  assert.equal(day.feesGomining, 0.77);
});

test('Miner Wars cycles run Tuesday to Tuesday UTC', () => {
  const c = minerWarsCycle(Date.parse('2026-10-03T12:00:00Z'));
  assert.equal(c.number, 163);
  assert.equal(c.start, '2026-09-29T00:00:00.000Z');
  assert.equal(c.end, '2026-10-06T00:00:00.000Z');
  assert.equal(c.elapsedDays, 4.5);
  assert.equal(leagueName(3), 'Eclipse');
  assert.equal(leagueName(4), 'Horizon');
  assert.equal(leagueName(5), 'Dune I');
});

test('Miner Wars vs plain mining for a week', () => {
  const r = minerWarsVsSolo(market, { powerTh: 150, efficiencyWth: 15, clanBlocksWeek: 100, btcPerBlock: 0.001, clanPowerTh: 15000 });
  assert.equal(r.sharePct, 1);
  assert.equal(r.minerWars.grossBtc, 0.001);
  // fees are 0.0269 of a 0.04 payout per TH: 67.25% of the reward
  assert.equal(r.minerWars.netBtc, 0.0003275);
  assert.equal(r.solo.netBtc, 0.00017194); // (0.04 - 0.0269) * 150 * 7 / 80,000
  assert.equal(r.better, 'minerWars');
});

async function minerWarsService(routes) {
  const api = fakeFetch(routes);
  const client = new GoMiningClient({ token: 'secret', fetchImpl: api.fetchImpl });
  const service = new MinerWarsService({ client, now: () => Date.parse('2026-10-03T12:00:00Z') });
  return { service, api, client };
}

test('Miner Wars service finds HONKSQUAD, its zone and estimated BTC, and never sends the token', async () => {
  const { service, api } = await minerWarsService();
  const data = await service.get({ waitForMembers: true });
  assert.equal(data.status, 'live');
  assert.equal(data.league.id, 3);
  assert.equal(data.league.name, 'Eclipse');
  assert.equal(data.league.btcPerBlock, 0.001);
  assert.equal(data.league.promotedUpTo, 2);
  assert.equal(data.league.relegatedFrom, 5);
  assert.deepEqual([data.clan.position, data.clan.zone, data.clan.blocks], [2, 'promotion', 100]);
  assert.equal(data.clan.btcSoFar, 0.1);
  assert.equal(data.clan.blocksWeekProjected, 156); // 100 blocks in 4.5 days
  assert.equal(data.neighbours.length, 4);
  // 120 players, every third one in HONKSQUAD, read 50 at a time
  assert.equal(data.members.count, 40);
  assert.equal(data.members.rows[0].alias, 'p0');
  assert.equal(data.members.rows[0].boostsUsed, 5);
  assert.ok(api.calls.every((c) => c.headers.authorization === undefined));
  assert.ok(api.calls.every((c) => !c.body?.pagination || c.body.pagination.limit <= 50));
});

test('Miner Wars service returns "loading" members first, then serves cached data', async () => {
  const { service, api } = await minerWarsService();
  const first = await service.get();
  assert.equal(first.members.status, 'loading');
  await service.membersInflight;
  const calls = api.calls.length;
  const second = await service.get();
  assert.equal(second.members.status, 'live');
  assert.equal(api.calls.length, calls);
});

test('Miner Wars service reports unavailable when GoMining is down', async () => {
  const { service } = await minerWarsService({ 'POST /api/nft-game/clan-leaderboard/index-v2': () => new Response('down', { status: 502 }) });
  const data = await service.get();
  assert.equal(data.status, 'unavailable');
  assert.match(data.error, /HTTP 502/);
});

test('Fear & Greed from alternative.me, and outlook in the market summary', async () => {
  const api = fakeFetch();
  const external = new ExternalService({ fetchImpl: api.fetchImpl });
  assert.deepEqual(await external.sentiment(), { value: 62, label: 'Greed', yesterday: 58, lastWeek: 47 });
  const client = new GoMiningClient({ fetchImpl: api.fetchImpl });
  const service = new MarketService({ client, external, historyPath: join(await mkdtemp(join(tmpdir(), 'gomining-outlook-')), 'h.json') });
  const app = createApp({ market: service, minerWars: new MinerWarsService({ client }) });
  const { createServer: http } = await import('node:http');
  const server = http(app).listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const m = await (await fetch(`${base}/api/market`)).json();
    assert.equal(m.sources.sentiment, 'live');
    assert.equal(m.outlook.sentiment.value, 62);
    assert.equal(m.outlook.halving.nextHalvingHeight, 1050000);
    assert.equal(m.outlook.difficulty.difficultyChangePct, 1.8);
    assert.equal(m.outlook.breakEven.rows.length, 9);
    const mw = await (await fetch(`${base}/api/minerwars`)).json();
    assert.equal(mw.status, 'live');
    assert.equal(mw.clan.name, 'HONKSQUAD');
  } finally {
    server.close();
  }
});

test('MCP: clan Miner Wars, outlook and discount tools', async () => {
  const api = fakeFetch();
  const client = new GoMiningClient({ fetchImpl: api.fetchImpl });
  const market = new MarketService({ client, external: new ExternalService({ fetchImpl: api.fetchImpl }), historyPath: join(await mkdtemp(join(tmpdir(), 'gomining-mw-')), 'h.json') });
  const server = createServer({ client, market, minerWars: new MinerWarsService({ client }) });
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), mcp.connect(a)]);
  const call = async (name, args = {}) => JSON.parse((await mcp.callTool({ name, arguments: args })).content[0].text);
  const mw = await call('gomining_clan_miner_wars', { powerTh: 150 });
  assert.equal(mw.clan.name, 'HONKSQUAD');
  assert.equal(mw.members.count, 40);
  assert.equal(mw.board, undefined);
  assert.ok(mw.vsSolo.minerWars.netBtc > 0);
  const outlook = await call('gomining_outlook', { powerTh: 16 });
  assert.equal(outlook.fearGreed.label, 'Greed');
  assert.equal(outlook.breakEven.rows[3].efficiencyWth, 15);
  const discount = await call('gomining_maintenance_discount', { powerTh: 16, efficiencyWth: 15, gominingHeld: 1e6, vipPct: 6, serviceButton: true });
  assert.equal(discount.totalPct, 29);
});

test('VIP level from the best of three paths, and what the next level needs', () => {
  const s = vipStatus({ powerTh: 1200, veGomining: 3000 });
  assert.equal(s.level.name, 'Platinum II');
  assert.deepEqual(s.reachedBy, ['th']);
  assert.equal(s.byPath.veGomining, 'Gold II');
  assert.equal(s.next.level.name, 'Platinum III');
  assert.deepEqual(s.next.needs, { th: 1300, veGomining: 22000, referralUsd: 250000 });
  assert.equal(s.next.gains.discountPct, 0.3);
  assert.equal(vipStatus({ referralUsd: 600000 }).level.name, 'Diamond I');
  assert.equal(vipStatus({ powerTh: 2e6 }).next, null);
  assert.equal(vipStatus().level.name, 'Bronze I');
});

test('Simple Earn: base APR times the VIP multiplier, paid in BTC', () => {
  const r = simpleEarn({ amount: 1000, assetPriceUsd: 1, aprPct: 12.02, vipLevel: 'Platinum II', btcPriceUsd: 80000 });
  assert.equal(r.multiplier, 1.22);
  assert.equal(r.effectiveAprPct, 14.664);
  assert.equal(r.periods.year.usd, 146.644);
  assert.equal(r.periods.year.sats, 183305);
  assert.throws(() => simpleEarn({ amount: 1, aprPct: 1, btcPriceUsd: 1 }), /price/);
});

test('maintenance discount still counts VIP and Service Button without a GOMINING price', () => {
  const d = maintenanceDiscount(market, { powerTh: 16, efficiencyWth: 15, gominingHeld: 2000, vipLevel: 'Platinum I', serviceButton: true });
  assert.equal(d.tokenPct, 0);
  assert.equal(d.totalPct, 5.1);
  assert.equal(d.gominingForMax, null);
});

test('external answers are shared for a while, and the last good one is kept when CoinGecko throttles', async () => {
  let clock = 0;
  let throttled = false;
  const api = fakeFetch({ 'GET /api/v3/simple/price': () => (throttled ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ bitcoin: { usd: 80500 }, 'gomining-token': { usd: 0.42 } }), { status: 200 })) });
  const external = new ExternalService({ fetchImpl: api.fetchImpl, now: () => clock });
  const count = () => api.calls.filter((c) => c.url.includes('simple/price')).length;
  await external.prices();
  await external.prices();
  assert.equal(count(), 1);
  clock = 100_000;
  throttled = true;
  const stale = await external.prices();
  assert.equal(stale.stale, true);
  assert.equal(stale.gomining.usd, 0.42);
  assert.equal(count(), 2);
  clock = 120_000; // within the retry pause: no new call
  await external.prices();
  assert.equal(count(), 2);
  clock = 7 * 3_600_000; // too old to serve
  await assert.rejects(external.prices(), /HTTP 429/);
});
