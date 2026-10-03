// The one place both the dashboard and the MCP server get GoMining data from.
//
// Fetches the three public endpoints in parallel, normalizes them, and caches the result. When
// GoMining is unreachable each part falls back to data/sample-snapshot.json and is reported as
// `sample`, so every screen and tool says plainly when it is not showing live numbers.
// Each live payout is also recorded by payout date in data/history.json, which builds the
// day-by-day series GoMining's API does not provide.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeIncome, normalizePresets, normalizeUpgradeRates } from './calc.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
export const DEFAULT_SNAPSHOT_PATH = join(DATA_DIR, 'sample-snapshot.json');
export const DEFAULT_HISTORY_PATH = join(DATA_DIR, 'history.json');
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 730;

export class MarketService {
  constructor({ client, snapshotPath = DEFAULT_SNAPSHOT_PATH, historyPath = DEFAULT_HISTORY_PATH, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    this.client = client;
    this.snapshotPath = snapshotPath;
    this.historyPath = historyPath;
    this.ttlMs = ttlMs;
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
    if (!fresh && this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.value;
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
    const settled = await Promise.allSettled(parts.map(([, fetchPart, normalize]) => fetchPart().then(normalize)));

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
    if (result.sources.income === 'live') await this.record(result.income).catch(() => {});
    return result;
  }

  async history() {
    try {
      const rows = JSON.parse(await readFile(this.historyPath, 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  // Keyed by GoMining's payout date, so refetches correct the day in place instead of duplicating it.
  async record(income) {
    const day = income.payoutDate.slice(0, 10);
    const point = {
      date: day,
      btcPriceUsd: income.btcPriceUsd,
      rewardUsdPerThDay: income.rewardUsdPerThDay,
      rewardSatsPerThDay: income.rewardSatsPerThDay,
      electricityKwhPriceUsd: income.electricityKwhPriceUsd,
      serviceUsdPerThDay: income.serviceUsdPerThDay,
    };
    const rows = (await this.history()).filter((row) => row.date !== day);
    rows.push(point);
    rows.sort((a, b) => a.date.localeCompare(b.date));
    await mkdir(dirname(this.historyPath), { recursive: true });
    await writeFile(this.historyPath, JSON.stringify(rows.slice(-HISTORY_LIMIT), null, 2));
  }
}
