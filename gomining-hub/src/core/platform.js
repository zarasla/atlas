// GoMining's other public numbers (no token; the same calls app.gomining.com makes):
//   GET  /platform-statistics             users mining, total TH, Simple Earn users, cards, locked tokens
//   POST /nft/marketplace-statistics      miners, holders, upgrades, registrations, secondary-market volume
//   POST /ve-gomining-lock/statistics     veGOMINING locked and votes per network, yearly income per vote
//   POST /mint-and-burn/index             every weekly Burn & Mint cycle since 2023
//   POST /mint-and-burn/get-epoch-start-date   when an epoch began
//   POST /nft-game/nft-game-ability/find-all   Miner Wars spells and their GOMINING prices
//
// Each part is cached on its own and falls back to its last good answer (marked stale) if GoMining
// is briefly unreachable; it is never replaced by made-up numbers.

import { burnMintSummary } from './calc.js';
import { TtlCache } from './cache.js';

const TTL_MS = { platform: 10 * 60_000, tokenomics: 60 * 60_000, spells: 60 * 60_000 };

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const numberOrNull = (value) => (isNumber(value) ? value : null);
// GoMining sends token totals in wei (18 decimals) as strings.
const fromWei = (value) => {
  try {
    return Number(BigInt(String(value ?? '0').split('.')[0] || '0') / 10n ** 12n) / 1e6;
  } catch {
    return null;
  }
};
const unwrap = (response) => (response && typeof response === 'object' && 'data' in response ? response.data : response);

export class PlatformService {
  constructor({ client, now = Date.now, cache } = {}) {
    this.client = client;
    this.now = now;
    this.cache = cache ?? new TtlCache({ now, retryMs: 10 * 60_000 });
  }

  call(method, path, body) {
    return this.client.request(method, path, { auth: false, body }).then(unwrap);
  }

  veStatistics() {
    return this.call('POST', '/ve-gomining-lock/statistics', {}).then((data) => {
      const rows = Array.isArray(data?.array) ? data.array : [];
      if (!rows.length) throw new Error('GoMining returned no veGOMINING statistics');
      const networks = rows.map((row) => ({
        network: row.network === 'VIRTUAL_GMT' ? 'GoMining wallet' : String(row.network ?? '').slice(0, 20),
        locked: fromWei(row.totalLocked),
        votes: fromWei(row.totalVotes),
        averageLockDays: numberOrNull(row.averageLockPeriodInDays),
        yearlyIncomePerVote: numberOrNull(row.yearlyIncomePerVote),
      }));
      const locked = networks.reduce((sum, row) => sum + (row.locked ?? 0), 0);
      const votes = networks.reduce((sum, row) => sum + (row.votes ?? 0), 0);
      return {
        networks,
        locked: Math.round(locked),
        votes: Math.round(votes),
        // GoMining publishes one rate for all networks; GOMINING earned per vote per year.
        yearlyIncomePerVote: networks.find((row) => row.yearlyIncomePerVote !== null)?.yearlyIncomePerVote ?? null,
      };
    });
  }

  // Platform-wide counters, with GoMining's own one-day changes.
  platform() {
    return this.cache.get('platform', TTL_MS.platform, async () => {
      const [stats, market, ve] = await Promise.allSettled([
        this.call('GET', '/platform-statistics'),
        this.call('POST', '/nft/marketplace-statistics', {}),
        this.veStatistics(),
      ]);
      if (stats.status === 'rejected' && market.status === 'rejected') throw stats.reason;
      const s = stats.status === 'fulfilled' ? stats.value ?? {} : {};
      const m = market.status === 'fulfilled' ? market.value ?? {} : {};
      const day = m.oneDayDifference ?? {};
      return {
        updatedAt: new Date(this.now()).toISOString(),
        users: { mining: numberOrNull(s.miningUsersCount), registered: numberOrNull(m.usersRegistered), minerWars: numberOrNull(m.usersRegisteredInMinerWars), simpleEarn: numberOrNull(s.simpleEarnEnabledCount), cards: numberOrNull(s.cardsCreatedCount), holders: numberOrNull(m.holders) },
        hashrateTh: numberOrNull(s.totalHashrateTh) ?? numberOrNull(m.power),
        miners: { total: numberOrNull(m.nfts), generated: numberOrNull(m.minersGenerated), purchases: numberOrNull(m.purchases), upgrades: numberOrNull(m.upgradesCount) },
        secondaryMarket: { purchases: numberOrNull(m.secondaryMarketPurchasesCount), totalUsd: numberOrNull(m.secondaryMarketPurchasesTotalValue), lastWeekUsd: numberOrNull(m.oneWeekDifference?.secondaryMarketPurchasesTotalValue) },
        btcPaid: { total: numberOrNull(m.totalIncomes), minerWars: numberOrNull(m.totalIncomesInMinerWars) },
        tokensLocked: numberOrNull(s.totalTokensLocked) ?? numberOrNull(m.totalTokensLocked),
        lastDay: {
          miningUsers: numberOrNull(s.delta?.miningUsersCount),
          hashrateTh: numberOrNull(s.delta?.totalHashrateTh),
          simpleEarn: numberOrNull(s.delta?.simpleEarnEnabledCount),
          tokensLocked: numberOrNull(s.delta?.totalTokensLocked),
          miners: numberOrNull(day.nfts),
          upgrades: numberOrNull(day.upgradesCount),
          registered: numberOrNull(day.usersRegistered),
        },
        ve: ve.status === 'fulfilled' ? ve.value : null,
        errors: Object.fromEntries([['statistics', stats], ['marketplace', market], ['ve', ve]].filter(([, o]) => o.status === 'rejected').map(([k, o]) => [k, o.reason?.message ?? String(o.reason)])),
      };
    });
  }

  // Burn & Mint history, the current epoch's progress, and veGOMINING totals.
  tokenomics() {
    return this.cache.get('tokenomics', TTL_MS.tokenomics, async () => {
      const [cycles, ve] = await Promise.all([this.call('POST', '/mint-and-burn/index', {}), this.veStatistics().catch(() => null)]);
      const rows = Array.isArray(cycles?.array) ? cycles.array : [];
      if (!rows.length) throw new Error('GoMining returned no Burn & Mint cycles');
      const latestEpoch = Math.max(...rows.map((row) => Number(row.currentEpoch)).filter(Number.isInteger));
      const start = Number.isInteger(latestEpoch)
        ? await this.call('POST', '/mint-and-burn/get-epoch-start-date', { epoch: latestEpoch }).catch(() => null)
        : null;
      const summary = burnMintSummary(rows, { epochStart: start?.startDate });
      return { updatedAt: new Date(this.now()).toISOString(), ...summary, ve };
    });
  }

  // Miner Wars spells on sale now, with their GOMINING price and effect values.
  spells() {
    return this.cache.get('spells', TTL_MS.spells, async () => {
      const data = await this.call('POST', '/nft-game/nft-game-ability/find-all', {});
      const now = this.now();
      const rows = (Array.isArray(data?.array) ? data.array : [])
        .filter((row) => row?.enabled && Date.parse(row.availableFrom ?? 0) <= now && Date.parse(row.availableTo ?? 0) > now)
        .map((row) => ({
          type: String(row.type ?? '').slice(0, 30),
          tier: String(row.subtype ?? '').slice(0, 20),
          name: String(row.name ?? '').slice(0, 60),
          description: String(row.description ?? '').slice(0, 120),
          priceGomining: numberOrNull(row.priceInGMT),
          freeUses: numberOrNull(row.freeUsageCount),
          effect: row.data && typeof row.data === 'object' ? row.data : {},
        }));
      if (!rows.length) throw new Error('GoMining returned no Miner Wars spells');
      const order = { basic: 0, pro: 1, ultra: 2 };
      rows.sort((a, b) => a.type.localeCompare(b.type) || (order[a.tier] ?? 9) - (order[b.tier] ?? 9));
      return { updatedAt: new Date(now).toISOString(), spells: rows };
    });
  }
}
