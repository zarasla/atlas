import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GoMiningClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import { fakeFetch } from './fake-api.js';

async function connect({ token, routes, allowWrites } = {}) {
  const api = fakeFetch(routes);
  const server = createServer(new GoMiningClient({ token, fetchImpl: api.fetchImpl }), { allowWrites });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    return { isError: Boolean(result.isError), text, data: result.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, api };
}

test('lists every tool', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'gomining_api_request', 'gomining_calculate_earnings', 'gomining_daily_reward', 'gomining_miner_prices', 'gomining_status', 'gomining_upgrade_rates',
  ]);
});

test('daily reward is cached and never sends the token', async () => {
  const { call, api } = await connect({ token: 'secret' });
  const first = await call('gomining_daily_reward');
  await call('gomining_daily_reward');
  assert.equal(first.data.rewardSatsPerThDay, 50);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].headers.authorization, undefined);
});

test('miner prices filter by efficiency and budget', async () => {
  const { call } = await connect();
  const { data } = await call('gomining_miner_prices', { efficiencyWth: 12, maxPriceUsd: 100 });
  assert.equal(data.count, 1);
  assert.equal(data.miners[0].powerTh, 1);
  assert.deepEqual(data.efficienciesListed, [12, 15]);
});

test('earnings fall back to the listed price for payback', async () => {
  const { call } = await connect();
  const { data } = await call('gomining_calculate_earnings', { powerTh: 16, efficiencyWth: 15 });
  assert.equal(data.priceSource, 'GoMining listed price');
  assert.equal(data.payback.priceUsd, 249.99);
  assert.equal(data.period.days, 30);
});

test('api_request sends the bearer token and body to GoMining', async () => {
  const routes = { 'POST /api/nft/get-state': (_url, init) => new Response(JSON.stringify({ data: { ok: true, auth: init.headers.authorization } })) };
  const { call, api } = await connect({ token: 'secret', routes });
  const { data } = await call('gomining_api_request', { path: '/nft/get-state', body: { pagination: { skip: 0, limit: 10 } } });
  assert.deepEqual(data, { data: { ok: true, auth: 'Bearer secret' } });
  assert.deepEqual(api.calls[0].body, { pagination: { skip: 0, limit: 10 } });
});

test('api_request refuses paths that leave the API host', async () => {
  const { call, api } = await connect({ token: 'secret' });
  for (const path of ['https://evil.example/x', '//evil.example/x', '/../../x', 'nft/get-state']) {
    const result = await call('gomining_api_request', { method: 'GET', path });
    assert.ok(result.isError, `expected ${path} to be refused`);
  }
  assert.equal(api.calls.length, 0);
});

test('api_request blocks writes unless allowed', async () => {
  const blocked = await (await connect({ token: 'secret' })).call('gomining_api_request', { method: 'DELETE', path: '/thing' });
  assert.ok(blocked.isError);
  assert.match(blocked.text, /GOMINING_ALLOW_WRITES/);

  const routes = { 'DELETE /api/thing': () => new Response('{"ok":true}') };
  const allowed = await (await connect({ token: 'secret', routes, allowWrites: true })).call('gomining_api_request', { method: 'DELETE', path: '/thing' });
  assert.deepEqual(allowed.data, { ok: true });
});

test('api_request explains an auth failure and shows the body', async () => {
  const routes = { 'POST /api/user/me': () => new Response('{"message":"Unauthorized"}', { status: 401 }) };
  const { call } = await connect({ token: 'expired', routes });
  const result = await call('gomining_api_request', { path: '/user/me' });
  assert.ok(result.isError);
  assert.match(result.text, /HTTP 401 \(token missing, expired/);
  assert.match(result.text, /Unauthorized/);
});

test('status reports configuration without leaking the token', async () => {
  const { call } = await connect({ token: 'secret' });
  const { data, text } = await call('gomining_status');
  assert.equal(data.tokenConfigured, true);
  assert.ok(!text.includes('secret'));
});
