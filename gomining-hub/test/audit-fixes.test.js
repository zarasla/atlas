// Regression tests for the October 2026 audit: Miner Wars league names and maintenance rule, halving
// pace, discount parts, plan guard, backoff, history safety, path hardening and the remote MCP.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as http } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { halving, investmentPlan, leagueDisplayName, maintenanceDiscount, minerWarsClanNet, minerWarsVsSolo, normalizeIncome } from '../src/core/calc.js';
import { GoMiningClient } from '../src/core/client.js';
import { MarketService } from '../src/core/market.js';
import { MinerWarsService } from '../src/core/minerwars.js';
import { createServer } from '../src/mcp/server.js';
import { createApp } from '../src/web/server.js';
import { clanBoard, fakeFetch, income } from './fake-api.js';

// 0.04 USD at 80,000 USD/BTC = 50 sats per TH; electricity 0.0012 per W/TH, service 0.0089.
const market = normalizeIncome(income);
const tempFile = async (name) => join(await mkdtemp(join(tmpdir(), 'gomining-audit-')), name);

test('league names come from GoMining\'s league list, Dune divisions numbered as GoMining numbers them', () => {
  assert.equal(leagueDisplayName('odyssey'), 'Odyssey');
  assert.equal(leagueDisplayName('eclipse'), 'Eclipse');
  assert.equal(leagueDisplayName('dune-12'), 'Dune 12');
  assert.equal(leagueDisplayName('dune-29'), 'Dune 29');
});

test('the league size is the number of clans on the board, not GoMining\'s count field', async () => {
  const api = fakeFetch({
    'POST /api/nft-game/clan-leaderboard/index-v2': (_url, init) => {
      const { leagueId } = JSON.parse(init.body);
      // `count` only covers the safe-zone list; the board itself has 6 clans.
      const data = leagueId === 3 ? { ...clanBoard, count: 2 } : { count: 0, clansPromoted: [], clansRemaining: [], clansRelegated: [] };
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  });
  const service = new MinerWarsService({ client: new GoMiningClient({ fetchImpl: api.fetchImpl }), now: () => Date.parse('2026-10-03T12:00:00Z') });
  const data = await service.board(3);
  assert.equal(data.league.clans, 6);
  assert.equal(data.league.name, 'Eclipse');
});

test('Miner Wars fetches back off after a failure instead of retrying on every visit', async () => {
  let clock = Date.parse('2026-10-03T12:00:00Z');
  let down = true;
  const api = fakeFetch({ 'POST /api/nft-game/clan-leaderboard/index-v2': (url, init) => (down ? new Response('down', { status: 502 }) : fakeFetch().fetchImpl(url, init)) });
  const service = new MinerWarsService({ client: new GoMiningClient({ fetchImpl: api.fetchImpl }), now: () => clock });
  await assert.rejects(service.board(3), /HTTP 502/);
  const calls = api.calls.length;
  clock += 60_000;
  await assert.rejects(service.board(3), /HTTP 502/);
  assert.equal(api.calls.length, calls, 'no new GoMining calls within the retry pause');
  down = false;
  clock += 10 * 60_000;
  assert.equal((await service.board(3)).clans.length, 6);
  // A later failure serves the last good board, marked stale.
  down = true;
  clock += 11 * 60_000;
  const stale = await service.board(3);
  assert.equal(stale.stale, true);
  assert.equal(stale.clans.length, 6);
});

test('Miner Wars net follows GoMining: a full week of maintenance, never below zero', () => {
  // Live 3 Oct 2026 case: 16 TH at 15 W/TH, 0.1024% of 89 blocks x 0.00027098 BTC = 0.0000247 BTC,
  // less than a week of maintenance (16 x 0.0269 x 7 USD), so GoMining pays nothing.
  const live = { ...market, btcPriceUsd: 84628.63721693, rewardUsdPerThDay: 0.04019466622639745, rewardSatsPerThDay: 47.5 };
  const r = minerWarsVsSolo(live, { powerTh: 16, efficiencyWth: 15, clanBlocksWeek: 89, btcPerBlock: 0.00027098, clanPowerTh: 15625.3, leagueEfficiencyWth: 17.91, leagueDiscountPct: 6.39 });
  assert.equal(r.minerWars.grossBtc, 0.0000247);
  assert.equal(r.minerWars.maintenanceBtc, 0.0000356);
  assert.equal(r.minerWars.netBtc, 0);
  assert.equal(r.minerWars.flooredAtZero, true);
  assert.equal(r.better, 'solo');

  // Above Mining-mode output the excess is charged at the league's W/TH: 0.001 BTC gross, 0.000525
  // Mining-mode gross, own fees 0.00035306, excess 0.000475 at (0.0012 x 20 + 0.0089) / 0.04.
  const big = minerWarsVsSolo(market, { powerTh: 150, efficiencyWth: 15, clanBlocksWeek: 100, btcPerBlock: 0.001, clanPowerTh: 15000, leagueEfficiencyWth: 20, leagueDiscountPct: 0 });
  assert.equal(big.minerWars.netBtc, 0.00025625);

  // Someone not in the clan yet adds their TH to the total instead of taking all of it, and loses
  // the joining day's Mining mode reward (one day of their weekly plain-mining net).
  const whale = minerWarsVsSolo(market, { powerTh: 20000, efficiencyWth: 15, clanBlocksWeek: 89, btcPerBlock: 0.0003, clanPowerTh: 15625.3, joining: true });
  assert.equal(whale.sharePct, 56.1399);
  assert.equal(whale.clanPowerTh, 35625.3);
  assert.equal(whale.minerWars.switchCostBtc, Number((whale.solo.netBtc / 7).toFixed(8)));
  assert.equal(whale.minerWars.firstWeekNetBtc, Number((whale.minerWars.netBtc - whale.minerWars.switchCostBtc).toFixed(8)));
  assert.equal(big.minerWars.switchCostBtc, 0);
});

test('rough clan net: projected gross less a week of maintenance at the league average', () => {
  const r = minerWarsClanNet(market, { btcWeek: 0.024, clanPowerTh: 15625.3, leagueEfficiencyWth: 17.91, leagueDiscountPct: 6.39 });
  assert.equal(r.maintenanceBtc, 0.03889716);
  assert.equal(r.netBtc, 0);
  assert.equal(minerWarsClanNet(market, { btcWeek: 0.02, clanPowerTh: 0, leagueEfficiencyWth: 17 }), null);
});

test('halving is counted at 10-minute blocks', () => {
  const h = halving(969766, { satsPerThDay: 47.5, now: Date.parse('2026-10-03T00:00:00Z') });
  assert.equal(h.blocksLeft, 80234);
  assert.equal(h.daysLeft, 557);
  assert.equal(h.estimatedDate.slice(0, 10), '2028-04-12');
});

test('discount: Service Button builds 0.3% a day; Mining mode is only what the member enters, never assumed', () => {
  const base = { powerTh: 16, efficiencyWth: 15, gominingUsd: 0.5 };
  assert.equal(maintenanceDiscount(market, { ...base, serviceButtonDays: 4 }).serviceButtonPct, 1.2);
  assert.equal(maintenanceDiscount(market, { ...base, serviceButtonDays: 25 }).serviceButtonPct, 3);
  assert.equal(maintenanceDiscount(market, { ...base, serviceButton: true }).serviceButtonPct, 3);
  const fixed = maintenanceDiscount(market, { ...base, gominingHeld: 1e6, vipLevel: 'Elite', serviceButtonDays: 10 });
  assert.equal(fixed.miningModePct, 0);
  assert.equal(fixed.totalPct, 29);
  const withMode = maintenanceDiscount(market, { ...base, gominingHeld: 1e6, vipLevel: 'Elite V', serviceButtonDays: 10, miningModePct: 1.75 });
  assert.equal(withMode.vipPct, 6, 'GoMining\'s table name "Elite V" is accepted');
  assert.equal(withMode.totalPct, 30.75);
});

test('the investment plan refuses a reinvest price that is really a per-W/TH step', () => {
  assert.throws(() => investmentPlan(market, { efficiencyWth: 15, monthlyUsd: 100, months: 24, pricePerThUsd: 14.99, reinvest: true, reinvestPricePerThUsd: 0.772 }), /far below/);
  assert.ok(investmentPlan(market, { efficiencyWth: 15, monthlyUsd: 100, months: 24, pricePerThUsd: 14.99, reinvest: true, reinvestPricePerThUsd: 11.5 }).summary.finalTh < 300);
});

test('reinvesting follows GoMining\'s rules: 10-5,000 TH, better than 20 W/TH, $0.10 a day', () => {
  // 5 TH earns 5 x 0.0131 = $0.0655 a day: under the minimum and under 10 TH, so paid in BTC.
  const small = investmentPlan(market, { startTh: 5, efficiencyWth: 15, months: 2, pricePerThUsd: 15, reinvest: true });
  assert.equal(small.summary.reinvestedUsd, 0);
  assert.ok(small.summary.reinvestBlockedDays['needs at least 10 TH'] > 0);
  assert.equal(small.summary.finalTh, 5);
  // 20 W/TH miners can't reinvest into TH at all.
  const hot = investmentPlan(market, { startTh: 100, efficiencyWth: 20, months: 1, pricePerThUsd: 10, reinvest: true });
  assert.equal(hot.summary.reinvestedUsd, 0);
  assert.ok(hot.summary.reinvestBlockedDays['needs better than 20 W/TH'] > 0);
  // 20 TH at 15 W/TH qualifies: rewards compound daily.
  const ok = investmentPlan(market, { startTh: 20, efficiencyWth: 15, months: 12, pricePerThUsd: 15, reinvest: true, reinvestBonusPct: 5 });
  assert.deepEqual(ok.summary.reinvestBlockedDays, {});
  assert.ok(ok.summary.finalTh > 20 + ok.summary.reinvestedUsd / 15, 'the VIP bonus adds TH');
});

test('the client refuses encoded dot segments and backslashes', () => {
  const client = new GoMiningClient({ fetchImpl: fakeFetch().fetchImpl });
  for (const path of ['/%2e%2e/admin', '/%2E%2E/x', '/a/%2e/b', '/\\evil']) assert.throws(() => client.resolve(path), /Path must be/, path);
  assert.equal(client.resolve('/nft/get-upgrade-rate').href, 'https://api.gomining.com/api/nft/get-upgrade-rate');
});

test('a damaged history file is kept aside, never silently replaced', async () => {
  const historyPath = await tempFile('history.json');
  await writeFile(historyPath, '[{"date":"2026-10-01"'); // truncated mid-write
  const service = new MarketService({ client: new GoMiningClient({ fetchImpl: fakeFetch().fetchImpl }), historyPath });
  await service.get();
  const files = await readdir(join(historyPath, '..'));
  assert.ok(files.some((f) => f.startsWith('history.json.corrupt-')), 'the damaged file is backed up');
  assert.ok(!files.includes('history.json.tmp'), 'the temporary file is renamed into place');
  assert.equal(JSON.parse(await readFile(historyPath, 'utf8')).length, 1);
});

test('a malformed URL path is a 400, not a 500', async () => {
  const service = new MarketService({ client: new GoMiningClient({ fetchImpl: fakeFetch().fetchImpl }), historyPath: await tempFile('h.json') });
  const server = http(createApp({ market: service })).listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/%E0%A4%A`);
    assert.equal(response.status, 400);
  } finally {
    server.close();
  }
});

test('the remote MCP has no raw API passthrough; the local one marks it destructive', async () => {
  const client = new GoMiningClient({ token: 'secret', fetchImpl: fakeFetch().fetchImpl });
  const service = new MarketService({ client, historyPath: await tempFile('h.json') });
  const tools = async (options) => {
    const mcp = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer({ client, market: service, ...options }).connect(b), mcp.connect(a)]);
    return (await mcp.listTools()).tools;
  };
  assert.ok(!(await tools({ remote: true })).some((t) => t.name === 'gomining_api_request'));
  const local = (await tools({})).find((t) => t.name === 'gomining_api_request');
  assert.equal(local.annotations.destructiveHint, true);
});
