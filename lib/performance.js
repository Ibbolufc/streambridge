const crypto = require('crypto');
const http = require('http');
const https = require('https');

const STREAM_TTL_MS = Number(process.env.STREAM_CACHE_TTL_MS || 10 * 60 * 1000);
const STREAM_EMPTY_TTL_MS = Number(process.env.STREAM_NEGATIVE_CACHE_TTL_MS || 30 * 1000);
const API_TTL_MS = Number(process.env.API_CACHE_TTL_MS || 10 * 60 * 1000);
const API_EMPTY_TTL_MS = Number(process.env.API_NEGATIVE_CACHE_TTL_MS || 30 * 1000);
const SEASON_TTL_MS = Number(process.env.SEASON_CACHE_TTL_MS || 30 * 60 * 1000);
const EPISODE_TTL_MS = Number(process.env.EPISODE_CACHE_TTL_MS || 5 * 60 * 1000);
const PLAYBACK_TTL_MS = Number(process.env.PLAYBACK_CACHE_TTL_MS || 10 * 60 * 1000);
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

    // Refresh insertion order so frequently used entries survive pruning.
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
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableSerialize(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;

  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(',')}}`;
}

function getHeader(headers, name) {
  if (!headers) return '';
  const wanted = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value || '');
  }
  return '';
}

function isEmptyApiResult(data) {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data.Items)) return data.Items.length === 0;
  if (Array.isArray(data.MediaSources)) return data.MediaSources.length === 0;
  return false;
}

function apiTtlFor(url, data) {
  if (isEmptyApiResult(data)) return API_EMPTY_TTL_MS;
  if (/\/Shows\/[^/]+\/Seasons(?:\?|$)/i.test(url)) return SEASON_TTL_MS;
  if (/\/Shows\/[^/]+\/Episodes(?:\?|$)/i.test(url)) return EPISODE_TTL_MS;
  if (/\/Items\/[^/]+\/PlaybackInfo(?:\?|$)/i.test(url)) return PLAYBACK_TTL_MS;
  return API_TTL_MS;
}

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000
});

const apiCache = new TTLCache(MAX_CACHE_ENTRIES);
const apiInFlight = new Map();
const streamCache = new TTLCache(MAX_CACHE_ENTRIES);
const streamInFlight = new Map();

// Patch Axios before embyClient is loaded. This keeps Emby TCP/TLS connections
// alive, caches safe GET responses, and coalesces identical in-flight requests.
const axiosPath = require.resolve('axios');
const originalAxios = require(axiosPath);

function normalizeAxiosConfig(configOrUrl, maybeConfig) {
  if (typeof configOrUrl === 'string') {
    return { ...(maybeConfig || {}), url: configOrUrl };
  }
  return { ...(configOrUrl || {}) };
}

async function optimizedAxios(configOrUrl, maybeConfig) {
  const config = normalizeAxiosConfig(configOrUrl, maybeConfig);
  const method = String(config.method || 'get').toLowerCase();
  const enhancedConfig = {
    ...config,
    httpAgent: config.httpAgent || httpAgent,
    httpsAgent: config.httpsAgent || httpsAgent
  };

  if (method !== 'get' || !enhancedConfig.url) {
    return originalAxios(enhancedConfig);
  }

  const authFingerprint = getHeader(enhancedConfig.headers, 'x-emby-token')
    || getHeader(enhancedConfig.headers, 'authorization');
  const key = hash([
    method,
    enhancedConfig.url,
    stableSerialize(enhancedConfig.params || {}),
    authFingerprint
  ].join('|'));

  const cached = apiCache.get(key);
  if (cached.hit) {
    return {
      ...cached.value,
      config: enhancedConfig,
      request: undefined
    };
  }

  if (apiInFlight.has(key)) {
    return apiInFlight.get(key);
  }

  const requestPromise = originalAxios(enhancedConfig)
    .then(response => {
      apiCache.set(key, {
        data: response.data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }, apiTtlFor(enhancedConfig.url, response.data));
      return response;
    })
    .finally(() => {
      apiInFlight.delete(key);
    });

  apiInFlight.set(key, requestPromise);
  return requestPromise;
}

// Preserve the normal Axios helper surface for compatibility.
Object.assign(optimizedAxios, originalAxios);
optimizedAxios.request = config => optimizedAxios(config);
require.cache[axiosPath].exports = optimizedAxios;

// Load the original resolver once with the optimized Axios instance, then wrap
// its public getStream function with a higher-level result cache. This avoids
// repeating provider lookup + series/season/episode + PlaybackInfo work.
const embyClientPath = require.resolve('./embyClient');
const originalEmbyClient = require(embyClientPath);
const originalGetStream = originalEmbyClient.getStream.bind(originalEmbyClient);

async function optimizedGetStream(idOrExternalId, config) {
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

  if (streamInFlight.has(key)) {
    return streamInFlight.get(key);
  }

  const resolvePromise = Promise.resolve(originalGetStream(idOrExternalId, config))
    .then(result => {
      const hasStreams = Array.isArray(result) && result.length > 0;
      streamCache.set(
        key,
        result,
        hasStreams ? STREAM_TTL_MS : STREAM_EMPTY_TTL_MS
      );
      return result;
    })
    .finally(() => {
      streamInFlight.delete(key);
    });

  streamInFlight.set(key, resolvePromise);
  return resolvePromise;
}

require.cache[embyClientPath].exports = {
  ...originalEmbyClient,
  getStream: optimizedGetStream
};

console.log('⚡ StreamBridge performance layer enabled');
