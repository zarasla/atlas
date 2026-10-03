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
// GoMining's token has been listed under both ids; whichever CoinGecko answers for is used.
const TOKEN_IDS = ['gomining-token', 'gmt-token'];

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits) => (isNumber(value) ? Number(value.toFixed(digits)) : null);

export class ExternalService {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetch = fetchImpl;
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

  async network() {
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

  async prices() {
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

  // Top coins by market cap for the ticker bar: symbol, name, price and 24h change.
  async topCoins(limit = 50) {
    const rows = await this.json(`${COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&price_change_percentage=24h`);
    if (!Array.isArray(rows)) throw new Error('CoinGecko markets data is malformed');
    return rows
      .filter((row) => typeof row?.symbol === 'string' && isNumber(row?.current_price))
      .map((row) => ({
        rank: isNumber(row.market_cap_rank) ? row.market_cap_rank : null,
        symbol: row.symbol.toUpperCase().slice(0, 12),
        name: String(row.name ?? '').slice(0, 40),
        priceUsd: row.current_price,
        change24hPct: round(row.price_change_percentage_24h, 2),
      }));
  }

  // Fear & Greed index, 0 (extreme fear) to 100 (extreme greed), newest first from alternative.me.
  async sentiment() {
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
