#!/usr/bin/env node
// Serves the dashboard (public/) and a small JSON API over the shared market service.
//
//   GET /api/market     payout, prices, network, miner ROI, upgrade advisor, efficiency curve, sources
//   GET /api/history    payouts recorded on days this server fetched live data
//   GET /api/ticker     BTC and GOMINING prices plus the top 50 coins by market cap (ticker bar)
//   GET /api/minerwars  HONKSQUAD's Miner Wars league, rank, blocks, prize estimate and members
//   GET /api/earnings   ?powerTh=16&efficiencyWth=15&days=30[&priceUsd=250][&average=1]
//   /mcp/<MCP_ACCESS_KEY>  the MCP server over Streamable HTTP, for Claude's custom connectors
//
// The dashboard routes never see a GoMining token. The remote MCP endpoint is off unless
// MCP_ACCESS_KEY is set (at least 32 characters); the key is the secret part of the URL, so only
// someone with the full connector URL can reach the tools. Never commit the key or the URL.

import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateEarnings, findListedPrice, marketSummary } from '../core/calc.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ExternalService } from '../core/external.js';
import { fromEnv } from '../core/config.js';
import { TickerService } from '../core/ticker.js';
import { createServer as createMcpServer } from '../mcp/server.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
// The browser calculator imports the exact same maths the server and MCP tools use.
const CALC_MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'calc.js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    // Google Fonts serves the Russo One headline face; everything else is same-origin only.
    'content-security-policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const MAX_BODY_BYTES = 1_000_000;
const MIN_KEY_LENGTH = 32;

// Constant-time comparison so the key can't be guessed one character at a time.
const sameKey = (given, expected) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

// Stateless MCP: a fresh server and transport per request, which is all Claude's connectors need.
async function handleMcp(req, res, mcp) {
  const body = req.method === 'POST' ? await readJson(req) : undefined;
  const server = createMcpServer(mcp);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const origin = (req) => {
  const host = String(req.headers.host ?? '');
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return '';
  const proto = req.headers['x-forwarded-proto'] === 'http' && /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https';
  return `${proto}://${host}`;
};

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

/**
 * @param {object} options
 * @param {import('../core/market.js').MarketService} options.market  tokenless market for the dashboard
 * @param {{ key: string, client: object, market: object, allowWrites?: boolean }} [options.mcp]
 *   enables /mcp/<key>; omitted or a short key leaves the endpoint off
 */
export function createApp({ market, mcp, ticker, minerWars }) {
  const mcpEnabled = Boolean(mcp?.key && mcp.key.length >= MIN_KEY_LENGTH);
  const routes = {
    '/api/market': async (url) => {
      const data = await market.get({ fresh: url.searchParams.get('refresh') === '1' });
      return { ...data, ...marketSummary(data) };
    },
    '/api/history': async () => ({ rows: await market.history() }),
    '/api/ticker': async () => (ticker ? ticker.get() : { btc: null, gomining: null, coins: [] }),
    '/api/minerwars': async () => (minerWars ? minerWars.get() : { status: 'unavailable', error: 'Miner Wars data is not configured' }),
    '/api/earnings': async (url) => {
      const query = url.searchParams;
      const powerTh = positive(query.get('powerTh'));
      const efficiencyWth = positive(query.get('efficiencyWth'));
      if (!powerTh || !efficiencyWth) return [400, { error: 'powerTh and efficiencyWth must be positive numbers' }];
      const days = Math.min(Math.round(positive(query.get('days')) ?? 30), 3650);
      const data = await market.get();
      const given = positive(query.get('priceUsd'));
      const listed = given ? null : findListedPrice(data.presets, powerTh, efficiencyWth);
      return {
        ...calculateEarnings(data.income, { powerTh, efficiencyWth, days, priceUsd: given ?? listed ?? undefined, useAverageReward: query.get('average') === '1' }),
        priceSource: given ? 'provided' : listed ? 'GoMining listed price' : null,
        dataSource: data.sources.income,
      };
    },
  };

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
        const key = url.pathname.slice('/mcp/'.length);
        // Same 404 for "off" and "wrong key", so the endpoint's existence isn't revealed.
        if (!mcpEnabled || !sameKey(key, mcp.key)) return send(res, 404, { error: 'Not found' });
        return await handleMcp(req, res, mcp);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      const route = routes[url.pathname];
      if (route) {
        const result = await route(url);
        return Array.isArray(result) ? send(res, result[0], result[1]) : send(res, 200, result);
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      if (url.pathname === '/lib/calc.js') return send(res, 200, await readFile(CALC_MODULE), TYPES['.js']);

      // Static files, confined to public/.
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = normalize(join(PUBLIC_DIR, relative));
      if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 403, 'Forbidden', 'text/plain');
      let body = await readFile(file).catch(() => null);
      if (!body) return send(res, 404, 'Not found', 'text/plain');
      // Link previews (Discord) need absolute URLs; use the address the page was requested on so no
      // domain is hard-coded. Only a plain host name is accepted, never arbitrary header text.
      if (extname(file) === '.html') body = Buffer.from(body.toString('utf8').replaceAll('__ORIGIN__', origin(req)));
      return send(res, 200, body, TYPES[extname(file)] ?? 'application/octet-stream');
    } catch (error) {
      if (res.headersSent) return res.end();
      return send(res, error?.status ?? 500, { error: error?.message ?? String(error) });
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT) || 4173;
  const host = process.env.HOST || '127.0.0.1';
  const dashboard = fromEnv(process.env, { withToken: false });
  const key = process.env.MCP_ACCESS_KEY?.trim();
  // The MCP tools may use a GoMining token (from the VPS env file); the dashboard never does.
  const mcp = key ? { key, ...fromEnv(process.env), market: dashboard.market, minerWars: dashboard.minerWars } : undefined;
  const ticker = new TickerService({ external: new ExternalService() });
  createHttpServer(createApp({ market: dashboard.market, mcp, ticker, minerWars: dashboard.minerWars })).listen(port, host, () => {
    console.log(`GoMining Hub dashboard: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (key && key.length < MIN_KEY_LENGTH) console.log(`Remote MCP is OFF: MCP_ACCESS_KEY must be at least ${MIN_KEY_LENGTH} characters`);
    else console.log(`Remote MCP: ${key ? 'on at /mcp/<MCP_ACCESS_KEY>' : 'off (MCP_ACCESS_KEY not set)'}`);
  });
}
