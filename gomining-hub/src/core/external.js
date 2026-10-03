// Public, keyless data from outside GoMining that puts the payout in context:
//   mempool.space   Bitcoin network hashrate, difficulty, next difficulty adjustment, block height, fees
//   CoinGecko       BTC and GOMINING token prices with 24h change and market cap
//   alternative.me  Crypto Fear & Greed index (today, yesterday, a week ago)
//
// Each source is optional: if one is down or rate-limited, its part comes back null with an error
// message and the rest of the dashboard carries on. Results are cached like the GoMining data.

const TIMEOUT_MS = 10_000;
const MEMPOOL = 'https://mempool.space/api';
const COINGECKO = 'https://api.coingecko.com/api/v3';
const FEAR_GREED = 'https://api.alternative.me/fng/?limit=8';
// GoMining's token has been listed under both ids; whichever CoinGecko answers for is used
// (in October 2026 it is gmt-token).
const TOKEN_IDS = ['gmt-token', 'gomining-token'];

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits) => (isNumber(value) ? Number(value.toFixed(digits)) : null);

// How long each answer is reused, so the ticker, the dashboard and the MCP tools together make at
// most one call per source per period (CoinGecko's free API answers HTTP 429 when asked too often).
const TTL_MS = { network: 60_000, prices: 90_000, topCoins: 90_000, sentiment: 30 * 60_000, priceHistory: 6 * 60 * 60_000, stablecoins: 24 * 60 * 60_000 };
const FALLBACK_STABLECOINS = new Set(['usdt', 'usdc', 'usds', 'usde', 'dai', 'usd1', 'usdg', 'pyusd', 'rlusd', 'fdusd', 'tusd', 'usdd', 'gho', 'frax', 'busd', 'eurc']);
// After a failure, wait this long before asking again, and keep serving the last good answer
// (marked stale) for up to MAX_STALE_MS.
const RETRY_AFTER_MS = 60_000;
const MAX_STALE_MS = 6 * 60 * 60_000;

export class ExternalService {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, cache = true } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.useCache = cache;
    this.memo = new Map();
  }

  // Shared cache with stale fallback. A stale value gets `stale: true` and `asOf` (when it was fetched).
  async cached(key, ttlMs, load) {
    if (!this.useCache) return load();
    const entry = this.memo.get(key) ?? {};
    const now = this.now();
    if (entry.value && now - entry.at < ttlMs) return entry.value;
    if (entry.errorAt && now - entry.errorAt < RETRY_AFTER_MS) return this.fallback(entry);
    entry.inflight ??= load()
      .then((value) => { Object.assign(entry, { value, at: this.now(), good: value, goodAt: this.now(), error: null, errorAt: null }); })
      .catch((error) => { Object.assign(entry, { value: null, error, errorAt: this.now() }); })
      .finally(() => { entry.inflight = null; });
    this.memo.set(key, entry);
    await entry.inflight;
    return entry.value ?? this.fallback(entry);
  }

  fallback(entry) {
    if (entry.good && this.now() - entry.goodAt < MAX_STALE_MS) {
      const asOf = new Date(entry.goodAt).toISOString();
      return Array.isArray(entry.good) ? Object.assign([...entry.good], { stale: true, asOf }) : { ...entry.good, stale: true, asOf };
    }
    throw entry.error;
  }

  async json(url) {
    const response = await this.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${new URL(url).host} returned HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${new URL(url).host} returned something that isn't JSON`);
    }
  }

  network() {
    return this.cached('network', TTL_MS.network, () => this.loadNetwork());
  }

  prices() {
    return this.cached('prices', TTL_MS.prices, () => this.loadPrices());
  }

  topCoins(limit = 50) {
    return this.cached(`topCoins:${limit}`, TTL_MS.topCoins, () => this.loadTopCoins(limit));
  }

  sentiment() {
    return this.cached('sentiment', TTL_MS.sentiment, () => this.loadSentiment());
  }

  priceHistory() {
    return this.cached('priceHistory', TTL_MS.priceHistory, () => this.loadPriceHistory());
  }

  // Daily USD closes for the last 365 days of BTC and GOMINING (CoinGecko), for the heatmap calendar.
  async loadPriceHistory() {
    const series = async (id) => {
      const data = await this.json(`${COINGECKO}/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`);
      const rows = Array.isArray(data?.prices) ? data.prices : [];
      const byDay = new Map();
      for (const [ms, price] of rows) if (isNumber(ms) && isNumber(price)) byDay.set(new Date(ms).toISOString().slice(0, 10), price);
      if (byDay.size < 2) throw new Error(`CoinGecko returned no price history for ${id}`);
      return [...byDay].map(([date, usd]) => ({ date, usd }));
    };
    const btc = await series('bitcoin');
    let gomining = null;
    for (const id of TOKEN_IDS) {
      gomining = await series(id).catch(() => null);
      if (gomining) break;
    }
    return { btc, gomining };
  }

  async loadNetwork() {
    const [adjustment, hashrate, height, fees] = await Promise.all([
      this.json(`${MEMPOOL}/v1/difficulty-adjustment`),
      this.json(`${MEMPOOL}/v1/mining/hashrate/3d`),
      this.json(`${MEMPOOL}/blocks/tip/height`),
      this.json(`${MEMPOOL}/v1/fees/recommended`),
    ]);
    if (!isNumber(hashrate?.currentHashrate) || !isNumber(hashrate?.currentDifficulty)) throw new Error('mempool.space hashrate data is malformed');
    return {
      hashrateEhs: round(hashrate.currentHashrate / 1e18, 1),
      difficultyT: round(hashrate.currentDifficulty / 1e12, 2),
      blockHeight: isNumber(height) ? height : null,
      nextAdjustment: {
        progressPct: round(adjustment?.progressPercent, 1),
        estimatedChangePct: round(adjustment?.difficultyChange, 2),
        remainingBlocks: isNumber(adjustment?.remainingBlocks) ? adjustment.remainingBlocks : null,
        estimatedDate: isNumber(adjustment?.estimatedRetargetDate) ? new Date(adjustment.estimatedRetargetDate).toISOString() : null,
        previousChangePct: round(adjustment?.previousRetarget, 2),
        avgBlockMinutes: isNumber(adjustment?.timeAvg) ? round(adjustment.timeAvg / 60000, 1) : null,
      },
      feesSatVb: {
        fastest: fees?.fastestFee ?? null,
        halfHour: fees?.halfHourFee ?? null,
        hour: fees?.hourFee ?? null,
        economy: fees?.economyFee ?? null,
      },
    };
  }

  async loadPrices() {
    const ids = ['bitcoin', ...TOKEN_IDS].join(',');
    const data = await this.json(`${COINGECKO}/simple/price?ids=${ids}&vs_currencies=usd,eur&include_24hr_change=true&include_market_cap=true`);
    const pick = (row) => (row && isNumber(row.usd) ? {
      usd: row.usd,
      eur: isNumber(row.eur) ? row.eur : null,
      change24hPct: round(row.usd_24h_change, 2),
      marketCapUsd: isNumber(row.usd_market_cap) ? Math.round(row.usd_market_cap) : null,
    } : null);
    const btc = pick(data?.bitcoin);
    if (!btc) throw new Error('CoinGecko returned no BTC price');
    const token = TOKEN_IDS.map((id) => pick(data?.[id])).find(Boolean) ?? null;
    return { btc, gomining: token };
  }

  // CoinGecko's own stablecoin category (USDT, USDC, DAI, USDe and the rest), so new ones drop out of
  // the ticker by themselves. If it can't be read, a short list of the big ones is used instead.
  stablecoinIds() {
    return this.cached('stablecoins', TTL_MS.stablecoins, async () => {
      const rows = await this.json(`${COINGECKO}/coins/markets?vs_currency=usd&category=stablecoins&order=market_cap_desc&per_page=250&page=1`);
      if (!Array.isArray(rows) || !rows.length) throw new Error('CoinGecko stablecoin list is malformed');
      return rows.map((row) => row?.id).filter((id) => typeof id === 'string');
    });
  }

  // Top coins by market cap for the ticker bar, stablecoins left out: symbol, name, price, 24h change.
  async loadTopCoins(limit) {
    const [rows, stable] = await Promise.all([
      // Ask for more than needed so the bar stays full once stablecoins are taken out.
      this.json(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${Math.min(limit * 2, 250)}&page=1&price_change_percentage=24h`),
      this.stablecoinIds().catch(() => null),
    ]);
    if (!Array.isArray(rows)) throw new Error('CoinGecko markets data is malformed');
    const stableIds = new Set(stable ?? []);
    const isStable = (row) => (stable ? stableIds.has(row.id) : FALLBACK_STABLECOINS.has(String(row.symbol).toLowerCase()));
    return rows
      .filter((row) => typeof row?.symbol === 'string' && isNumber(row?.current_price) && !isStable(row))
      .slice(0, limit)
      .map((row) => ({
        rank: isNumber(row.market_cap_rank) ? row.market_cap_rank : null,
        symbol: row.symbol.toUpperCase().slice(0, 12),
        name: String(row.name ?? '').slice(0, 40),
        priceUsd: row.current_price,
        change24hPct: round(row.price_change_percentage_24h, 2),
      }));
  }

  // Fear & Greed index, 0 (extreme fear) to 100 (extreme greed), newest first from alternative.me.
  async loadSentiment() {
    const data = await this.json(FEAR_GREED);
    const rows = Array.isArray(data?.data) ? data.data : [];
    const pick = (row) => {
      const value = Number(row?.value);
      return row && Number.isFinite(value) ? { value, label: String(row.value_classification ?? '').slice(0, 30) } : null;
    };
    const today = pick(rows[0]);
    if (!today) throw new Error('alternative.me returned no Fear & Greed value');
    return { ...today, yesterday: pick(rows[1])?.value ?? null, lastWeek: pick(rows[7])?.value ?? null };
  }

  // All parts in parallel; a failing part is null with its error kept.
  async get() {
    const names = ['network', 'prices', 'sentiment'];
    const settled = await Promise.allSettled(names.map((name) => this[name]()));
    const result = { errors: {} };
    names.forEach((name, index) => {
      const outcome = settled[index];
      result[name] = outcome.status === 'fulfilled' ? outcome.value : null;
      if (outcome.status === 'rejected') result.errors[name] = outcome.reason?.message ?? String(outcome.reason);
    });
    return result;
  }
}
