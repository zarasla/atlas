// A small shared cache for public data: each key is fetched at most once per `ttlMs`, concurrent
// callers share one request, a failure isn't retried for `retryMs` (so visitors can't make the server
// hammer an API), and the last good answer is served, marked stale, for up to `maxStaleMs`.

export class TtlCache {
  constructor({ now = Date.now, retryMs = 60_000, maxStaleMs = 6 * 60 * 60_000 } = {}) {
    this.now = now;
    this.retryMs = retryMs;
    this.maxStaleMs = maxStaleMs;
    this.entries = new Map();
  }

  async get(key, ttlMs, load) {
    const entry = this.entries.get(key) ?? {};
    this.entries.set(key, entry);
    const now = this.now();
    if (entry.value !== undefined && now - entry.at < ttlMs) return entry.value;
    if (entry.errorAt && now - entry.errorAt < this.retryMs) return this.fallback(entry);
    entry.inflight ??= Promise.resolve()
      .then(load)
      .then((value) => { Object.assign(entry, { value, at: this.now(), error: null, errorAt: null }); })
      .catch((error) => { Object.assign(entry, { error, errorAt: this.now() }); })
      .finally(() => { entry.inflight = null; });
    await entry.inflight;
    return entry.error ? this.fallback(entry) : entry.value;
  }

  fallback(entry) {
    if (entry.value !== undefined && this.now() - entry.at < this.maxStaleMs) {
      const asOf = new Date(entry.at).toISOString();
      return entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value) ? { ...entry.value, stale: true, asOf } : entry.value;
    }
    throw entry.error;
  }
}
