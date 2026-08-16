const crypto = require('crypto');
const http = require('http');
const https = require('https');
const axios = require('axios');

// Safe performance layer for StreamBridge (Emby only).
// 1) persistent HTTP/HTTPS connections;
// 2) complete stream-result caching;
// 3) duplicate in-flight request coalescing.

const STREAM_TTL_MS = Number(process.env.STREAM_CACHE_TTL_MS || 10 * 60 * 1000);
const NEGATIVE_TTL_MS = Number(process.env.STREAM_NEGATIVE_CACHE_TTL_MS || 30 * 1000);
const MAX_CACHE_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 5000);

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

const streamCache = new TTLCache(MAX_CACHE_ENTRIES);
const inFlight = new Map();

const embyClient = require('./embyClient');
const originalGetStream = embyClient.getStream.bind(embyClient);

embyClient.getStream = async function optimizedGetStream(idOrExternalId, config) {
  if (!config?.serverUrl || !config?.userId || !config?.accessToken) {
    return originalGetStream(idOrExternalId, config);
  }

  const key = hash([
    config.serverUrl,
    config.userId,
    config.accessToken,
    idOrExternalId
  ].join('|'));

  const cached = streamCache.get(key);
  if (cached.hit) return cached.value;

  if (inFlight.has(key)) return inFlight.get(key);

  const lookup = Promise.resolve()
    .then(() => originalGetStream(idOrExternalId, config))
    .then(result => {
      const hasStreams = Array.isArray(result) && result.length > 0;
      streamCache.set(key, result, hasStreams ? STREAM_TTL_MS : NEGATIVE_TTL_MS);
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, lookup);
  return lookup;
};

module.exports = {};

console.log('⚡ StreamBridge safe performance layer enabled for Emby');
