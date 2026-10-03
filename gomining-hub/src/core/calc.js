// Turns GoMining's raw market responses into the numbers the dashboard and Claude show.
//
// Income aggregation fields (USD per day):
//   totalIncomePerThToday   gross pool payout per TH
//   totalIncomePerTh        gross payout per TH over the last 365 days (sometimes missing)
//   c1ValuePerThPerWtToday  electricity per TH per W/TH (kWh price * 24 / 1000)
//   c2/c3/c4ValuePerThToday service fee components per TH

export const SATS_PER_BTC = 100_000_000;
// W/TH levels GoMining sells or still upgrades from.
export const EFFICIENCY_RANGE = { min: 12, max: 20 };

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits) => Number(value.toFixed(digits));
const toSats = (usd, btcPriceUsd) => (usd / btcPriceUsd) * SATS_PER_BTC;

export function normalizeIncome(income) {
  if (!income || typeof income.createdAt !== 'string' || !(income.btcCourseInUsd > 0) || !isNumber(income.totalIncomePerThToday) || !isNumber(income.c1ValuePerThPerWtToday) || !isNumber(income.c2ValuePerThToday)) {
    throw new Error('GoMining income aggregation is missing expected fields');
  }
  const btcPriceUsd = income.btcCourseInUsd;
  const rewardUsdPerThDay = income.totalIncomePerThToday;
  const serviceUsdPerThDay = income.c2ValuePerThToday + (income.c3ValuePerThToday ?? 0) + (income.c4ValuePerThToday ?? 0);
  return {
    payoutDate: income.createdAt,
    btcPriceUsd,
    rewardUsdPerThDay,
    rewardSatsPerThDay: round(toSats(rewardUsdPerThDay, btcPriceUsd), 2),
    averageRewardUsdPerThDay365: isNumber(income.totalIncomePerTh) ? round(income.totalIncomePerTh / 365, 6) : null,
    electricityUsdPerThPerWthDay: income.c1ValuePerThPerWtToday,
    electricityKwhPriceUsd: round((income.c1ValuePerThPerWtToday * 1000) / 24, 6),
    serviceUsdPerThDay: round(serviceUsdPerThDay, 6),
  };
}

// One row per miner GoMining sells, cheapest per (efficiency, power), best efficiency first.
export function normalizePresets(presets) {
  const best = new Map();
  for (const row of presets ?? []) {
    if (!(row?.power > 0) || !(row?.energyEfficiency > 0) || !(row?.priceUsdt > 0)) continue;
    const key = `${row.energyEfficiency}:${row.power}`;
    const current = best.get(key);
    if (!current || row.priceUsdt < current.priceUsd) {
      best.set(key, { powerTh: row.power, efficiencyWth: row.energyEfficiency, priceUsd: row.priceUsdt, priceUsdPerTh: round(row.priceUsdt / row.power, 4) });
    }
  }
  return [...best.values()].sort((a, b) => a.efficiencyWth - b.efficiencyWth || a.powerTh - b.powerTh);
}

export function normalizeUpgradeRates(rates) {
  const steps = (list) => (Array.isArray(list) ? list : [])
    .filter((row) => Number.isInteger(row?.toLevel) && isNumber(row?.priceUsd))
    .map((row) => ({ toLevelWth: row.toLevel, priceUsdPerTh: row.priceUsd }))
    .sort((a, b) => a.toLevelWth - b.toLevelWth);
  return {
    // What a TH is worth at each W/TH level; GoMining uses it to price miners at other efficiencies.
    valuationSteps: steps(rates?.powerUpgradePriceConfig),
    // What an owner pays per TH to improve a miner by one W/TH, to the given level.
    efficiencyUpgradeSteps: steps(rates?.energyEfficiencyUpgradePriceConfig),
  };
}

// Per-TH daily split of the gross payout into electricity, service and what is left for the owner.
export function dailyBreakdownPerTh(market, efficiencyWth) {
  const electricityUsd = market.electricityUsdPerThPerWthDay * efficiencyWth;
  const netUsd = market.rewardUsdPerThDay - electricityUsd - market.serviceUsdPerThDay;
  return {
    efficiencyWth,
    grossUsd: round(market.rewardUsdPerThDay, 6),
    electricityUsd: round(electricityUsd, 6),
    serviceUsd: round(market.serviceUsdPerThDay, 6),
    netUsd: round(netUsd, 6),
    netSats: round(toSats(netUsd, market.btcPriceUsd), 2),
  };
}

// Net reward per TH per day at every efficiency in range: shows where a miner stops paying.
export function efficiencyCurve(market, { min = EFFICIENCY_RANGE.min, max = EFFICIENCY_RANGE.max } = {}) {
  const rows = [];
  for (let level = min; level <= max; level++) rows.push(dailyBreakdownPerTh(market, level));
  const breakEven = (market.rewardUsdPerThDay - market.serviceUsdPerThDay) / market.electricityUsdPerThPerWthDay;
  return { rows, breakEvenEfficiencyWth: round(breakEven, 2) };
}

// Daily and period earnings for a miner of `powerTh` at `efficiencyWth`, at today's payout and fees.
// `priceUsd` enables the payback estimate. Discounts (paying fees in GOMINING, VIP level, clan
// boosts) are not modelled, so the net figure is a conservative baseline.
export function calculateEarnings(market, { powerTh, efficiencyWth, days = 30, priceUsd, useAverageReward = false }) {
  if (!(powerTh > 0)) throw new Error('powerTh must be greater than 0');
  if (!(efficiencyWth > 0)) throw new Error('efficiencyWth must be greater than 0');
  if (!(days > 0)) throw new Error('days must be greater than 0');

  const averageAvailable = useAverageReward && market.averageRewardUsdPerThDay365 !== null;
  const rewardPerTh = averageAvailable ? market.averageRewardUsdPerThDay365 : market.rewardUsdPerThDay;
  const grossUsd = rewardPerTh * powerTh;
  const electricityUsd = market.electricityUsdPerThPerWthDay * efficiencyWth * powerTh;
  const serviceUsd = market.serviceUsdPerThDay * powerTh;
  const netUsd = grossUsd - electricityUsd - serviceUsd;
  const sats = (usd) => Math.round(toSats(usd, market.btcPriceUsd));

  let payback = null;
  if (priceUsd > 0) {
    const annualReturnPct = round(((netUsd * 365) / priceUsd) * 100, 2);
    payback = netUsd > 0
      ? { priceUsd, days: Math.ceil(priceUsd / netUsd), annualReturnPct }
      : { priceUsd, days: null, annualReturnPct, note: 'Net reward is zero or negative at this efficiency, so it never pays back at current rates' };
  }

  return {
    input: { powerTh, efficiencyWth, rewardBasis: averageAvailable ? '365-day average' : 'today' },
    market: { payoutDate: market.payoutDate, btcPriceUsd: market.btcPriceUsd, rewardUsdPerThDay: rewardPerTh },
    perDay: {
      grossUsd: round(grossUsd, 6),
      electricityUsd: round(electricityUsd, 6),
      serviceUsd: round(serviceUsd, 6),
      netUsd: round(netUsd, 6),
      netSats: sats(netUsd),
    },
    period: {
      days,
      grossUsd: round(grossUsd * days, 4),
      feesUsd: round((electricityUsd + serviceUsd) * days, 4),
      netUsd: round(netUsd * days, 4),
      netSats: sats(netUsd * days),
      netBtc: round((netUsd * days) / market.btcPriceUsd, 8),
    },
    payback,
    assumptions: 'Rates held constant at the latest GoMining payout. Fee discounts (GOMINING token, VIP, clan/league boosts) and BTC price or difficulty changes are not included.',
  };
}

// Listed price for an exact (power, efficiency) GoMining sells, or null.
export function findListedPrice(presets, powerTh, efficiencyWth) {
  return presets.find((row) => row.powerTh === powerTh && row.efficiencyWth === efficiencyWth)?.priceUsd ?? null;
}

// Hashprice: what one PH/s earns per day, the industry's standard yardstick for mining revenue.
export function hashprice(market) {
  return {
    usdPerPhDay: round(market.rewardUsdPerThDay * 1000, 4),
    satsPerPhDay: Math.round(toSats(market.rewardUsdPerThDay * 1000, market.btcPriceUsd)),
  };
}

// Today's payout per TH against the 365-day average, in percent (null when GoMining omits the average).
export function payoutVsAverage(market) {
  const average = market.averageRewardUsdPerThDay365;
  return average ? round((market.rewardUsdPerThDay / average - 1) * 100, 2) : null;
}

// Every miner GoMining sells, with its daily net, payback and annual return at today's rates.
export function minerRoi(market, presets) {
  return presets.map((miner) => {
    const perTh = dailyBreakdownPerTh(market, miner.efficiencyWth);
    const netUsdDay = perTh.netUsd * miner.powerTh;
    return {
      ...miner,
      netUsdDay: round(netUsdDay, 4),
      netSatsDay: Math.round(toSats(netUsdDay, market.btcPriceUsd)),
      paybackDays: netUsdDay > 0 ? Math.ceil(miner.priceUsd / netUsdDay) : null,
      annualReturnPct: round(((netUsdDay * 365) / miner.priceUsd) * 100, 2),
    };
  });
}

// Is it worth upgrading efficiency? Each W/TH less saves one W/TH of electricity per TH per day;
// compare that with what GoMining charges per TH for the step.
export function upgradeAdvisor(market, upgrades, { discountPct = 0, kwhPriceUsd } = {}) {
  // A maintenance discount also discounts electricity, so a lower W/TH saves less than list.
  const discount = Math.min(Math.max(Number(discountPct) || 0, 0), 100) / 100;
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const savingUsdPerThDay = electricity * (1 - discount);
  return upgrades.efficiencyUpgradeSteps
    .filter((step) => step.toLevelWth >= EFFICIENCY_RANGE.min && step.toLevelWth < EFFICIENCY_RANGE.max)
    .map((step) => ({
      fromWth: step.toLevelWth + 1,
      toWth: step.toLevelWth,
      costUsdPerTh: step.priceUsdPerTh,
      savingUsdPerThDay: round(savingUsdPerThDay, 6),
      paybackDays: savingUsdPerThDay > 0 ? Math.ceil(step.priceUsdPerTh / savingUsdPerThDay) : null,
    }));
}

// Everything derived from one market reading, shared by the dashboard API and the MCP tools.
export function marketSummary(data) {
  const income = data.income;
  const roi = minerRoi(income, data.presets);
  const best = roi.filter((row) => row.paybackDays).sort((a, b) => a.paybackDays - b.paybackDays)[0] ?? null;
  return {
    hashprice: hashprice(income),
    payoutVsAveragePct: payoutVsAverage(income),
    curve: efficiencyCurve(income),
    minerRoi: roi,
    fastestPayback: best,
    upgradeAdvisor: upgradeAdvisor(income, data.upgrades),
    outlook: {
      breakEven: breakEvenBtcPrice(income),
      difficulty: difficultyImpact(income, data.network?.nextAdjustment),
      halving: data.network ? halving(data.network.blockHeight, { avgBlockMinutes: data.network.nextAdjustment?.avgBlockMinutes, satsPerThDay: income.rewardSatsPerThDay }) : null,
      sentiment: data.sentiment ?? null,
    },
  };
}

export const DAYS_PER_MONTH = 30.4375;
const PERIODS = [['day', 1], ['week', 7], ['month', DAYS_PER_MONTH], ['year', 365]];

// Rewards for a miner over a day, week, month and year. `discountPct` is the owner's maintenance
// discount (VIP level, paying fees in GOMINING), applied to electricity and service together.
// `gominingUsd` (optional) adds the net in GOMINING tokens.
// `kwhPriceUsd` optionally replaces GoMining's published electricity rate.
export function rewardsBreakdown(market, { powerTh, efficiencyWth, discountPct = 0, priceUsd, gominingUsd, useAverageReward = false, kwhPriceUsd }) {
  if (!(powerTh > 0)) throw new Error('powerTh must be greater than 0');
  if (!(efficiencyWth > 0)) throw new Error('efficiencyWth must be greater than 0');
  const discount = Math.min(Math.max(Number(discountPct) || 0, 0), 100) / 100;
  const rewardPerTh = useAverageReward && market.averageRewardUsdPerThDay365 !== null ? market.averageRewardUsdPerThDay365 : market.rewardUsdPerThDay;
  const grossUsd = rewardPerTh * powerTh;
  const electricityPerThPerWth = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const electricityUsd = electricityPerThPerWth * efficiencyWth * powerTh;
  const serviceUsd = market.serviceUsdPerThDay * powerTh;
  const discountUsd = (electricityUsd + serviceUsd) * discount;
  const netUsd = grossUsd - electricityUsd - serviceUsd + discountUsd;
  const periods = {};
  for (const [name, days] of PERIODS) {
    periods[name] = {
      grossUsd: round(grossUsd * days, 4),
      electricityUsd: round(electricityUsd * days, 4),
      serviceUsd: round(serviceUsd * days, 4),
      discountUsd: round(discountUsd * days, 4),
      netUsd: round(netUsd * days, 4),
      netBtc: round((netUsd * days) / market.btcPriceUsd, 8),
      netSats: Math.round(toSats(netUsd * days, market.btcPriceUsd)),
      netGomining: gominingUsd > 0 ? round((netUsd * days) / gominingUsd, 2) : null,
      // What maintenance costs after the discount, and the same in GOMINING tokens if paid that way.
      feesUsd: round((electricityUsd + serviceUsd - discountUsd) * days, 4),
      feesGomining: gominingUsd > 0 ? round(((electricityUsd + serviceUsd - discountUsd) * days) / gominingUsd, 2) : null,
    };
  }
  const payback = priceUsd > 0 ? {
    priceUsd,
    days: netUsd > 0 ? Math.ceil(priceUsd / netUsd) : null,
    annualReturnPct: round(((netUsd * 365) / priceUsd) * 100, 2),
  } : null;
  return {
    input: { powerTh, efficiencyWth, discountPct: discount * 100, kwhPriceUsd: round((electricityPerThPerWth * 1000) / 24, 6), rewardBasis: rewardPerTh === market.rewardUsdPerThDay ? 'today' : '365-day average' },
    periods,
    payback,
  };
}

// Listed price per TH for an efficiency: the 1 TH miner if GoMining sells one, else the cheapest per TH.
export function listedPricePerTh(presets, efficiencyWth) {
  const rows = presets.filter((row) => row.efficiencyWth === efficiencyWth);
  if (!rows.length) return null;
  return rows.find((row) => row.powerTh === 1)?.priceUsdPerTh ?? Math.min(...rows.map((row) => row.priceUsdPerTh));
}

// Month-by-month simulation of buying hashrate at a fixed price per TH, at today's rates.
// With `reinvest`, each month's net reward also buys TH. Returns monthly rows and a summary.
// `reinvestPricePerThUsd` is what reinvested rewards pay per TH (e.g. GoMining's power-upgrade price,
// defaults to pricePerThUsd) and `reinvestBonusPct` adds bonus TH on reinvestment (e.g. a VIP bonus).
// GoMining's eligibility rules and minimums for reinvesting are not modelled.
export function investmentPlan(market, {
  startTh = 0, efficiencyWth, monthlyUsd = 0, months = 12, pricePerThUsd, reinvest = false, discountPct = 0,
  reinvestPricePerThUsd, reinvestBonusPct = 0, kwhPriceUsd, useAverageReward = false,
}) {
  if (!(efficiencyWth > 0)) throw new Error('efficiencyWth must be greater than 0');
  if (!(pricePerThUsd > 0)) throw new Error('pricePerThUsd must be greater than 0');
  const span = Math.min(Math.max(Math.round(months), 1), 120);
  const reinvestPrice = reinvestPricePerThUsd > 0 ? reinvestPricePerThUsd : pricePerThUsd;
  const bonus = 1 + Math.min(Math.max(Number(reinvestBonusPct) || 0, 0), 100) / 100;
  const perThMonth = rewardsBreakdown(market, { powerTh: 1, efficiencyWth, discountPct, kwhPriceUsd, useAverageReward }).periods.month.netUsd;
  let th = Math.max(Number(startTh) || 0, 0);
  let invested = th * pricePerThUsd;
  let earnedUsd = 0;
  let reinvestedUsd = 0;
  let breakEvenMonth = null;
  const rows = [];
  for (let month = 1; month <= span; month++) {
    th += monthlyUsd / pricePerThUsd;
    invested += monthlyUsd;
    const netUsd = th * perThMonth;
    earnedUsd += netUsd;
    if (reinvest && netUsd > 0) {
      th += (netUsd / reinvestPrice) * bonus;
      reinvestedUsd += netUsd;
    }
    if (breakEvenMonth === null && invested > 0 && earnedUsd >= invested) breakEvenMonth = month;
    rows.push({ month, th: round(th, 3), investedUsd: round(invested, 2), netUsdMonth: round(netUsd, 2), earnedUsd: round(earnedUsd, 2) });
  }
  const last = rows.at(-1);
  return {
    rows,
    summary: {
      finalTh: last.th,
      investedUsd: last.investedUsd,
      earnedUsd: last.earnedUsd,
      earnedBtc: round(earnedUsd / market.btcPriceUsd, 8),
      reinvestedUsd: round(reinvestedUsd, 2),
      monthlyIncomeUsdAtEnd: round(last.th * perThMonth, 2),
      breakEvenMonth,
    },
  };
}

// A member's own miners (entered by them, never fetched): per-miner net and the next W/TH upgrade,
// plus totals. The discount reduces electricity + service, so it also shrinks what an upgrade saves.
export function portfolio(market, miners, { discountPct = 0, upgrades } = {}) {
  const discount = Math.min(Math.max(Number(discountPct) || 0, 0), 100) / 100;
  const stepCost = (toLevel) => upgrades?.efficiencyUpgradeSteps?.find((step) => step.toLevelWth === toLevel)?.priceUsdPerTh ?? null;
  const rows = miners
    .filter((miner) => miner.powerTh > 0 && miner.efficiencyWth > 0)
    .map((miner) => {
      const daily = rewardsBreakdown(market, { powerTh: miner.powerTh, efficiencyWth: miner.efficiencyWth, discountPct: discount * 100 }).periods.day;
      const target = Math.ceil(miner.efficiencyWth) - 1;
      const costPerTh = target >= EFFICIENCY_RANGE.min ? stepCost(target) : null;
      const savingUsdDay = market.electricityUsdPerThPerWthDay * (miner.efficiencyWth - target) * miner.powerTh * (1 - discount);
      const upgrade = costPerTh === null ? null : {
        toWth: target,
        costUsd: round(costPerTh * miner.powerTh, 2),
        savingUsdDay: round(savingUsdDay, 4),
        paybackDays: savingUsdDay > 0 ? Math.ceil((costPerTh * miner.powerTh) / savingUsdDay) : null,
      };
      return { ...miner, netUsdDay: daily.netUsd, netSatsDay: daily.netSats, netUsdMonth: round(daily.netUsd * DAYS_PER_MONTH, 2), upgrade };
    });
  const totalTh = rows.reduce((sum, row) => sum + row.powerTh, 0);
  const netUsdDay = rows.reduce((sum, row) => sum + row.netUsdDay, 0);
  return {
    rows,
    totals: {
      miners: rows.length,
      powerTh: round(totalTh, 3),
      avgEfficiencyWth: totalTh ? round(rows.reduce((sum, row) => sum + row.efficiencyWth * row.powerTh, 0) / totalTh, 2) : null,
      netUsdDay: round(netUsdDay, 4),
      netSatsDay: Math.round(toSats(netUsdDay, market.btcPriceUsd)),
      netUsdMonth: round(netUsdDay * DAYS_PER_MONTH, 2),
      netBtcMonth: round((netUsdDay * DAYS_PER_MONTH) / market.btcPriceUsd, 8),
    },
  };
}

// The same market at a different BTC price ("what if BTC is $200k?"). The payout per TH in BTC is set
// by network difficulty, not price, so it stays the same and its USD value scales with the price;
// electricity and service fees are charged in USD and stay as they are. Difficulty is held constant.
export function atBtcPrice(market, btcPriceUsd) {
  if (!(btcPriceUsd > 0) || btcPriceUsd === market.btcPriceUsd) return market;
  const scale = btcPriceUsd / market.btcPriceUsd;
  return {
    ...market,
    btcPriceUsd,
    rewardUsdPerThDay: market.rewardUsdPerThDay * scale,
    averageRewardUsdPerThDay365: market.averageRewardUsdPerThDay365 === null ? null : market.averageRewardUsdPerThDay365 * scale,
  };
}

// ---- Outlook: what could change the payout ------------------------------------------------------

const clampPct = (value) => Math.min(Math.max(Number(value) || 0, 0), 100) / 100;

// The BTC price at which the payout only just covers electricity and service, per W/TH. The payout in
// sats per TH is set by difficulty, so break-even = USD fees / BTC paid per TH. Difficulty held constant.
export function breakEvenBtcPrice(market, { discountPct = 0, kwhPriceUsd, min = EFFICIENCY_RANGE.min, max = EFFICIENCY_RANGE.max } = {}) {
  const discount = clampPct(discountPct);
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const btcPerTh = market.rewardSatsPerThDay / SATS_PER_BTC;
  const rows = [];
  for (let level = min; level <= max; level++) {
    const feesUsd = (electricity * level + market.serviceUsdPerThDay) * (1 - discount);
    const price = btcPerTh > 0 ? feesUsd / btcPerTh : null;
    rows.push({
      efficiencyWth: level,
      breakEvenBtcUsd: price === null ? null : Math.round(price),
      headroomPct: price ? round((market.btcPriceUsd / price - 1) * 100, 1) : null,
    });
  }
  return { btcPriceUsd: market.btcPriceUsd, discountPct: discount * 100, rows };
}

// What the next difficulty adjustment does to the payout: sats per TH scale with 1 / difficulty.
export function difficultyImpact(market, adjustment, { powerTh } = {}) {
  const change = adjustment?.estimatedChangePct;
  if (typeof change !== 'number' || !Number.isFinite(change)) return null;
  const satsNow = market.rewardSatsPerThDay;
  const satsAfter = satsNow / (1 + change / 100);
  return {
    difficultyChangePct: change,
    satsPerThNow: round(satsNow, 2),
    satsPerThAfter: round(satsAfter, 2),
    payoutChangePct: round((satsAfter / satsNow - 1) * 100, 2),
    satsPerDayChange: powerTh > 0 ? round((satsAfter - satsNow) * powerTh, 1) : null,
    estimatedDate: adjustment.estimatedDate ?? null,
    remainingBlocks: adjustment.remainingBlocks ?? null,
    progressPct: adjustment.progressPct ?? null,
  };
}

export const HALVING_INTERVAL = 210_000;

// Countdown to the next halving from the current block height. After it the block subsidy (and so
// roughly the sats per TH, transaction fees aside) halves at the same difficulty.
export function halving(blockHeight, { avgBlockMinutes, satsPerThDay, now = Date.now() } = {}) {
  if (!Number.isInteger(blockHeight) || blockHeight < 0) return null;
  const epoch = Math.floor(blockHeight / HALVING_INTERVAL);
  const nextHeight = (epoch + 1) * HALVING_INTERVAL;
  const blocksLeft = nextHeight - blockHeight;
  const minutes = avgBlockMinutes > 0 ? avgBlockMinutes : 10;
  const msLeft = blocksLeft * minutes * 60_000;
  return {
    blockHeight,
    nextHalvingHeight: nextHeight,
    blocksLeft,
    daysLeft: Math.round(msLeft / 86_400_000),
    estimatedDate: new Date(now + msLeft).toISOString(),
    progressPct: round(((HALVING_INTERVAL - blocksLeft) / HALVING_INTERVAL) * 100, 1),
    subsidyBtcNow: 50 / 2 ** epoch,
    subsidyBtcAfter: 50 / 2 ** (epoch + 1),
    satsPerThAfter: satsPerThDay > 0 ? round(satsPerThDay / 2, 2) : null,
  };
}

// ---- Maintenance discount -----------------------------------------------------------------------

// GoMining's maintenance discount has three parts that add up:
//   paying in GOMINING  1% per 18 days of maintenance the GOMINING balance (wallet + locked) covers, max 20%
//   VIP level           0% (Bronze I) up to 6% (Elite), see VIP_LEVELS
//   Service Button      3% when used
export const TOKEN_DISCOUNT = { daysPerPct: 18, maxPct: 20 };
// GoMining VIP levels: maintenance discount % and the bonus TH when reinvesting rewards in TH.
export const VIP_LEVELS = [
  ['Bronze I', 0], ['Bronze II', 0.3], ['Silver I', 0.6], ['Silver II', 0.9], ['Silver III', 1.2], ['Gold I', 1.5], ['Gold II', 1.8],
  ['Platinum I', 2.1], ['Platinum II', 2.4], ['Platinum III', 2.7], ['Diamond I', 3], ['Diamond II', 3.3], ['Diamond III', 3.6], ['Diamond IV', 3.9], ['Diamond V', 4.2],
  ['Legend I', 4.5], ['Legend II', 4.8], ['Legend III', 5.1], ['Legend IV', 5.4], ['Legend V', 5.7], ['Elite', 6],
].map(([name, discountPct], index) => ({ name, discountPct, reinvestBonusPct: index >= 10 ? 10 : index >= 2 ? 5 : 0 }));
export const SERVICE_BUTTON_PCT = 3;

export function maintenanceDiscount(market, { powerTh, efficiencyWth, gominingHeld = 0, gominingUsd, vipLevel, vipPct = 0, serviceButton = false, kwhPriceUsd }) {
  if (!(powerTh > 0) || !(efficiencyWth > 0)) throw new Error('powerTh and efficiencyWth must be greater than 0');
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const dailyUsd = (electricity * efficiencyWth + market.serviceUsdPerThDay) * powerTh;
  const held = Math.max(Number(gominingHeld) || 0, 0);
  const price = gominingUsd > 0 ? gominingUsd : null;
  const coverageDays = price && dailyUsd > 0 ? Math.floor((held * price) / dailyUsd) : 0;
  const tokenPct = Math.min(Math.floor(coverageDays / TOKEN_DISCOUNT.daysPerPct), TOKEN_DISCOUNT.maxPct);
  const level = VIP_LEVELS.find((row) => row.name.toLowerCase() === String(vipLevel ?? '').toLowerCase());
  const vip = level ? level.discountPct : Math.min(Math.max(Number(vipPct) || 0, 0), 6);
  const buttonPct = serviceButton ? SERVICE_BUTTON_PCT : 0;
  const tokensForDays = (days) => (price ? Math.ceil((days * dailyUsd) / price) : null);
  const nextPct = tokenPct < TOKEN_DISCOUNT.maxPct ? tokenPct + 1 : null;
  return {
    dailyMaintenanceUsd: round(dailyUsd, 4),
    coverageDays,
    tokenPct,
    vipPct: vip,
    vipLevel: level?.name ?? null,
    reinvestBonusPct: level?.reinvestBonusPct ?? null,
    serviceButtonPct: buttonPct,
    totalPct: round(tokenPct + vip + buttonPct, 2),
    gominingForMax: tokensForDays(TOKEN_DISCOUNT.maxPct * TOKEN_DISCOUNT.daysPerPct),
    next: nextPct === null ? null : { pct: nextPct, gominingNeeded: tokensForDays(nextPct * TOKEN_DISCOUNT.daysPerPct) },
  };
}

// ---- Miner Wars ---------------------------------------------------------------------------------

// Cycles run Tuesday 00:00 UTC to Tuesday 00:00 UTC; cycle 148 started on 16 Jun 2026.
const CYCLE_ANCHOR = { number: 148, startMs: Date.UTC(2026, 5, 16) };
const WEEK_MS = 7 * 86_400_000;

export function minerWarsCycle(now = Date.now()) {
  const index = Math.floor((now - CYCLE_ANCHOR.startMs) / WEEK_MS);
  const startMs = CYCLE_ANCHOR.startMs + index * WEEK_MS;
  return {
    number: CYCLE_ANCHOR.number + index,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + WEEK_MS).toISOString(),
    elapsedDays: round((now - startMs) / 86_400_000, 3),
  };
}

// One week of Miner Wars against one week of plain mining, for a member's power.
// Miner Wars: the clan's BTC (blocks won x BTC per block) is shared by TH, and maintenance is charged
// only on the TH-equivalent of that reward, so net = gross x (1 - fees per TH / payout per TH).
// Solo: today's payout per TH minus fees. Both use the member's own W/TH and discount; spells,
// personal GOMINING rewards and league-average fee adjustments are left out.
export function minerWarsVsSolo(market, { powerTh, efficiencyWth, discountPct = 0, clanBlocksWeek, btcPerBlock, clanPowerTh, kwhPriceUsd }) {
  if (!(powerTh > 0) || !(efficiencyWth > 0)) throw new Error('powerTh and efficiencyWth must be greater than 0');
  const discount = clampPct(discountPct);
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const feesPerThDay = (electricity * efficiencyWth + market.serviceUsdPerThDay) * (1 - discount);
  const soloNetUsd = (market.rewardUsdPerThDay - feesPerThDay) * powerTh * 7;
  const share = clanPowerTh > 0 ? Math.min(powerTh / clanPowerTh, 1) : 0;
  const mwGrossBtc = Math.max(clanBlocksWeek || 0, 0) * Math.max(btcPerBlock || 0, 0) * share;
  const feeRatio = market.rewardUsdPerThDay > 0 ? feesPerThDay / market.rewardUsdPerThDay : 1;
  const mwNetBtc = mwGrossBtc * (1 - feeRatio);
  const soloNetBtc = soloNetUsd / market.btcPriceUsd;
  return {
    sharePct: round(share * 100, 4),
    solo: { netBtc: round(soloNetBtc, 8), netUsd: round(soloNetUsd, 2) },
    minerWars: {
      grossBtc: round(mwGrossBtc, 8),
      feesBtc: round(mwGrossBtc * feeRatio, 8),
      netBtc: round(mwNetBtc, 8),
      netUsd: round(mwNetBtc * market.btcPriceUsd, 2),
    },
    differencePct: soloNetBtc > 0 ? round((mwNetBtc / soloNetBtc - 1) * 100, 1) : null,
    better: mwNetBtc > soloNetBtc ? 'minerWars' : 'solo',
  };
}
