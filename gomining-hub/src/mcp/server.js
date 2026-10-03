import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  FIXED_MAX_DISCOUNT_PCT, HALVING_NOTE, SIMPLE_EARN_ASSETS, VE_MAX_LOCK_DAYS, VIP_LEVELS, breakEvenBtcPrice, breakEvenMatrix, calculateEarnings, clanFinder,
  dailyBreakdownPerTh, difficultyImpact, efficiencyCurve, findListedPrice, halving, hashprice, listedPricePerTh, maintenanceDiscount, minerRoi, minerWarsVsSolo,
  payoutVsAverage, pointsPerSecond, simpleEarn, simpleEarnVsMining, upgradeAdvisor, upgradeComparison, veLock, vipStatus,
} from '../core/calc.js';
import { GoMiningError } from '../core/client.js';

const MAX_RESPONSE_CHARS = 60_000;

const json = (value) => {
  let text = JSON.stringify(value, null, 2);
  if (text.length > MAX_RESPONSE_CHARS) {
    text = `${text.slice(0, MAX_RESPONSE_CHARS)}\n… truncated (${text.length} characters total). Narrow the request to see the rest.`;
  }
  return { content: [{ type: 'text', text }] };
};

const failure = (error) => {
  const detail = error instanceof GoMiningError && error.body !== undefined ? `\nResponse body: ${JSON.stringify(error.body).slice(0, 2000)}` : '';
  return { isError: true, content: [{ type: 'text', text: `${error?.message ?? String(error)}${detail}` }] };
};

const tool = (handler) => async (args) => {
  try {
    return json(await handler(args ?? {}));
  } catch (error) {
    return failure(error);
  }
};

// Every market answer says where its numbers came from, so Claude never presents sample data as live.
const provenance = (market, part) => ({
  dataSource: market.sources[part],
  ...(market.sources[part] === 'sample' ? { sampleCapturedAt: market.sampleCapturedAt, liveError: market.errors[part] } : {}),
});

// `remote`: the server behind the public /mcp/<key> URL. It gets the public tools only, never the raw
// GoMining API passthrough (GoMining uses POST for actions too, so a leaked URL must not reach it).
// Personal account data (balances, miners, real discounts, Simple Earn APRs) lives behind GoMining's
// own login; GoMining's official MCP connector serves it, so this server points there.
const OFFICIAL_MCP = 'https://mcp.gomining.com/mcp';

export function createServer({ client, market, minerWars, platform, allowWrites = false, remote = false }) {
  const server = new McpServer({ name: 'gomining-hub', version: '0.1.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const marketData = () => market.get();

  server.registerTool('gomining_daily_reward', {
    title: 'GoMining daily reward',
    description: 'Latest GoMining daily payout per TH (USD and sats), the BTC price used, electricity per W/TH, kWh price and service fee per TH. Optionally splits it for one efficiency.',
    inputSchema: {
      efficiencyWth: z.number().positive().optional().describe('Also show the per-TH split into electricity, service and net at this W/TH'),
    },
    annotations: readOnly,
  }, tool(async ({ efficiencyWth }) => {
    const data = await market.get();
    return {
      ...data.income,
      hashprice: hashprice(data.income),
      payoutVsAveragePct: payoutVsAverage(data.income),
      ...(efficiencyWth ? { breakdownPerTh: dailyBreakdownPerTh(data.income, efficiencyWth) } : {}),
      ...provenance(data, 'income'),
    };
  }));

  server.registerTool('gomining_miner_prices', {
    title: 'GoMining miner prices',
    description: 'Digital miners GoMining currently sells: power (TH), energy efficiency (W/TH), price in USD and price per TH. Filter by efficiency or budget.',
    inputSchema: {
      efficiencyWth: z.number().positive().optional().describe('Only miners at this energy efficiency, e.g. 12 or 15'),
      maxPriceUsd: z.number().positive().optional().describe('Only miners at or below this price'),
    },
    annotations: readOnly,
  }, tool(async ({ efficiencyWth, maxPriceUsd }) => {
    const data = await market.get();
    const miners = data.presets.filter((row) => (efficiencyWth === undefined || row.efficiencyWth === efficiencyWth) && (maxPriceUsd === undefined || row.priceUsd <= maxPriceUsd));
    return { count: miners.length, efficienciesListed: [...new Set(data.presets.map((row) => row.efficiencyWth))], miners, ...provenance(data, 'presets') };
  }));

  server.registerTool('gomining_upgrade_rates', {
    title: 'GoMining upgrade rates',
    description: 'GoMining price tables per W/TH level, both in USD per TH for ONE W/TH step: valuationSteps (a TH\'s value at a level is the SUM of the steps from the worst level down to it, so a single row is not a price per TH) and efficiencyUpgradeSteps (what an owner pays per TH to improve a miner by one W/TH to that level).',
    annotations: readOnly,
  }, tool(async () => {
    const data = await market.get();
    return { ...data.upgrades, ...provenance(data, 'upgrades') };
  }));

  server.registerTool('gomining_efficiency_curve', {
    title: 'Net reward by efficiency',
    description: 'Net reward per TH per day at each energy efficiency from 12 to 20 W/TH at today\'s payout and fees, plus the break-even W/TH above which a miner earns nothing.',
    annotations: readOnly,
  }, tool(async () => {
    const data = await market.get();
    return { ...efficiencyCurve(data.income), ...provenance(data, 'income') };
  }));

  server.registerTool('gomining_miner_roi', {
    title: 'Payback of every GoMining miner',
    description: 'Every miner GoMining sells with its price, daily net reward, payback days and annual return at today\'s payout and fees, sorted fastest payback first.',
    inputSchema: {
      efficiencyWth: z.number().positive().optional().describe('Only miners at this efficiency'),
      maxPriceUsd: z.number().positive().optional().describe('Only miners at or below this price'),
    },
    annotations: readOnly,
  }, tool(async ({ efficiencyWth, maxPriceUsd }) => {
    const data = await market.get();
    const rows = minerRoi(data.income, data.presets)
      .filter((row) => (efficiencyWth === undefined || row.efficiencyWth === efficiencyWth) && (maxPriceUsd === undefined || row.priceUsd <= maxPriceUsd))
      .sort((a, b) => (a.paybackDays ?? Infinity) - (b.paybackDays ?? Infinity));
    return { count: rows.length, miners: rows, ...provenance(data, 'presets') };
  }));

  server.registerTool('gomining_upgrade_advisor', {
    title: 'Is a W/TH upgrade worth it?',
    description: 'For each one-step efficiency upgrade (e.g. 16 to 15 W/TH): GoMining\'s cost per TH, the electricity it saves per TH per day, and the payback in days.',
    annotations: readOnly,
  }, tool(async () => {
    const data = await market.get();
    return { steps: upgradeAdvisor(data.income, data.upgrades), ...provenance(data, 'upgrades') };
  }));

  server.registerTool('gomining_network_stats', {
    title: 'Bitcoin network and prices',
    description: 'Bitcoin network hashrate, difficulty, next difficulty adjustment (progress, expected change, date), block height and fees from mempool.space, plus BTC and GOMINING token prices with 24h change from CoinGecko.',
    annotations: readOnly,
  }, tool(async () => {
    const data = await market.get();
    return {
      network: data.network,
      prices: data.prices,
      sources: { network: data.sources.network, prices: data.sources.prices },
      ...(data.errors.network || data.errors.prices ? { errors: { network: data.errors.network, prices: data.errors.prices } } : {}),
    };
  }));

  server.registerTool('gomining_outlook', {
    title: 'What could change the payout',
    description: `Break-even BTC price for each W/TH at today\'s difficulty (the BTC price where the payout only just covers electricity and service, measured against GoMining\'s payout BTC rate), what the next difficulty adjustment does to sats per TH, the halving countdown (at 10-minute blocks), and the crypto Fear & Greed index. All pre-halving: ${HALVING_NOTE}`,
    inputSchema: {
      discountPct: z.number().min(0).max(100).optional().describe('Maintenance discount % for the break-even prices'),
      powerTh: z.number().positive().optional().describe('Also show the sats-per-day change from the difficulty adjustment for this many TH'),
    },
    annotations: readOnly,
  }, tool(async ({ discountPct, powerTh }) => {
    const data = await market.get();
    const network = data.network;
    return {
      breakEven: breakEvenBtcPrice(data.income, { discountPct }),
      difficulty: difficultyImpact(data.income, network?.nextAdjustment, { powerTh }),
      halving: network ? halving(network.blockHeight, { satsPerThDay: data.income.rewardSatsPerThDay }) : null,
      fearGreed: data.sentiment,
      sources: { income: data.sources.income, network: data.sources.network, sentiment: data.sources.sentiment },
    };
  }));

  server.registerTool('gomining_maintenance_discount', {
    title: 'Maintenance discount builder',
    description: `GoMining maintenance discount from its parts (docs.gomining.com): paying in GOMINING (1% per 18 days of maintenance your GOMINING wallet plus locked balance covers, max 20%), VIP level (0% Bronze I to 6% Elite; pass vipLevel) and the Service Button (+0.3% per day pressed in a row, max 3% after 10 days), ${FIXED_MAX_DISCOUNT_PCT}% together at most. Mining mode adds its own discount, which changes every week with the Burn & Mint vote and is only shown in the member's app: pass miningModePct from there (it is never assumed). Also how much GOMINING is needed for the next step and for the full 20%.`,
    inputSchema: {
      powerTh: z.number().positive().describe('Total TH of the miners'),
      efficiencyWth: z.number().positive().describe('Average W/TH'),
      gominingHeld: z.number().min(0).optional().describe('GOMINING in the virtual wallet plus locked'),
      vipLevel: z.enum(VIP_LEVELS.map((row) => row.name)).optional().describe('VIP level, e.g. "Platinum II" (sets the VIP discount)'),
      vipPct: z.number().min(0).max(6).optional().describe('VIP discount % instead of a level'),
      serviceButton: z.boolean().optional().describe('Service Button pressed 10 days in a row (3%)'),
      serviceButtonDays: z.number().int().min(0).max(10).optional().describe('Days in a row the Service Button was pressed (0.3% each, max 10)'),
      miningModePct: z.number().min(0).max(100).optional().describe('Mining mode discount % exactly as the member\'s GoMining app shows it this week (0 in Miner Wars or during the trial)'),
    },
    annotations: readOnly,
  }, tool(async (args) => {
    const data = await market.get();
    const gominingUsd = data.prices?.gomining?.usd;
    return {
      ...maintenanceDiscount(data.income, { ...args, gominingUsd }),
      gominingUsd: gominingUsd ?? null,
      ...(gominingUsd ? {} : { note: 'The GOMINING price is unavailable right now, so the GOMINING part counts as 0%; VIP and Service Button are included' }),
    };
  }));

  server.registerTool('gomining_vip', {
    title: 'VIP level and Simple Earn',
    description: `GoMining VIP level (official table, gomining.com/vip) from mining power TH or locked veGOMINING votes, whichever is higher, with its perks (maintenance discount, Simple Earn multiplier, Instant Funds fee, Launchpad allocation, reinvest bonus, referral royalty) and what the next level needs. Referral activity is a third path whose thresholds only the app shows. Optionally estimates Simple Earn rewards: Simple Earn APRs change often and only the member's wallet shows them, so earnAprPct must come from there. For the member's real VIP level and Simple Earn rates, GoMining's official MCP connector (${OFFICIAL_MCP}) reads them from their account.`,
    inputSchema: {
      powerTh: z.number().min(0).optional().describe('Own mining power in TH'),
      veGomining: z.number().min(0).optional().describe('veGOMINING votes'),
      earnAsset: z.enum(SIMPLE_EARN_ASSETS).optional().describe('Simple Earn asset'),
      earnAmount: z.number().positive().optional().describe('Amount of that asset in Simple Earn'),
      earnAprPct: z.number().min(0).optional().describe('Base APR % for that asset, as the GoMining wallet shows it'),
      earnAssetPriceUsd: z.number().positive().optional().describe('Asset price in USD (BTC and stablecoins are filled in)'),
      rewardInTh: z.boolean().optional().describe('Simple Earn rewards paid in TH (+10% TH, only for cycles of $0.10 or more)'),
    },
    annotations: readOnly,
  }, tool(async ({ powerTh, veGomining, earnAsset, earnAmount, earnAprPct, earnAssetPriceUsd, rewardInTh }) => {
    const status = vipStatus({ powerTh, veGomining });
    if (!earnAsset || !earnAmount) return { ...status, levels: VIP_LEVELS };
    if (earnAprPct === undefined) throw new Error('earnAprPct is needed: Simple Earn APRs change often and only the GoMining wallet shows the current one');
    const data = await market.get();
    const btcPriceUsd = data.prices?.btc?.usd ?? data.income.btcPriceUsd;
    const assetPriceUsd = earnAssetPriceUsd ?? (earnAsset === 'BTC' ? btcPriceUsd : ['USDT', 'USDC'].includes(earnAsset) ? 1 : undefined);
    if (!assetPriceUsd) throw new Error(`earnAssetPriceUsd is needed for ${earnAsset}`);
    return { ...status, simpleEarn: simpleEarn({ amount: earnAmount, assetPriceUsd, aprPct: earnAprPct, vipLevel: status.level.name, btcPriceUsd, rewardInTh }) };
  }));

  const needsMinerWars = () => {
    if (!minerWars) throw new Error('Miner Wars data is not configured on this server');
    return minerWars;
  };
  const leagueRef = z.union([z.number().int().positive(), z.string().min(2)]).describe('League id (1 Odyssey, 3 Eclipse, 4 Horizon, 5+ Dune divisions) or name, e.g. "Eclipse" or "Dune 12"');
  const resolveLeague = async (ref) => {
    const { leagues } = await needsMinerWars().leagues();
    const league = typeof ref === 'number' ? leagues.find((row) => row.id === ref) : leagues.find((row) => row.name.toLowerCase() === String(ref).trim().toLowerCase().replace(/-/g, ' '));
    if (!league) throw new Error(`No league ${JSON.stringify(ref)} this cycle. Leagues: ${leagues.map((row) => row.name).join(', ')}`);
    return league;
  };

  server.registerTool('gomining_miner_wars_leagues', {
    title: 'Miner Wars leagues',
    description: 'Every Miner Wars league this cycle (Odyssey, Eclipse, Horizon and the Dune divisions) from GoMining\'s public data: clan slots, promotion and relegation targets, and GoMining\'s published odds of each round multiplier with the resulting average multiplier. Also the cycle number and dates (Tuesday to Tuesday UTC).',
    annotations: readOnly,
  }, tool(async () => needsMinerWars().leagues()));

  server.registerTool('gomining_miner_wars_board', {
    title: 'Miner Wars clan board',
    description: 'A Miner Wars league\'s live clan board from GoMining\'s public leaderboard: every clan\'s position, zone, blocks won, TH and estimated BTC so far (gross, before maintenance), plus the league\'s prize fund, BTC per block and weighted average W/TH and discount. Give a league, or a clan name to find it in any league. With powerTh, also compares a week in that clan with plain mining using GoMining\'s rules (a full week of maintenance on all your TH comes out of your share, never below zero; reward beyond Mining mode is charged at the league averages; the joining day earns no Mining mode reward).',
    inputSchema: {
      league: leagueRef.optional(),
      clan: z.string().min(2).optional().describe('Clan name (or part of it) to look up across all leagues'),
      powerTh: z.number().positive().optional().describe('Your TH, to compare a week in the clan with plain mining'),
      efficiencyWth: z.number().positive().optional().describe('Your W/TH (default 15)'),
      discountPct: z.number().min(0).max(100).optional().describe('Your maintenance discount %'),
      member: z.boolean().optional().describe('You are already in the clan (your TH is part of its total)'),
      includeBoard: z.boolean().optional().describe('Include every clan on the board'),
    },
    annotations: readOnly,
  }, tool(async ({ league, clan, powerTh, efficiencyWth = 15, discountPct = 0, member = false, includeBoard = false }) => {
    if (!league && !clan) throw new Error('Give a league or a clan name');
    let target = null;
    let leagueId;
    if (clan) {
      const found = await needsMinerWars().search(clan, { limit: 10 });
      if (!found.count) return { ...found, note: 'No clan with that name on any league board this cycle' };
      target = found.clans[0];
      leagueId = target.leagueId;
      if (!powerTh && !includeBoard) return found;
    } else {
      leagueId = (await resolveLeague(league)).id;
    }
    const board = await needsMinerWars().board(leagueId);
    const row = target ? board.clans.find((c) => c.clanId === target.clanId) ?? target : null;
    const income = (await marketData()).income;
    // Joining adds your own fair chance on top of the clan's pace: the league's weekly blocks x your share of league power.
    const lg = board.league;
    const extra = member || !(lg.totalPowerTh > 0) || !powerTh ? 0 : (lg.blocksWeekProjected ?? 0) * (powerTh / (lg.totalPowerTh + powerTh));
    const vs = row && powerTh ? minerWarsVsSolo(income, {
      powerTh, efficiencyWth, discountPct, joining: !member, clanBlocksWeek: (row.blocksWeekProjected ?? row.blocks) + extra, btcPerBlock: board.league.btcPerBlock,
      clanPowerTh: row.powerTh, leagueEfficiencyWth: board.league.avgEfficiencyWth, leagueDiscountPct: board.league.avgDiscountPct ?? undefined,
    }) : null;
    return {
      cycle: board.cycle,
      league: board.league,
      ...(row ? { clan: row } : {}),
      ...(vs ? { vsSolo: vs } : {}),
      ...(includeBoard || !row ? { board: board.clans } : { top: board.clans.slice(0, 10) }),
      ...(board.stale ? { stale: true, asOf: board.asOf } : {}),
    };
  }));

  server.registerTool('gomining_clan_finder', {
    title: 'Best Miner Wars clan for your miners',
    description: 'Ranks every clan on a league board by what a week in it would pay you, at each clan\'s pace so far this cycle and GoMining\'s maintenance rules (full week of maintenance on all your TH, never below zero, beyond-Mining-mode reward at the league averages, one day of Mining mode lost when joining). Your TH is added to each clan; blocks are assumed to grow with the clan\'s share of league power. Also your points per second (TH x 20 / W/TH). An estimate: multipliers, spells and other players change the outcome.',
    inputSchema: {
      league: leagueRef,
      powerTh: z.number().positive().describe('Your TH'),
      efficiencyWth: z.number().positive().describe('Your W/TH'),
      discountPct: z.number().min(0).max(100).optional().describe('Your maintenance discount %'),
      limit: z.number().int().min(1).max(50).optional().describe('How many clans to return (default 15)'),
    },
    annotations: readOnly,
  }, tool(async ({ league, powerTh, efficiencyWth, discountPct = 0, limit = 15 }) => {
    const board = await needsMinerWars().board((await resolveLeague(league)).id);
    const income = (await marketData()).income;
    const result = clanFinder(income, { board: board.clans, league: board.league, elapsedDays: board.cycle.elapsedDays, powerTh, efficiencyWth, discountPct, limit });
    return { cycle: board.cycle, league: board.league.name, pointsPerSecond: pointsPerSecond(powerTh, efficiencyWth), ...result };
  }));

  server.registerTool('gomining_spells', {
    title: 'Miner Wars spells and prices',
    description: 'Miner Wars spells and power-ups on sale now (GoMining\'s public list): type, tier, GOMINING price and effect values. 97.5% of GOMINING spent on spells goes to the personal-battle prize pool.',
    annotations: readOnly,
  }, tool(async () => {
    if (!platform) throw new Error('Platform data is not configured on this server');
    return platform.spells();
  }));

  server.registerTool('gomining_platform_stats', {
    title: 'GoMining platform statistics',
    description: 'GoMining\'s public platform counters: users mining, total hashrate, Simple Earn users, cards, miners, upgrades, holders, secondary-market volume, BTC paid out (all time, and in Miner Wars), GOMINING locked, veGOMINING totals and income per vote, with GoMining\'s own one-day changes.',
    annotations: readOnly,
  }, tool(async () => {
    if (!platform) throw new Error('Platform data is not configured on this server');
    return platform.platform();
  }));

  server.registerTool('gomining_tokenomics', {
    title: 'GOMINING Burn & Mint and veGOMINING',
    description: `GOMINING tokenomics from GoMining's public record: every weekly Burn & Mint cycle (GOMINING burned from maintenance paid in tokens, minted, net burned, the share of votes for burning read back from the mint formula, and what went to veGOMINING holders), the current epoch's progress, and veGOMINING totals with GoMining's yearly income per vote. With lockAmount, also simulates a lock: votes (amount x days / ${VE_MAX_LOCK_DAYS}, falling to zero at the end), the VIP level they give and for how long, and rewards at the current income per vote.`,
    inputSchema: {
      weeks: z.number().int().min(1).max(400).optional().describe('How many recent weekly cycles to include (default 12)'),
      lockAmount: z.number().positive().optional().describe('GOMINING to lock, for the lock simulation'),
      lockDays: z.number().int().min(7).max(VE_MAX_LOCK_DAYS).optional().describe(`Lock length in days, 7 to ${VE_MAX_LOCK_DAYS} (default ${VE_MAX_LOCK_DAYS}, 4 years)`),
    },
    annotations: readOnly,
  }, tool(async ({ weeks = 12, lockAmount, lockDays = VE_MAX_LOCK_DAYS }) => {
    if (!platform) throw new Error('Platform data is not configured on this server');
    const data = await platform.tokenomics();
    const gominingUsd = (await marketData()).prices?.gomining?.usd;
    return {
      latest: data.latest,
      epoch: data.epoch,
      totals: data.totals,
      ve: data.ve,
      weeks: data.weeks.slice(-weeks),
      ...(lockAmount ? { lock: veLock({ amount: lockAmount, lockDays, yearlyIncomePerVote: data.ve?.yearlyIncomePerVote, gominingUsd }) } : {}),
    };
  }));

  server.registerTool('gomining_planner', {
    title: 'Mining planner',
    description: 'Planning maths at today\'s GoMining payout and fees: (1) a break-even matrix of net reward per TH per day for each W/TH at several BTC prices; (2) with powerTh and budgetUsd, whether the budget earns more as efficiency upgrades (GoMining\'s per-step prices) or as more TH (at powerPricePerThUsd, default GoMining\'s new-miner list price per TH at that efficiency); (3) with capitalUsd and simpleEarnAprPct, the same money in Simple Earn versus new TH.',
    inputSchema: {
      btcPrices: z.array(z.number().positive()).max(12).optional().describe('BTC prices for the break-even matrix (default: today and ±25/50%)'),
      discountPct: z.number().min(0).max(100).optional().describe('Total maintenance discount %'),
      powerTh: z.number().positive().optional().describe('Your miner\'s TH, for the upgrade comparison'),
      efficiencyWth: z.number().positive().optional().describe('Your miner\'s W/TH (default 15)'),
      budgetUsd: z.number().positive().optional().describe('Budget to spend on upgrades'),
      powerPricePerThUsd: z.number().positive().optional().describe('What adding a TH costs you (your app\'s power-upgrade price)'),
      capitalUsd: z.number().positive().optional().describe('Amount for Simple Earn vs mining'),
      simpleEarnAprPct: z.number().min(0).optional().describe('Simple Earn base APR % from your wallet'),
      vipLevel: z.enum(VIP_LEVELS.map((row) => row.name)).optional().describe('VIP level for the Simple Earn multiplier'),
    },
    annotations: readOnly,
  }, tool(async ({ btcPrices, discountPct = 0, powerTh, efficiencyWth = 15, budgetUsd, powerPricePerThUsd, capitalUsd, simpleEarnAprPct, vipLevel }) => {
    const data = await market.get();
    const btc = data.income.btcPriceUsd;
    const listed = listedPricePerTh(data.presets, Math.round(efficiencyWth));
    const result = { matrix: breakEvenMatrix(data.income, { btcPrices: btcPrices ?? [0.5, 0.75, 1, 1.25, 1.5, 2].map((k) => Math.round(btc * k)), discountPct }), ...provenance(data, 'income') };
    if (powerTh && budgetUsd) result.upgrade = upgradeComparison(data.income, data.upgrades, { powerTh, efficiencyWth, budgetUsd, discountPct, powerPricePerThUsd: powerPricePerThUsd ?? listed ?? undefined });
    if (capitalUsd && simpleEarnAprPct !== undefined) {
      if (!listed) throw new Error(`GoMining lists no new miners at ${Math.round(efficiencyWth)} W/TH to compare with`);
      result.simpleEarnVsMining = simpleEarnVsMining(data.income, { capitalUsd, aprPct: simpleEarnAprPct, vipLevel, efficiencyWth, pricePerThUsd: listed, discountPct });
    }
    return result;
  }));

  server.registerTool('gomining_calculate_earnings', {
    title: 'Calculate GoMining miner earnings',
    description: 'Estimate daily and period earnings for a GoMining miner of a given power and efficiency at the latest payout and fees: gross, electricity, service, net in USD, sats and BTC, plus payback days and annual return when a price is known. Without priceUsd, the listed GoMining price for that exact miner is used when one exists.',
    inputSchema: {
      powerTh: z.number().positive().describe('Miner power in TH, e.g. 16'),
      efficiencyWth: z.number().positive().describe('Energy efficiency in W/TH, e.g. 15 (lower is better)'),
      days: z.number().int().positive().max(3650).optional().describe('Period length in days for totals (default 30)'),
      priceUsd: z.number().positive().optional().describe('What the miner cost or would cost, for the payback estimate'),
      useAverageReward: z.boolean().optional().describe('Use the 365-day average payout per TH instead of today\'s'),
    },
    annotations: readOnly,
  }, tool(async ({ powerTh, efficiencyWth, days, priceUsd, useAverageReward }) => {
    const data = await market.get();
    const listed = priceUsd ? null : findListedPrice(data.presets, powerTh, efficiencyWth);
    const price = priceUsd ?? listed ?? undefined;
    return {
      ...calculateEarnings(data.income, { powerTh, efficiencyWth, days, priceUsd: price, useAverageReward }),
      priceSource: priceUsd ? 'provided' : listed ? 'GoMining listed price' : null,
      ...provenance(data, 'income'),
    };
  }));

  server.registerTool('gomining_payout_history', {
    title: 'GoMining payout history',
    description: 'Daily payout per TH, BTC price and fees recorded by this server each day it fetched live data (GoMining\'s API has no history endpoint, so the series starts the first day the server ran).',
    inputSchema: {
      days: z.number().int().positive().max(730).optional().describe('Only the most recent N days'),
    },
    annotations: { readOnlyHint: true },
  }, tool(async ({ days }) => {
    const rows = await market.history();
    const slice = days ? rows.slice(-days) : rows;
    return { count: slice.length, firstDate: slice[0]?.date ?? null, lastDate: slice.at(-1)?.date ?? null, rows: slice };
  }));

  if (!remote) server.registerTool('gomining_api_request', {
    title: 'Call the GoMining API',
    description: [
      'Call any GoMining API endpoint under https://api.gomining.com/api and return the JSON response.',
      'Use it for account data (your miners, rewards, wallet, clan, league) that the other tools do not cover.',
      'Sends the GOMINING_TOKEN bearer token when one is configured. GoMining reads data with POST as often as GET, so check the endpoint before calling it.',
      allowWrites ? '' : 'PUT, PATCH and DELETE are blocked unless GOMINING_ALLOW_WRITES=1.',
    ].filter(Boolean).join(' '),
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST').describe('HTTP method'),
      path: z.string().describe('API path after /api, starting with "/", e.g. /nft/get-upgrade-rate'),
      body: z.record(z.string(), z.unknown()).optional().describe('JSON body for POST/PUT/PATCH (default {})'),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query string parameters'),
    },
    // POST can change an account on GoMining, so the tool is always marked as possibly destructive.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, tool(async ({ method = 'POST', path, body, query }) => {
    if (!allowWrites && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new GoMiningError(`${method} is blocked. Set GOMINING_ALLOW_WRITES=1 to allow changes to your GoMining account.`);
    }
    return client.request(method, path, { body, query });
  }));

  server.registerTool('gomining_status', {
    title: 'GoMining Hub status',
    description: 'Shows how this server is configured and whether GoMining is reachable: base URL, token set, writes allowed, and whether market data is live or sample.',
    annotations: { readOnlyHint: true },
  }, tool(async () => {
    const data = await market.get();
    return {
      baseUrl: client.baseUrl,
      tokenConfigured: client.hasToken,
      writesAllowed: allowWrites,
      accountTools: remote ? 'not available on the remote connector (public data only)' : 'gomining_api_request',
      personalData: `For your own balances, miners, rewards, VIP level and Simple Earn rates, connect GoMining's official MCP: ${OFFICIAL_MCP}`,
      marketData: data.source,
      ...(data.source === 'sample' ? { liveErrors: data.errors, sampleCapturedAt: data.sampleCapturedAt } : {}),
    };
  }));

  return server;
}
