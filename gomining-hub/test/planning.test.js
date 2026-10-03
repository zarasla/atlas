// The planning and token maths, checked against GoMining's published formulas.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VE_MAX_LOCK_DAYS, breakEvenMatrix, clanFinder, expectedMultiplier, normalizeIncome, normalizeUpgradeRates, pointsPerSecond, simpleEarnVsMining, upgradeComparison, veLock } from '../src/core/calc.js';
import { income } from './fake-api.js';

// 0.04 USD at 80,000 USD/BTC = 50 sats per TH; electricity 0.0012 per W/TH, service 0.0089.
const market = normalizeIncome(income);

test('profit matrix: sats per TH stay, their USD value follows the BTC price, fees stay in USD', () => {
  const m = breakEvenMatrix(market, { btcPrices: [160000, 40000, 80000, 80000] });
  assert.deepEqual(m.btcPrices, [40000, 80000, 160000], 'sorted, duplicates dropped');
  const at15 = m.rows.find((r) => r.efficiencyWth === 15);
  // 0.0000005 BTC x price - (0.018 + 0.0089)
  assert.deepEqual(at15.netUsdPerThDay, [-0.0069, 0.0131, 0.0531]);
  assert.equal(at15.breakEvenBtcUsd, 53800);
  assert.throws(() => breakEvenMatrix(market, { btcPrices: [] }), /at least one/);
});

test('efficiency or power: cumulative W/TH step prices against more TH at a price per TH', () => {
  const upgrades = normalizeUpgradeRates({ energyEfficiencyUpgradePriceConfig: [{ toLevel: 17, priceUsd: 1 }, { toLevel: 16, priceUsd: 1.2 }, { toLevel: 15, priceUsd: 1.5 }] });
  const r = upgradeComparison(market, upgrades, { powerTh: 100, efficiencyWth: 18, budgetUsd: 250, powerPricePerThUsd: 15 });
  assert.deepEqual(r.efficiency.map((row) => [row.toWth, row.costUsd, row.gainUsdDay, row.affordable]), [[17, 100, 0.12, true], [16, 220, 0.24, true], [15, 370, 0.36, false]]);
  assert.equal(r.bestEfficiency.toWth, 16);
  // 250 / 15 = 16.667 TH at (0.04 - 0.0216 - 0.0089) = 0.0095 a day each
  assert.equal(r.power.addedTh, 16.667);
  assert.equal(r.power.gainUsdDay, 0.1583);
  // 0.24 / 220 per dollar beats 0.1583 / 250
  assert.equal(r.verdict, 'efficiency');
  // A maintenance discount shrinks what a lower W/TH saves.
  assert.equal(upgradeComparison(market, upgrades, { powerTh: 100, efficiencyWth: 18, budgetUsd: 250, discountPct: 20 }).efficiency[0].gainUsdDay, 0.096);
});

test('Simple Earn or mining for the same money', () => {
  const r = simpleEarnVsMining(market, { capitalUsd: 1000, aprPct: 10, vipLevel: 'Silver I', efficiencyWth: 15, pricePerThUsd: 15 });
  assert.equal(r.simpleEarn.aprPct, 11);
  assert.equal(r.simpleEarn.yearUsd, 110);
  // 66.667 TH x 0.0131 x 365
  assert.equal(r.mining.yearUsd, 318.77);
  assert.equal(r.better, 'mining');
  assert.throws(() => simpleEarnVsMining(market, { capitalUsd: 1000, efficiencyWth: 15, pricePerThUsd: 15 }), /APR/);
});

test('veGOMINING: votes = tokens x days / 1461, matching GoMining\'s own lock statistics', () => {
  // GoMining's statistics (4 Oct 2026): 97,923,458 locked, 43,497,250 votes, average lock 648.97 days.
  assert.ok(Math.abs((97_923_458 * 648.97) / VE_MAX_LOCK_DAYS - 43_497_250) / 43_497_250 < 0.001);
  const full = veLock({ amount: 10000, lockDays: 1461, yearlyIncomePerVote: 0.23, gominingUsd: 0.4 });
  assert.equal(full.votes, 10000);
  assert.equal(full.vipLevel, 'Platinum II');
  // Votes fall in a straight line, so rewards are half the starting votes x rate x years.
  assert.equal(full.rewardsTotal, 4603.15); // 5,000 x 0.23 x 1461 / 365
  assert.equal(full.rewardsTotalUsd, 1841.26);
  const year = veLock({ amount: 10000, lockDays: 365, yearlyIncomePerVote: 0.23 });
  assert.equal(year.votes, 2498.29);
  assert.equal(year.vipLevel, 'Gold II');
  // Gold II needs 2,000 votes: held until the votes fall below it.
  assert.equal(year.vipHoldsDays, 72);
  assert.equal(year.schedule.at(-1).votes, 0);
  assert.equal(veLock({ amount: 100, lockDays: 1 }).lockDays, 7, 'a lock is at least a week');
  assert.equal(veLock({ amount: 100, lockDays: 9999 }).lockDays, 1461, 'and at most four years');
  assert.equal(veLock({ amount: 100, lockDays: 365 }).rewardsTotal, null, 'no rate, no reward estimate');
});

test('Miner Wars points and multipliers', () => {
  assert.equal(pointsPerSecond(1, 15), 1.3333); // GoMining's own example: 1 TH at 15 W/TH
  assert.equal(pointsPerSecond(0, 15), 0);
  assert.equal(expectedMultiplier([{ p: 0.5, v: 1 }, { p: 0.25, v: 2 }, { p: 0.25, v: 4 }]), 2);
  assert.equal(expectedMultiplier([]), null);
});

test('clan finder: the clan keeps its pace, your TH adds its own fair share, BTC split by TH', () => {
  const league = { btcPerBlock: 0.001, totalPowerTh: 100000, totalBlocks: 700, avgEfficiencyWth: 18, avgDiscountPct: 5 };
  const board = [
    { clanId: 1, name: 'Big', position: 1, blocks: 350, powerTh: 50000, zone: 'promotion' },
    { clanId: 2, name: 'Spells', position: 2, blocks: 70, powerTh: 500, zone: 'safe' },
    { clanId: 3, name: 'Empty', position: 3, blocks: 0, powerTh: 0, zone: 'safe' },
  ];
  const r = clanFinder(market, { board, league, elapsedDays: 7, powerTh: 1000, efficiencyWth: 15 });
  assert.equal(r.rows.length, 2, 'clans without power are skipped');
  // Your fair share of the league's 700 blocks: 700 x 1000 / 101000
  assert.equal(r.yourBlocksWeek, 6.93);
  const spells = r.rows.find((row) => row.clanId === 2);
  assert.equal(spells.blocksWeek, 76.9);
  assert.equal(spells.blocksVsPower, 20, '10% of blocks on 0.5% of power');
  assert.equal(r.rows.find((row) => row.clanId === 1).blocksVsPower, 1);
  assert.ok(r.rows[0].netBtc >= r.rows[1].netBtc);
  assert.deepEqual(clanFinder(market, { board, league, elapsedDays: 0.1, powerTh: 1, efficiencyWth: 15 }).rows, []);
});
