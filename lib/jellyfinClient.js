const axios = require("axios");
const crypto = require("crypto");
const common = require("./commonClient");

const HEADER_JELLYFIN_TOKEN = "X-MediaBrowser-Token";
const ITEM_TYPE_MOVIE = common.ITEM_TYPE_MOVIE;
const ITEM_TYPE_EPISODE = common.ITEM_TYPE_EPISODE;
const ITEM_TYPE_SERIES = common.ITEM_TYPE_SERIES;
const DEFAULT_FIELDS = common.DEFAULT_FIELDS;
const CODEC_FORMAT_MAP = common.CODEC_FORMAT_MAP;

const INDEX_TTL_MS = Number(process.env.JELLYFIN_INDEX_TTL_MS || 30 * 60 * 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.JELLYFIN_REQUEST_TIMEOUT_MS || 30000);
const DEFAULT_PAGE_SIZE = Math.max(25, Number(process.env.JELLYFIN_INDEX_PAGE_SIZE || 100));
const FALLBACK_PAGE_SIZE = Math.max(10, Number(process.env.JELLYFIN_FALLBACK_PAGE_SIZE || 25));
const MAX_PAGES_PER_VIEW = Math.max(10, Number(process.env.JELLYFIN_INDEX_MAX_PAGES || 2000));

// Incremental per-server indexes. We do not enumerate the whole Jellyfin server
// before answering a request. We scan the relevant user library until the requested
// provider ID is found, then resume from that point for later misses.
const scanStates = new Map();
const scanLocks = new Map();

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function makeApiRequest(url, params = {}, config, timeout = REQUEST_TIMEOUT_MS) {
  try {
    const response = await axios({
      method: "get",
      url,
      headers: { [HEADER_JELLYFIN_TOKEN]: config.accessToken },
      params,
      timeout
    });
    return response.data;
  } catch (err) {
    const sanitizedUrl = url.replace(/https?:\/\/[^\/\s:]+(?::\d+)?/, "[SERVER]");
    const sanitizedParams = { ...params };
    if (sanitizedParams.UserId) delete sanitizedParams.UserId;
    console.warn(`⚠️ Jellyfin API request failed for ${sanitizedUrl} with params ${JSON.stringify(sanitizedParams)}:`, err.message);
    if (err.response?.status === 401) {
      console.log("🔧 Jellyfin returned 401. The access token may be invalid or expired.");
    }
    return null;
  }
}

function normalizeProviderKey(providerName, providerValue) {
  if (providerValue === null || providerValue === undefined) return null;

  const provider = String(providerName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let value = String(providerValue).trim();
  if (!value) return null;

  if (provider === "imdb") {
    value = value.toLowerCase();
    if (!value.startsWith("tt")) value = `tt${value}`;
    return `imdb:${value}`;
  }
  if (provider === "tmdb") return `tmdb:${value}`;
  if (provider === "tvdb") return `tvdb:${value}`;
  if (provider === "anidb") return `anidb:${value}`;
  return null;
}

function requestedProviderKeys(imdbId, tmdbId, tvdbId, anidbId) {
  return [
    imdbId ? normalizeProviderKey("imdb", imdbId) : null,
    tmdbId ? normalizeProviderKey("tmdb", tmdbId) : null,
    tvdbId ? normalizeProviderKey("tvdb", tvdbId) : null,
    anidbId ? normalizeProviderKey("anidb", anidbId) : null
  ].filter(Boolean);
}

function addIndexedItem(index, item) {
  if (!item?.Id || !item?.ProviderIds) return;

  for (const [providerName, providerValue] of Object.entries(item.ProviderIds)) {
    const key = normalizeProviderKey(providerName, providerValue);
    if (!key) continue;
    const existing = index.get(key) || [];
    if (!existing.some(entry => entry.Id === item.Id)) {
      existing.push(item);
      index.set(key, existing);
    }
  }
}

function findInIndex(index, keys, imdbId, tmdbId, tvdbId, anidbId) {
  const found = new Map();
  for (const key of keys) {
    for (const item of index.get(key) || []) {
      if (common._isMatchingProviderId(item.ProviderIds, imdbId, tmdbId, tvdbId, anidbId)) {
        found.set(item.Id, item);
      }
    }
  }
  return [...found.values()];
}

function stateKey(itemType, config) {
  return hash([itemType, config.serverUrl, config.userId, config.accessToken].join("|"));
}

async function getRelevantViews(itemType, config) {
  const data = await makeApiRequest(
    `${config.serverUrl}/Users/${encodeURIComponent(config.userId)}/Views`,
    { EnableImages: false },
    config
  );

  const views = Array.isArray(data?.Items) ? data.Items.filter(view => view?.Id) : [];
  if (!views.length) {
    console.warn(`⚠️ Jellyfin returned no user views for ${itemType}; falling back to user root.`);
    return [{ Id: null, Name: "All Libraries", CollectionType: null }];
  }

  const wanted = itemType === ITEM_TYPE_MOVIE
    ? new Set(["movies", "mixed"])
    : new Set(["tvshows", "mixed"]);

  const relevant = views.filter(view => wanted.has(String(view.CollectionType || "").toLowerCase()));
  return relevant.length ? relevant : views;
}

async function createScanState(itemType, config) {
  return {
    index: new Map(),
    views: await getRelevantViews(itemType, config),
    viewIndex: 0,
    startIndex: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    pagesInCurrentView: 0,
    complete: false,
    expiresAt: Date.now() + INDEX_TTL_MS,
    indexedItems: 0
  };
}

async function getScanState(itemType, config) {
  const key = stateKey(itemType, config);
  let state = scanStates.get(key);
  if (!state || state.expiresAt <= Date.now()) {
    state = await createScanState(itemType, config);
    scanStates.set(key, state);
  }
  return { key, state };
}

async function fetchLibraryPage(state, itemType, config) {
  const view = state.views[state.viewIndex];
  const params = {
    Recursive: true,
    IncludeItemTypes: itemType,
    Fields: "ProviderIds,Name,Id,Type",
    StartIndex: state.startIndex,
    Limit: state.pageSize,
    EnableTotalRecordCount: false,
    EnableImages: false,
    EnableUserData: false
  };
  if (view?.Id) params.ParentId = view.Id;

  const url = `${config.serverUrl}/Users/${encodeURIComponent(config.userId)}/Items`;
  let data = await makeApiRequest(url, params, config);

  // Some very large/slow libraries still struggle with 100 DTOs. Retry the same
  // page with a smaller limit before giving up.
  if (!data && state.pageSize > FALLBACK_PAGE_SIZE) {
    state.pageSize = FALLBACK_PAGE_SIZE;
    params.Limit = state.pageSize;
    console.log(`↪️ Jellyfin ${itemType} retrying ${view?.Name || "library"} with page size ${state.pageSize}`);
    data = await makeApiRequest(url, params, config, Math.max(REQUEST_TIMEOUT_MS, 45000));
  }

  return { data, view };
}

function advanceView(state) {
  state.viewIndex += 1;
  state.startIndex = 0;
  state.pagesInCurrentView = 0;
  state.pageSize = DEFAULT_PAGE_SIZE;
  if (state.viewIndex >= state.views.length) state.complete = true;
}

async function scanUntilMatch(state, itemType, keys, imdbId, tmdbId, tvdbId, anidbId, config) {
  let existing = findInIndex(state.index, keys, imdbId, tmdbId, tvdbId, anidbId);
  if (existing.length || state.complete) return existing;

  while (!state.complete) {
    if (state.pagesInCurrentView >= MAX_PAGES_PER_VIEW) {
      console.warn(`⚠️ Jellyfin ${itemType} scan page safety limit reached for ${state.views[state.viewIndex]?.Name || "library"}.`);
      advanceView(state);
      continue;
    }

    const { data, view } = await fetchLibraryPage(state, itemType, config);
    if (!data) {
      // Do not mark the scan complete; a later request can retry this page.
      return [];
    }

    const items = Array.isArray(data.Items) ? data.Items : [];
    for (const item of items) addIndexedItem(state.index, item);
    state.indexedItems += items.length;
    state.pagesInCurrentView += 1;
    state.startIndex += items.length;

    existing = findInIndex(state.index, keys, imdbId, tmdbId, tvdbId, anidbId);
    if (existing.length) {
      console.log(`✅ Jellyfin ${itemType} provider match found after indexing ${state.indexedItems} items`);
      return existing;
    }

    if (items.length === 0 || items.length < state.pageSize) {
      console.log(`📚 Jellyfin ${itemType} scanned library: ${view?.Name || "All Libraries"}`);
      advanceView(state);
    }
  }

  console.log(`📚 Jellyfin ${itemType} provider scan complete: ${state.indexedItems} items, ${state.index.size} provider IDs`);
  return [];
}

async function findIndexedItems(itemType, imdbId, tmdbId, tvdbId, anidbId, config) {
  const keys = requestedProviderKeys(imdbId, tmdbId, tvdbId, anidbId);
  if (!keys.length) return [];

  const { key, state } = await getScanState(itemType, config);
  const cached = findInIndex(state.index, keys, imdbId, tmdbId, tvdbId, anidbId);
  if (cached.length) return cached;
  if (state.complete) return [];

  // Serialize scans for the same user/library so simultaneous different titles do
  // not issue duplicate recursive page requests against Jellyfin.
  const previous = scanLocks.get(key) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => scanUntilMatch(state, itemType, keys, imdbId, tmdbId, tvdbId, anidbId, config));
  scanLocks.set(key, current.finally(() => {
    if (scanLocks.get(key) === current) scanLocks.delete(key);
  }));

  return current;
}

async function findMovieItem(imdbId, tmdbId, tvdbId, anidbId, config) {
  return findIndexedItems(ITEM_TYPE_MOVIE, imdbId, tmdbId, tvdbId, anidbId, config);
}

async function findSeriesItem(imdbId, tmdbId, tvdbId, anidbId, config) {
  return findIndexedItems(ITEM_TYPE_SERIES, imdbId, tmdbId, tvdbId, anidbId, config);
}

async function findEpisodeItem(parentSeriesItem, seasonNumber, episodeNumber, config) {
  const seasonsData = await makeApiRequest(
    `${config.serverUrl}/Shows/${parentSeriesItem.Id}/Seasons`,
    { UserId: config.userId, Fields: "Id,IndexNumber,Name" },
    config
  );
  if (!seasonsData?.Items?.length) return null;

  const targetSeason = seasonsData.Items.find(s => Number(s.IndexNumber) === Number(seasonNumber));
  if (!targetSeason) return null;

  const episodesData = await makeApiRequest(
    `${config.serverUrl}/Shows/${parentSeriesItem.Id}/Episodes`,
    { SeasonId: targetSeason.Id, UserId: config.userId, Fields: DEFAULT_FIELDS },
    config
  );
  if (!episodesData?.Items?.length) return null;

  return episodesData.Items.find(ep =>
    Number(ep.IndexNumber) === Number(episodeNumber) &&
    Number(ep.ParentIndexNumber) === Number(seasonNumber)
  ) || null;
}

async function getPlaybackStreams(item, seriesName = null, config) {
  const playbackInfoData = await makeApiRequest(
    `${config.serverUrl}/Items/${item.Id}/PlaybackInfo`,
    { UserId: config.userId },
    config
  );

  if (!playbackInfoData?.MediaSources?.length) {
    console.warn("❌ No Jellyfin MediaSources found for item:", item.Name, `(${item.Id})`);
    return null;
  }

  const streamDetailsArray = [];
  for (const source of playbackInfoData.MediaSources) {
    try {
      const videoStream = source.MediaStreams?.find(ms => ms.Type === "Video");
      const audioStream = source.MediaStreams?.find(ms => ms.Type === "Audio" && ms.IsDefault)
        || source.MediaStreams?.find(ms => ms.Type === "Audio");
      const subtitleStreams = source.MediaStreams?.filter(ms => ms.Type === "Subtitle") || [];
      const mediaInfo = common.safeExtractMediaInfo(source, videoStream, audioStream);
      const streamDescription = common.buildStreamDescription(mediaInfo);

      let qualityTitle = "";
      if (videoStream) {
        qualityTitle += videoStream.DisplayTitle || "";
        if (videoStream.Width && videoStream.Height &&
            !qualityTitle.toLowerCase().includes(`${videoStream.Height}p`) &&
            !qualityTitle.toLowerCase().includes(`${videoStream.Width}x${videoStream.Height}`)) {
          qualityTitle = `${qualityTitle ? qualityTitle + " " : ""}${videoStream.Height}p`;
        }
        if (videoStream.Codec && !qualityTitle.toLowerCase().includes(videoStream.Codec.toLowerCase())) {
          qualityTitle = `${qualityTitle ? qualityTitle + " " : ""}${videoStream.Codec.toUpperCase()}`;
        }
      } else if (source.Container) {
        qualityTitle = source.Container.toUpperCase();
      }
      if (source.Name && !qualityTitle) qualityTitle = source.Name;
      qualityTitle = qualityTitle || "Direct Play";

      const container = source.Container || "mkv";
      const directPlayUrl = `${config.serverUrl}/Videos/${item.Id}/stream.${container}?MediaSourceId=${encodeURIComponent(source.Id)}&Static=true&api_key=${encodeURIComponent(config.accessToken)}&DeviceId=stremio-addon-device-id`;

      const subtitles = subtitleStreams.map(sub => {
        const format = CODEC_FORMAT_MAP[sub.Codec?.toLowerCase()] || "srt";
        return {
          id: `sub-${item.Id}-${source.Id}-${sub.Index}`,
          lang: sub.Language || "und",
          url: `${config.serverUrl}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.${format}?api_key=${encodeURIComponent(config.accessToken)}`
        };
      });

      streamDetailsArray.push({
        directPlayUrl,
        itemName: item.Name,
        seriesName,
        seasonNumber: item.Type === ITEM_TYPE_EPISODE ? item.ParentIndexNumber : null,
        episodeNumber: item.Type === ITEM_TYPE_EPISODE ? item.IndexNumber : null,
        itemId: item.Id,
        mediaSourceId: source.Id,
        container: source.Container,
        videoCodec: videoStream?.Codec || source.VideoCodec || null,
        audioCodec: audioStream?.Codec || null,
        qualityTitle,
        embyUrlBase: config.serverUrl,
        apiKey: config.accessToken,
        subtitles,
        streamDescription,
        mediaInfo
      });
    } catch (error) {
      console.error(`❌ Error processing Jellyfin MediaSource ${source.Id} for item ${item.Id}:`, error?.message || String(error));
    }
  }

  return streamDetailsArray.length ? streamDetailsArray : null;
}

async function getStream(idOrExternalId, config) {
  if (!config.serverUrl || !config.userId || !config.accessToken) {
    console.error("❌ Jellyfin configuration missing (serverUrl, userId, or accessToken)");
    return null;
  }

  let fullIdForLog = idOrExternalId;
  try {
    const parsedId = common.parseMediaId(idOrExternalId);
    if (!parsedId) {
      console.error(`❌ Failed to parse Jellyfin input ID: ${idOrExternalId}`);
      return null;
    }

    fullIdForLog = parsedId.baseId + (parsedId.itemType === ITEM_TYPE_EPISODE
      ? ` S${parsedId.seasonNumber}E${parsedId.episodeNumber}` : "");

    if (parsedId.itemType === ITEM_TYPE_MOVIE) {
      const items = await findMovieItem(parsedId.imdbId, parsedId.tmdbId, parsedId.tvdbId, parsedId.anidbId, config);
      if (!items.length) return null;
      const results = await Promise.all(items.map(item => getPlaybackStreams(item, null, config)));
      const allStreams = results.flatMap(streams => streams || []);
      return allStreams.length ? common.deduplicateAndSortStreams(allStreams) : null;
    }

    if (parsedId.itemType === ITEM_TYPE_EPISODE) {
      const seriesItems = await findSeriesItem(parsedId.imdbId, parsedId.tmdbId, parsedId.tvdbId, parsedId.anidbId, config);
      if (!seriesItems.length) return null;
      const results = await Promise.all(seriesItems.map(async series => {
        const episode = await findEpisodeItem(series, parsedId.seasonNumber, parsedId.episodeNumber, config);
        return episode ? getPlaybackStreams(episode, series.Name, config) : null;
      }));
      const allStreams = results.flatMap(streams => streams || []);
      return allStreams.length ? common.deduplicateAndSortStreams(allStreams) : null;
    }

    return null;
  } catch (err) {
    console.error(`❌ Unhandled Jellyfin error for ID ${fullIdForLog}:`, err?.message || String(err));
    if (err?.stack && process.env.NODE_ENV === "development") console.error("Stack trace:", err.stack);
    return null;
  }
}

module.exports = {
  getStream,
  parseMediaId: common.parseMediaId,
  deduplicateAndSortStreams: common.deduplicateAndSortStreams
};
