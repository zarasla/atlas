// Thin client for GoMining's HTTP API (https://api.gomining.com/api).
//
// The three market endpoints are public: app.gomining.com calls them without a token.
//   POST /nft-income-aggregation/get-last    daily pool payout per TH, fees and the BTC rate used
//   GET  /nft-collection/find-all-generative  miners GoMining sells, with prices
//   POST /nft/get-upgrade-rate                per-W/TH valuation and upgrade price tables
//
// Account endpoints (your miners, rewards, clan) need the bearer token app.gomining.com uses.
// GoMining does not document them, so they go through request() rather than named methods.

export const DEFAULT_BASE_URL = 'https://api.gomining.com/api';
const DEFAULT_TIMEOUT_MS = 15000;

export class GoMiningError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GoMiningError';
    this.status = status;
    this.body = body;
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// GoMining wraps every response in { data }, and lists once more in { array }.
const unwrapData = (value) => (isRecord(value) && 'data' in value ? value.data : value);

export class GoMiningClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.origin = new URL(this.baseUrl).origin;
    this.token = token || undefined;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get hasToken() {
    return Boolean(this.token);
  }

  // Resolves an API path against the base URL and refuses anything that would leave GoMining's
  // API host, so the bearer token can only ever be sent to GoMining.
  resolve(path) {
    // %2e is a dot to URL parsers, so encoded dot segments are refused like plain ones.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('..') || /%2e|\\/i.test(path)) {
      throw new GoMiningError(`Path must be an API path starting with "/", e.g. /nft/get-upgrade-rate (got ${JSON.stringify(path)})`);
    }
    const url = new URL(this.baseUrl + path);
    if (url.origin !== this.origin) {
      throw new GoMiningError(`Refusing to call ${url.origin}: only ${this.origin} is allowed`);
    }
    return url;
  }

  async request(method, path, { body, query, auth = this.hasToken } = {}) {
    const url = this.resolve(path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const upper = method.toUpperCase();
    const headers = { accept: 'application/json' };
    if (auth) {
      if (!this.token) throw new GoMiningError('This call needs GOMINING_TOKEN to be set');
      headers.authorization = `Bearer ${this.token}`;
    }
    const init = { method: upper, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (upper !== 'GET' && upper !== 'HEAD') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }

    let response;
    try {
      response = await this.fetch(url, init);
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? `timed out after ${this.timeoutMs} ms` : error?.message ?? String(error);
      throw new GoMiningError(`${upper} ${url.pathname} failed: ${reason}`);
    }

    const text = await response.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; keep the raw text so the caller can see what came back.
    }
    if (!response.ok) {
      const denied = response.status === 401 || response.status === 403;
      const hint = !denied ? '' : auth ? ' (token missing, expired or not allowed for this endpoint)' : ' (refused without a token: the endpoint needs one, or a firewall or proxy blocked the request)';
      throw new GoMiningError(`${upper} ${url.pathname} returned HTTP ${response.status}${hint}`, { status: response.status, body: parsed });
    }
    return parsed;
  }

  // Public endpoints never send the token, so a stale token cannot break them.
  async getIncome() {
    return unwrapData(await this.request('POST', '/nft-income-aggregation/get-last', { auth: false }));
  }

  async getMinerPresets() {
    const data = unwrapData(await this.request('GET', '/nft-collection/find-all-generative', { auth: false }));
    return isRecord(data) && Array.isArray(data.array) ? data.array : Array.isArray(data) ? data : [];
  }

  async getUpgradeRates() {
    return unwrapData(await this.request('POST', '/nft/get-upgrade-rate', { auth: false }));
  }
}
