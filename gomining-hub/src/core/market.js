// The one place both the dashboard and the MCP server get GoMining data from.
//
// Fetches the three public endpoints in parallel, normalizes them, and caches the result. When
// GoMining is unreachable each part falls back to data/sample-snapshot.json and is reported as
// `sample`, so every screen and tool says plainly when it is not showing live numbers.
// Each live payout is also recorded by payout date in data/history.json, which builds the
// day-by-day series GoMining's API does not provide.
//
// An optional ExternalService adds Bitcoin network stats, BTC/GOMINING prices and Fear & Greed. Those parts are
// `null` (source `unavailable`) when their providers can't be reached; they never use sample data.

import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeIncome, normalizePresets, normalizeUpgradeRates } from './calc.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
export const DEFAULT_SNAPSHOT_PATH = join(DATA_DIR, 'sample-snapshot.json');
export const DEFAULT_HISTORY_PATH = join(DATA_DIR, 'history.json');
const DEFAULT_TTL_MS = 5 * 60 * 1000;
// A forced refresh still waits this long after the last fetch, so a public dashboard's refresh
// button can't be used to hammer GoMining.
const MIN_REFRESH_MS = 60 * 1000;
const HISTORY_LIMIT = 730;

export class MarketService {
  constructor({ client, external, snapshotPath = DEFAULT_SNAPSHOT_PATH, historyPath = DEFAULT_HISTORY_PATH, ttlMs = DEFAULT_TTL_MS, minRefreshMs = MIN_REFRESH_MS, now = Date.now } = {}) {
    this.client = client;
    this.external = external;
    this.snapshotPath = snapshotPath;
    this.historyPath = historyPath;
    this.ttlMs = ttlMs;
    this.minRefreshMs = minRefreshMs;
    this.now = now;
    this.cache = null;
    this.inflight = null;
  }

  async snapshot() {
    this.snapshotData ??= JSON.parse(await readFile(this.snapshotPath, 'utf8'));
    return this.snapshotData;
  }

  // Returns { source, fetchedAt, errors, income, presets, upgrades }. `source` is `live` only
  // when all three parts came from GoMining just now.
  async get({ fresh = false } = {}) {
    const age = this.cache ? this.now() - this.cache.at : Infinity;
    if (age < (fresh ? this.minRefreshMs : this.ttlMs)) return this.cache.value;
    this.inflight ??= this.load().finally(() => { this.inflight = null; });
    const value = await this.inflight;
    this.cache = { at: this.now(), value };
    return value;
  }

  async load() {
    const parts = [
      ['income', () => this.client.getIncome(), normalizeIncome, (s) => s.income],
      ['presets', () => this.client.getMinerPresets(), normalizePresets, (s) => s.presets],
      ['upgrades', () => this.client.getUpgradeRates(), normalizeUpgradeRates, (s) => s.upgrades],
    ];
    const [settled, outside] = await Promise.all([
      Promise.allSettled(parts.map(([, fetchPart, normalize]) => fetchPart().then(normalize))),
      this.external ? this.external.get().catch((error) => ({ network: null, prices: null, sentiment: null, errors: { network: error.message, prices: error.message, sentiment: error.message } })) : null,
    ]);

    const result = { source: 'live', fetchedAt: new Date(this.now()).toISOString(), errors: {}, sources: {} };
    for (const [index, [name, , normalize, fromSnapshot]] of parts.entries()) {
      const outcome = settled[index];
      if (outcome.status === 'fulfilled') {
        result[name] = outcome.value;
        result.sources[name] = 'live';
      } else {
        result[name] = normalize(fromSnapshot(await this.snapshot()));
        result.sources[name] = 'sample';
        result.errors[name] = outcome.reason?.message ?? String(outcome.reason);
        result.source = 'sample';
      }
    }
    if (result.source === 'sample') result.sampleCapturedAt = (await this.snapshot()).capturedAt;
    for (const part of ['network', 'prices', 'sentiment']) {
      result[part] = outside?.[part] ?? null;
      result.sources[part] = !result[part] ? 'unavailable' : result[part].stale ? 'stale' : 'live';
      if (outside?.errors?.[part]) result.errors[part] = outside.errors[part];
    }
    if (result.sources.income === 'live') await this.record(result.income, result).catch(() => {});
    return result;
  }

  async history() {
    return (await this.readHistory()).rows;
  }

  // A missing file is an empty history; an unreadable one is reported, so it is never overwritten.
  async readHistory() {
    let text;
    try {
      text = await readFile(this.historyPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { rows: [], ok: true };
      return { rows: [], ok: false };
    }
    try {
      const rows = JSON.parse(text);
      return Array.isArray(rows) ? { rows, ok: true } : { rows: [], ok: false };
    } catch {
      return { rows: [], ok: false };
    }
  }

  // Keyed by GoMining's payout date, so refetches correct the day in place instead of duplicating it.
  async record(income, extra = {}) {
    const day = income.payoutDate.slice(0, 10);
    const point = {
      date: day,
      btcPriceUsd: income.btcPriceUsd,
      rewardUsdPerThDay: income.rewardUsdPerThDay,
      rewardSatsPerThDay: income.rewardSatsPerThDay,
      electricityKwhPriceUsd: income.electricityKwhPriceUsd,
      serviceUsdPerThDay: income.serviceUsdPerThDay,
      hashpriceUsdPerPhDay: Number((income.rewardUsdPerThDay * 1000).toFixed(4)),
      ...(extra.network ? { hashrateEhs: extra.network.hashrateEhs, difficultyT: extra.network.difficultyT } : {}),
      ...(extra.prices?.gomining ? { gominingUsd: extra.prices.gomining.usd } : {}),
    };
    const current = await this.readHistory();
    if (!current.ok) {
      // Keep the damaged file for recovery and start a new one beside it rather than losing it.
      await copyFile(this.historyPath, `${this.historyPath}.corrupt-${Date.now()}`).catch(() => {});
    }
    const rows = current.rows.filter((row) => row.date !== day);
    rows.push(point);
    rows.sort((a, b) => a.date.localeCompare(b.date));
    await mkdir(dirname(this.historyPath), { recursive: true });
    // Write a temporary file and rename it over the old one, so a crash mid-write can't truncate it.
    const temp = `${this.historyPath}.tmp`;
    await writeFile(temp, JSON.stringify(rows.slice(-HISTORY_LIMIT), null, 2));
    await rename(temp, this.historyPath);
  }
}
