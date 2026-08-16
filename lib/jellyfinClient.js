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
const INDEX_PAGE_SIZE = Math.max(100, Number(process.env.JELLYFIN_INDEX_PAGE_SIZE || 1000));
const INDEX_MAX_PAGES = Math.max(1, Number(process.env.JELLYFIN_INDEX_MAX_PAGES || 100));

const libraryIndexCache = new Map();
const libraryIndexInFlight = new Map();

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function makeApiRequest(url, params = {}, config) {
  try {
    const response = await axios({
      method: "get",
      url,
      headers: { [HEADER_JELLYFIN_TOKEN]: config.accessToken },
      params,
      timeout: 10000
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

  const provider = String(providerName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
  const keys = [];
  if (imdbId) keys.push(normalizeProviderKey("imdb", imdbId));
  if (tmdbId) keys.push(normalizeProviderKey("tmdb", tmdbId));
  if (tvdbId) keys.push(normalizeProviderKey("tvdb", tvdbId));
  if (anidbId) keys.push(normalizeProviderKey("anidb", anidbId));
  return keys.filter(Boolean);
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

function indexCacheKey(itemType, config) {
  return hash([itemType, config.serverUrl, config.userId, config.accessToken].join("|"));
}

async function buildLibraryIndex(itemType, config) {
  const index = new Map();
  let startIndex = 0;
  let indexedItems = 0;

  for (let page = 0; page < INDEX_MAX_PAGES; page++) {
    const data = await makeApiRequest(`${config.serverUrl}/Items`, {
      UserId: config.userId,
      Recursive: true,
      IncludeItemTypes: itemType,
      Fields: "ProviderIds,Name,Id,Type",
      StartIndex: startIndex,
      Limit: INDEX_PAGE_SIZE,
      EnableTotalRecordCount: true
    }, config);

    const items = data?.Items || [];
    for (const item of items) addIndexedItem(index, item);
    indexedItems += items.length;

    const total = Number(data?.TotalRecordCount || 0);
    startIndex += items.length;

    if (items.length === 0 || items.length < INDEX_PAGE_SIZE || (total > 0 && startIndex >= total)) {
      break;
    }
  }

  console.log(`📚 Jellyfin ${itemType} provider index ready: ${indexedItems} items, ${index.size} provider IDs`);
  return index;
}

async function getLibraryIndex(itemType, config) {
  const key = indexCacheKey(itemType, config);
  const cached = libraryIndexCache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.index;
  }
  if (cached) libraryIndexCache.delete(key);

  if (libraryIndexInFlight.has(key)) {
    return libraryIndexInFlight.get(key);
  }

  const buildPromise = buildLibraryIndex(itemType, config)
    .then(index => {
      libraryIndexCache.set(key, {
        index,
        expiresAt: Date.now() + INDEX_TTL_MS
      });
      return index;
    })
    .finally(() => {
      libraryIndexInFlight.delete(key);
    });

  libraryIndexInFlight.set(key, buildPromise);
  return buildPromise;
}

async function findIndexedItems(itemType, imdbId, tmdbId, tvdbId, anidbId, config) {
  const keys = requestedProviderKeys(imdbId, tmdbId, tvdbId, anidbId);
  if (keys.length === 0) return [];

  const index = await getLibraryIndex(itemType, config);
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
    {
      SeasonId: targetSeason.Id,
      UserId: config.userId,
      Fields: DEFAULT_FIELDS
    },
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
        if (videoStream.Width && videoStream.Height) {
          if (!qualityTitle.toLowerCase().includes(`${videoStream.Height}p`) &&
              !qualityTitle.toLowerCase().includes(`${videoStream.Width}x${videoStream.Height}`)) {
            qualityTitle = `${qualityTitle ? qualityTitle + " " : ""}${videoStream.Height}p`;
          }
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
        const codec = sub.Codec?.toLowerCase();
        const format = CODEC_FORMAT_MAP[codec] || "srt";
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

  return streamDetailsArray.length > 0 ? streamDetailsArray : null;
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

    fullIdForLog = parsedId.baseId + (
      parsedId.itemType === ITEM_TYPE_EPISODE
        ? ` S${parsedId.seasonNumber}E${parsedId.episodeNumber}`
        : ""
    );

    if (parsedId.itemType === ITEM_TYPE_MOVIE) {
      const items = await findMovieItem(
        parsedId.imdbId,
        parsedId.tmdbId,
        parsedId.tvdbId,
        parsedId.anidbId,
        config
      );

      if (!items.length) return null;

      const results = await Promise.all(items.map(item => getPlaybackStreams(item, null, config)));
      const allStreams = results.flatMap(streams => streams || []);
      return allStreams.length ? common.deduplicateAndSortStreams(allStreams) : null;
    }

    if (parsedId.itemType === ITEM_TYPE_EPISODE) {
      const seriesItems = await findSeriesItem(
        parsedId.imdbId,
        parsedId.tmdbId,
        parsedId.tvdbId,
        parsedId.anidbId,
        config
      );

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
    if (err?.stack && process.env.NODE_ENV === "development") {
      console.error("Stack trace:", err.stack);
    }
    return null;
  }
}

module.exports = {
  getStream,
  parseMediaId: common.parseMediaId,
  deduplicateAndSortStreams: common.deduplicateAndSortStreams
};
