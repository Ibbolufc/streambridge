const axios = require("axios");
const common = require("./commonClient");

// --- Constants ---
const HEADER_EMBY_TOKEN = 'X-Emby-Token';
const ITEM_TYPE_MOVIE = common.ITEM_TYPE_MOVIE;
const ITEM_TYPE_EPISODE = common.ITEM_TYPE_EPISODE;
const ITEM_TYPE_SERIES = common.ITEM_TYPE_SERIES;
const DEFAULT_FIELDS = common.DEFAULT_FIELDS;
const CODEC_FORMAT_MAP = common.CODEC_FORMAT_MAP;

// Small in-memory external-ID index used only for Silo backends. Silo's
// Jellyfin compatibility surface does not currently implement Emby's
// ImdbId/TmdbId/TvdbId/AnyProviderIdEquals filters, but it does expose
// ProviderIds on normal item-list responses.
const siloIndexCache = new Map();
const SILO_INDEX_TTL_MS = 10 * 60 * 1000;

function normalizeProviderIds(providerIds = {}) {
    const out = {};
    for (const [key, value] of Object.entries(providerIds || {})) {
        if (value == null) continue;
        out[String(key).toLowerCase()] = String(value).trim();
    }
    return out;
}

function normalizeBackend(config = {}) {
    return String(config.backend || config.serverType || 'emby').toLowerCase();
}

function isSilo(config = {}) {
    return normalizeBackend(config) === 'silo';
}

function cacheKey(config) {
    return `${config.serverUrl}|${config.userId}`;
}

function addProviderIndexEntry(index, item) {
    if (!item?.Id) return;
    const p = normalizeProviderIds(item.ProviderIds || item.ProviderIDs);
    const type = String(item.Type || '').toLowerCase();
    const target = type === 'series' ? index.series : index.movie;
    if (!target) return;

    if (p.imdb) target.imdb.set(p.imdb.toLowerCase(), item);
    if (p.tmdb) target.tmdb.set(p.tmdb, item);
    if (p.tvdb) target.tvdb.set(p.tvdb, item);
    if (p.anidb) target.anidb.set(p.anidb, item);
}

async function buildSiloProviderIndex(config, force = false) {
    const key = cacheKey(config);
    const cached = siloIndexCache.get(key);
    if (!force && cached && Date.now() - cached.builtAt < SILO_INDEX_TTL_MS) {
        return cached;
    }

    const index = {
        builtAt: Date.now(),
        movie: { imdb: new Map(), tmdb: new Map(), tvdb: new Map(), anidb: new Map() },
        series: { imdb: new Map(), tmdb: new Map(), tvdb: new Map(), anidb: new Map() }
    };

    const limit = 500;
    let startIndex = 0;
    let total = Infinity;

    while (startIndex < total) {
        const params = {
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            Fields: 'ProviderIds,Name,Id',
            StartIndex: startIndex,
            Limit: limit,
            EnableTotalRecordCount: true
        };
        const data = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, params, config);
        if (!data || !Array.isArray(data.Items)) break;

        for (const item of data.Items) addProviderIndexEntry(index, item);
        total = Number.isFinite(Number(data.TotalRecordCount)) ? Number(data.TotalRecordCount) : startIndex + data.Items.length;
        if (data.Items.length === 0) break;
        startIndex += data.Items.length;
        if (data.Items.length < limit) break;
    }

    index.builtAt = Date.now();
    siloIndexCache.set(key, index);
    return index;
}

function findInSiloIndex(index, kind, imdbId, tmdbId, tvdbId, anidbId) {
    const bucket = index?.[kind];
    if (!bucket) return [];
    let item = null;
    if (imdbId) item = bucket.imdb.get(String(imdbId).toLowerCase());
    if (!item && tmdbId) item = bucket.tmdb.get(String(tmdbId));
    if (!item && tvdbId) item = bucket.tvdb.get(String(tvdbId));
    if (!item && anidbId) item = bucket.anidb.get(String(anidbId));
    return item ? [item] : [];
}

/**
 * Performs an Emby/Jellyfin-compatible API request with standard headers and error handling.
 */
async function makeApiRequest(url, params = {}, config) {
    try {
        const response = await axios({
            method: 'get',
            url: url,
            headers: { [HEADER_EMBY_TOKEN]: config.accessToken },
            params: params,
            timeout: 10000
        });
        return response.data;
    } catch (err) {
        const sanitizedUrl = url.replace(/https?:\/\/[^\/\s:]+(?::\d+)?/, '[SERVER]');
        const sanitizedParams = { ...params };
        if (sanitizedParams.UserId) delete sanitizedParams.UserId;
        console.warn(`⚠️ API Request failed for ${sanitizedUrl} with params ${JSON.stringify(sanitizedParams)}:`, err.message);
        if (err.response?.status === 401) {
             console.log("🔧 Detected Unauthorized (401). The provided access token might be invalid or expired.");
        }
        return null;
    }
}

async function findMovieItem(imdbId, tmdbId, tvdbId, anidbId, config) {
    if (isSilo(config)) {
        const index = await buildSiloProviderIndex(config);
        let found = findInSiloIndex(index, 'movie', imdbId, tmdbId, tvdbId, anidbId);
        if (found.length === 0) {
            const refreshed = await buildSiloProviderIndex(config, true);
            found = findInSiloIndex(refreshed, 'movie', imdbId, tmdbId, tvdbId, anidbId);
        }
        return found;
    }

    let foundItems = [];
    const baseMovieParams = {
        IncludeItemTypes: ITEM_TYPE_MOVIE,
        Recursive: true,
        Fields: DEFAULT_FIELDS,
        Limit: 10,
        Filters: "IsNotFolder",
        UserId: config.userId
    };

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
            if (matches.length > 0) foundItems.push(...matches);
        }
    }

    if (foundItems.length === 0) {
        const anyProviderIdFormats = [];
        if (imdbId) {
            const numericImdbId = imdbId.replace('tt', '');
            anyProviderIdFormats.push(`imdb.${imdbId}`, `Imdb.${imdbId}`);
            if (numericImdbId !== imdbId) anyProviderIdFormats.push(`imdb.${numericImdbId}`, `Imdb.${numericImdbId}`);
        } else if (tmdbId) anyProviderIdFormats.push(`tmdb.${tmdbId}`, `Tmdb.${tmdbId}`);
        else if (tvdbId) anyProviderIdFormats.push(`tvdb.${tvdbId}`, `Tvdb.${tvdbId}`);
        else if (anidbId) anyProviderIdFormats.push(`anidb.${anidbId}`, `AniDb.${anidbId}`);

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
                if (matches.length > 0) foundItems.push(...matches);
            }
        }
    }
    return foundItems;
}

async function findSeriesItem(imdbId, tmdbId, tvdbId, anidbId, config) {
    if (isSilo(config)) {
        const index = await buildSiloProviderIndex(config);
        let found = findInSiloIndex(index, 'series', imdbId, tmdbId, tvdbId, anidbId);
        if (found.length === 0) {
            const refreshed = await buildSiloProviderIndex(config, true);
            found = findInSiloIndex(refreshed, 'series', imdbId, tmdbId, tvdbId, anidbId);
        }
        return found;
    }

    let foundSeries = [];
    const baseSeriesParams = {
        IncludeItemTypes: ITEM_TYPE_SERIES,
        Recursive: true,
        Fields: "ProviderIds,Name,Id",
        Limit: 5
    };
    const seriesLookupParams1 = { ...baseSeriesParams };
    if (imdbId) seriesLookupParams1.ImdbId = imdbId;
    else if (tmdbId) seriesLookupParams1.TmdbId = tmdbId;
    else if (tvdbId) seriesLookupParams1.TvdbId = tvdbId;
    else if (anidbId) seriesLookupParams1.AniDbId = anidbId;
    const data1 = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, seriesLookupParams1, config);
    if (data1?.Items?.length > 0) {
        const matches = data1.Items.filter(s => common._isMatchingProviderId(s.ProviderIds, imdbId, tmdbId, tvdbId, anidbId));
        if (matches.length > 0) foundSeries.push(...matches);
    }

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
                if (matches.length > 0) foundSeries.push(...matches);
            }
        }
    }
    return foundSeries;
}

async function findEpisodeItem(parentSeriesItem, seasonNumber, episodeNumber, config) {
    const seasonsParams = { UserId: config.userId, Fields: "Id,IndexNumber,Name" };
    const seasonsData = await makeApiRequest(`${config.serverUrl}/Shows/${parentSeriesItem.Id}/Seasons`, seasonsParams, config);
    if (!(seasonsData?.Items?.length > 0)) return null;
    const targetSeason = seasonsData.Items.find(s => s.IndexNumber === seasonNumber);
    if (!targetSeason) return null;

    const episodesParams = { SeasonId: targetSeason.Id, UserId: config.userId, Fields: DEFAULT_FIELDS };
    const episodesData = await makeApiRequest(`${config.serverUrl}/Shows/${parentSeriesItem.Id}/Episodes`, episodesParams, config);
    if (!(episodesData?.Items?.length > 0)) return null;
    return episodesData.Items.find(ep => ep.IndexNumber === episodeNumber && ep.ParentIndexNumber === seasonNumber) || null;
}

async function getPlaybackStreams(item, seriesName = null, config) {
    const playbackInfoParams = { UserId: config.userId };
    const playbackInfoData = await makeApiRequest(`${config.serverUrl}/Items/${item.Id}/PlaybackInfo`, playbackInfoParams, config);
    if (!(playbackInfoData?.MediaSources?.length > 0)) {
        console.warn("❌ No MediaSources found for item:", item.Name, `(${item.Id})`);
        return null;
    }

    const streamDetailsArray = [];
    for (const source of playbackInfoData.MediaSources) {
        try {
            const videoStream = source.MediaStreams?.find(ms => ms.Type === 'Video');
            const audioStream = source.MediaStreams?.find(ms => ms.Type === 'Audio' && ms.IsDefault)
                             || source.MediaStreams?.find(ms => ms.Type === 'Audio');
            const subtitleStreams = source.MediaStreams?.filter(ms => ms.Type === 'Subtitle') || [];
            const mediaInfo = common.safeExtractMediaInfo(source, videoStream, audioStream);
            const streamDescription = common.buildStreamDescription(mediaInfo);

            let qualityTitle = "";
            if (videoStream) {
                qualityTitle += videoStream.DisplayTitle || "";
                if (videoStream.Width && videoStream.Height &&
                    !qualityTitle.toLowerCase().includes(videoStream.Height + "p") &&
                    !qualityTitle.toLowerCase().includes(videoStream.Width + "x" + videoStream.Height)) {
                    qualityTitle = (qualityTitle ? qualityTitle + " " : "") + `${videoStream.Height}p`;
                }
                if (videoStream.Codec && !qualityTitle.toLowerCase().includes(videoStream.Codec.toLowerCase())) {
                    qualityTitle = (qualityTitle ? qualityTitle + " " : "") + videoStream.Codec.toUpperCase();
                }
            } else if (source.Container) qualityTitle = source.Container.toUpperCase();
            if (source.Name && !qualityTitle) qualityTitle = source.Name;
            qualityTitle = qualityTitle || 'Direct Play';

            const directPlayUrl = `${config.serverUrl}/Videos/${item.Id}/stream.${source.Container}?MediaSourceId=${source.Id}&Static=true&api_key=${config.accessToken}&DeviceId=stremio-addon-device-id`;
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
            console.error(`❌ Error processing MediaSource ${source.Id} for item ${item.Id}:`, error?.message || String(error));
        }
    }
    return streamDetailsArray;
}

function parseExternalId(idOrExternalId) {
    const raw = String(idOrExternalId || '').trim();
    const parts = raw.split(':');
    let base = parts[0];
    let seasonNumber = null;
    let episodeNumber = null;

    if (parts.length >= 3) {
        seasonNumber = Number(parts[parts.length - 2]);
        episodeNumber = Number(parts[parts.length - 1]);
        base = parts.slice(0, -2).join(':');
    }

    let imdbId = null, tmdbId = null, tvdbId = null, anidbId = null;
    if (/^tt\d+$/i.test(base)) imdbId = base.toLowerCase();
    else if (/^imdb:/i.test(base)) imdbId = base.substring(5).toLowerCase();
    else if (/^tmdb:/i.test(base)) tmdbId = base.substring(5);
    else if (/^tmdb\d+$/i.test(base)) tmdbId = base.replace(/^tmdb/i, '');
    else if (/^tvdb:/i.test(base)) tvdbId = base.substring(5);
    else if (/^tvdb\d+$/i.test(base)) tvdbId = base.replace(/^tvdb/i, '');
    else if (/^anidb:/i.test(base)) anidbId = base.substring(6);
    else if (/^anidb\d+$/i.test(base)) anidbId = base.replace(/^anidb/i, '');

    return { imdbId, tmdbId, tvdbId, anidbId, seasonNumber, episodeNumber };
}

async function getStream(idOrExternalId, config) {
    if (!config.serverUrl || !config.userId || !config.accessToken) {
        console.error("❌ Configuration missing (serverUrl, userId, or accessToken)");
        return null;
    }

    const { imdbId, tmdbId, tvdbId, anidbId, seasonNumber, episodeNumber } = parseExternalId(idOrExternalId);
    if (!imdbId && !tmdbId && !tvdbId && !anidbId) {
        console.warn('⚠️ Unsupported external ID:', idOrExternalId);
        return null;
    }

    const isEpisode = Number.isInteger(seasonNumber) && Number.isInteger(episodeNumber);
    if (isEpisode) {
        const seriesItems = await findSeriesItem(imdbId, tmdbId, tvdbId, anidbId, config);
        for (const series of seriesItems || []) {
            const episode = await findEpisodeItem(series, seasonNumber, episodeNumber, config);
            if (episode) return await getPlaybackStreams(episode, series.Name, config);
        }
        return null;
    }

    const movies = await findMovieItem(imdbId, tmdbId, tvdbId, anidbId, config);
    for (const movie of movies || []) {
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
