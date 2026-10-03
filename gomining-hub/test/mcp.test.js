import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GoMiningClient } from '../src/core/client.js';
import { MarketService } from '../src/core/market.js';
import { createServer } from '../src/mcp/server.js';
import { fakeFetch } from './fake-api.js';

async function connect({ token, routes, allowWrites } = {}) {
  const api = fakeFetch(routes);
  const client = new GoMiningClient({ token, fetchImpl: api.fetchImpl });
  const market = new MarketService({ client, historyPath: join(await mkdtemp(join(tmpdir(), 'gomining-mcp-')), 'history.json') });
  const server = createServer({ client, market, allowWrites });
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  const call = async (name, args = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return { isError: Boolean(result.isError), text, data: result.isError ? undefined : JSON.parse(text) };
  };
  return { mcp, call, api };
}

test('lists every tool', async () => {
  const { mcp } = await connect();
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'gomining_api_request', 'gomining_calculate_earnings', 'gomining_clan_miner_wars', 'gomining_daily_reward', 'gomining_efficiency_curve', 'gomining_maintenance_discount',
    'gomining_miner_prices', 'gomining_miner_roi', 'gomining_network_stats', 'gomining_outlook', 'gomining_payout_history', 'gomining_status', 'gomining_upgrade_advisor', 'gomining_upgrade_rates', 'gomining_vip',
  ]);
});

test('market tools report their data source and never send the token', async () => {
  const { call, api } = await connect({ token: 'secret' });
  const reward = await call('gomining_daily_reward', { efficiencyWth: 15 });
  assert.equal(reward.data.dataSource, 'live');
  assert.equal(reward.data.breakdownPerTh.netUsd, 0.0131);
  assert.ok(api.calls.every((c) => c.headers.authorization === undefined));
});

test('market tools flag sample data when GoMining is down', async () => {
  const { call } = await connect({ routes: { 'POST /api/nft-income-aggregation/get-last': () => new Response('down', { status: 502 }) } });
  const reward = await call('gomining_daily_reward');
  assert.equal(reward.data.dataSource, 'sample');
  assert.match(reward.data.liveError, /HTTP 502/);
  const status = await call('gomining_status');
  assert.equal(status.data.marketData, 'sample');
});

test('miner prices, efficiency curve, earnings and history', async () => {
  const { call } = await connect();
  const prices = await call('gomining_miner_prices', { efficiencyWth: 12, maxPriceUsd: 100 });
  assert.equal(prices.data.count, 1);
  const curve = await call('gomining_efficiency_curve');
  assert.equal(curve.data.rows.length, 9);
  const earnings = await call('gomining_calculate_earnings', { powerTh: 16, efficiencyWth: 15 });
  assert.equal(earnings.data.priceSource, 'GoMining listed price');
  assert.equal(earnings.data.payback.priceUsd, 249.99);
  const history = await call('gomining_payout_history');
  assert.equal(history.data.count, 1, 'the live fetch above recorded today');
});

test('api_request sends the token, confines paths and blocks writes by default', async () => {
  const routes = { 'POST /api/nft/get-state': (_url, init) => new Response(JSON.stringify({ auth: init.headers.authorization })) };
  const { call, api } = await connect({ token: 'secret', routes });
  assert.deepEqual((await call('gomining_api_request', { path: '/nft/get-state' })).data, { auth: 'Bearer secret' });
  assert.ok((await call('gomining_api_request', { method: 'GET', path: 'https://evil.example/x' })).isError);
  const blocked = await call('gomining_api_request', { method: 'DELETE', path: '/thing' });
  assert.match(blocked.text, /GOMINING_ALLOW_WRITES/);
  assert.equal(api.calls.length, 1);
});

test('api_request explains auth failures', async () => {
  const { call } = await connect({ token: 'expired', routes: { 'POST /api/user/me': () => new Response('{"message":"Unauthorized"}', { status: 401 }) } });
  const result = await call('gomining_api_request', { path: '/user/me' });
  assert.match(result.text, /HTTP 401 \(token missing, expired/);
  assert.match(result.text, /Unauthorized/);
});
