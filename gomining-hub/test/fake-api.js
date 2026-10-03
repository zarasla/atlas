// A stand-in for api.gomining.com: responses shaped like the real public endpoints, and a record of
// every request so tests can check headers and bodies.

export const income = {
  createdAt: '2026-09-09T03:31:04.474Z',
  btcCourseInUsd: 80000,
  totalIncomePerThToday: 0.04,
  totalIncomePerTh: 14.6,
  c1ValuePerThPerWtToday: 0.0012,
  c2ValuePerThToday: 0.0089,
  c3ValuePerThToday: 0,
  c4ValuePerThToday: 0,
};

export const presets = [
  { id: 1, power: 1, energyEfficiency: 12, priceUsdt: 18.99 },
  { id: 2, power: 16, energyEfficiency: 12, priceUsdt: 297.99 },
  { id: 3, power: 16, energyEfficiency: 15, priceUsdt: 249.99 },
  { id: 4, power: 16, energyEfficiency: 15, priceUsdt: 259.99 },
  { id: 5, power: 0, energyEfficiency: 15, priceUsdt: 1 },
];

export const upgradeRates = {
  powerUpgradePriceConfig: [{ toLevel: 13, priceUsd: 0.5 }, { toLevel: 12, priceUsd: 0.6 }],
  energyEfficiencyUpgradePriceConfig: [{ toLevel: 12, priceUsd: 1.1 }],
};

// Shaped like mempool.space and CoinGecko responses.
export const mempool = {
  adjustment: { progressPercent: 42.5, difficultyChange: 1.8, estimatedRetargetDate: Date.parse('2026-10-10T00:00:00Z'), remainingBlocks: 1159, previousRetarget: -0.9, timeAvg: 590000 },
  hashrate: { currentHashrate: 812.4e18, currentDifficulty: 112.3e12 },
  height: 915000,
  fees: { fastestFee: 6, halfHourFee: 4, hourFee: 3, economyFee: 2, minimumFee: 1 },
};
export const coingecko = {
  bitcoin: { usd: 80500, eur: 74000, usd_24h_change: 1.25, usd_market_cap: 1.6e12 },
  'gomining-token': { usd: 0.42, eur: 0.39, usd_24h_change: -2.5, usd_market_cap: 170e6 },
};

const reply = (status, value) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export function fakeFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    calls.push({ url: target.toString(), method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${method} ${target.pathname}`;
    if (routes[key]) return routes[key](target, init);
    switch (key) {
      case 'POST /api/nft-income-aggregation/get-last': return reply(200, { data: income });
      case 'GET /api/nft-collection/find-all-generative': return reply(200, { data: { array: presets, count: presets.length } });
      case 'POST /api/nft/get-upgrade-rate': return reply(200, { data: upgradeRates });
      case 'GET /api/v1/difficulty-adjustment': return reply(200, mempool.adjustment);
      case 'GET /api/v1/mining/hashrate/3d': return reply(200, mempool.hashrate);
      case 'GET /api/blocks/tip/height': return reply(200, mempool.height);
      case 'GET /api/v1/fees/recommended': return reply(200, mempool.fees);
      case 'GET /api/v3/simple/price': return reply(200, coingecko);
      default: return reply(404, { message: 'Not Found' });
    }
  };
  return { fetchImpl, calls, reply };
}
