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
  // GoMining's per-W/TH step tables are cents per TH; typed in as a price per TH they compound into
  // nonsense, so a reinvest price far below the new-miner price is refused.
  if (reinvestPricePerThUsd > 0 && reinvestPricePerThUsd < pricePerThUsd * 0.25) {
    throw new Error(`A reinvest price of $${reinvestPricePerThUsd} per TH is far below the $${round(pricePerThUsd, 2)} new-miner price. Enter the full price per TH your app shows for adding power.`);
  }
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

// GoMining's maintenance discount has four parts that add up, to 30.2% at most (GoMining's figure):
//   paying in GOMINING  1% per 18 days of maintenance the GOMINING balance (wallet + locked) covers, max 20%
//   VIP level           0% (Bronze I) up to 6% (Elite), see VIP_LEVELS
//   Service Button      +0.3% for each day pressed in a row, max 3% after 10 days; missing a day resets it
//   Mining mode         an extra discount for everyone in Mining mode (not Miner Wars). GoMining doesn't
//                       state it alone; 1.2% is what's left of its 30.2% maximum after the other three.
export const TOKEN_DISCOUNT = { daysPerPct: 18, maxPct: 20 };
export const SERVICE_BUTTON = { pctPerDay: 0.3, maxDays: 10 };
export const MINING_MODE_PCT = 1.2;
export const MAX_DISCOUNT_PCT = 30.2;
// GoMining VIP levels (from the app's VIP table). A level is reached by ANY one of three paths: own
// mining power (TH), locked veGOMINING, or referral activity in USD over the last 180 days.
// Each level sets the maintenance discount, the Simple Earn APR multiplier, the bonus TH when
// reinvesting rewards in TH, and the referral royalty.
export const VIP_LEVELS = [
  // name,          TH,     veGOMINING,  referral USD, discount %, Simple Earn x, royalty %
  ['Bronze I',      0,      0,           0,            0,          1,     5],
  ['Bronze II',     5,      50,          500,          0.3,        1.08,  5],
  ['Silver I',      10,     100,         1_000,        0.6,        1.1,   7],
  ['Silver II',     25,     250,         2_500,        0.9,        1.12,  7],
  ['Silver III',    50,     500,         5_000,        1.2,        1.14,  7],
  ['Gold I',        100,    1_000,       10_000,       1.5,        1.16,  9],
  ['Gold II',       200,    2_000,       20_000,       1.8,        1.18,  9],
  ['Platinum I',    500,    5_000,       50_000,       2.1,        1.2,   12],
  ['Platinum II',   1_000,  10_000,      100_000,      2.4,        1.22,  12],
  ['Platinum III',  2_500,  25_000,      250_000,      2.7,        1.24,  12],
  ['Diamond I',     5_000,  50_000,      500_000,      3,          1.26,  14],
  ['Diamond II',    7_000,  70_000,      700_000,      3.3,        1.28,  14],
  ['Diamond III',   9_000,  90_000,      900_000,      3.6,        1.3,   14],
  ['Diamond IV',    12_000, 120_000,     1_200_000,    3.9,        1.32,  14],
  ['Diamond V',     20_000, 200_000,     2_000_000,    4.2,        1.34,  14],
  ['Legend I',      50_000, 500_000,     5_000_000,    4.5,        1.36,  15],
  ['Legend II',     100_000, 1_000_000,  10_000_000,   4.8,        1.38,  15],
  ['Legend III',    250_000, 2_500_000,  25_000_000,   5.1,        1.4,   15],
  ['Legend IV',     400_000, 4_000_000,  40_000_000,   5.4,        1.42,  15],
  ['Legend V',      750_000, 7_500_000,  75_000_000,   5.7,        1.44,  15],
  ['Elite',         1_000_000, 10_000_000, 100_000_000, 6,         1.46,  15],
].map(([name, th, veGomining, referralUsd, discountPct, simpleEarnMultiplier, royaltyPct], index) => ({
  name, th, veGomining, referralUsd, discountPct, simpleEarnMultiplier, royaltyPct, reinvestBonusPct: index >= 10 ? 10 : index >= 2 ? 5 : 0,
}));

const findVip = (name) => VIP_LEVELS.find((row) => row.name.toLowerCase() === String(name ?? '').toLowerCase());

// Which VIP level a member has (the highest any one path reaches) and what the next level needs.
export function vipStatus({ powerTh = 0, veGomining = 0, referralUsd = 0 } = {}) {
  const have = { th: Math.max(Number(powerTh) || 0, 0), veGomining: Math.max(Number(veGomining) || 0, 0), referralUsd: Math.max(Number(referralUsd) || 0, 0) };
  const reached = (key) => VIP_LEVELS.reduce((best, row, index) => (have[key] >= row[key] ? index : best), 0);
  const byPath = { th: reached('th'), veGomining: reached('veGomining'), referralUsd: reached('referralUsd') };
  const index = Math.max(byPath.th, byPath.veGomining, byPath.referralUsd);
  const level = VIP_LEVELS[index];
  const nextRow = VIP_LEVELS[index + 1] ?? null;
  return {
    level,
    reachedBy: Object.keys(byPath).filter((key) => byPath[key] === index && index > 0),
    byPath: Object.fromEntries(Object.entries(byPath).map(([key, i]) => [key, VIP_LEVELS[i].name])),
    next: nextRow && {
      level: nextRow,
      // Any ONE of these is enough.
      needs: {
        th: round(Math.max(nextRow.th - have.th, 0), 2),
        veGomining: round(Math.max(nextRow.veGomining - have.veGomining, 0), 2),
        referralUsd: round(Math.max(nextRow.referralUsd - have.referralUsd, 0), 2),
      },
      gains: {
        discountPct: round(nextRow.discountPct - level.discountPct, 2),
        simpleEarnMultiplier: round(nextRow.simpleEarnMultiplier - level.simpleEarnMultiplier, 2),
        reinvestBonusPct: nextRow.reinvestBonusPct - level.reinvestBonusPct,
        royaltyPct: nextRow.royaltyPct - level.royaltyPct,
      },
    },
  };
}

// Simple Earn: idle balances earn BTC (paid every 4 hours) at the asset's base APR times the VIP
// multiplier. Base APRs change; these are GoMining's published rates as checked in October 2026, and
// the app shows the current ones.
export const SIMPLE_EARN_ASSETS = { BTC: 3.03, USDT: 9.85, USDC: 9.85, BNB: 1.52 };
export const SIMPLE_EARN_RATES_CHECKED = '2026-10';

export function simpleEarn({ amount, assetPriceUsd, aprPct, vipLevel, btcPriceUsd }) {
  if (!(amount > 0)) throw new Error('Enter an amount');
  if (!(assetPriceUsd > 0)) throw new Error('The asset price is unavailable');
  if (!(aprPct >= 0)) throw new Error('Enter the base APR');
  if (!(btcPriceUsd > 0)) throw new Error('The BTC price is unavailable');
  const level = findVip(vipLevel) ?? VIP_LEVELS[0];
  const effectiveAprPct = aprPct * level.simpleEarnMultiplier;
  const valueUsd = amount * assetPriceUsd;
  const yearUsd = (valueUsd * effectiveAprPct) / 100;
  const periods = {};
  for (const [name, days] of PERIODS) {
    const usdValue = (yearUsd * days) / 365;
    periods[name] = { usd: round(usdValue, 4), btc: round(usdValue / btcPriceUsd, 8), sats: Math.round(toSats(usdValue, btcPriceUsd)) };
  }
  return { vipLevel: level.name, multiplier: level.simpleEarnMultiplier, baseAprPct: aprPct, effectiveAprPct: round(effectiveAprPct, 3), valueUsd: round(valueUsd, 2), periods };
}
// `serviceButtonDays` is how many days in a row the Service Button has been pressed (0-10);
// `serviceButton: true` means the full 10.
export function maintenanceDiscount(market, { powerTh, efficiencyWth, gominingHeld = 0, gominingUsd, vipLevel, vipPct = 0, serviceButton = false, serviceButtonDays, miningMode = false, kwhPriceUsd }) {
  if (!(powerTh > 0) || !(efficiencyWth > 0)) throw new Error('powerTh and efficiencyWth must be greater than 0');
  const electricity = kwhPriceUsd > 0 ? (kwhPriceUsd * 24) / 1000 : market.electricityUsdPerThPerWthDay;
  const dailyUsd = (electricity * efficiencyWth + market.serviceUsdPerThDay) * powerTh;
  const held = Math.max(Number(gominingHeld) || 0, 0);
  const price = gominingUsd > 0 ? gominingUsd : null;
  const coverageDays = price && dailyUsd > 0 ? Math.floor((held * price) / dailyUsd) : 0;
  const tokenPct = Math.min(Math.floor(coverageDays / TOKEN_DISCOUNT.daysPerPct), TOKEN_DISCOUNT.maxPct);
  const level = findVip(vipLevel);
  const vip = level ? level.discountPct : Math.min(Math.max(Number(vipPct) || 0, 0), 6);
  const days = serviceButtonDays !== undefined ? Number(serviceButtonDays) || 0 : serviceButton ? SERVICE_BUTTON.maxDays : 0;
  const buttonPct = round(Math.min(Math.max(Math.floor(days), 0), SERVICE_BUTTON.maxDays) * SERVICE_BUTTON.pctPerDay, 1);
  const modePct = miningMode ? MINING_MODE_PCT : 0;
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
    totalPct: round(tokenPct + vip + buttonPct + modePct, 2),
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

// One week of Miner Wars against one week of plain mining, for a member's power, using GoMining's rules:
//   - the clan's BTC (blocks won x BTC per block) is shared among members by TH;
//   - maintenance for the member's FULL TH for the whole week is taken out of that reward, and a block
//     never goes below zero (no debt): a share smaller than a week's maintenance pays nothing;
//   - reward above what the member would have earned in Mining mode is charged electricity at the
//     league's weighted-average W/TH and discount instead of the member's own.
// Blocks are treated as equal value (GoMining weights rounds by a multiplier), so per-block floors
// reduce to one floor on the week. Spells and personal GOMINING rewards are left out.
// `joining`: the member isn't in the clan yet, so their TH is added to the clan total.
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
    },
    differencePct: soloNetBtc > 0 ? round((mwNetBtc / soloNetBtc - 1) * 100, 1) : null,
    better: mwNetBtc > soloNetBtc ? 'minerWars' : 'solo',
  };
}

// Rough net for the whole clan this week: the projected reward less a week of maintenance on the
// clan's TH at the league's average W/TH and discount (the clan's own average isn't public).
export function minerWarsClanNet(market, { btcWeek, clanPowerTh, leagueEfficiencyWth, leagueDiscountPct = 0 }) {
  if (!(btcWeek >= 0) || !(clanPowerTh > 0) || !(leagueEfficiencyWth > 0)) return null;
  const feesPerThDay = (market.electricityUsdPerThPerWthDay * leagueEfficiencyWth + market.serviceUsdPerThDay) * (1 - clampPct(leagueDiscountPct));
  const maintenanceBtc = (feesPerThDay * clanPowerTh * 7) / market.btcPriceUsd;
  return { maintenanceBtc: round(maintenanceBtc, 8), netBtc: round(Math.max(btcWeek - maintenanceBtc, 0), 8) };
}
