// Builds the shared GoMining client and market service from the environment.
//
//   GOMINING_TOKEN         bearer token from app.gomining.com, for account endpoints (optional)
//   GOMINING_BASE_URL      API base URL (default https://api.gomining.com/api)
//   GOMINING_ALLOW_WRITES  set to 1 to allow PUT/PATCH/DELETE through the API passthrough

import { DEFAULT_BASE_URL, GoMiningClient } from './client.js';
import { MarketService } from './market.js';

export function fromEnv(env = process.env) {
  const client = new GoMiningClient({
    baseUrl: env.GOMINING_BASE_URL || DEFAULT_BASE_URL,
    token: env.GOMINING_TOKEN?.replace(/^Bearer\s+/i, '').trim(),
  });
  return { client, market: new MarketService({ client }), allowWrites: env.GOMINING_ALLOW_WRITES === '1' };
}
