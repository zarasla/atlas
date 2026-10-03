import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GoMiningClient } from '../src/core/client.js';
import { MarketService } from '../src/core/market.js';
import { createApp } from '../src/web/server.js';
import { fakeFetch } from './fake-api.js';

const KEY = 'test-key-0123456789abcdef0123456789abcdef';
let server;
let base;

before(async () => {
  const client = new GoMiningClient({ fetchImpl: fakeFetch().fetchImpl });
  const market = new MarketService({ client, historyPath: join(await mkdtemp(join(tmpdir(), 'gomining-remote-')), 'history.json') });
  server = createServer(createApp({ market, mcp: { key: KEY, client, market } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('remote MCP works with the right key', async () => {
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${KEY}`)));
  const { tools } = await mcp.listTools();
  assert.ok(tools.some((t) => t.name === 'gomining_calculate_earnings'));
  const result = await mcp.callTool({ name: 'gomining_daily_reward', arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).rewardSatsPerThDay, 50);
  await mcp.close();
});

test('remote MCP is invisible without the exact key', async () => {
  const init = { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };
  for (const path of ['/mcp', '/mcp/', `/mcp/${KEY.slice(0, -1)}`, `/mcp/${KEY}x`, '/mcp/wrong']) {
    assert.equal((await fetch(base + path, init)).status, 404, path);
  }
});

test('remote MCP stays off when the key is too short', async () => {
  const client = new GoMiningClient({ fetchImpl: fakeFetch().fetchImpl });
  const market = new MarketService({ client, historyPath: join(await mkdtemp(join(tmpdir(), 'gomining-short-')), 'history.json') });
  const app = createServer(createApp({ market, mcp: { key: 'short', client, market } }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.address().port}/mcp/short`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 404);
  app.close();
});
