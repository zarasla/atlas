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
export function upgradeAdvisor(market, upgrades) {
  const savingUsdPerThDay = market.electricityUsdPerThPerWthDay;
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
  };
}

export const DAYS_PER_MONTH = 30.4375;
const PERIODS = [['day', 1], ['week', 7], ['month', DAYS_PER_MONTH], ['year', 365]];

// Rewards for a miner over a day, week, month and year. `discountPct` is the owner's maintenance
// discount (VIP level, paying fees in GOMINING), applied to electricity and service together.
// `gominingUsd` (optional) adds the net in GOMINING tokens.
export function rewardsBreakdown(market, { powerTh, efficiencyWth, discountPct = 0, priceUsd, gominingUsd, useAverageReward = false }) {
  if (!(powerTh > 0)) throw new Error('powerTh must be greater than 0');
  if (!(efficiencyWth > 0)) throw new Error('efficiencyWth must be greater than 0');
  const discount = Math.min(Math.max(Number(discountPct) || 0, 0), 100) / 100;
  const rewardPerTh = useAverageReward && market.averageRewardUsdPerThDay365 !== null ? market.averageRewardUsdPerThDay365 : market.rewardUsdPerThDay;
  const grossUsd = rewardPerTh * powerTh;
  const electricityUsd = market.electricityUsdPerThPerWthDay * efficiencyWth * powerTh;
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
    };
  }
  const payback = priceUsd > 0 ? {
    priceUsd,
    days: netUsd > 0 ? Math.ceil(priceUsd / netUsd) : null,
    annualReturnPct: round(((netUsd * 365) / priceUsd) * 100, 2),
  } : null;
  return { input: { powerTh, efficiencyWth, discountPct: discount * 100, rewardBasis: rewardPerTh === market.rewardUsdPerThDay ? 'today' : '365-day average' }, periods, payback };
}

// Listed price per TH for an efficiency: the 1 TH miner if GoMining sells one, else the cheapest per TH.
export function listedPricePerTh(presets, efficiencyWth) {
  const rows = presets.filter((row) => row.efficiencyWth === efficiencyWth);
  if (!rows.length) return null;
  return rows.find((row) => row.powerTh === 1)?.priceUsdPerTh ?? Math.min(...rows.map((row) => row.priceUsdPerTh));
}

// Month-by-month simulation of buying hashrate at a fixed price per TH, at today's rates.
// With `reinvest`, each month's net reward also buys TH. Returns monthly rows and a summary.
export function investmentPlan(market, { startTh = 0, efficiencyWth, monthlyUsd = 0, months = 12, pricePerThUsd, reinvest = false, discountPct = 0 }) {
  if (!(efficiencyWth > 0)) throw new Error('efficiencyWth must be greater than 0');
  if (!(pricePerThUsd > 0)) throw new Error('pricePerThUsd must be greater than 0');
  const span = Math.min(Math.max(Math.round(months), 1), 120);
  const perThMonth = rewardsBreakdown(market, { powerTh: 1, efficiencyWth, discountPct }).periods.month.netUsd;
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
      th += netUsd / pricePerThUsd;
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
