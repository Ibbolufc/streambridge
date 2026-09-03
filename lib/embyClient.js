const axios = require("axios");
const common = require("./commonClient");

// --- Constants ---
const HEADER_EMBY_TOKEN = 'X-Emby-Token';
const ITEM_TYPE_MOVIE = common.ITEM_TYPE_MOVIE;
const ITEM_TYPE_EPISODE = common.ITEM_TYPE_EPISODE;
const ITEM_TYPE_SERIES = common.ITEM_TYPE_SERIES;
const DEFAULT_FIELDS = common.DEFAULT_FIELDS;
const CODEC_FORMAT_MAP = common.CODEC_FORMAT_MAP;

// --- Silo external-ID index ---
// Silo's Jellyfin compatibility layer exposes ProviderIds on item-list responses,
// but currently doesn't implement Emby's ImdbId/TmdbId/TvdbId/AnyProviderIdEquals
// filters. Build a short-lived in-memory index for Silo only; Emby behaviour stays
// exactly as before.
const siloIndexCache = new Map();
const SILO_INDEX_TTL_MS = 10 * 60 * 1000;

function isSilo(config = {}) {
    return String(config.backend || config.serverType || 'emby').toLowerCase() === 'silo';
}

function normalizeProviderIds(providerIds = {}) {
    const out = {};
    for (const [key, value] of Object.entries(providerIds || {})) {
        if (value == null) continue;
        out[String(key).toLowerCase()] = String(value).trim();
    }
    return out;
}

function siloCacheKey(config) {
    return `${config.serverUrl}|${config.userId}`;
}

function addSiloIndexItem(index, item) {
    if (!item?.Id) return;
    const type = String(item.Type || '').toLowerCase();
    const bucket = type === 'series' ? index.series : type === 'movie' ? index.movie : null;
    if (!bucket) return;
    const ids = normalizeProviderIds(item.ProviderIds || item.ProviderIDs);
    if (ids.imdb) bucket.imdb.set(ids.imdb.toLowerCase(), item);
    if (ids.tmdb) bucket.tmdb.set(ids.tmdb, item);
    if (ids.tvdb) bucket.tvdb.set(ids.tvdb, item);
    if (ids.anidb) bucket.anidb.set(ids.anidb, item);
}

async function buildSiloProviderIndex(config, force = false) {
    const key = siloCacheKey(config);
    const cached = siloIndexCache.get(key);
    if (!force && cached && Date.now() - cached.builtAt < SILO_INDEX_TTL_MS) return cached;

    const index = {
        builtAt: Date.now(),
        movie: { imdb: new Map(), tmdb: new Map(), tvdb: new Map(), anidb: new Map() },
        series: { imdb: new Map(), tmdb: new Map(), tvdb: new Map(), anidb: new Map() }
    };

    const limit = 500;
    let startIndex = 0;
    let total = Infinity;

    while (startIndex < total) {
        const data = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, {
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            Fields: 'ProviderIds,Name,Id',
            StartIndex: startIndex,
            Limit: limit,
            EnableTotalRecordCount: true
        }, config);

        if (!data || !Array.isArray(data.Items)) break;
        for (const item of data.Items) addSiloIndexItem(index, item);
        total = Number.isFinite(Number(data.TotalRecordCount)) ? Number(data.TotalRecordCount) : startIndex + data.Items.length;
        if (data.Items.length === 0) break;
        startIndex += data.Items.length;
        if (data.Items.length < limit) break;
    }

    index.builtAt = Date.now();
    siloIndexCache.set(key, index);
    console.log(`🧱 Silo provider index built: ${index.movie.imdb.size + index.movie.tmdb.size} movie keys, ${index.series.imdb.size + index.series.tmdb.size + index.series.tvdb.size} series keys`);
    return index;
}

function findSiloIndexedItem(index, kind, imdbId, tmdbId, tvdbId, anidbId) {
    const bucket = index?.[kind];
    if (!bucket) return [];
    let item = null;
    if (imdbId) item = bucket.imdb.get(String(imdbId).toLowerCase());
    if (!item && tmdbId) item = bucket.tmdb.get(String(tmdbId));
    if (!item && tvdbId) item = bucket.tvdb.get(String(tvdbId));
    if (!item && anidbId) item = bucket.anidb.get(String(anidbId));
    return item ? [item] : [];
}

async function findSiloItems(kind, imdbId, tmdbId, tvdbId, anidbId, config) {
    let index = await buildSiloProviderIndex(config);
    let found = findSiloIndexedItem(index, kind, imdbId, tmdbId, tvdbId, anidbId);
    // Refresh once on a miss so newly-added media can resolve immediately instead
    // of waiting for the cache TTL.
    if (found.length === 0) {
        index = await buildSiloProviderIndex(config, true);
        found = findSiloIndexedItem(index, kind, imdbId, tmdbId, tvdbId, anidbId);
    }
    return found;
}

// --- Emby Item Finding ---

/**
 * Performs an Emby API request with standard headers and error handling.
 * @param {string} url - The full URL for the API request.
 * @param {object} [params] - Optional query parameters.
 * @param {string} [method='get'] - The HTTP method.
 * @param {object} config - The configuration object containing serverUrl, userId, and accessToken.
 * @returns {Promise<object|null>} The response data object or null if an error occurs.
 */
async function makeApiRequest(url, params = {}, config) {
    try {
        const response = await axios({
            method: 'get',
            url: url,
            headers: { [HEADER_EMBY_TOKEN]: config.accessToken },
            params: params,
            timeout: 10000 // 10 seconds timeout
        });
        return response.data;
    } catch (err) {
        // SECURITY: Redact sensitive info from URL (remove domain/host to protect user's server URL)
        // Match protocol, domain, and optional port, replace with [SERVER]
        const sanitizedUrl = url.replace(/https?:\/\/[^\/\s:]+(?::\d+)?/, '[SERVER]');
        const sanitizedParams = { ...params };
        // Remove userId from params if present (it's already in the URL path, but less sensitive)
        if (sanitizedParams.UserId) delete sanitizedParams.UserId;
        
        console.warn(`⚠️ API Request failed for ${sanitizedUrl} with params ${JSON.stringify(sanitizedParams)}:`, err.message);
        
        if (err.response?.status === 401) {
             console.log("🔧 Detected Unauthorized (401). The provided access token might be invalid or expired.");
        }
        return null; // Indicate failure
    }
}

/**
 * Attempts to find a movie item in Emby using various strategies.
 */
async function findMovieItem(imdbId, tmdbId, tvdbId, anidbId, config) {
    if (isSilo(config)) {
        return findSiloItems('movie', imdbId, tmdbId, tvdbId, anidbId, config);
    }

    let foundItems = [];
    const baseMovieParams = {
        IncludeItemTypes: ITEM_TYPE_MOVIE,
        Recursive: true,
        Fields: DEFAULT_FIELDS,
        Limit: 10, // Limit results per query
        Filters: "IsNotFolder", // Important filter for movies
        UserId: config.userId
    };

    // --- Strategy 1: Direct ID Lookup (/Items) ---
    const directLookupParams = { ...baseMovieParams };
    let searchedIdField = "";
    if (imdbId) { directLookupParams.ImdbId = imdbId; searchedIdField = "ImdbId"; }
    else if (tmdbId) { directLookupParams.TmdbId = tmdbId; searchedIdField = "TmdbId"; }
    else if (tvdbId) { directLookupParams.TvdbId = tvdbId; searchedIdField = "TvdbId"; }
    else if (anidbId) { directLookupParams.AniDbId = anidbId; searchedIdField = "AniDbId"; }
    if (searchedIdField) {
        const data = await makeApiRequest(`${config.serverUrl}/Items`, directLookupParams, config);
        if (data?.Items?.length > 0) {
            const matches = data.Items.filter(i => common._isMatchingProviderId(i.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
            if (matches.length > 0) {
                foundItems.push(...matches);
            }
        }
    }

    // --- Strategy 2: AnyProviderIdEquals Lookup (/Users/{UserId}/Items) ---
    if (foundItems.length === 0) {
        const anyProviderIdFormats = [];
        if (imdbId) {
            const numericImdbId = imdbId.replace('tt', '');
            anyProviderIdFormats.push(`imdb.${imdbId}`, `Imdb.${imdbId}`);
            if (numericImdbId !== imdbId) anyProviderIdFormats.push(`imdb.${numericImdbId}`, `Imdb.${numericImdbId}`);
        } else if (tmdbId) {
            anyProviderIdFormats.push(`tmdb.${tmdbId}`, `Tmdb.${tmdbId}`);
        } else if (tvdbId) {
            anyProviderIdFormats.push(`tvdb.${tvdbId}`, `Tvdb.${tvdbId}`);
        } else if (anidbId) {
            anyProviderIdFormats.push(`anidb.${anidbId}`, `AniDb.${anidbId}`);
        }

        for (const attemptFormat of anyProviderIdFormats) {
            const altParams = { ...baseMovieParams, AnyProviderIdEquals: attemptFormat };
            delete altParams.ImdbId;
            delete altParams.TmdbId;
            delete altParams.TvdbId;
            delete altParams.AniDbId;
            delete altParams.UserId;

            const data = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, altParams, config);
            if (data?.Items?.length > 0) {
                const matches = data.Items.filter(i => common._isMatchingProviderId(i.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
                 if (matches.length > 0) {
                    foundItems.push(...matches);
                }
            }
        }
    }

    return foundItems;
}

/**
 * Attempts to find a series item in Emby.
 */
async function findSeriesItem(imdbId, tmdbId, tvdbId, anidbId, config) {
    if (isSilo(config)) {
        return findSiloItems('series', imdbId, tmdbId, tvdbId, anidbId, config);
    }

    let foundSeries = [];
    const baseSeriesParams = {
        IncludeItemTypes: ITEM_TYPE_SERIES,
        Recursive: true,
        Fields: "ProviderIds,Name,Id", // Only need these fields for series lookup
        Limit: 5
    };

    // --- Strategy 1: Direct ID Lookup (/Users/{UserId}/Items) ---
    const seriesLookupParams1 = { ...baseSeriesParams };
    if (imdbId) seriesLookupParams1.ImdbId = imdbId;
    else if (tmdbId) seriesLookupParams1.TmdbId = tmdbId;
    else if (tvdbId) seriesLookupParams1.TvdbId = tvdbId;
    else if (anidbId) seriesLookupParams1.AniDbId = anidbId;
    const data1 = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, seriesLookupParams1, config);
    if (data1?.Items?.length > 0) {
        const matches = data1.Items.filter(s => common._isMatchingProviderId(s.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
        if (matches.length > 0) {
            foundSeries.push(...matches);
        }
    }

    // --- Strategy 2: AnyProviderIdEquals Lookup (/Users/{UserId}/Items) ---
    if (foundSeries.length === 0) {
        let anyProviderIdValue = null;
        if (imdbId) anyProviderIdValue = `imdb.${imdbId}`;
        else if (tmdbId) anyProviderIdValue = `tmdb.${tmdbId}`;
        else if (tvdbId) anyProviderIdValue = `tvdb.${tvdbId}`;
        else if (anidbId) anyProviderIdValue = `anidb.${anidbId}`;
        if (anyProviderIdValue) {
            const seriesLookupParams2 = { ...baseSeriesParams, AnyProviderIdEquals: anyProviderIdValue };
            delete seriesLookupParams2.ImdbId;
            delete seriesLookupParams2.TmdbId;
            delete seriesLookupParams2.TvdbId;
            delete seriesLookupParams2.AniDbId;
            const data2 = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, seriesLookupParams2, config);
            if (data2?.Items?.length > 0) {
                const matches = data2.Items.filter(s => common._isMatchingProviderId(s.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
                 if (matches.length > 0) {
                    foundSeries.push(...matches);
                }
            }
        }
    }

    return foundSeries;
}

/**
 * Finds a specific episode within a given series and season in Emby.
 */
async function findEpisodeItem(parentSeriesItem, seasonNumber, episodeNumber, config) {
    // 1. Get Seasons for the Series
    const seasonsParams = { UserId: config.userId, Fields: "Id,IndexNumber,Name" };
    const seasonsData = await makeApiRequest(`${config.serverUrl}/Shows/${parentSeriesItem.Id}/Seasons`, seasonsParams, config);

    if (!seasonsData?.Items?.length > 0) {
        return null;
    }

    // 2. Find the Target Season
    const targetSeason = seasonsData.Items.find(s => s.IndexNumber === seasonNumber);
    if (!targetSeason) {
        return null;
    }

    // 3. Get Episodes for the Target Season
    const episodesParams = {
        SeasonId: targetSeason.Id,
        UserId: config.userId,
        Fields: DEFAULT_FIELDS
    };
    const episodesData = await makeApiRequest(`${config.serverUrl}/Shows/${parentSeriesItem.Id}/Episodes`, episodesParams, config);

    if (!episodesData?.Items?.length > 0) {
        return null;
    }

    // 4. Find the Target Episode
    const targetEpisode = episodesData.Items.find(ep => ep.IndexNumber === episodeNumber && ep.ParentIndexNumber === seasonNumber);

    if (!targetEpisode) {
        return null;
    }

    return targetEpisode;
}

/**
 * Gets playback information for an Emby item and generates direct play stream URLs.
 */
async function getPlaybackStreams(item, seriesName = null, config) {
    
    const playbackInfoParams = { UserId: config.userId};
    const playbackInfoData = await makeApiRequest(
        `${config.serverUrl}/Items/${item.Id}/PlaybackInfo`,
        playbackInfoParams,
        config
    );

    if (!playbackInfoData?.MediaSources?.length > 0) {
        console.warn("❌ No MediaSources found for item:", item.Name, `(${item.Id})`);
        return null;
    }

    const streamDetailsArray = [];

    // Process ALL available MediaSources (multiple quality options)
    for (const source of playbackInfoData.MediaSources) {
        try {
            // Extract video stream (primary video track)
            const videoStream = source.MediaStreams?.find(ms => ms.Type === 'Video');
            
            // Extract audio stream (prefer default, fallback to first)
            const audioStream = source.MediaStreams?.find(ms => ms.Type === 'Audio' && ms.IsDefault)
                             || source.MediaStreams?.find(ms => ms.Type === 'Audio');
            
            // Extract subtitle streams
            const subtitleStreams = source.MediaStreams?.filter(ms => ms.Type === 'Subtitle') || [];
            
            // Build enriched media info object using safe extraction
            const mediaInfo = common.safeExtractMediaInfo(source, videoStream, audioStream);
            
            // Build comprehensive description string
            const streamDescription = common.buildStreamDescription(mediaInfo);
            
            // Build Quality Title (preserved for backward compatibility)
            let qualityTitle = "";
            if (videoStream) {
              qualityTitle += videoStream.DisplayTitle || "";
              if (videoStream.Width && videoStream.Height) {
                  if (!qualityTitle.toLowerCase().includes(videoStream.Height + "p") && !qualityTitle.toLowerCase().includes(videoStream.Width + "x" + videoStream.Height)) {
                      qualityTitle = (qualityTitle ? qualityTitle + " " : "") + `${videoStream.Height}p`;
                  }
              }
              if (videoStream.Codec) {
                  if (!qualityTitle.toLowerCase().includes(videoStream.Codec.toLowerCase())) {
                        qualityTitle = (qualityTitle ? qualityTitle + " " : "") + videoStream.Codec.toUpperCase();
                  }
              }
          } else if (source.Container) {
              qualityTitle = source.Container.toUpperCase();
          }
          if (source.Name && !qualityTitle) {
                qualityTitle = source.Name;
          }
          qualityTitle = qualityTitle || 'Direct Play';

            // Construct direct play URL (Emby format; also implemented by Silo jellycompat)
            const directPlayUrl = `${config.serverUrl}/Videos/${item.Id}/stream.${source.Container}?MediaSourceId=${source.Id}&Static=true&api_key=${config.accessToken}&DeviceId=stremio-addon-device-id`;
            
            // Format subtitles for Stremio
            const subtitles = subtitleStreams.map(sub => {
                const codec = sub.Codec?.toLowerCase();
                const format = CODEC_FORMAT_MAP[codec] || 'srt';
                
                return {
                    id: `sub-${item.Id}-${source.Id}-${sub.Index}`,
                    lang: sub.Language || 'und',
                    url: `${config.serverUrl}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.${format}?api_key=${config.accessToken}`
                };
            });
            
            streamDetailsArray.push({
                directPlayUrl: directPlayUrl,
                itemName: item.Name,
                seriesName: seriesName,
                seasonNumber: item.Type === ITEM_TYPE_EPISODE ? item.ParentIndexNumber : null,
                episodeNumber: item.Type === ITEM_TYPE_EPISODE ? item.IndexNumber : null,
                itemId: item.Id,
                mediaSourceId: source.Id,
                container: source.Container,
                videoCodec: videoStream?.Codec || source.VideoCodec || null,
                audioCodec: audioStream?.Codec || null,
                qualityTitle: qualityTitle,
                embyUrlBase: config.serverUrl,
                apiKey: config.accessToken,
                subtitles: subtitles,
                streamDescription: streamDescription,
                mediaInfo: mediaInfo
            });
        } catch (error) {
            console.error(`❌ Error processing MediaSource ${source.Id} for item ${item.Id}:`, error?.message || String(error));
            continue;
        }
    }

    return streamDetailsArray;
}

/**
 * Main function: Gets stream details for a movie or series episode based on
 * an external ID and returning direct play stream information, using provided configuration.
 */
async function getStream(idOrExternalId, config) {
    
    // Validate provided configuration
    if (!config.serverUrl || !config.userId || !config.accessToken) {
        console.error("❌ Configuration missing (serverUrl, userId, or accessToken)");
        return null;
    }

    let imdbId = null;
    let tmdbId = null;
    let tvdbId = null;
    let anidbId = null;
    let seasonNumber = null;
    let episodeNumber = null;

    const raw = String(idOrExternalId || '').trim();

    // Stremio series IDs are normally tt1234567:1:2. Preserve support for
    // explicit provider prefixes too (tmdb:123 / tvdb:123 / anidb:123).
    const episodeMatch = raw.match(/^(.*):(\d+):(\d+)$/);
    const baseId = episodeMatch ? episodeMatch[1] : raw;
    if (episodeMatch) {
        seasonNumber = parseInt(episodeMatch[2], 10);
        episodeNumber = parseInt(episodeMatch[3], 10);
    }

    if (/^tt\d+$/i.test(baseId)) {
        imdbId = baseId.toLowerCase();
    } else if (/^imdb:/i.test(baseId)) {
        imdbId = baseId.slice(5).toLowerCase();
    } else if (/^tmdb:/i.test(baseId)) {
        tmdbId = baseId.slice(5);
    } else if (/^tmdb\d+$/i.test(baseId)) {
        tmdbId = baseId.replace(/^tmdb/i, '');
    } else if (/^tvdb:/i.test(baseId)) {
        tvdbId = baseId.slice(5);
    } else if (/^tvdb\d+$/i.test(baseId)) {
        tvdbId = baseId.replace(/^tvdb/i, '');
    } else if (/^anidb:/i.test(baseId)) {
        anidbId = baseId.slice(6);
    } else if (/^anidb\d+$/i.test(baseId)) {
        anidbId = baseId.replace(/^anidb/i, '');
    } else {
        console.warn("⚠️ Unrecognized external ID:", raw);
        return null;
    }

    const isEpisodeRequest = seasonNumber !== null && episodeNumber !== null;

    if (isEpisodeRequest) {
        const seriesItems = await findSeriesItem(imdbId, tmdbId, tvdbId, anidbId, config);
        if (!seriesItems?.length) return null;

        for (const series of seriesItems) {
            const episode = await findEpisodeItem(series, seasonNumber, episodeNumber, config);
            if (!episode) continue;
            const streams = await getPlaybackStreams(episode, series.Name, config);
            if (streams?.length) return streams;
        }
        return null;
    }

    const movieItems = await findMovieItem(imdbId, tmdbId, tvdbId, anidbId, config);
    if (!movieItems?.length) return null;

    for (const movie of movieItems) {
        const streams = await getPlaybackStreams(movie, null, config);
        if (streams?.length) return streams;
    }

    return null;
}

module.exports = {
    getStream,
    findMovieItem,
    findSeriesItem,
    findEpisodeItem,
    getPlaybackStreams,
    buildSiloProviderIndex
};
