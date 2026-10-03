import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateEarnings, findListedPrice, normalizeIncome, normalizePresets, normalizeUpgradeRates } from '../src/calc.js';
import { income, presets, upgradeRates } from './fake-api.js';

test('normalizeIncome derives sats, kWh price and the 365-day average', () => {
  const market = normalizeIncome(income);
  assert.equal(market.rewardSatsPerThDay, 50); // 0.04 / 80000 * 1e8
  assert.equal(market.electricityKwhPriceUsd, 0.05); // 0.0012 * 1000 / 24
  assert.equal(market.serviceUsdPerThDay, 0.0089);
  assert.equal(market.averageRewardUsdPerThDay365, 0.04);
});

test('normalizeIncome rejects a malformed payout', () => {
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

test('calculateEarnings subtracts electricity and service from the gross payout', () => {
  const result = calculateEarnings(normalizeIncome(income), { powerTh: 16, efficiencyWth: 15, days: 30, priceUsd: 249.99 });
  // gross 0.64, electricity 0.0012*15*16 = 0.288, service 0.0089*16 = 0.1424, net 0.2096
  assert.equal(result.perDay.grossUsd, 0.64);
  assert.equal(result.perDay.electricityUsd, 0.288);
  assert.equal(result.perDay.serviceUsd, 0.1424);
  assert.equal(result.perDay.netUsd, 0.2096);
  assert.equal(result.perDay.netSats, 262);
  assert.equal(result.period.netUsd, 6.288);
  assert.equal(result.payback.days, 1193);
});

test('calculateEarnings reports no payback when fees exceed the payout', () => {
  const result = calculateEarnings(normalizeIncome(income), { powerTh: 1, efficiencyWth: 30, priceUsd: 10 });
  assert.ok(result.perDay.netUsd < 0);
  assert.equal(result.payback.days, null);
});

test('calculateEarnings validates its inputs', () => {
  assert.throws(() => calculateEarnings(normalizeIncome(income), { powerTh: 0, efficiencyWth: 15 }), /powerTh/);
});
