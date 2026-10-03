import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExternalService } from '../src/core/external.js';
import { TickerService } from '../src/core/ticker.js';
import { fakeFetch } from './fake-api.js';

test('ticker pins BTC and GOMINING and lists the other top coins', async () => {
  const api = fakeFetch();
  const ticker = new TickerService({ external: new ExternalService({ fetchImpl: api.fetchImpl }) });
  const data = await ticker.get();
  assert.deepEqual(data.btc, { priceUsd: 80500, change24hPct: 1.25 });
  assert.deepEqual(data.gomining, { priceUsd: 0.42, change24hPct: -2.5 });
  assert.deepEqual(data.coins.map((c) => c.symbol), ['ETH', 'SOL'], 'BTC is pinned, stablecoins and rows without a price are dropped');
  await ticker.get();
  assert.equal(api.calls.length, 3, 'cached for a minute: one markets call, one stablecoin list and one price call');
});

test('without CoinGecko\'s stablecoin list, the big stablecoins are still left out', async () => {
  const base = fakeFetch();
  const fetchImpl = async (url, init) => (new URL(url).searchParams.get('category') ? new Response('{}', { status: 429 }) : base.fetchImpl(url, init));
  const coins = await new ExternalService({ fetchImpl }).topCoins(50);
  assert.deepEqual(coins.map((c) => c.symbol), ['BTC', 'ETH', 'SOL']);
});

test('ticker keeps the last good list when CoinGecko fails', async () => {
  let fail = false;
  let clock = 0;
  const base = fakeFetch();
  const fetchImpl = async (url, init) => (fail ? new Response('{}', { status: 429 }) : base.fetchImpl(url, init));
  const ticker = new TickerService({ external: new ExternalService({ fetchImpl }), now: () => clock });
  assert.equal((await ticker.get()).coins.length, 2);
  fail = true;
  clock += 120000;
  assert.equal((await ticker.get()).coins.length, 2);
});
