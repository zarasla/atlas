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

export const fearGreed = { data: [{ value: '62', value_classification: 'Greed' }, { value: '58', value_classification: 'Greed' }, ...Array(5).fill({ value: '50', value_classification: 'Neutral' }), { value: '47', value_classification: 'Neutral' }] };

// Shaped like GoMining's Miner Wars leaderboards: HONKSQUAD (43680) is in league 3, 50 rows per page.
const clanRow = (clanId, name, position, blocks, power) => ({ blocksMined: blocks, btcMined: 0, clanId, nftPower: power, position, clan: { id: clanId, name, image: null, isDeleted: false } });
export const clanBoard = {
  count: 6, totalMinedBlocks: 400, btcFund: '0.4', status: 'active', me: null, totalPower: 50000, weightedEnergyEfficiencyPerTh: 17.9, weightedAvgDiscount: 0.0639,
  clansPromoted: [clanRow(1, 'Alpha', 1, 120, 9000), clanRow(43680, 'HONKSQUAD', 2, 100, 15000)],
  clansRemaining: [clanRow(3, 'Gamma', 3, 80, 12000), clanRow(4, 'Delta', 4, 60, 8000)],
  clansRelegated: [clanRow(5, 'Eps', 5, 30, 4000), clanRow(6, 'Zeta', 6, 10, 2000)],
};
const player = (userId, alias, clanId, position, blocks, power) => ({ nftPower: power, position, blocksMined: blocks, clanId, gmtRewards: 0, usedAbilities: [{ count: 3 }, { count: 2 }], user: { userId, alias, image: null } });
export const players = Array.from({ length: 120 }, (_, i) => player(1000 + i, `p${i}`, i % 3 === 0 ? 43680 : 1, i + 1, 120 - i, 10 + i));

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
      case 'GET /fng/': return reply(200, fearGreed);
      case 'POST /api/nft-game/clan-leaderboard/index-v2': {
        const body = JSON.parse(init.body);
        if (body.pagination.limit > 50) return reply(400, { description: 'limit must be less than or equal to 50' });
        return reply(200, { data: body.leagueId === 3 ? clanBoard : { count: 0, totalMinedBlocks: 0, btcFund: '0', clansPromoted: [], clansRemaining: [], clansRelegated: [] } });
      }
      case 'POST /api/nft-game/user-leaderboard/index': {
        const { leagueId, pagination } = JSON.parse(init.body);
        const rows = leagueId === 3 ? players.slice(pagination.skip, pagination.skip + pagination.limit) : [];
        return reply(200, { data: { participants: rows, count: leagueId === 3 ? players.length : 0, totalMinedBlocks: 400 } });
      }
      case 'GET /api/v3/coins/markets': return reply(200, [
        { market_cap_rank: 1, symbol: 'btc', name: 'Bitcoin', current_price: 80500, price_change_percentage_24h: 1.25 },
        { market_cap_rank: 2, symbol: 'eth', name: 'Ethereum', current_price: 3100.5, price_change_percentage_24h: -0.8 },
        { market_cap_rank: 3, symbol: 'sol', name: 'Solana', current_price: 160.2, price_change_percentage_24h: 4.1 },
        { market_cap_rank: 4, symbol: 'bad', name: 'No price' },
      ]);
      default: return reply(404, { message: 'Not Found' });
    }
  };
  return { fetchImpl, calls, reply };
}
