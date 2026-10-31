import z from '@deepseek-ai/schemastery';

/**
 * dsh-plugin-network-meter — Host half.
 *
 * Measures every outbound HTTP request the DSH Host makes and reports the
 * bytes sent and received.
 *
 * Why `globalThis.fetch` is the seam: DSH has no injectable HTTP transport
 * service. Its outbound stack reaches the wire through the bare global
 * `fetch` — `dsh-llm-deepseek`, `dsh-llm-pi-ai` (through the provider SDKs),
 * `dsh-web-search-deepseek`, `dsh-web-deepseek-api`, `dsh-mcp-client` (the
 * streamable-http transport falls back to the global), and the plugin market.
 * The one exception is `dsh-web-fetch-http`'s direct path, which owns its own
 * undici `Agent`; its proxy-exempt path still uses the global.
 *
 * This is the same seam `dsh-experimental-inspector` uses for its fetch
 * capture, and the wrapper below preserves the caller's contract exactly:
 * `input` and `init` are forwarded by identity, so `init.dispatcher`,
 * `init.signal` and every other option reach Node's own undici untouched.
 */

/** Classification of one observed request by destination. */
export const SCOPE = {
  LLM: 'llm',
  WEB: 'web',
  MCP: 'mcp',
  PLUGIN: 'plugin',
  OTHER: 'other'
};

/** Hosts that identify a scope when the URL alone does not. */
const SCOPE_HOSTS = [
  { scope: SCOPE.LLM, match: /(^|\.)(deepseek\.com|deepseek\.ai|openai\.com|anthropic\.com|openrouter\.ai)$/i },
  { scope: SCOPE.LLM, match: /(api|chat|llm|inference|models)\./i },
  { scope: SCOPE.PLUGIN, match: /(plugin|market|npmjs|registry|github)\./i }
];

/**
 * Classify a URL into a reporting scope.
 *
 * The classification is a reporting aid, not a transport fact: a request to an
 * unknown host lands in `other` rather than being guessed into a bucket.
 *
 * @param {string} url - the absolute request URL.
 * @returns {string} one of the `SCOPE` values.
 */
export function classifyScope(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return SCOPE.OTHER;
  }
  if (!host) return SCOPE.OTHER;
  for (const rule of SCOPE_HOSTS) {
    if (rule.match.test(host)) return rule.scope;
  }
  return SCOPE.OTHER;
}

/**
 * Byte length of a request body without consuming it.
 *
 * A `ReadableStream` body cannot be measured without reading it, so it is
 * reported as unknown rather than drained: draining it would consume the
 * caller's payload.
 *
 * @param {unknown} body - the request body value.
 * @returns {number|null} the byte count, or `null` when it cannot be known.
 */
function bodyByteLength(body) {
  if (body == null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (typeof body !== 'object') return null;
  if (typeof body.byteLength === 'number') return body.byteLength; // Buffer, ArrayBuffer, TypedArray
  if (typeof body.size === 'number') return body.size; // Blob, File
  return null;
}

/**
 * The accumulator for observed traffic.
 *
 * Every number it reports is a byte count observed on a real request; a body
 * whose size cannot be determined contributes `0` to the totals and increments
 * `unmeasured`, so an undercount is visible rather than silent.
 */
export class TrafficLedger {
  constructor(options = {}) {
    this.startedAt = Date.now();
    this.maxHosts = options.maxHosts ?? 25;
    this.maxRecent = options.maxRecent ?? 60;
    /**
     * The window the current rate is measured over, in milliseconds. A short
     * window tracks the moment; a long one smooths the jitter of one answer.
     */
    this.rateWindowMs = options.rateWindowMs ?? 5000;
    this.reset();
  }

  /** Clear every counter, keeping the plugin's start time. */
  reset() {
    this.sentBytes = 0;
    this.receivedBytes = 0;
    this.requests = 0;
    this.errors = 0;
    this.unmeasured = 0;
    this.byScope = new Map();
    this.byHost = new Map();
    this.recent = [];
    /**
     * The completed requests inside the current rate window, each with the
     * moment it finished. The window is trimmed on every read, so the rate
     * reflects the last few seconds rather than the whole session.
     */
    this.window = [];
  }

  /**
   * Drop the entries that fell out of the rate window.
   *
   * @param {number} now - the current time.
   * @returns {void}
   */
  trimWindow(now) {
    const cutoff = now - this.rateWindowMs;
    let drop = 0;
    while (drop < this.window.length && this.window[drop].at < cutoff) drop += 1;
    if (drop > 0) this.window.splice(0, drop);
  }

  /**
   * The current traffic rate, over the rate window.
   *
   * @param {number} now - the current time.
   * @returns {{sentBytesPerSecond: number, receivedBytesPerSecond: number, activeRequests: number, windowMs: number}} the rate.
   */
  rate(now = Date.now()) {
    this.trimWindow(now);
    let sent = 0;
    let received = 0;
    for (const entry of this.window) {
      sent += entry.sentBytes;
      received += entry.receivedBytes;
    }
    // The window's own span is what the rate divides by: a request that
    // finished one second ago is one second of traffic, not five.
    const oldest = this.window.length > 0 ? this.window[0].at : now;
    const spanMs = Math.max(1, Math.min(now - oldest, this.rateWindowMs));
    return {
      sentBytesPerSecond: (sent / spanMs) * 1000,
      receivedBytesPerSecond: (received / spanMs) * 1000,
      activeRequests: this.window.length,
      windowMs: this.rateWindowMs
    };
  }

  /**
   * Record one completed request.
   *
   * @param {object} entry - the observation.
   * @param {string} entry.url - the request URL.
   * @param {string} entry.method - the HTTP method.
   * @param {number|null} entry.sentBytes - bytes written, or `null` when unknown.
   * @param {number} entry.receivedBytes - bytes read from the response.
   * @param {number} entry.status - the HTTP status, or `0` when the request failed.
   * @param {number} entry.durationMs - the wall time of the request.
   * @param {string} entry.error - the failure text, when the request failed.
   */
  record(entry) {
    const sent = Number.isFinite(entry.sentBytes) ? entry.sentBytes : 0;
    const received = Number.isFinite(entry.receivedBytes) ? entry.receivedBytes : 0;
    const scope = classifyScope(entry.url);
    let host = 'unknown';
    try {
      host = new URL(entry.url).hostname.toLowerCase();
    } catch { /* keep the placeholder */ }

    this.requests += 1;
    this.sentBytes += sent;
    this.receivedBytes += received;
    if (entry.status === 0) this.errors += 1;
    if (!Number.isFinite(entry.sentBytes)) this.unmeasured += 1;

    const finishedAt = Date.now();
    this.window.push({ at: finishedAt, sentBytes: sent, receivedBytes: received });
    this.trimWindow(finishedAt);

    const scopeRow = this.byScope.get(scope) ?? { scope, sentBytes: 0, receivedBytes: 0, requests: 0 };
    scopeRow.sentBytes += sent;
    scopeRow.receivedBytes += received;
    scopeRow.requests += 1;
    this.byScope.set(scope, scopeRow);

    const hostRow = this.byHost.get(host) ?? { host, scope, sentBytes: 0, receivedBytes: 0, requests: 0 };
    hostRow.sentBytes += sent;
    hostRow.receivedBytes += received;
    hostRow.requests += 1;
    this.byHost.set(host, hostRow);

    this.recent.unshift({
      url: entry.url,
      method: entry.method,
      host,
      scope,
      status: entry.status,
      sentBytes: sent,
      receivedBytes: received,
      durationMs: entry.durationMs,
      error: entry.error ?? null,
      at: Date.now()
    });
    if (this.recent.length > this.maxRecent) this.recent.length = this.maxRecent;
  }

  /**
   * Build the snapshot the UI reads.
   *
   * @returns {object} the current counters, the live rate, scopes, hosts and recent requests.
   */
  snapshot() {
    const now = Date.now();
    const scopes = [...this.byScope.values()]
      .sort((a, b) => (b.receivedBytes + b.sentBytes) - (a.receivedBytes + a.sentBytes));
    const hosts = [...this.byHost.values()]
      .sort((a, b) => (b.receivedBytes + b.sentBytes) - (a.receivedBytes + a.sentBytes))
      .slice(0, this.maxHosts);
    const current = this.rate(now);
    return {
      startedAt: this.startedAt,
      uptimeMs: now - this.startedAt,
      // The live rate is the headline; the totals stay as context.
      sentBytesPerSecond: current.sentBytesPerSecond,
      receivedBytesPerSecond: current.receivedBytesPerSecond,
      activeRequests: current.activeRequests,
      windowMs: current.windowMs,
      sentBytes: this.sentBytes,
      receivedBytes: this.receivedBytes,
      totalBytes: this.sentBytes + this.receivedBytes,
      requests: this.requests,
      errors: this.errors,
      unmeasured: this.unmeasured,
      scopes,
      hosts,
      recent: this.recent.slice(0, 20)
    };
  }
}

/**
 * Measure a `Request` object's body through a clone.
 *
 * @param {unknown} input - the fetch input.
 * @returns {Promise<number|null>} the byte count, or `null` when unknown.
 */
async function measureRequestBody(input) {
  if (input == null || typeof input !== 'object' || typeof input.clone !== 'function') return null;
  const body = input.body;
  if (body == null) return 0;
  try {
    const reader = input.clone().body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength ?? 0;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Count the bytes of a response body while the caller still receives it.
 *
 * The response is cloned and the clone is drained in the background: the
 * caller's stream is untouched, and the byte total arrives when the body ends.
 *
 * @param {Response} response - the response to measure.
 * @param {TrafficLedger} ledger - the accumulator.
 * @param {object} entry - the request facts recorded once the body completes.
 * @returns {void}
 */
function measureResponseBody(response, ledger, entry) {
  if (response.body === null) {
    const declared = Number(response.headers.get('content-length'));
    ledger.record({
      ...entry,
      receivedBytes: Number.isFinite(declared) && declared > 0 ? declared : 0,
      durationMs: Date.now() - entry.startedAt
    });
    return;
  }

  let received = 0;
  let reader;
  try {
    reader = response.clone().body.getReader();
  } catch {
    ledger.record({ ...entry, receivedBytes: 0, durationMs: Date.now() - entry.startedAt });
    return;
  }

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength ?? 0;
      }
    } catch {
      // An aborted or cancelled body ends the count where it stopped.
    }
    ledger.record({ ...entry, receivedBytes: received, durationMs: Date.now() - entry.startedAt });
  })();
}

/**
 * Install the traffic observer.
 *
 * The wrapper is deliberately transparent: it measures, then forwards
 * `input` and `init` to the previous `fetch` by identity. A measurement that
 * fails never fails the request it measures.
 *
 * @param {TrafficLedger} ledger - the accumulator to feed.
 * @param {object} options - installation options.
 * @param {object} [options.logger] - the plugin's logger.
 * @returns {{stop: () => void, installed: boolean, error: string|null}} the owner.
 */
export function installTrafficObserver(ledger, options = {}) {
  const logger = options.logger ?? console;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const original = globalThis.fetch;

  if (typeof original !== 'function') {
    return { stop: () => {}, installed: false, error: 'globalThis.fetch is unavailable in this runtime' };
  }
  if (descriptor !== undefined && !('value' in descriptor)) {
    return { stop: () => {}, installed: false, error: 'globalThis.fetch is an accessor and cannot be observed safely' };
  }

  const observedFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input ?? ''));

    // The plugin's own endpoints are answered by the Host's HTTP server, not
    // by a fetch, so this never fires in the shipped composition. It is here
    // so a Host-side caller of the plugin's own route cannot count as
    // application traffic.
    if (url.includes('/api/network-meter/')) {
      return Reflect.apply(original, globalThis, [input, init]);
    }

    const method = (init?.method ?? (typeof input === 'object' ? input?.method : undefined) ?? 'GET').toUpperCase();
    const startedAt = Date.now();

    let sentBytes = bodyByteLength(init?.body);
    if (sentBytes === null || (sentBytes === 0 && init?.body == null && typeof input === 'object' && input?.body != null)) {
      // A Request object carrying a body: measure it through a clone so the
      // caller's payload is never consumed.
      sentBytes = await measureRequestBody(input);
    }

    let response;
    try {
      response = await Reflect.apply(original, globalThis, [input, init]);
    } catch (error) {
      ledger.record({
        url,
        method,
        sentBytes,
        receivedBytes: 0,
        status: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    measureResponseBody(response, ledger, {
      url,
      method,
      sentBytes,
      status: response.status,
      startedAt
    });

    return response;
  };

  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: observedFetch,
      writable: true,
      configurable: true,
      enumerable: descriptor?.enumerable ?? false
    });
  } catch (error) {
    return {
      stop: () => {},
      installed: false,
      error: `could not install the fetch observer: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  logger?.info?.('network-meter: observing outbound HTTP traffic');

  return {
    installed: true,
    error: null,
    stop() {
      try {
        if (descriptor === undefined) delete globalThis.fetch;
        else Object.defineProperty(globalThis, 'fetch', descriptor);
      } catch (error) {
        logger?.warn?.(`network-meter: could not restore globalThis.fetch: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
}

/**
 * The plugin's configuration schema, validated by the Loader at activation.
 *
 * This is a schemastery schema, so the Loader resolves the bundle patch's
 * `config` against it and rejects an out-of-range value before the plugin
 * runs. An unknown key is rejected too: a typo in a patch must not become a
 * silently ignored setting.
 */
const configSchema = z.object({
  /**
   * Whether the observer wraps `globalThis.fetch` at all. Turning it off
   * leaves the plugin mounted and its endpoint answering, so the UI can
   * report that observation is disabled.
   */
  observe: z.boolean().default(true),
  /** How many hosts the snapshot reports. */
  maxHosts: z.natural().max(200).default(25),
  /** How many recent requests the snapshot keeps. */
  maxRecent: z.natural().max(500).default(60),
  /** How often the browser polls the Host, in milliseconds. */
  refreshMs: z.natural().min(200).max(60000).default(1000),
  /**
   * The window the live rate is measured over, in milliseconds. A short
   * window tracks the moment; a long one smooths the jitter of one answer.
   */
  rateWindowMs: z.natural().min(500).max(60000).default(5000)
});

const CONFIG_KEYS = new Set(['observe', 'maxHosts', 'maxRecent', 'refreshMs', 'rateWindowMs']);

export const Config = Object.assign(
  (value = {}) => {
    for (const key of Object.keys(value ?? {})) {
      if (!CONFIG_KEYS.has(key)) {
        throw new Error(`network-meter: unknown configuration key "${key}" (known keys: ${[...CONFIG_KEYS].join(', ')})`);
      }
    }
    return configSchema(value);
  },
  { '~standard': configSchema['~standard'] }
);

export const name = 'dsh-plugin-network-meter';

/**
 * Activate the plugin.
 *
 * @param {object} ctx - the Cordis context.
 * @param {object} config - the validated configuration.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ? ctx.logger('network-meter') : console;
  const settings = Config(config);
  const ledger = new TrafficLedger({
    maxHosts: settings.maxHosts,
    maxRecent: settings.maxRecent,
    rateWindowMs: settings.rateWindowMs
  });

  const observer = settings.observe
    ? installTrafficObserver(ledger, { logger })
    : { stop: () => {}, installed: false, error: 'observation is disabled by configuration' };

  if (!observer.installed) {
    logger?.warn?.(`network-meter: traffic observation is off — ${observer.error}`);
  }

  const snapshot = () => ({
    ...ledger.snapshot(),
    observing: observer.installed,
    observationError: observer.error,
    refreshMs: settings.refreshMs,
    plugin: name,
    version: '1.0.0'
  });

  ctx.inject(['webServer'], (scope) => {
    const sendJson = (res, statusCode, data) => {
      const body = Buffer.from(JSON.stringify(data), 'utf8');
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(body);
    };

    // The web server's `register` returns a disposer. The plugin owns both
    // registrations, so it removes them when it unmounts: a re-enabled
    // plugin must be able to claim the same paths again.
    const disposeStats = scope.webServer.register({
      kind: 'exact',
      path: '/api/network-meter/stats',
      handler(req, res) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          return;
        }
        sendJson(res, 200, { ok: true, ...snapshot() });
      }
    });

    const disposeReset = scope.webServer.register({
      kind: 'exact',
      path: '/api/network-meter/reset',
      handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          return;
        }
        ledger.reset();
        sendJson(res, 200, { ok: true, ...snapshot() });
      }
    });

    // Unmounting the plugin releases both routes, so a re-enabled plugin can
    // claim the same paths again.
    ctx.effect(() => () => {
      disposeStats?.();
      disposeReset?.();
    }, 'network-meter: release the host routes');

    logger?.info?.('network-meter: host endpoints registered');
  });

  return () => {
    observer.stop();
    logger?.info?.('network-meter: stopped');
  };
}
