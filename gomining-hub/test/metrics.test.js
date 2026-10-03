import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashprice, marketSummary, minerRoi, normalizeIncome, normalizePresets, normalizeUpgradeRates, payoutVsAverage, upgradeAdvisor } from '../src/core/calc.js';
import { GoMiningClient } from '../src/core/client.js';
import { ExternalService } from '../src/core/external.js';
import { MarketService } from '../src/core/market.js';
import { fakeFetch, income, presets, upgradeRates } from './fake-api.js';

const market = normalizeIncome(income);

test('hashprice and payout versus the 365-day average', () => {
  assert.deepEqual(hashprice(market), { usdPerPhDay: 40, satsPerPhDay: 50000 });
  assert.equal(payoutVsAverage(market), 0);
  assert.equal(payoutVsAverage({ ...market, rewardUsdPerThDay: 0.044 }), 10);
  assert.equal(payoutVsAverage({ ...market, averageRewardUsdPerThDay365: null }), null);
});

test('minerRoi gives daily net, payback and annual return for every listed miner', () => {
  const rows = minerRoi(market, normalizePresets(presets));
  const m = rows.find((r) => r.powerTh === 16 && r.efficiencyWth === 15);
  assert.equal(m.netUsdDay, 0.2096); // (0.04 - 0.018 - 0.0089) * 16
  assert.equal(m.paybackDays, 1193);
  assert.equal(m.annualReturnPct, 30.6);
});

test('upgradeAdvisor compares step cost with daily electricity saved', () => {
  const [step] = upgradeAdvisor(market, normalizeUpgradeRates(upgradeRates));
  assert.deepEqual(step, { fromWth: 13, toWth: 12, costUsdPerTh: 1.1, savingUsdPerThDay: 0.0012, paybackDays: 917 });
});

test('marketSummary picks the fastest payback miner', () => {
  const summary = marketSummary({ income: market, presets: normalizePresets(presets), upgrades: normalizeUpgradeRates(upgradeRates) });
  assert.equal(summary.fastestPayback.paybackDays, Math.min(...summary.minerRoi.map((r) => r.paybackDays)));
  assert.equal(summary.curve.rows.length, 9);
});

test('external service parses network stats and prices', async () => {
  const data = await new ExternalService({ fetchImpl: fakeFetch().fetchImpl }).get();
  assert.deepEqual(data.errors, {});
  assert.equal(data.network.hashrateEhs, 812.4);
  assert.equal(data.network.difficultyT, 112.3);
  assert.equal(data.network.blockHeight, 915000);
  assert.equal(data.network.nextAdjustment.estimatedChangePct, 1.8);
  assert.equal(data.network.nextAdjustment.avgBlockMinutes, 9.8);
  assert.equal(data.network.feesSatVb.fastest, 6);
  assert.equal(data.prices.btc.usd, 80500);
  assert.equal(data.prices.gomining.change24hPct, -2.5);
});

test('a down provider only blanks its own part', async () => {
  const api = fakeFetch({ 'GET /api/v3/simple/price': () => new Response('{}', { status: 429 }) });
  const data = await new ExternalService({ fetchImpl: api.fetchImpl }).get();
  assert.equal(data.prices, null);
  assert.match(data.errors.prices, /HTTP 429/);
  assert.ok(data.network);
});

test('market service merges external data and records it in history', async () => {
  const api = fakeFetch();
  const svc = new MarketService({
    client: new GoMiningClient({ fetchImpl: api.fetchImpl }),
    external: new ExternalService({ fetchImpl: api.fetchImpl }),
    historyPath: join(await mkdtemp(join(tmpdir(), 'gomining-metrics-')), 'history.json'),
  });
  const data = await svc.get();
  assert.equal(data.sources.network, 'live');
  assert.equal(data.sources.prices, 'live');
  const [row] = await svc.history();
  assert.equal(row.hashrateEhs, 812.4);
  assert.equal(row.gominingUsd, 0.42);
  assert.equal(row.hashpriceUsdPerPhDay, 40);
});

test('without external providers those parts are marked unavailable', async () => {
  const api = fakeFetch();
  const svc = new MarketService({ client: new GoMiningClient({ fetchImpl: api.fetchImpl }), historyPath: join(await mkdtemp(join(tmpdir(), 'gomining-noext-')), 'h.json') });
  const data = await svc.get();
  assert.equal(data.network, null);
  assert.equal(data.sources.prices, 'unavailable');
});

test('rewardsBreakdown covers every period and applies the maintenance discount', async () => {
  const { rewardsBreakdown, investmentPlan, listedPricePerTh } = await import('../src/core/calc.js');
  const plain = rewardsBreakdown(market, { powerTh: 16, efficiencyWth: 15, gominingUsd: 0.4 });
  assert.equal(plain.periods.day.netUsd, 0.2096);
  assert.equal(plain.periods.week.netUsd, 1.4672);
  assert.equal(plain.periods.year.netUsd, 76.504);
  assert.equal(plain.periods.day.netGomining, 0.52);
  // 20% off maintenance: (0.288 + 0.1424) * 0.2 = 0.08608 more per day
  const disc = rewardsBreakdown(market, { powerTh: 16, efficiencyWth: 15, discountPct: 20, priceUsd: 249.99 });
  assert.equal(disc.periods.day.discountUsd, 0.0861);
  assert.equal(disc.periods.day.netUsd, 0.2957);
  assert.equal(disc.payback.days, 846);
  assert.equal(rewardsBreakdown(market, { powerTh: 1, efficiencyWth: 15, discountPct: 500 }).input.discountPct, 100);

  assert.equal(listedPricePerTh(normalizePresets(presets), 12), 18.99);
  assert.equal(listedPricePerTh(normalizePresets(presets), 15), 15.6244);
  assert.equal(listedPricePerTh(normalizePresets(presets), 13), null);

  const plan = investmentPlan(market, { startTh: 10, efficiencyWth: 15, monthlyUsd: 100, months: 12, pricePerThUsd: 20 });
  assert.equal(plan.rows.length, 12);
  assert.equal(plan.summary.finalTh, 70);        // 10 + 12 × 5
  assert.equal(plan.summary.investedUsd, 1400);  // 200 + 12 × 100
  assert.equal(plan.summary.reinvestedUsd, 0);
  const compounding = investmentPlan(market, { startTh: 10, efficiencyWth: 15, monthlyUsd: 100, months: 12, pricePerThUsd: 20, reinvest: true });
  assert.ok(compounding.summary.finalTh > 70);
  assert.ok(compounding.summary.reinvestedUsd > 0);
  const payoff = investmentPlan(market, { startTh: 10, efficiencyWth: 12, monthlyUsd: 0, months: 120, pricePerThUsd: 5 });
  assert.ok(payoff.summary.breakEvenMonth > 0);
});
