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
    // Per-W/TH step values, not prices per TH: a TH's value at a level is the sum of the steps from
    // the worst level down to it (12 W/TH: about $17.25, matching the listed 5,000 TH miner).
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
    assumptions: `Pre-halving figures: rates held constant at the latest GoMining payout. ${HALVING_NOTE} Fee discounts (GOMINING token, VIP, clan/league boosts) and BTC price or difficulty changes are not included.`,
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
      halving: data.network ? halving(data.network.blockHeight, { satsPerThDay: income.rewardSatsPerThDay }) : null,
      sentiment: data.sentiment ?? null,
    },
  };
}

export const DAYS_PER_MONTH = 30.4375;
// Every estimate uses today's pre-halving payout; nobody can say where BTC's price will be after it.
export const HALVING_NOTE = 'The next halving (about April 2028) halves the BTC paid per TH; what BTC\'s price does then cannot be predicted, so it is left out.';
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

// GoMining's rules for reinvesting rewards into TH (docs: Rewards, Reward Reinvestment): the selected
// miner must have 10 to 5,000 TH and better than 20 W/TH, and the day's reward must be at least
// $0.10; otherwise the reward is paid in BTC. TH is bought at the power-upgrade price, with no fee.
export const TH_REINVEST_RULES = { minTh: 10, maxTh: 5000, maxEfficiencyWth: 20, minUsdPerDay: 0.1 };

// Why a miner can't reinvest into TH, or null when it can.
export function thReinvestBlocker({ powerTh, efficiencyWth, netUsdDay }) {
  if (!(efficiencyWth < TH_REINVEST_RULES.maxEfficiencyWth)) return `needs better than ${TH_REINVEST_RULES.maxEfficiencyWth} W/TH`;
  if (powerTh < TH_REINVEST_RULES.minTh) return `needs at least ${TH_REINVEST_RULES.minTh} TH`;
  if (powerTh >= TH_REINVEST_RULES.maxTh) return `the miner is at the ${grouped(TH_REINVEST_RULES.maxTh)} TH maximum`;
  if (netUsdDay < TH_REINVEST_RULES.minUsdPerDay) return `the daily reward is under $${TH_REINVEST_RULES.minUsdPerDay.toFixed(2)}`;
  return null;
}
const grouped = (value) => new Intl.NumberFormat('en-US').format(value);

// Day-by-day simulation (GoMining pays and reinvests daily) of buying hashrate at a fixed price per
// TH, at today's rates, reported month by month. `monthlyUsd` buys TH at the start of each month.
// With `reinvest`, each day's net reward buys TH when GoMining's reinvestment rules allow it (all
// the TH is treated as one miner) and is paid out in BTC when they don't. `reinvestPricePerThUsd` is
// the power-upgrade price per TH (defaults to pricePerThUsd); `reinvestBonusPct` is the VIP bonus.
export function investmentPlan(market, {
  startTh = 0, efficiencyWth, monthlyUsd = 0, months = 12, pricePerThUsd, reinvest = false, discountPct = 0,
  reinvestPricePerThUsd, reinvestBonusPct = 0, kwhPriceUsd, useAverageReward = false,
}) {
  if (!(efficiencyWth > 0)) throw new Error('efficiencyWth must be greater than 0');
  if (!(pricePerThUsd > 0)) throw new Error('pricePerThUsd must be greater than 0');
  // GoMining's per-W/TH step tables are cents per TH; typed in as a price per TH they compound into
  // nonsense, so a reinvest price far below the new-miner price is refused.
  if (reinvestPricePerThUsd > 0 && reinvestPricePerThUsd < pricePerThUsd * 0.25) {
    throw new Error(`A reinvest price of $${reinvestPricePerThUsd} per TH is far below the $${round(pricePerThUsd, 2)} new-miner price. Enter the full price per TH your app shows for adding power.`);
  }
  const span = Math.min(Math.max(Math.round(months), 1), 120);
  const reinvestPrice = reinvestPricePerThUsd > 0 ? reinvestPricePerThUsd : pricePerThUsd;
  const bonus = 1 + Math.min(Math.max(Number(reinvestBonusPct) || 0, 0), 100) / 100;
  const perThDay = rewardsBreakdown(market, { powerTh: 1, efficiencyWth, discountPct, kwhPriceUsd, useAverageReward }).periods.day.netUsd;
  let th = Math.max(Number(startTh) || 0, 0);
  let invested = th * pricePerThUsd;
  let earnedUsd = 0;
  let reinvestedUsd = 0;
  let paidOutUsd = 0;
  let breakEvenMonth = null;
  const blockers = new Map();
  const rows = [];
  let dayIndex = 0;
  for (let month = 1; month <= span; month++) {
    th += monthlyUsd / pricePerThUsd;
    invested += monthlyUsd;
    const monthEnd = Math.round(month * DAYS_PER_MONTH);
    let netMonth = 0;
    for (; dayIndex < monthEnd; dayIndex++) {
      const netUsd = th * perThDay;
      netMonth += netUsd;
      earnedUsd += netUsd;
      const blocker = reinvest && netUsd > 0 ? thReinvestBlocker({ powerTh: th, efficiencyWth, netUsdDay: netUsd }) : 'off';
      if (reinvest && netUsd > 0 && !blocker) {
        th += (netUsd / reinvestPrice) * bonus;
        reinvestedUsd += netUsd;
      } else {
        if (reinvest && blocker !== 'off') blockers.set(blocker, (blockers.get(blocker) ?? 0) + 1);
        paidOutUsd += Math.max(netUsd, 0);
      }
    }
    if (breakEvenMonth === null && invested > 0 && earnedUsd >= invested) breakEvenMonth = month;
    rows.push({ month, th: round(th, 3), investedUsd: round(invested, 2), netUsdMonth: round(netMonth, 2), earnedUsd: round(earnedUsd, 2) });
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
      paidOutUsd: round(paidOutUsd, 2),
      monthlyIncomeUsdAtEnd: round(last.th * perThDay * DAYS_PER_MONTH, 2),
      breakEvenMonth,
      // Days when reinvesting was on but GoMining's rules paid the reward in BTC instead, by reason.
      reinvestBlockedDays: Object.fromEntries(blockers),
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
// roughly the sats per TH, transaction fees aside) halves at the same difficulty. Blocks are counted
// at 10 minutes: difficulty retargets every 2,016 blocks to hold that pace, so the current period's
// average (which can read 12+ minutes early in a period) would push the date months out.
export function halving(blockHeight, { blockMinutes = 10, satsPerThDay, now = Date.now() } = {}) {
  if (!Number.isInteger(blockHeight) || blockHeight < 0) return null;
  const epoch = Math.floor(blockHeight / HALVING_INTERVAL);
  const nextHeight = (epoch + 1) * HALVING_INTERVAL;
  const blocksLeft = nextHeight - blockHeight;
  const minutes = blockMinutes > 0 ? blockMinutes : 10;
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

// GoMining's maintenance discount (docs.gomining.com, Maintenance fees and discounts) has four parts
// that add up:
//   paying in GOMINING  1% per 18 days of maintenance the GOMINING balance (wallet + locked) covers, max 20%
//   VIP level           0% (Bronze I) up to 6% (Elite), see VIP_LEVELS
//   Service Button      +0.3% for each day pressed in a row, max 3% after 10 days; missing a day resets it
//   Mining mode         an extra discount for everyone in Mining mode (not Miner Wars, not during the
//                       trial). Its size changes every Burn & Mint cycle with the veGOMINING vote and is
//                       only shown inside the account, so it is entered by the member, never assumed.
// The first three are fixed rules, 29% together at most; Mining mode comes on top.
// None of them applies to the Bonus Miner.
export const TOKEN_DISCOUNT = { daysPerPct: 18, maxPct: 20 };
export const SERVICE_BUTTON = { pctPerDay: 0.3, maxDays: 10 };
export const VIP_MAX_DISCOUNT_PCT = 6;
export const FIXED_MAX_DISCOUNT_PCT = round(TOKEN_DISCOUNT.maxPct + VIP_MAX_DISCOUNT_PCT + SERVICE_BUTTON.pctPerDay * SERVICE_BUTTON.maxDays, 2);
// Reinvesting rewards into GOMINING tokens costs 2.25%; reinvesting into TH has no fee (docs: Rewards).
export const GOMINING_REINVEST_FEE_PCT = 2.25;
// GoMining's VIP table (gomining.com/vip, checked 4 Oct 2026). A level is reached by mining power (TH)
// OR locked veGOMINING votes, or by referral activity over a rolling 180 days, whichever is highest.
// GoMining publishes the TH and veGOMINING thresholds; the referral-activity thresholds are only
// shown in the app, so they are not modelled. Each level sets the maintenance discount, the Simple
// Earn APR multiplier, the Instant Funds fee, the Launchpad allocation, the referral mining royalty
// and, from Silver I, the bonus TH when reinvesting rewards in TH (+5%, +10% from Diamond I).
export const VIP_LEVELS = [
  // name,          TH,        veGOMINING,  discount %, Simple Earn x, Instant Funds fee %, royalty %, Launchpad (x, tier)
  ['Bronze I',      0,         0,           0,          1,     2.5,  5,  null],
  ['Bronze II',     5,         50,          0.3,        1.08,  2.43, 5,  null],
  ['Silver I',      10,        100,         0.6,        1.1,   2.36, 7,  [1, 1]],
  ['Silver II',     25,        250,         0.9,        1.12,  2.29, 7,  [2.5, 2]],
  ['Silver III',    50,        500,         1.2,        1.14,  2.21, 7,  [5.3, 3]],
  ['Gold I',        100,       1_000,       1.5,        1.16,  2.14, 9,  [11, 4]],
  ['Gold II',       200,       2_000,       1.8,        1.18,  2.07, 9,  [23, 5]],
  ['Platinum I',    500,       5_000,       2.1,        1.2,   2,    12, [60, 6]],
  ['Platinum II',   1_000,     10_000,      2.4,        1.22,  1.96, 12, [125, 7]],
  ['Platinum III',  2_500,     25_000,      2.7,        1.24,  1.92, 12, [330, 8]],
  ['Diamond I',     5_000,     50_000,      3,          1.26,  1.88, 14, [700, 9]],
  ['Diamond II',    7_000,     70_000,      3.3,        1.28,  1.85, 14, [700, 9]],
  ['Diamond III',   9_000,     90_000,      3.6,        1.3,   1.81, 14, [700, 9]],
  ['Diamond IV',    12_000,    120_000,     3.9,        1.32,  1.77, 14, [700, 9]],
  ['Diamond V',     20_000,    200_000,     4.2,        1.34,  1.73, 14, [700, 9]],
  ['Legend I',      50_000,    500_000,     4.5,        1.36,  1.69, 15, [700, 9]],
  ['Legend II',     100_000,   1_000_000,   4.8,        1.38,  1.65, 15, [700, 9]],
  ['Legend III',    250_000,   2_500_000,   5.1,        1.4,   1.62, 15, [700, 9]],
  ['Legend IV',     400_000,   4_000_000,   5.4,        1.42,  1.58, 15, [700, 9]],
  ['Legend V',      750_000,   7_500_000,   5.7,        1.44,  1.54, 15, [700, 9]],
  ['Elite',         1_000_000, 10_000_000,  6,          1.46,  1.5,  15, [700, 9]],
].map(([name, th, veGomining, discountPct, simpleEarnMultiplier, instantFundsFeePct, royaltyPct, launchpad], index) => ({
  name, th, veGomining, discountPct, simpleEarnMultiplier, instantFundsFeePct, royaltyPct,
  launchpad: launchpad ? { multiplier: launchpad[0], tier: launchpad[1] } : null,
  reinvestBonusPct: index >= 10 ? 10 : index >= 2 ? 5 : 0,
  // Clan ownership in Miner Wars from Gold I, a personal VIP manager from Platinum I.
  clanOwner: index >= 5,
  vipManager: index >= 7,
}));

// GoMining's table calls the top level "Elite V" and its docs call it "Elite"; both are accepted.
const findVip = (name) => {
  const wanted = String(name ?? '').toLowerCase().replace(/^elite v$/, 'elite');
  return VIP_LEVELS.find((row) => row.name.toLowerCase() === wanted);
};

// Which VIP level a member has (the higher of the TH and veGOMINING paths) and what the next level needs.
export function vipStatus({ powerTh = 0, veGomining = 0 } = {}) {
  const have = { th: Math.max(Number(powerTh) || 0, 0), veGomining: Math.max(Number(veGomining) || 0, 0) };
  const reached = (key) => VIP_LEVELS.reduce((best, row, index) => (have[key] >= row[key] ? index : best), 0);
  const byPath = { th: reached('th'), veGomining: reached('veGomining') };
  const index = Math.max(byPath.th, byPath.veGomining);
  const level = VIP_LEVELS[index];
  const nextRow = VIP_LEVELS[index + 1] ?? null;
  return {
    level,
    reachedBy: Object.keys(byPath).filter((key) => byPath[key] === index && index > 0),
    byPath: Object.fromEntries(Object.entries(byPath).map(([key, i]) => [key, VIP_LEVELS[i].name])),
    next: nextRow && {
      level: nextRow,
      // Either one is enough.
      needs: {
        th: round(Math.max(nextRow.th - have.th, 0), 2),
        veGomining: round(Math.max(nextRow.veGomining - have.veGomining, 0), 2),
      },
      gains: {
        discountPct: round(nextRow.discountPct - level.discountPct, 2),
        simpleEarnMultiplier: round(nextRow.simpleEarnMultiplier - level.simpleEarnMultiplier, 2),
        reinvestBonusPct: nextRow.reinvestBonusPct - level.reinvestBonusPct,
        royaltyPct: nextRow.royaltyPct - level.royaltyPct,
      },
    },
    note: 'Referral activity over the last 180 days is a third path; its thresholds are shown only in the GoMining app.',
  };
}

// Simple Earn (docs: Simple Earn): idle balances earn at the asset's APR times the VIP multiplier,
// counted on the lowest balance in each full 4-hour cycle (6 a day) and paid in BTC, or in TH with
// 10% more TH. A TH reward needs at least $0.10 in that cycle; a smaller cycle is paid in BTC.
// GoMining sets each asset's APR and changes it often, and shows the current one only in the app,
// so the member enters it: nothing here assumes a rate.
export const SIMPLE_EARN_ASSETS = ['BTC', 'USDT', 'USDC', 'ETH', 'SOL', 'BNB', 'GRAM'];
export const SIMPLE_EARN_RULES = { cyclesPerDay: 6, thBonusPct: 10, thMinUsdPerCycle: 0.1 };

export function simpleEarn({ amount, assetPriceUsd, aprPct, vipLevel, btcPriceUsd, rewardInTh = false, thPriceUsd }) {
  if (!(amount > 0)) throw new Error('Enter an amount');
  if (!(assetPriceUsd > 0)) throw new Error('The asset price is unavailable');
  if (!(aprPct >= 0)) throw new Error('Enter the APR your GoMining wallet shows for this asset');
  if (!(btcPriceUsd > 0)) throw new Error('The BTC price is unavailable');
  const level = findVip(vipLevel) ?? VIP_LEVELS[0];
  const effectiveAprPct = aprPct * level.simpleEarnMultiplier;
  const valueUsd = amount * assetPriceUsd;
  const yearUsd = (valueUsd * effectiveAprPct) / 100;
  const cycleUsd = yearUsd / (365 * SIMPLE_EARN_RULES.cyclesPerDay);
  // Paid in TH only when the cycle reaches the minimum; otherwise that cycle is paid in BTC as usual.
  const inTh = rewardInTh && cycleUsd >= SIMPLE_EARN_RULES.thMinUsdPerCycle;
  const thFactor = inTh ? 1 + SIMPLE_EARN_RULES.thBonusPct / 100 : 1;
  const periods = {};
  for (const [name, days] of PERIODS) {
    const usdValue = (yearUsd * days) / 365;
    periods[name] = {
      usd: round(usdValue, 4),
      btc: round(usdValue / btcPriceUsd, 8),
      sats: Math.round(toSats(usdValue, btcPriceUsd)),
      th: inTh && thPriceUsd > 0 ? round((usdValue * thFactor) / thPriceUsd, 4) : null,
    };
  }
  return {
    vipLevel: level.name,
    multiplier: level.simpleEarnMultiplier,
    baseAprPct: aprPct,
    effectiveAprPct: round(effectiveAprPct, 3),
    valueUsd: round(valueUsd, 2),
    perCycleUsd: round(cycleUsd, 4),
    rewardType: inTh ? 'TH' : 'BTC',
    ...(rewardInTh && !inTh ? { thNote: `Each 4-hour cycle earns ${round(cycleUsd, 4)} USD, under the $${SIMPLE_EARN_RULES.thMinUsdPerCycle.toFixed(2)} minimum for TH, so it is paid in BTC` } : {}),
    periods,
  };
}

// `serviceButtonDays` is how many days in a row the Service Button has been pressed (0-10);
// `serviceButton: true` means the full 10. `miningModePct` is the Mining mode discount the member's
// app shows (it changes weekly), 0 when not given.
export function maintenanceDiscount(market, { powerTh, efficiencyWth, gominingHeld = 0, gominingUsd, vipLevel, vipPct = 0, serviceButton = false, serviceButtonDays, miningModePct = 0, kwhPriceUsd }) {
  if (!(powerTh > 0) || !(efficiencyWth > 0)) throw new Error('powerTh and efficiencyWth must be greater than 0');
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const dailyUsd = (electricity * efficiencyWth + market.serviceUsdPerThDay) * powerTh;
  const held = Math.max(Number(gominingHeld) || 0, 0);
  const price = gominingUsd > 0 ? gominingUsd : null;
  const coverageDays = price && dailyUsd > 0 ? Math.floor((held * price) / dailyUsd) : 0;
  const tokenPct = Math.min(Math.floor(coverageDays / TOKEN_DISCOUNT.daysPerPct), TOKEN_DISCOUNT.maxPct);
  const level = findVip(vipLevel);
  const vip = level ? level.discountPct : Math.min(Math.max(Number(vipPct) || 0, 0), VIP_MAX_DISCOUNT_PCT);
  const days = serviceButtonDays !== undefined ? Number(serviceButtonDays) || 0 : serviceButton ? SERVICE_BUTTON.maxDays : 0;
  const buttonPct = round(Math.min(Math.max(Math.floor(days), 0), SERVICE_BUTTON.maxDays) * SERVICE_BUTTON.pctPerDay, 1);
  const modePct = Math.min(Math.max(Number(miningModePct) || 0, 0), 100);
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
    miningModePct: modePct,
    totalPct: round(Math.min(tokenPct + vip + buttonPct + modePct, 100), 2),
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

// Points per second (docs: Game Mechanics): PPS = TH x base EE / your W/TH, base EE 20 W/TH.
// Spells, boosts and avatar bonuses don't change the base PPS.
export const MINER_WARS_BASE_EE = 20;
export function pointsPerSecond(powerTh, efficiencyWth) {
  if (!(powerTh > 0) || !(efficiencyWth > 0)) return 0;
  return round((powerTh * MINER_WARS_BASE_EE) / efficiencyWth, 4);
}

// GoMining's league names: "odyssey", "eclipse", "horizon", "dune-12" -> Odyssey, Eclipse, Horizon, Dune 12.
export function leagueDisplayName(name) {
  const [base, order] = String(name ?? '').split('-');
  const title = base ? base[0].toUpperCase() + base.slice(1) : 'League';
  return order ? `${title} ${order}` : title;
}

// Average round multiplier from a league's published odds: [{ p, v }] (probability, multiplier).
export function expectedMultiplier(config) {
  const rows = Array.isArray(config) ? config.filter((row) => row?.p >= 0 && row?.v > 0) : [];
  const total = rows.reduce((sum, row) => sum + row.p, 0);
  return total > 0 ? round(rows.reduce((sum, row) => sum + row.p * row.v, 0) / total, 3) : null;
}

// One week of Miner Wars against one week of plain mining, for a member's power, using GoMining's rules:
//   - the clan's BTC (blocks won x BTC per block) is shared among members by TH;
//   - maintenance for the member's FULL TH for the whole week is taken out of that reward, and a block
//     never goes below zero (no debt): a share smaller than a week's maintenance pays nothing;
//   - reward above what the member would have earned in Mining mode is charged electricity at the
//     league's weighted-average W/TH and discount instead of the member's own;
//   - switching mode costs a day: the day you join a clan earns no Mining mode reward (and after
//     leaving, daily BTC resumes only after a full UTC day in Mining mode). With `joining`, one day
//     of Mining mode net is counted as the cost of switching.
// GoMining weights each round by its multiplier, which can't be known in advance, so blocks are
// treated as equal value and per-block floors reduce to one floor on the week. Spells and personal
// GOMINING rewards are left out. `joining`: the member's TH is added to the clan total.
export function minerWarsVsSolo(market, {
  powerTh, efficiencyWth, discountPct = 0, clanBlocksWeek, btcPerBlock, clanPowerTh, kwhPriceUsd,
  leagueEfficiencyWth, leagueDiscountPct, joining = false,
}) {
  if (!(powerTh > 0) || !(efficiencyWth > 0)) throw new Error('powerTh and efficiencyWth must be greater than 0');
  const discount = clampPct(discountPct);
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const feesPerThDay = (electricity * efficiencyWth + market.serviceUsdPerThDay) * (1 - discount);
  const soloNetUsd = (market.rewardUsdPerThDay - feesPerThDay) * powerTh * 7;
  const clanTh = Math.max(Number(clanPowerTh) || 0, 0) + (joining ? powerTh : 0);
  const share = clanTh > 0 ? Math.min(powerTh / clanTh, 1) : 0;
  const mwGrossBtc = Math.max(clanBlocksWeek || 0, 0) * Math.max(btcPerBlock || 0, 0) * share;

  const btcPrice = market.btcPriceUsd;
  const miningGrossBtc = (market.rewardUsdPerThDay * powerTh * 7) / btcPrice;
  const ownFeesBtc = (feesPerThDay * powerTh * 7) / btcPrice;
  const leagueEff = leagueEfficiencyWth > 0 ? leagueEfficiencyWth : efficiencyWth;
  const leagueDiscount = leagueDiscountPct === undefined || leagueDiscountPct === null ? discount : clampPct(leagueDiscountPct);
  const leagueFeeRatio = market.rewardUsdPerThDay > 0 ? ((electricity * leagueEff + market.serviceUsdPerThDay) * (1 - leagueDiscount)) / market.rewardUsdPerThDay : 1;
  const excessBtc = Math.max(mwGrossBtc - miningGrossBtc, 0);
  const chargedBtc = ownFeesBtc + excessBtc * leagueFeeRatio;
  const mwNetBtc = Math.max(mwGrossBtc - chargedBtc, 0);
  const soloNetBtc = soloNetUsd / btcPrice;
  // The joining day earns no Mining mode reward: a one-off cost of one day's Mining mode net.
  const switchCostBtc = joining ? Math.max(soloNetBtc / 7, 0) : 0;
  const firstWeekBtc = mwNetBtc - switchCostBtc;
  return {
    sharePct: round(share * 100, 4),
    clanPowerTh: round(clanTh, 1),
    solo: { grossBtc: round(miningGrossBtc, 8), netBtc: round(soloNetBtc, 8), netUsd: round(soloNetUsd, 2) },
    minerWars: {
      grossBtc: round(mwGrossBtc, 8),
      maintenanceBtc: round(chargedBtc, 8),
      feesBtc: round(Math.min(chargedBtc, mwGrossBtc), 8),
      netBtc: round(mwNetBtc, 8),
      netUsd: round(mwNetBtc * btcPrice, 2),
      // The share didn't cover a week's maintenance, so GoMining pays nothing (and charges nothing more).
      flooredAtZero: mwGrossBtc > 0 && chargedBtc >= mwGrossBtc,
      switchCostBtc: round(switchCostBtc, 8),
      firstWeekNetBtc: round(firstWeekBtc, 8),
    },
    differencePct: soloNetBtc > 0 ? round((mwNetBtc / soloNetBtc - 1) * 100, 1) : null,
    better: mwNetBtc > soloNetBtc ? 'minerWars' : 'solo',
  };
}

// Every clan on a league board ranked by what a week in it would pay this member, at the clan's pace
// so far. The clan keeps winning at its pace (whatever won those blocks, power or spells), and the
// member's TH adds its own fair chance: the league's weekly blocks x the member's share of league
// power (the board publishes TH, not points). BTC is then shared by TH, GoMining's rule.
// `blocksVsPower` is the clan's share of blocks over its share of power: around 1 for a clan winning
// on power, far above 1 for one winning on spells, which only continues while its members keep
// casting them. `board` is [{ clanId, name, position, blocks, powerTh, zone }], `league`
// { btcPerBlock, totalPowerTh, totalBlocks, avgEfficiencyWth, avgDiscountPct }.
export function clanFinder(market, { board, league, elapsedDays, powerTh, efficiencyWth, discountPct = 0, kwhPriceUsd, limit = 20 }) {
  if (!(powerTh > 0) || !(efficiencyWth > 0)) throw new Error('powerTh and efficiencyWth must be greater than 0');
  if (!(elapsedDays > 0.25)) return { rows: [], note: 'The cycle has only just started: there are no blocks to project from yet.' };
  const scale = 7 / Math.min(elapsedDays, 7);
  const leagueTh = Math.max(league.totalPowerTh || 0, 0);
  const leagueBlocks = Math.max(league.totalBlocks || 0, 0);
  const yourBlocks = leagueTh > 0 ? leagueBlocks * scale * (powerTh / (leagueTh + powerTh)) : 0;
  const rows = (board ?? []).filter((clan) => clan.powerTh > 0).map((clan) => {
    const blocksWithYou = clan.blocks * scale + yourBlocks;
    const blockShare = leagueBlocks > 0 ? clan.blocks / leagueBlocks : 0;
    const powerShare = leagueTh > 0 ? clan.powerTh / leagueTh : 0;
    const r = minerWarsVsSolo(market, {
      powerTh, efficiencyWth, discountPct, kwhPriceUsd, joining: true, clanBlocksWeek: blocksWithYou, btcPerBlock: league.btcPerBlock,
      clanPowerTh: clan.powerTh, leagueEfficiencyWth: league.avgEfficiencyWth, leagueDiscountPct: league.avgDiscountPct ?? undefined,
    });
    return {
      clanId: clan.clanId, name: clan.name, position: clan.position, zone: clan.zone, powerTh: clan.powerTh,
      blocksWeek: round(blocksWithYou, 1), sharePct: r.sharePct, netBtc: r.minerWars.netBtc, netUsd: r.minerWars.netUsd,
      flooredAtZero: r.minerWars.flooredAtZero, vsSoloPct: r.differencePct, soloNetBtc: r.solo.netBtc,
      blocksVsPower: powerShare > 0 ? round(blockShare / powerShare, 2) : null,
    };
  }).sort((a, b) => b.netBtc - a.netBtc || a.position - b.position);
  return { rows: rows.slice(0, limit), soloNetBtc: rows[0]?.soloNetBtc ?? null, yourBlocksWeek: round(yourBlocks, 2) };
}

// Rough net for the whole clan this week: the projected reward less a week of maintenance on the
// clan's TH at the league's average W/TH and discount (the clan's own average isn't public).
export function minerWarsClanNet(market, { btcWeek, clanPowerTh, leagueEfficiencyWth, leagueDiscountPct = 0 }) {
  if (!(btcWeek >= 0) || !(clanPowerTh > 0) || !(leagueEfficiencyWth > 0)) return null;
  const feesPerThDay = (market.electricityUsdPerThPerWthDay * leagueEfficiencyWth + market.serviceUsdPerThDay) * (1 - clampPct(leagueDiscountPct));
  const maintenanceBtc = (feesPerThDay * clanPowerTh * 7) / market.btcPriceUsd;
  return { maintenanceBtc: round(maintenanceBtc, 8), netBtc: round(Math.max(btcWeek - maintenanceBtc, 0), 8) };
}

// ---- Planning tools -----------------------------------------------------------------------------

// Net reward per TH per day for each W/TH (rows) at each BTC price (columns), at today's difficulty:
// sats per TH stay the same and fees stay in USD, so only the USD value of the payout moves.
export function breakEvenMatrix(market, { btcPrices, discountPct = 0, kwhPriceUsd, min = EFFICIENCY_RANGE.min, max = EFFICIENCY_RANGE.max }) {
  const prices = [...new Set((btcPrices ?? []).map(Number).filter((p) => p > 0))].sort((a, b) => a - b);
  if (!prices.length) throw new Error('Give at least one BTC price');
  const discount = clampPct(discountPct);
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const btcPerTh = market.rewardSatsPerThDay / SATS_PER_BTC;
  const rows = [];
  for (let level = min; level <= max; level++) {
    const feesUsd = (electricity * level + market.serviceUsdPerThDay) * (1 - discount);
    rows.push({
      efficiencyWth: level,
      breakEvenBtcUsd: btcPerTh > 0 ? Math.round(feesUsd / btcPerTh) : null,
      netUsdPerThDay: prices.map((price) => round(btcPerTh * price - feesUsd, 5)),
    });
  }
  return { btcPrices: prices, satsPerThDay: market.rewardSatsPerThDay, discountPct: discount * 100, rows };
}

// Spend a budget on better efficiency or on more TH? Efficiency upgrades are priced from GoMining's
// per-step table (each step improves the miner by one W/TH, priced per TH); more TH is priced at
// `powerPricePerThUsd` (the member's power-upgrade price, or a new miner's list price per TH).
export function upgradeComparison(market, upgrades, { powerTh, efficiencyWth, budgetUsd, discountPct = 0, kwhPriceUsd, powerPricePerThUsd }) {
  if (!(powerTh > 0) || !(efficiencyWth > 0)) throw new Error('powerTh and efficiencyWth must be greater than 0');
  const discount = clampPct(discountPct);
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const steps = upgrades?.efficiencyUpgradeSteps ?? [];
  const stepPrice = (toLevel) => steps.find((step) => step.toLevelWth === toLevel)?.priceUsdPerTh ?? null;
  const efficiency = [];
  let costPerTh = 0;
  for (let target = Math.ceil(efficiencyWth) - 1; target >= EFFICIENCY_RANGE.min; target--) {
    const price = stepPrice(target);
    if (price === null) break;
    costPerTh += price;
    const costUsd = costPerTh * powerTh;
    const savingUsdDay = electricity * (efficiencyWth - target) * powerTh * (1 - discount);
    efficiency.push({
      toWth: target,
      costUsd: round(costUsd, 2),
      gainUsdDay: round(savingUsdDay, 4),
      paybackDays: savingUsdDay > 0 ? Math.ceil(costUsd / savingUsdDay) : null,
      affordable: budgetUsd > 0 ? costUsd <= budgetUsd : null,
    });
  }
  const netPerThDay = rewardsBreakdown(market, { powerTh: 1, efficiencyWth, discountPct: discount * 100, kwhPriceUsd }).periods.day.netUsd;
  let power = null;
  if (powerPricePerThUsd > 0 && budgetUsd > 0) {
    const addedTh = budgetUsd / powerPricePerThUsd;
    const gainUsdDay = addedTh * netPerThDay;
    power = { pricePerThUsd: powerPricePerThUsd, addedTh: round(addedTh, 3), costUsd: round(budgetUsd, 2), gainUsdDay: round(gainUsdDay, 4), paybackDays: gainUsdDay > 0 ? Math.ceil(budgetUsd / gainUsdDay) : null };
  }
  // Best use of the budget: the deepest efficiency upgrade it pays for, against the TH it buys,
  // compared by daily gain per dollar spent.
  const bestEfficiency = efficiency.filter((row) => row.affordable).at(-1) ?? null;
  const perDollar = (row) => (row && row.costUsd > 0 ? row.gainUsdDay / row.costUsd : -Infinity);
  const verdict = !power && !bestEfficiency ? null : perDollar(bestEfficiency) >= perDollar(power) ? 'efficiency' : 'power';
  return { netPerThDayUsd: round(netPerThDay, 6), efficiency, power, bestEfficiency, verdict };
}

// The same money in Simple Earn (APR x VIP multiplier, capital stays yours) or in new TH at a price
// per TH (net mining reward at today's rates; the miner is kept and could be sold, but its resale
// price can't be predicted, so it isn't counted).
export function simpleEarnVsMining(market, { capitalUsd, aprPct, vipLevel, efficiencyWth, pricePerThUsd, discountPct = 0, kwhPriceUsd }) {
  if (!(capitalUsd > 0)) throw new Error('Enter an amount');
  if (!(aprPct >= 0)) throw new Error('Enter the Simple Earn APR your wallet shows');
  if (!(pricePerThUsd > 0) || !(efficiencyWth > 0)) throw new Error('A miner price per TH and efficiency are needed');
  const level = findVip(vipLevel) ?? VIP_LEVELS[0];
  const earnYearUsd = (capitalUsd * aprPct * level.simpleEarnMultiplier) / 100;
  const th = capitalUsd / pricePerThUsd;
  const mineDayUsd = th * rewardsBreakdown(market, { powerTh: 1, efficiencyWth, discountPct, kwhPriceUsd }).periods.day.netUsd;
  return {
    simpleEarn: { aprPct: round(aprPct * level.simpleEarnMultiplier, 3), yearUsd: round(earnYearUsd, 2), monthUsd: round((earnYearUsd / 365) * DAYS_PER_MONTH, 2), capitalKept: true },
    mining: { th: round(th, 3), yearUsd: round(mineDayUsd * 365, 2), monthUsd: round(mineDayUsd * DAYS_PER_MONTH, 2), paybackDays: mineDayUsd > 0 ? Math.ceil(capitalUsd / mineDayUsd) : null, returnPct: round(((mineDayUsd * 365) / capitalUsd) * 100, 2) },
    better: mineDayUsd * 365 > earnYearUsd ? 'mining' : 'simpleEarn',
  };
}

// ---- GOMINING token: veGOMINING and Burn & Mint -------------------------------------------------

// Locking GOMINING for 1 week to 4 years gives veGOMINING votes in proportion to the lock length,
// and the votes fall each week to zero at the lock's end (docs: veGOMINING & Locks). GoMining's own
// lock statistics give votes / locked = average lock days / 1461, so 4 years counts as 1461 days.
export const VE_MAX_LOCK_DAYS = 1461;
export const VE_MIN_LOCK_DAYS = 7;

// A lock's votes now and over time, the VIP level they give and how long it holds, and the GOMINING
// rewards at GoMining's current yearly income per vote (held constant, although it moves weekly).
export function veLock({ amount, lockDays, yearlyIncomePerVote, gominingUsd }) {
  if (!(amount > 0)) throw new Error('Enter how much GOMINING to lock');
  const days = Math.min(Math.max(Math.round(Number(lockDays) || 0), VE_MIN_LOCK_DAYS), VE_MAX_LOCK_DAYS);
  const votes = (amount * days) / VE_MAX_LOCK_DAYS;
  const votesAt = (day) => Math.max(votes * (1 - day / days), 0);
  const status = vipStatus({ veGomining: votes });
  const threshold = status.level.veGomining;
  // The day the falling votes drop below the level reached at the start.
  const levelHoldsDays = threshold > 0 ? Math.floor(days * (1 - threshold / votes)) : null;
  const income = yearlyIncomePerVote > 0 ? yearlyIncomePerVote : null;
  // Rewards follow the votes, which fall in a straight line: the average is half the starting votes.
  const rewardsOver = (from, to) => (income === null ? null : ((votesAt(from) + votesAt(to)) / 2) * income * ((to - from) / 365));
  const total = rewardsOver(0, days);
  const step = Math.max(7, Math.round(days / 12 / 7) * 7);
  const schedule = [];
  for (let day = 0; day < days; day += step) schedule.push({ day, votes: round(votesAt(day), 2), vipLevel: vipStatus({ veGomining: votesAt(day) }).level.name });
  schedule.push({ day: days, votes: 0, vipLevel: VIP_LEVELS[0].name });
  return {
    amount,
    lockDays: days,
    votes: round(votes, 2),
    votesPerToken: round(days / VE_MAX_LOCK_DAYS, 4),
    vipLevel: status.level.name,
    vipHoldsDays: levelHoldsDays,
    yearlyIncomePerVote: income,
    rewardsFirstYear: income === null ? null : round(rewardsOver(0, Math.min(days, 365)), 2),
    rewardsTotal: total === null ? null : round(total, 2),
    rewardsTotalUsd: total !== null && gominingUsd > 0 ? round(total * gominingUsd, 2) : null,
    schedule,
  };
}

// Epochs (docs: Epochs): tokens to burn during the epoch and its mint coefficient C.
export const EPOCHS = [
  [10e6, 0.8], [20e6, 0.81], [30e6, 0.82], [40e6, 0.83], [50e6, 0.84], [60e6, 0.85], [70e6, 0.86], [80e6, 0.87], [90e6, 0.88], [100e6, 0.89],
  [200e6, 0.9], [300e6, 0.91], [400e6, 0.92], [500e6, 0.93], [600e6, 0.94], [650e6, 0.95], [700e6, 0.96], [750e6, 0.97], [1_345_762_000, 0.98], [0, 0.99],
].map(([toBurn, coefficient], epoch) => ({ epoch, toBurn, coefficient }));

// GoMining's on-chain amounts have 18 decimals; whole tokens are plenty here.
const fromWei = (value) => {
  try {
    return Number(BigInt(String(value ?? '0').split('.')[0] || '0') / 10n ** 12n) / 1e6;
  } catch {
    return 0;
  }
};

// Weekly Burn & Mint cycles from GoMining's public record. Minted = (1 - V x (1 - C)) x burned
// (docs: Voting), so V, the share of votes for burning, can be read back from each week.
// `epochStart` is when the current epoch began.
export function burnMintSummary(cycles, { epochStart } = {}) {
  const weeks = (Array.isArray(cycles) ? cycles : [])
    .filter((row) => typeof row?.blockCreatedAt === 'string' && row.burnValue !== undefined)
    .map((row) => {
      const burned = fromWei(row.burnValue);
      const minted = fromWei(row.mintValue);
      const epoch = Number(row.currentEpoch);
      const c = EPOCHS[epoch]?.coefficient;
      const ratio = burned > 0 ? minted / burned : null;
      const share = (label) => fromWei((Array.isArray(row.mintReceivers) ? row.mintReceivers : []).find((r) => r?.label === label)?.value);
      return {
        date: row.blockCreatedAt.slice(0, 10),
        epoch,
        burned: Math.round(burned),
        minted: Math.round(minted),
        netBurned: Math.round(burned - minted),
        burnVotePct: ratio !== null && c !== undefined ? round(Math.min(Math.max((1 - ratio) / (1 - c), 0), 1) * 100, 1) : null,
        toVeHolders: Math.round(share('mintReward')),
        toRewards: Math.round(share('nftMarketing')),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = weeks.at(-1) ?? null;
  const epoch = last ? EPOCHS[last.epoch] ?? null : null;
  const start = epochStart ? String(epochStart).slice(0, 10) : null;
  const inEpoch = start && last ? weeks.filter((w) => w.date >= start && w.epoch === last.epoch) : [];
  const burnedThisEpoch = inEpoch.reduce((sum, w) => sum + w.burned, 0);
  const avgWeek = inEpoch.length ? burnedThisEpoch / inEpoch.length : 0;
  return {
    weeks,
    latest: last,
    totals: { cycles: weeks.length, burned: weeks.reduce((s, w) => s + w.burned, 0), minted: weeks.reduce((s, w) => s + w.minted, 0), netBurned: weeks.reduce((s, w) => s + w.netBurned, 0) },
    epoch: epoch && {
      number: epoch.epoch,
      coefficient: epoch.coefficient,
      toBurn: epoch.toBurn,
      startDate: start,
      burned: start ? burnedThisEpoch : null,
      progressPct: start && epoch.toBurn > 0 ? round(Math.min((burnedThisEpoch / epoch.toBurn) * 100, 100), 1) : null,
      // At this epoch's average weekly burn, how many more weekly cycles until the next epoch.
      cyclesLeft: avgWeek > 0 && epoch.toBurn > burnedThisEpoch ? Math.ceil((epoch.toBurn - burnedThisEpoch) / avgWeek) : null,
    },
  };
}
