// The ticker bar's data: BTC and GOMINING pinned on the left, the rest of the top 50 by market cap
// scrolling. Fetched at most once a minute for everyone, so visitors never hit CoinGecko directly.

const TTL_MS = 60 * 1000;

export class TickerService {
  constructor({ external, ttlMs = TTL_MS, now = Date.now }) {
    this.external = external;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cache = null;
    this.inflight = null;
  }

  async get() {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.value;
    this.inflight ??= this.load().finally(() => { this.inflight = null; });
    const value = await this.inflight;
    // Keep the last good list if CoinGecko is briefly unavailable.
    if (value.coins.length || !this.cache) this.cache = { at: this.now(), value };
    return this.cache.value;
  }

  async load() {
    const [coins, prices] = await Promise.allSettled([this.external.topCoins(50), this.external.prices()]);
    const list = coins.status === 'fulfilled' ? coins.value : [];
    const quote = prices.status === 'fulfilled' ? prices.value : null;
    const btcRow = list.find((coin) => coin.symbol === 'BTC');
    return {
      updatedAt: new Date(this.now()).toISOString(),
      btc: quote?.btc ? { priceUsd: quote.btc.usd, change24hPct: quote.btc.change24hPct } : btcRow ? { priceUsd: btcRow.priceUsd, change24hPct: btcRow.change24hPct } : null,
      gomining: quote?.gomining ? { priceUsd: quote.gomining.usd, change24hPct: quote.gomining.change24hPct } : null,
      coins: list.filter((coin) => coin.symbol !== 'BTC'),
      ...(coins.status === 'rejected' ? { error: coins.reason?.message ?? String(coins.reason) } : {}),
    };
  }
}
