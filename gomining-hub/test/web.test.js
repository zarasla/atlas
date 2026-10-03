import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { GoMiningClient } from '../src/core/client.js';
import { MarketService } from '../src/core/market.js';
import { createApp } from '../src/web/server.js';
import { fakeFetch } from './fake-api.js';

let server;
let base;

before(async () => {
  const client = new GoMiningClient({ fetchImpl: fakeFetch().fetchImpl });
  const market = new MarketService({ client, historyPath: join(await mkdtemp(join(tmpdir(), 'gomining-web-')), 'history.json') });
  server = createServer(createApp({ market }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('GET /api/market returns all parts plus the efficiency curve', async () => {
  const body = await (await fetch(`${base}/api/market`)).json();
  assert.equal(body.source, 'live');
  assert.equal(body.curve.rows.length, 9);
  assert.equal(body.presets.length, 3);
});

test('GET /api/earnings validates input and uses the listed price', async () => {
  assert.equal((await fetch(`${base}/api/earnings?powerTh=0&efficiencyWth=15`)).status, 400);
  const body = await (await fetch(`${base}/api/earnings?powerTh=16&efficiencyWth=15&days=10`)).json();
  assert.equal(body.period.days, 10);
  assert.equal(body.priceSource, 'GoMining listed price');
});

test('serves the dashboard and refuses paths outside public/', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /The Goose's/);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 403);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/market`, { method: 'POST' })).status, 405);
});

test('fills the link-preview address from the request host, rejecting junk hosts', async () => {
  const { request } = await import('node:http');
  const get = (host) => new Promise((resolve, reject) => {
    const req = request(`${base}/`, { headers: { host } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.end();
  });
  const good = await get('hub.example.com');
  assert.match(good, /content="https:\/\/hub\.example\.com\/og-image\.jpg"/);
  assert.ok(!good.includes('__ORIGIN__'));
  const bad = await get('evil.com"><script>');
  assert.ok(!bad.includes('<script>"'), 'header text is never injected');
  assert.match(bad, /content="\/og-image\.jpg"/);
});

test('serves the shared calculation module to the browser calculator', async () => {
  const response = await fetch(`${base}/lib/calc.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /export function rewardsBreakdown/);
  assert.equal((await fetch(`${base}/lib/market.js`)).status, 404);
});
