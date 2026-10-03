// Builds the shared GoMining client and market service from the environment.
//
//   GOMINING_TOKEN         bearer token from app.gomining.com, for account endpoints (optional)
//   GOMINING_BASE_URL      API base URL (default https://api.gomining.com/api)
//   GOMINING_ALLOW_WRITES  set to 1 to allow PUT/PATCH/DELETE through the API passthrough
//   GOMINING_HISTORY_PATH  where recorded payout days are saved (default data/history.json)
//
// The dashboard calls fromEnv(env, { withToken: false }): it only serves public data, so a token
// in its environment is never loaded into memory.

import { DEFAULT_BASE_URL, GoMiningClient } from './client.js';
import { ExternalService } from './external.js';
import { MarketService } from './market.js';

export function fromEnv(env = process.env, { withToken = true } = {}) {
  const client = new GoMiningClient({
    baseUrl: env.GOMINING_BASE_URL || DEFAULT_BASE_URL,
    token: withToken ? env.GOMINING_TOKEN?.replace(/^Bearer\s+/i, '').trim() : undefined,
  });
  const market = new MarketService({ client, external: new ExternalService(), ...(env.GOMINING_HISTORY_PATH ? { historyPath: env.GOMINING_HISTORY_PATH } : {}) });
  return { client, market, allowWrites: withToken && env.GOMINING_ALLOW_WRITES === '1' };
}
