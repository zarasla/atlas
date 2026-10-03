import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HALVING_NOTE, MAX_DISCOUNT_PCT, SIMPLE_EARN_ASSETS, SIMPLE_EARN_RATES_CHECKED, VIP_LEVELS, minerWarsClanNet, breakEvenBtcPrice, simpleEarn, vipStatus, calculateEarnings, dailyBreakdownPerTh, difficultyImpact, efficiencyCurve, findListedPrice, halving, hashprice, maintenanceDiscount, minerRoi, minerWarsVsSolo, payoutVsAverage, upgradeAdvisor } from '../core/calc.js';
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
export function createServer({ client, market, minerWars, allowWrites = false, remote = false }) {
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
    description: `GoMining maintenance discount from its parts, ${MAX_DISCOUNT_PCT}% at most: paying in GOMINING (1% per 18 days of maintenance your GOMINING balance covers, max 20%), VIP level (0% Bronze I to 6% Elite; pass vipLevel), the Service Button (+0.3% per day pressed in a row, max 3% after 10 days) and Mining mode (about 1.2%, derived from GoMining's 30.2% maximum; not for Miner Wars). Also how much GOMINING is needed for the next step and for the full 20%.`,
    inputSchema: {
      powerTh: z.number().positive().describe('Total TH of the miners'),
      efficiencyWth: z.number().positive().describe('Average W/TH'),
      gominingHeld: z.number().min(0).optional().describe('GOMINING in the virtual wallet plus locked'),
      vipLevel: z.enum(VIP_LEVELS.map((row) => row.name)).optional().describe('VIP level, e.g. "Platinum II" (sets the VIP discount)'),
      vipPct: z.number().min(0).max(6).optional().describe('VIP discount % instead of a level'),
      serviceButton: z.boolean().optional().describe('Service Button pressed 10 days in a row (3%)'),
      serviceButtonDays: z.number().int().min(0).max(10).optional().describe('Days in a row the Service Button was pressed (0.3% each, max 10)'),
      miningMode: z.boolean().optional().describe('In Mining mode (about +1.2%)'),
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
    description: 'GoMining VIP level from any one of three paths (mining power TH, locked veGOMINING, referral activity in USD over 180 days), its perks (maintenance discount, Simple Earn multiplier, reinvest bonus, referral royalty) and what the next level needs. Optionally estimates Simple Earn BTC rewards for an amount of BTC, USDT, USDC or BNB.',
    inputSchema: {
      powerTh: z.number().min(0).optional().describe('Own mining power in TH'),
      veGomining: z.number().min(0).optional().describe('Locked veGOMINING'),
      referralUsd: z.number().min(0).optional().describe('Referral activity over the last 180 days, USD'),
      earnAsset: z.enum(Object.keys(SIMPLE_EARN_ASSETS)).optional().describe('Simple Earn asset'),
      earnAmount: z.number().positive().optional().describe('Amount of that asset in Simple Earn'),
      earnAprPct: z.number().min(0).optional().describe(`Base APR % (defaults to GoMining's published rate as checked ${SIMPLE_EARN_RATES_CHECKED}; check the app)`),
      earnAssetPriceUsd: z.number().positive().optional().describe('Asset price in USD (needed for BNB)'),
    },
    annotations: readOnly,
  }, tool(async ({ powerTh, veGomining, referralUsd, earnAsset, earnAmount, earnAprPct, earnAssetPriceUsd }) => {
    const status = vipStatus({ powerTh, veGomining, referralUsd });
    if (!earnAsset || !earnAmount) return { ...status, levels: VIP_LEVELS };
    const data = await market.get();
    const btcPriceUsd = data.prices?.btc?.usd ?? data.income.btcPriceUsd;
    const assetPriceUsd = earnAssetPriceUsd ?? (earnAsset === 'BTC' ? btcPriceUsd : earnAsset === 'BNB' ? undefined : 1);
    return { ...status, simpleEarn: simpleEarn({ amount: earnAmount, assetPriceUsd, aprPct: earnAprPct ?? SIMPLE_EARN_ASSETS[earnAsset], vipLevel: status.level.name, btcPriceUsd }) };
  }));

  server.registerTool('gomining_clan_miner_wars', {
    title: 'HONKSQUAD in Miner Wars',
    description: 'HONKSQUAD\'s live Miner Wars standing in the current cycle from GoMining\'s public leaderboards: league, rank, zone (promotion, safe, relegation), blocks won, TH, the league prize fund and average BTC per block, the clan\'s estimated BTC this cycle (gross, before maintenance) with a rough net, neighbouring clans, and the players who mined for the clan this cycle. Optionally compares a week of Miner Wars with plain mining for a member\'s power using GoMining\'s rule: a full week of maintenance on the member\'s TH comes out of the reward, never below zero.',
    inputSchema: {
      powerTh: z.number().positive().optional().describe('A member\'s TH, to compare Miner Wars with plain mining'),
      efficiencyWth: z.number().positive().optional().describe('That member\'s W/TH (default 15)'),
      discountPct: z.number().min(0).max(100).optional().describe('That member\'s maintenance discount %'),
      joining: z.boolean().optional().describe('The member is not in HONKSQUAD yet (their TH is added to the clan total)'),
      includeBoard: z.boolean().optional().describe('Include the whole league board'),
    },
    annotations: readOnly,
  }, tool(async ({ powerTh, efficiencyWth = 15, discountPct = 0, joining = false, includeBoard = false }) => {
    if (!minerWars) throw new Error('Miner Wars data is not configured on this server');
    const data = await minerWars.get({ waitForMembers: true });
    if (data.status !== 'live') return data;
    const { board, ...rest } = data;
    const income = (await marketData()).income;
    const clanNet = minerWarsClanNet(income, { btcWeek: data.clan.btcWeekProjected ?? data.clan.btcSoFar, clanPowerTh: data.clan.powerTh, leagueEfficiencyWth: data.league.avgEfficiencyWth, leagueDiscountPct: data.league.avgDiscountPct ?? 0 });
    let comparison;
    if (powerTh) {
      comparison = minerWarsVsSolo(income, {
        powerTh, efficiencyWth, discountPct, joining, clanBlocksWeek: data.clan.blocksWeekProjected ?? data.clan.blocks, btcPerBlock: data.league.btcPerBlock,
        clanPowerTh: data.clan.powerTh, leagueEfficiencyWth: data.league.avgEfficiencyWth, leagueDiscountPct: data.league.avgDiscountPct ?? undefined,
      });
    }
    return {
      ...rest,
      ...(clanNet ? { clanWeekEstimate: { ...clanNet, note: 'Projected gross less a week of maintenance on the clan\'s TH at the league-average W/TH and discount (the clan\'s own average is not public). Each member\'s share is floored at zero separately.' } } : {}),
      ...(includeBoard ? { board } : {}),
      ...(comparison ? { vsSolo: comparison } : {}),
    };
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
      marketData: data.source,
      ...(data.source === 'sample' ? { liveErrors: data.errors, sampleCapturedAt: data.sampleCapturedAt } : {}),
    };
  }));

  return server;
}
