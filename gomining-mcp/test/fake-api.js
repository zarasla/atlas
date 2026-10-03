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

const reply = (status, value) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export function fakeFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    calls.push({ url: target.toString(), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const key = `${init.method} ${target.pathname}`;
    if (routes[key]) return routes[key](target, init);
    switch (key) {
      case 'POST /api/nft-income-aggregation/get-last': return reply(200, { data: income });
      case 'GET /api/nft-collection/find-all-generative': return reply(200, { data: { array: presets, count: presets.length } });
      case 'POST /api/nft/get-upgrade-rate': return reply(200, { data: upgradeRates });
      default: return reply(404, { message: 'Not Found' });
    }
  };
  return { fetchImpl, calls, reply };
}
