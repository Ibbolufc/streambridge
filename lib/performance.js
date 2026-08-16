const crypto = require('crypto');
const http = require('http');
const https = require('https');
const axios = require('axios');

// Safe performance layer for StreamBridge.
// It deliberately does NOT replace or monkey-patch Axios itself. Instead it:
//   1) enables persistent HTTP/HTTPS connections via Axios defaults;
//   2) caches complete getStream() results for Emby and Jellyfin;
//   3) coalesces identical simultaneous lookups into one backend resolution;
//   4) keeps Jellyfin library-index requests lightweight enough for large libraries.

const STREAM_TTL_MS = Number(process.env.STREAM_CACHE_TTL_MS || 10 * 60 * 1000);
const NEGATIVE_TTL_MS = Number(process.env.STREAM_NEGATIVE_CACHE_TTL_MS || 30 * 1000);
const MAX_CACHE_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 5000);
const JELLYFIN_REQUEST_TIMEOUT_MS = Number(process.env.JELLYFIN_REQUEST_TIMEOUT_MS || 30000);

class TTLCache {
  constructor(maxEntries) {
    this.maxEntries = Math.max(100, maxEntries || 5000);
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return { hit: false, value: undefined };

    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return { hit: false, value: undefined };
    }

    this.map.delete(key);
    this.map.set(key, entry);
    return { hit: true, value: entry.value };
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1000, ttlMs)
    });

    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  size() {
    return this.map.size;
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Reuse connections to media servers instead of repeatedly opening TCP/TLS sessions.
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 128,
  maxFreeSockets: 32
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 128,
  maxFreeSockets: 32
});

axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value) return value;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return undefined;
}

// Jellyfin can be slow when asked to enumerate a large recursive library with
// ProviderIds. Keep those requests deliberately lean and allow a longer timeout.
axios.interceptors.request.use(config => {
  const isJellyfin = Boolean(getHeader(config.headers, 'X-MediaBrowser-Token'));
  const isLibraryItemsRequest = isJellyfin && /\/Items(?:$|\?)/i.test(String(config.url || ''));

  if (isLibraryItemsRequest) {
    config.timeout = Math.max(Number(config.timeout || 0), JELLYFIN_REQUEST_TIMEOUT_MS);
    config.params = {
      ...(config.params || {}),
      EnableTotalRecordCount: false,
      EnableImages: false,
      EnableUserData: false
    };
  }

  return config;
});

const streamCache = new TTLCache(MAX_CACHE_ENTRIES);
const inFlight = new Map();

const stats = {
  hits: 0,
  misses: 0,
  coalesced: 0,
  resolved: 0
};

function wrapClient(client, serverType) {
  if (!client || typeof client.getStream !== 'function' || client.__streamBridgeOptimized) return;

  const originalGetStream = client.getStream.bind(client);

  client.getStream = async function optimizedGetStream(idOrExternalId, config) {
    if (!config?.serverUrl || !config?.userId || !config?.accessToken) {
      return originalGetStream(idOrExternalId, config);
    }

    // Credentials contribute to the key but are never stored in readable form.
    const key = hash([
      serverType,
      config.serverUrl,
      config.userId,
      config.accessToken,
      idOrExternalId
    ].join('|'));

    const cached = streamCache.get(key);
    if (cached.hit) {
      stats.hits++;
      return cached.value;
    }

    if (inFlight.has(key)) {
      stats.coalesced++;
      return inFlight.get(key);
    }

    stats.misses++;

    const lookup = Promise.resolve()
      .then(() => originalGetStream(idOrExternalId, config))
      .then(result => {
        const hasStreams = Array.isArray(result) && result.length > 0;
        streamCache.set(key, result, hasStreams ? STREAM_TTL_MS : NEGATIVE_TTL_MS);
        stats.resolved++;
        return result;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, lookup);
    return lookup;
  };

  Object.defineProperty(client, '__streamBridgeOptimized', {
    value: true,
    enumerable: false
  });
}

wrapClient(require('./embyClient'), 'emby');
wrapClient(require('./jellyfinClient'), 'jellyfin');

module.exports = {
  getStats() {
    return {
      ...stats,
      cacheEntries: streamCache.size(),
      inFlight: inFlight.size
    };
  }
};

console.log('⚡ StreamBridge safe performance layer enabled for Emby + Jellyfin');
