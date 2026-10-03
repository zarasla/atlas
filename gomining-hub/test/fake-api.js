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

// Shaped like GoMining's Miner Wars data: three leagues, and a board for league 3, 50 rows per page.
export const leagues = [
  { id: 1, test: false, name: 'odyssey', level: 1, relegationToLeagueId: 3, promotionToLeagueId: null, totalClansCount: 50, isDynamicClansMovement: false, roundMultiplierConfig: [{ p: 0.5, v: 1 }, { p: 0.5, v: 2 }] },
  { id: 3, test: false, name: 'eclipse', level: 2, relegationToLeagueId: 4, promotionToLeagueId: 1, totalClansCount: 50, isDynamicClansMovement: false, roundMultiplierConfig: [{ p: 0.6, v: 1 }, { p: 0.3, v: 2 }, { p: 0.1, v: 4 }] },
  { id: 5, test: false, name: 'dune-1', level: 4, relegationToLeagueId: null, promotionToLeagueId: 4, totalClansCount: 49, isDynamicClansMovement: true, roundMultiplierConfig: [{ p: 1, v: 1 }] },
  { id: 99, test: true, name: 'test-league', level: 9, roundMultiplierConfig: [] },
];
const clanRow = (clanId, name, position, blocks, power) => ({ blocksMined: blocks, btcMined: 0, clanId, nftPower: power, position, clan: { id: clanId, name, image: null, isDeleted: false } });
export const clanBoard = {
  count: 6, totalMinedBlocks: 400, btcFund: '0.4', status: 'active', me: null, totalPower: 50000, weightedEnergyEfficiencyPerTh: 17.9, weightedAvgDiscount: 0.0639,
  clansPromoted: [clanRow(1, 'Alpha', 1, 120, 9000), clanRow(2, 'Goose Squad', 2, 100, 15000)],
  clansRemaining: [clanRow(3, 'Gamma', 3, 80, 12000), clanRow(4, 'Delta', 4, 60, 8000)],
  clansRelegated: [clanRow(5, 'Eps', 5, 30, 4000), clanRow(6, 'Zeta', 6, 10, 2000)],
};

// Shaped like GoMining's other public statistics (token amounts in wei).
const wei = (tokens) => `${BigInt(Math.round(tokens * 1e6)) * 10n ** 12n}`;
const cycle = (date, epoch, burned, minted) => ({
  blockCreatedAt: `${date}T12:00:00.000Z`, network: 'ETH', currentEpoch: String(epoch), burnValue: wei(burned), mintValue: wei(minted),
  mintReceivers: [{ label: 'mintReward', value: wei(minted * 0.2) }, { label: 'nftMarketing', value: wei(minted * 0.1) }, { label: 'serviceProviders', value: wei(minted * 0.65) }, { label: 'goMiningTeam', value: wei(minted * 0.05) }],
});
export const burnMint = [cycle('2026-09-29', 8, 4_000_000, 3_904_000), cycle('2026-08-04', 7, 3_000_000, 2_934_000), cycle('2026-09-22', 8, 5_000_000, 4_880_000)];
export const platformStats = { miningUsersCount: 3685674, totalHashrateTh: 17377667, simpleEarnEnabledCount: 282537, cardsCreatedCount: 13413, totalTokensLocked: 261183001, delta: { miningUsersCount: 3902, totalHashrateTh: 24516, simpleEarnEnabledCount: 1586, cardsCreatedCount: 41, totalTokensLocked: 88845 } };
export const marketStats = { nfts: 603605, holders: 268791, power: 17408975.27, upgradesCount: 1307705, usersRegistered: 5564142, purchases: 760151, secondaryMarketPurchasesCount: 156143, secondaryMarketPurchasesTotalValue: 199096542.58, minersGenerated: 531059, totalIncomes: 6022.64, totalTokensLocked: 261183000.66, oneDayDifference: { nfts: 1249, upgradesCount: 4135, usersRegistered: 8397 }, oneWeekDifference: { secondaryMarketPurchasesTotalValue: 1443839.15 }, totalIncomesInMinerWars: 862.52, usersRegisteredInMinerWars: 48048 };
export const veStats = [
  { network: 'VIRTUAL_GMT', totalLocked: wei(163_314_714), totalVotes: wei(139_819_690), averageLockPeriodInDays: 1250.82, yearlyIncomePerVote: 0.23, totalMintReward: '0' },
  { network: 'ETH', totalLocked: wei(97_923_458), totalVotes: wei(43_497_250), averageLockPeriodInDays: 648.97, yearlyIncomePerVote: 0.23, totalMintReward: '0' },
];
export const spells = [
  { type: 'boost', subtype: 'basic', name: 'Boost X1', description: 'Boost', priceInGMT: 1, enabled: true, availableFrom: '2024-01-01T00:00:00Z', availableTo: '2124-01-01T00:00:00Z', freeUsageCount: 0, data: { value: 2000, multiply: 1 } },
  { type: 'boost', subtype: 'pro', name: 'Boost X10', description: 'Boost', priceInGMT: 10, enabled: true, availableFrom: '2024-01-01T00:00:00Z', availableTo: '2124-01-01T00:00:00Z', freeUsageCount: 0, data: { value: 2000, multiply: 10 } },
  { type: 'boost', subtype: 'basic', name: 'Old boost', description: 'Expired', priceInGMT: 1, enabled: true, availableFrom: '2024-01-01T00:00:00Z', availableTo: '2024-10-01T00:00:00Z', freeUsageCount: 0, data: {} },
];
const days = (base, n) => Array.from({ length: n }, (_, i) => [Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000, base * (1 + (i % 3 === 0 ? 0.02 : -0.01))]);

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
      case 'POST /api/nft-game/league/index': {
        const { calculatedAt } = JSON.parse(init.body);
        // GoMining answers an empty list unless asked as of a cycle start (Tuesday 00:00 UTC).
        return reply(200, { data: { array: /T00:00:00\.000Z$/.test(calculatedAt) ? leagues : [] } });
      }
      case 'GET /api/platform-statistics': return reply(200, { data: platformStats });
      case 'POST /api/nft/marketplace-statistics': return reply(200, { data: marketStats });
      case 'POST /api/ve-gomining-lock/statistics': return reply(200, { data: { array: veStats } });
      case 'POST /api/mint-and-burn/index': return reply(200, { data: { array: burnMint, count: burnMint.length } });
      case 'POST /api/mint-and-burn/get-epoch-start-date': return reply(200, { data: { epoch: JSON.parse(init.body).epoch, startDate: '2026-08-11T12:00:23.000Z' } });
      case 'POST /api/nft-game/nft-game-ability/find-all': return reply(200, { data: { array: spells } });
      case 'GET /api/v3/coins/bitcoin/market_chart': return reply(200, { prices: days(80000, 10) });
      case 'GET /api/v3/coins/gmt-token/market_chart': return reply(200, { prices: days(0.4, 10) });
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
