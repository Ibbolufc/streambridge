const axios = require("axios");
const common = require("./commonClient");

const HEADER_EMBY_TOKEN = 'X-Emby-Token';
const ITEM_TYPE_MOVIE = common.ITEM_TYPE_MOVIE;
const ITEM_TYPE_EPISODE = common.ITEM_TYPE_EPISODE;
const DEFAULT_FIELDS = common.DEFAULT_FIELDS;
const CODEC_FORMAT_MAP = common.CODEC_FORMAT_MAP;

// Silo's Jellyfin compatibility API currently does not implement the same
// provider-ID query filters StreamBridge uses for Emby. Instead of scanning a
// large Silo library, resolve IMDb metadata to title/year and use Silo's native
// SearchTerm support to find a very small candidate set.
const resolutionCache = new Map();
const metadataCache = new Map();
const RESOLUTION_TTL_MS = 30 * 60 * 1000;
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;

function cacheGet(cache, key, ttl) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > ttl) {
        cache.delete(key);
        return null;
    }
    return entry.value;
}

function cacheSet(cache, key, value) {
    cache.set(key, { at: Date.now(), value });
}

function normalizeTitle(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function extractYear(meta) {
    const candidates = [meta?.year, meta?.releaseInfo, meta?.released];
    for (const value of candidates) {
        const match = String(value || '').match(/\b(19|20)\d{2}\b/);
        if (match) return Number(match[0]);
    }
    return null;
}

async function fetchCinemetaMetadata(kind, imdbId) {
    if (!imdbId || !String(imdbId).startsWith('tt')) return null;

    const key = `${kind}:${String(imdbId).toLowerCase()}`;
    const cached = cacheGet(metadataCache, key, METADATA_TTL_MS);
    if (cached) return cached;

    const mediaType = kind === 'series' ? 'series' : 'movie';
    try {
        const response = await axios.get(
            `https://v3-cinemeta.strem.io/meta/${mediaType}/${encodeURIComponent(imdbId)}.json`,
            { timeout: 6000 }
        );
        const meta = response.data?.meta;
        if (!meta?.name) return null;

        const result = {
            name: String(meta.name),
            year: extractYear(meta)
        };
        cacheSet(metadataCache, key, result);
        return result;
    } catch (err) {
        console.warn(`⚠️ Silo metadata lookup failed for ${imdbId}:`, err?.message || String(err));
        return null;
    }
}

async function makeApiRequest(url, params, config, timeout = 12000) {
    try {
        const response = await axios.get(url, {
            headers: { [HEADER_EMBY_TOKEN]: config.accessToken },
            params: params || {},
            timeout
        });
        return response.data;
    } catch (err) {
        const sanitizedUrl = url.replace(/https?:\/\/[^\/\s:]+(?::\d+)?/, '[SERVER]');
        const sanitizedParams = { ...(params || {}) };
        if (sanitizedParams.UserId) delete sanitizedParams.UserId;
        console.warn(`⚠️ Silo API request failed for ${sanitizedUrl} with params ${JSON.stringify(sanitizedParams)}:`, err?.message || String(err));
        return null;
    }
}

// Return every confident match, not just the first one. Silo can represent
// different encodes/qualities as separate items with the same title/year, so
// collapsing to one item can hide valid 4K/1080p/remux versions.
function chooseCandidates(items, metadata) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const wantedTitle = normalizeTitle(metadata?.name);
    const wantedYear = Number(metadata?.year) || null;
    const exactTitle = items.filter(item => normalizeTitle(item?.Name) === wantedTitle);

    if (wantedYear) {
        const exactTitleAndYear = exactTitle.filter(item => Number(item?.ProductionYear) === wantedYear);
        if (exactTitleAndYear.length > 0) return exactTitleAndYear;

        // Some Silo items may omit ProductionYear even though the title is an
        // exact match. If every exact-title candidate has no usable year, keep
        // all of them so separate quality versions are not lost.
        if (exactTitle.length > 0 && exactTitle.every(item => !Number(item?.ProductionYear))) {
            return exactTitle;
        }
    }

    if (exactTitle.length === 1) return exactTitle;

    if (!wantedYear && exactTitle.length > 1) {
        const knownYears = new Set(
            exactTitle
                .map(item => Number(item?.ProductionYear))
                .filter(year => Number.isFinite(year) && year > 0)
        );
        if (knownYears.size <= 1) return exactTitle;
    }

    // If Silo search gives exactly one result, accept it as a fallback. This
    // helps where provider metadata uses punctuation/localized title variants.
    if (items.length === 1) return items;

    if (wantedYear) {
        const sameYear = items.filter(item => Number(item?.ProductionYear) === wantedYear);
        if (sameYear.length === 1) return sameYear;
    }

    return [];
}

async function findSiloItem(kind, imdbId, tmdbId, tvdbId, anidbId, config) {
    const externalKey = imdbId || (tmdbId ? `tmdb:${tmdbId}` : null) || (tvdbId ? `tvdb:${tvdbId}` : null) || (anidbId ? `anidb:${anidbId}` : null);
    if (!externalKey) return [];

    const cacheKey = `${config.serverUrl}|${config.userId}|${kind}|${externalKey}`;
    const cached = cacheGet(resolutionCache, cacheKey, RESOLUTION_TTL_MS);
    if (Array.isArray(cached)) return cached;
    if (cached) return [cached];

    // Cinemeta gives us a reliable title/year for the IMDb IDs Stremio's
    // Cinemeta catalogue normally sends to stream addons.
    const metadata = imdbId ? await fetchCinemetaMetadata(kind, imdbId) : null;
    if (!metadata?.name) {
        console.warn(`⚠️ Silo resolver cannot resolve ${externalKey} to a title yet`);
        return [];
    }

    console.log(`🔎 Silo resolving ${externalKey} as "${metadata.name}"${metadata.year ? ` (${metadata.year})` : ''}`);

    const includeType = kind === 'series' ? 'Series' : 'Movie';
    const data = await makeApiRequest(`${config.serverUrl}/Users/${config.userId}/Items`, {
        IncludeItemTypes: includeType,
        Recursive: true,
        SearchTerm: metadata.name,
        Fields: 'Name,Id',
        Limit: 25,
        EnableTotalRecordCount: false
    }, config);

    const items = chooseCandidates(data?.Items || [], metadata);
    if (items.length === 0) {
        console.warn(`⚠️ Silo search found no confident ${kind} match for "${metadata.name}"`);
        return [];
    }

    cacheSet(resolutionCache, cacheKey, items);
    console.log(`✅ Silo matched ${items.length} ${kind} item${items.length === 1 ? '' : 's'} for "${metadata.name}"${metadata.year ? ` (${metadata.year})` : ''}`);
    return items;
}

async function findEpisodeItem(parentSeriesItem, seasonNumber, episodeNumber, config) {
    const seasonsData = await makeApiRequest(
        `${config.serverUrl}/Shows/${parentSeriesItem.Id}/Seasons`,
        { UserId: config.userId, Fields: 'Id,IndexNumber,Name' },
        config
    );
    if (!Array.isArray(seasonsData?.Items)) return null;

    const targetSeason = seasonsData.Items.find(s => Number(s.IndexNumber) === Number(seasonNumber));
    if (!targetSeason) {
        console.warn(`⚠️ Silo season ${seasonNumber} not found for "${parentSeriesItem.Name}"`);
        return null;
    }

    const episodesData = await makeApiRequest(
        `${config.serverUrl}/Shows/${parentSeriesItem.Id}/Episodes`,
        {
            SeasonId: targetSeason.Id,
            UserId: config.userId,
            Fields: DEFAULT_FIELDS
        },
        config
    );
    if (!Array.isArray(episodesData?.Items)) return null;

    const episode = episodesData.Items.find(ep =>
        Number(ep.IndexNumber) === Number(episodeNumber) &&
        Number(ep.ParentIndexNumber) === Number(seasonNumber)
    );

    if (!episode) {
        console.warn(`⚠️ Silo episode S${seasonNumber}E${episodeNumber} not found for "${parentSeriesItem.Name}"`);
    }
    return episode || null;
}

async function getPlaybackStreams(item, seriesName, config) {
    const playback = await makeApiRequest(
        `${config.serverUrl}/Items/${item.Id}/PlaybackInfo`,
        { UserId: config.userId },
        config
    );

    if (!Array.isArray(playback?.MediaSources) || playback.MediaSources.length === 0) {
        console.warn(`❌ Silo returned no MediaSources for "${item.Name}" (${item.Id})`);
        return null;
    }

    const results = [];

    for (const source of playback.MediaSources) {
        try {
            const videoStream = source.MediaStreams?.find(ms => ms.Type === 'Video');
            const audioStream = source.MediaStreams?.find(ms => ms.Type === 'Audio' && ms.IsDefault)
                || source.MediaStreams?.find(ms => ms.Type === 'Audio');
            const subtitleStreams = source.MediaStreams?.filter(ms => ms.Type === 'Subtitle') || [];
            const mediaInfo = common.safeExtractMediaInfo(source, videoStream, audioStream);
            const streamDescription = common.buildStreamDescription(mediaInfo);

            let qualityTitle = '';
            if (videoStream) {
                qualityTitle += videoStream.DisplayTitle || '';
                if (videoStream.Width && videoStream.Height &&
                    !qualityTitle.toLowerCase().includes(`${videoStream.Height}p`) &&
                    !qualityTitle.toLowerCase().includes(`${videoStream.Width}x${videoStream.Height}`)) {
                    qualityTitle = (qualityTitle ? `${qualityTitle} ` : '') + `${videoStream.Height}p`;
                }
                if (videoStream.Codec && !qualityTitle.toLowerCase().includes(String(videoStream.Codec).toLowerCase())) {
                    qualityTitle = (qualityTitle ? `${qualityTitle} ` : '') + String(videoStream.Codec).toUpperCase();
                }
            } else if (source.Container) {
                qualityTitle = String(source.Container).toUpperCase();
            }
            if (source.Name && !qualityTitle) qualityTitle = source.Name;
            qualityTitle = qualityTitle || 'Direct Play';

            const container = source.Container || 'mkv';
            const directPlayUrl = `${config.serverUrl}/Videos/${item.Id}/stream.${container}?MediaSourceId=${encodeURIComponent(source.Id)}&Static=true&api_key=${encodeURIComponent(config.accessToken)}&DeviceId=stremio-addon-device-id`;

            const subtitles = subtitleStreams.map(sub => {
                const codec = String(sub.Codec || '').toLowerCase();
                const format = CODEC_FORMAT_MAP[codec] || 'srt';
                return {
                    id: `sub-${item.Id}-${source.Id}-${sub.Index}`,
                    lang: sub.Language || 'und',
                    url: `${config.serverUrl}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.${format}?api_key=${encodeURIComponent(config.accessToken)}`
                };
            });

            results.push({
                directPlayUrl,
                itemName: item.Name,
                seriesName: seriesName || null,
                seasonNumber: item.Type === ITEM_TYPE_EPISODE ? item.ParentIndexNumber : null,
                episodeNumber: item.Type === ITEM_TYPE_EPISODE ? item.IndexNumber : null,
                itemId: item.Id,
                mediaSourceId: source.Id,
                container,
                videoCodec: videoStream?.Codec || source.VideoCodec || null,
                audioCodec: audioStream?.Codec || null,
                qualityTitle,
                embyUrlBase: config.serverUrl,
                apiKey: config.accessToken,
                subtitles,
                streamDescription,
                mediaInfo
            });
        } catch (err) {
            console.warn(`⚠️ Error processing Silo MediaSource ${source?.Id || 'unknown'}:`, err?.message || String(err));
        }
    }

    return results.length ? results : null;
}

async function getStream(idOrExternalId, config) {
    if (!config?.serverUrl || !config?.userId || !config?.accessToken) {
        console.error('❌ Silo configuration missing serverUrl, userId, or accessToken');
        return null;
    }

    const parsed = common.parseMediaId(idOrExternalId);
    if (!parsed) return null;

    try {
        if (parsed.itemType === ITEM_TYPE_MOVIE) {
            const items = await findSiloItem('movie', parsed.imdbId, parsed.tmdbId, parsed.tvdbId, parsed.anidbId, config);
            const streamGroups = await Promise.all(
                items.map(item => getPlaybackStreams(item, null, config))
            );
            const allStreams = streamGroups.flatMap(streams => streams || []);
            return allStreams.length ? common.deduplicateAndSortStreams(allStreams) : null;
        }

        if (parsed.itemType === ITEM_TYPE_EPISODE) {
            const seriesItems = await findSiloItem('series', parsed.imdbId, parsed.tmdbId, parsed.tvdbId, parsed.anidbId, config);
            const streamGroups = await Promise.all(
                seriesItems.map(async series => {
                    const episode = await findEpisodeItem(series, parsed.seasonNumber, parsed.episodeNumber, config);
                    if (!episode) return [];
                    return await getPlaybackStreams(episode, series.Name, config) || [];
                })
            );
            const allStreams = streamGroups.flatMap(streams => streams || []);
            return allStreams.length ? common.deduplicateAndSortStreams(allStreams) : null;
        }

        return null;
    } catch (err) {
        console.error(`❌ Unhandled Silo resolver error for ${idOrExternalId}:`, err?.message || String(err));
        return null;
    }
}

module.exports = { getStream };
