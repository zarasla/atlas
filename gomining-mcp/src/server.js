import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { calculateEarnings, findListedPrice, normalizeIncome, normalizePresets, normalizeUpgradeRates } from './calc.js';
import { GoMiningError } from './client.js';

const MARKET_CACHE_MS = 5 * 60 * 1000;
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

// Caches each public market call briefly: the payout changes once a day and prices rarely.
function cached(load, ttlMs, now) {
  let entry;
  return async () => {
    if (entry && now() - entry.at < ttlMs) return entry.value;
    const value = await load();
    entry = { at: now(), value };
    return value;
  };
}

export function createServer(client, { allowWrites = false, now = Date.now } = {}) {
  const server = new McpServer({ name: 'gomining', version: '0.1.0' });

  const market = cached(async () => normalizeIncome(await client.getIncome()), MARKET_CACHE_MS, now);
  const presets = cached(async () => normalizePresets(await client.getMinerPresets()), MARKET_CACHE_MS, now);
  const upgrades = cached(async () => normalizeUpgradeRates(await client.getUpgradeRates()), MARKET_CACHE_MS, now);

  server.registerTool('gomining_daily_reward', {
    title: 'GoMining daily reward',
    description: 'Latest GoMining daily payout per TH (USD and sats), BTC price used for the payout, electricity cost per W/TH, kWh price and service fee per TH.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(() => market()));

  server.registerTool('gomining_miner_prices', {
    title: 'GoMining miner prices',
    description: 'Digital miners GoMining currently sells: power (TH), energy efficiency (W/TH), price in USD and price per TH. Filter by efficiency or a budget.',
    inputSchema: {
      efficiencyWth: z.number().positive().optional().describe('Only miners at this energy efficiency, e.g. 12 or 15'),
      maxPriceUsd: z.number().positive().optional().describe('Only miners at or below this price'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ efficiencyWth, maxPriceUsd }) => {
    const rows = (await presets()).filter((row) => (efficiencyWth === undefined || row.efficiencyWth === efficiencyWth) && (maxPriceUsd === undefined || row.priceUsd <= maxPriceUsd));
    return { count: rows.length, efficienciesListed: [...new Set((await presets()).map((row) => row.efficiencyWth))], miners: rows };
  }));

  server.registerTool('gomining_upgrade_rates', {
    title: 'GoMining upgrade rates',
    description: 'GoMining price tables per W/TH level: what a TH is valued at for each efficiency, and what an owner pays per TH to upgrade a miner one W/TH.',
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(() => upgrades()));

  server.registerTool('gomining_calculate_earnings', {
    title: 'Calculate GoMining miner earnings',
    description: 'Estimate daily and period earnings for a GoMining miner of a given power and efficiency at the latest payout and fees: gross, electricity, service, net in USD, sats and BTC, plus payback days and annual return when a price is known. If priceUsd is omitted, the listed GoMining price for that exact miner is used when one exists.',
    inputSchema: {
      powerTh: z.number().positive().describe('Miner power in TH, e.g. 16'),
      efficiencyWth: z.number().positive().describe('Energy efficiency in W/TH, e.g. 15 (lower is better)'),
      days: z.number().int().positive().max(3650).optional().describe('Period length in days for totals (default 30)'),
      priceUsd: z.number().positive().optional().describe('What the miner cost or would cost, for the payback estimate'),
      useAverageReward: z.boolean().optional().describe('Use the 365-day average payout per TH instead of today\'s'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ powerTh, efficiencyWth, days, priceUsd, useAverageReward }) => {
    let price = priceUsd;
    let priceSource = price ? 'provided' : null;
    if (!price) {
      try {
        price = findListedPrice(await presets(), powerTh, efficiencyWth) ?? undefined;
        if (price) priceSource = 'GoMining listed price';
      } catch {
        // Prices are optional here; earnings still compute without them.
      }
    }
    const result = calculateEarnings(await market(), { powerTh, efficiencyWth, days, priceUsd: price, useAverageReward });
    return { ...result, priceSource };
  }));

  server.registerTool('gomining_api_request', {
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
    annotations: { readOnlyHint: false, destructiveHint: allowWrites, openWorldHint: true },
  }, tool(async ({ method = 'POST', path, body, query }) => {
    if (!allowWrites && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new GoMiningError(`${method} is blocked. Set GOMINING_ALLOW_WRITES=1 to allow changes to your GoMining account.`);
    }
    return client.request(method, path, { body, query });
  }));

  server.registerTool('gomining_status', {
    title: 'GoMining MCP status',
    description: 'Shows how this GoMining MCP server is configured: API base URL, whether a token is set, and whether writes are allowed.',
    annotations: { readOnlyHint: true },
  }, tool(async () => ({
    baseUrl: client.baseUrl,
    tokenConfigured: client.hasToken,
    writesAllowed: allowWrites,
    marketCacheSeconds: MARKET_CACHE_MS / 1000,
  })));

  return server;
}
