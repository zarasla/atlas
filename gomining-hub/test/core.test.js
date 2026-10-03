import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { calculateEarnings, dailyBreakdownPerTh, efficiencyCurve, findListedPrice, normalizeIncome, normalizePresets, normalizeUpgradeRates } from '../src/core/calc.js';
import { GoMiningClient } from '../src/core/client.js';
import { MarketService } from '../src/core/market.js';
import { fakeFetch, income, presets, upgradeRates } from './fake-api.js';

const market = normalizeIncome(income);

test('normalizeIncome derives sats, kWh price and the 365-day average', () => {
  assert.equal(market.rewardSatsPerThDay, 50); // 0.04 / 80000 * 1e8
  assert.equal(market.electricityKwhPriceUsd, 0.05); // 0.0012 * 1000 / 24
  assert.equal(market.serviceUsdPerThDay, 0.0089);
  assert.equal(market.averageRewardUsdPerThDay365, 0.04);
  assert.throws(() => normalizeIncome({ ...income, btcCourseInUsd: 0 }), /missing expected fields/);
});

test('normalizePresets keeps the cheapest row per size, drops unusable rows and sorts', () => {
  const rows = normalizePresets(presets);
  assert.deepEqual(rows.map((row) => [row.efficiencyWth, row.powerTh, row.priceUsd]), [[12, 1, 18.99], [12, 16, 297.99], [15, 16, 249.99]]);
  assert.equal(findListedPrice(rows, 16, 15), 249.99);
  assert.equal(findListedPrice(rows, 3, 15), null);
});

test('normalizeUpgradeRates sorts both tables by level', () => {
  const rates = normalizeUpgradeRates(upgradeRates);
  assert.deepEqual(rates.valuationSteps.map((step) => step.toLevelWth), [12, 13]);
  assert.equal(rates.efficiencyUpgradeSteps[0].priceUsdPerTh, 1.1);
});

test('dailyBreakdownPerTh splits the payout and efficiencyCurve finds break-even', () => {
  const split = dailyBreakdownPerTh(market, 15);
  assert.equal(split.electricityUsd, 0.018);
  assert.equal(split.netUsd, 0.0131); // 0.04 - 0.018 - 0.0089
  const curve = efficiencyCurve(market);
  assert.deepEqual(curve.rows.map((row) => row.efficiencyWth), [12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(curve.breakEvenEfficiencyWth, 25.92); // (0.04 - 0.0089) / 0.0012
  assert.ok(curve.rows[0].netUsd > curve.rows.at(-1).netUsd);
});

test('calculateEarnings subtracts electricity and service and estimates payback', () => {
  const result = calculateEarnings(market, { powerTh: 16, efficiencyWth: 15, days: 30, priceUsd: 249.99 });
  assert.equal(result.perDay.grossUsd, 0.64);
  assert.equal(result.perDay.electricityUsd, 0.288);
  assert.equal(result.perDay.serviceUsd, 0.1424);
  assert.equal(result.perDay.netUsd, 0.2096);
  assert.equal(result.perDay.netSats, 262);
  assert.equal(result.period.netUsd, 6.288);
  assert.equal(result.payback.days, 1193);
  assert.equal(calculateEarnings(market, { powerTh: 1, efficiencyWth: 30, priceUsd: 10 }).payback.days, null);
  assert.throws(() => calculateEarnings(market, { powerTh: 0, efficiencyWth: 15 }), /powerTh/);
});

test('client refuses paths that would leave the API host', () => {
  const client = new GoMiningClient({ token: 't', fetchImpl: async () => { throw new Error('should not fetch'); } });
  for (const path of ['https://evil.example/x', '//evil.example/x', '/../x', 'nft']) {
    assert.throws(() => client.resolve(path), /Path must be|Refusing/);
  }
  assert.equal(client.resolve('/nft/get-upgrade-rate').toString(), 'https://api.gomining.com/api/nft/get-upgrade-rate');
});

async function service(routes, now = () => Date.parse('2026-09-09T12:00:00Z')) {
  const dir = await mkdtemp(join(tmpdir(), 'gomining-hub-'));
  const api = fakeFetch(routes);
  const historyPath = join(dir, 'history.json');
  return { api, historyPath, market: new MarketService({ client: new GoMiningClient({ fetchImpl: api.fetchImpl }), historyPath, now }) };
}

test('market service returns live data, caches it and records history by payout date', async () => {
  const { api, market: svc, historyPath } = await service();
  const data = await svc.get();
  assert.equal(data.source, 'live');
  assert.equal(data.income.rewardSatsPerThDay, 50);
  assert.equal(data.presets.length, 3);
  await svc.get();
  assert.equal(api.calls.length, 3, 'second call is served from cache');
  await svc.get({ fresh: true });
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  assert.equal(history.length, 1, 'refetching the same payout day updates it in place');
  assert.equal(history[0].date, '2026-09-09');
});

test('market service falls back to the sample snapshot per part and says so', async () => {
  const { market: svc, historyPath } = await service({ 'POST /api/nft-income-aggregation/get-last': () => new Response('{}', { status: 503 }) });
  const data = await svc.get();
  assert.equal(data.source, 'sample');
  assert.equal(data.sources.income, 'sample');
  assert.equal(data.sources.presets, 'live');
  assert.match(data.errors.income, /HTTP 503/);
  assert.ok(data.sampleCapturedAt);
  assert.ok(data.income.btcPriceUsd > 0);
  assert.deepEqual(await svc.history(), [], 'sample payouts are never recorded as history');
  await assert.rejects(readFile(historyPath));
});
