// SPDX-License-Identifier: GPL-2.0-or-later
/* lyrics.js
 *
 * Fetches and synchronizes lyrics for the currently playing track.
 * Integrates with LRCLIB API with local disk caching and full support
 * for non-Latin scripts (CJK, Arabic, Hebrew, Cyrillic, etc.) and LRC formats.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';

import {lyricsCacheDir} from './paths.js';

const LRCLIB_BASE = 'https://lrclib.net/api';
const MAX_LYRICS_BYTES = 512 * 1024; // 512 KB limit per response
const MAX_CACHED_FILES = 256;
const CHUNK_BYTES = 16 * 1024;

/* Regular expression for RTL scripts (Arabic, Hebrew, Persian, Urdu, etc.) */
const RTL_REGEX = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Checks if a string contains Right-to-Left characters.
 * @param {string} text
 * @returns {boolean}
 */
export function isRTLText(text) {
    return RTL_REGEX.test(text);
}

/**
 * Checks if a player matches the configured lyrics app whitelist.
 * Matches against desktopEntry, identity, and busName.
 *
 * @param {object} player an MprisPlayer
 * @param {string[]} whitelist array of whitelisted app names
 * @returns {boolean}
 */
export function isPlayerWhitelisted(player, whitelist) {
    if (!player || !Array.isArray(whitelist) || whitelist.length === 0)
        return false;

    const desktop = (player.desktopEntry || '').toLowerCase();
    const identity = (player.identity || '').toLowerCase();
    const bus = (player.busName || '').toLowerCase().replace('org.mpris.mediaplayer2.', '');

    return whitelist.some(entry => {
        const item = (entry || '').trim().toLowerCase();
        if (!item)
            return false;
        return desktop.includes(item) || identity.includes(item) || bus.includes(item);
    });
}

/**
 * Sanitizes track title to increase match rate on LRCLIB while preserving
 * non-Latin character sets and core track information.
 * @param {string} title
 * @returns {string}
 */
export function sanitizeTitle(title, artist = '') {
    if (!title)
        return '';

    let cleaned = title
        /* Remove feature tags like (feat. Artist) or [feat. Artist] */
        .replace(/[({\[][^)}\]]*(?:feat|featuring|ft\.)[^)}\]]*[)}\]]/gi, '')
        /* Remove official audio/video/lyrics tags */
        .replace(/[({\[][^)}\]]*(?:official|video|audio|lyrics|visualizer|hd|4k)[^\)\]\}]*[)}\]]/gi, '')
        /* Remove remastered / edition / live tags */
        .replace(/[({\[][^)}\]]*(?:remaster|deluxe|bonus|anniversary|edition|version|live)[^)}\]]*[)}\]]/gi, '')
        /* Remove Japanese/Chinese style brackets like 【Official Video】 */
        .replace(/【[^】]*】/g, '')
        /* Remove trailing - Single, - EP, or - Remastered 2021 */
        .replace(/\s*-\s*(?:remaster(?:ed)?(?:\s+\d+)?|live|single|ep)\s*$/i, '');

    if (artist) {
        const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        cleaned = cleaned.replace(new RegExp(`\\s*-\\s*${escaped}\\s*$`, 'i'), '');
    }

    return cleaned.trim();
}

/**
 * Builds a URL query string without relying on DOM URLSearchParams.
 * @param {Record<string, string|number>} params
 * @returns {string}
 */
export function buildQuery(params) {
    const parts = [];
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '')
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.join('&');
}



/**
 * Parses an LRC formatted string into an array of timed lyric lines.
 * Supports multiple timestamps per line, offsets, and non-Latin text.
 *
 * @param {string} lrcContent
 * @returns {{ lines: Array<{timeMs: number, text: string, isRTL: boolean}>, offsetMs: number }}
 */
export function parseLRC(lrcContent) {
    if (!lrcContent || typeof lrcContent !== 'string')
        return {lines: [], offsetMs: 0};

    const lines = [];
    let offsetMs = 0;

    const rawLines = lrcContent.split(/\r?\n/);
    const timeTagRegex = /\[(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/g;
    const offsetTagRegex = /^\[offset:\s*([+-]?\d+)\s*\]/i;

    for (const rawLine of rawLines) {
        const trimmed = rawLine.trim();
        if (!trimmed)
            continue;

        /* Check for metadata offset tag: [offset: +/-ms] */
        const offsetMatch = trimmed.match(offsetTagRegex);
        if (offsetMatch) {
            const parsedOffset = parseInt(offsetMatch[1], 10);
            if (!Number.isNaN(parsedOffset))
                offsetMs = parsedOffset;
            continue;
        }

        /* Check for timestamp tags */
        timeTagRegex.lastIndex = 0;
        const matches = [...trimmed.matchAll(timeTagRegex)];
        if (matches.length === 0)
            continue;

        /* The lyric text is everything after the last timestamp tag */
        const lastMatch = matches[matches.length - 1];
        const textStartIndex = (lastMatch.index ?? 0) + lastMatch[0].length;
        const text = trimmed.slice(textStartIndex).trim();
        const isRTL = isRTLText(text);

        for (const match of matches) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseFloat(match[2]);
            if (Number.isNaN(minutes) || Number.isNaN(seconds))
                continue;

            const timeMs = Math.round((minutes * 60 + seconds) * 1000);
            lines.push({
                timeMs,
                text,
                isRTL,
            });
        }
    }

    /* Apply offset and sort chronologically */
    for (const line of lines)
        line.timeMs = Math.max(0, line.timeMs + offsetMs);

    lines.sort((a, b) => a.timeMs - b.timeMs);

    /* Compute durationMs for each line based on when the next line begins */
    for (let i = 0; i < lines.length; i++) {
        const nextTime = (i + 1 < lines.length) ? lines[i + 1].timeMs : (lines[i].timeMs + 5000);
        lines[i].durationMs = Math.max(1000, nextTime - lines[i].timeMs);
    }

    return {lines, offsetMs};
}

export class LyricsData {
    /**
     * @param {object} params
     * @param {string} params.trackKey
     * @param {boolean} params.synced
     * @param {boolean} params.isInstrumental
     * @param {Array<{timeMs: number, text: string, isRTL: boolean}>} params.lines
     * @param {string} params.plainLyrics
     * @param {number} [params.durationMs]
     */
    constructor({trackKey, synced, isInstrumental, lines, plainLyrics, durationMs = 0}) {
        this.trackKey = trackKey;
        this.synced = synced;
        this.isInstrumental = isInstrumental;
        this.lines = lines ?? [];
        this.plainLyrics = plainLyrics ?? '';
        this._durationMs = durationMs;
    }

    /**
     * Estimated track duration in milliseconds.
     * Uses provided durationMs or computes from the last lyric line.
     * @returns {number}
     */
    get durationMs() {
        if (this._durationMs > 0)
            return this._durationMs;
        if (this.lines.length > 0) {
            const last = this.lines[this.lines.length - 1];
            return last.timeMs + (last.durationMs || 5000);
        }
        return 0;
    }

    /**
     * Finds the active line for a given playback position in milliseconds.
     * @param {number} positionMs
     * @returns {{ index: number, line: object|null, text: string, isRTL: boolean, isIntro: boolean, isOutro: boolean } | null}
     */
    getActiveLine(positionMs) {
        if (!this.synced || this.lines.length === 0)
            return null;

        const lines = this.lines;

        /* Before the first lyric line */
        if (positionMs < lines[0].timeMs) {
            return {
                index: -1,
                line: null,
                text: '',
                isRTL: false,
                isIntro: true,
                isOutro: false,
            };
        }

        /* Binary search for active line */
        let low = 0;
        let high = lines.length - 1;
        let index = 0;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (lines[mid].timeMs <= positionMs) {
                index = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        const line = lines[index];
        const isOutro = index === lines.length - 1 &&
            positionMs > line.timeMs + (line.durationMs || 10000);

        return {
            index,
            line,
            text: line.text,
            isRTL: line.isRTL,
            timeMs: line.timeMs,
            durationMs: line.durationMs || 4000,
            isIntro: false,
            isOutro,
        };
    }
}

export const LyricsManager = GObject.registerClass({
    Signals: {
        'lyrics-loaded': {param_types: [GObject.TYPE_STRING]},
    },
}, class LyricsManager extends GObject.Object {
    _init() {
        super._init();

        this._session = new Soup.Session({timeout: 10});
        this._session.user_agent = 'GNOME-Shell-Media-Controls/2.4';
        this._cancellable = new Gio.Cancellable();
        this._memoryCache = new Map();
        this._pending = new Map();
        this._currentKey = null;
        this._currentLyrics = null;
        this._generation = 0;

        this._cacheDir = lyricsCacheDir();
        try {
            this._cacheDir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                console.warn(`media-controls: lyrics cache dir: ${e.message}`);
        }
    }

    get currentLyrics() {
        return this._currentLyrics;
    }

    get currentKey() {
        return this._currentKey;
    }

    /**
     * Creates a stable track key from metadata.
     * @param {string} artist
     * @param {string} title
     * @returns {string}
     */
    trackKey(artist, title) {
        const a = (artist || '').trim().toLowerCase();
        const t = (title || '').trim().toLowerCase();
        return `${a}::${t}`;
    }

    /**
     * Resolves lyrics for the given player/track.
     * Checks memory cache, then disk cache, then queries LRCLIB.
     *
     * @param {object} player an MprisPlayer
     * @returns {Promise<LyricsData|null>}
     */
    async resolve(player) {
        if (!player || !player.title) {
            this._currentKey = null;
            this._currentLyrics = null;
            return null;
        }

        const title = player.title;
        const artist = player.artist || '';
        const album = player.album || '';
        const durationSeconds = player.length > 0 ? Math.round(player.length / 1000000) : 0;
        const key = this.trackKey(artist, title);

        if (this._currentKey === key && this._currentLyrics)
            return this._currentLyrics;

        this._currentKey = key;
        const generation = ++this._generation;

        /* 1. Memory cache check */
        if (this._memoryCache.has(key)) {
            const cached = this._memoryCache.get(key);
            if (generation === this._generation) {
                this._currentLyrics = cached;
                this.emit('lyrics-loaded', key);
            }
            return cached;
        }

        /* 2. In-flight request deduplication */
        if (this._pending.has(key)) {
            const lyrics = await this._pending.get(key);
            if (generation === this._generation) {
                this._currentLyrics = lyrics;
                this.emit('lyrics-loaded', key);
            }
            return lyrics;
        }

        /* 3. Fetch from disk cache or network */
        const promise = this._fetchAndCache(key, title, artist, album, durationSeconds)
            .finally(() => this._pending.delete(key));

        this._pending.set(key, promise);
        const lyrics = await promise;

        if (generation === this._generation) {
            this._currentLyrics = lyrics;
            this.emit('lyrics-loaded', key);
        }

        return lyrics;
    }

    async _fetchAndCache(key, title, artist, album, durationSeconds) {
        /* Check disk cache: if synced or instrumental, we can return immediately */
        const diskData = await this._readFromDisk(key);
        if (diskData && (diskData.synced || diskData.isInstrumental)) {
            this._memoryCache.set(key, diskData);
            return diskData;
        }

        /* Query LRCLIB for synced (or plain) lyrics */
        const raw = await this._queryLrclib(title, artist, album, durationSeconds);
        if (!raw) {
            if (diskData) {
                this._memoryCache.set(key, diskData);
                return diskData;
            }

            /* Cache negative result in memory to avoid repeated requests during playback */
            const emptyData = new LyricsData({
                trackKey: key,
                synced: false,
                isInstrumental: false,
                lines: [],
                plainLyrics: '',
            });
            this._memoryCache.set(key, emptyData);
            return emptyData;
        }

        let lines = [];
        let isSynced = false;

        if (raw.syncedLyrics) {
            const parsed = parseLRC(raw.syncedLyrics);
            lines = parsed.lines;
            isSynced = lines.length > 0;
        }

        const durationMs = raw.duration ? Math.round(raw.duration * 1000) : 0;
        const lyricsData = new LyricsData({
            trackKey: key,
            synced: isSynced,
            isInstrumental: raw.instrumental === true,
            lines,
            plainLyrics: raw.plainLyrics || '',
            durationMs,
        });

        this._memoryCache.set(key, lyricsData);
        await this._writeToDisk(key, raw);
        return lyricsData;
    }

    /* LRCLIB HTTP Query */
    async _queryLrclib(title, artist, album, durationSeconds) {
        try {
            let plainFallback = null;

            /* 1. Try exact match /api/get */
            const getParams = {
                track_name: title,
                artist_name: artist || '',
                album_name: album || '',
                duration: durationSeconds > 0 ? durationSeconds : '',
            };

            const getUrl = `${LRCLIB_BASE}/get?${buildQuery(getParams)}`;
            const exactRes = await this._httpGet(getUrl);
            if (exactRes) {
                /* If exact match has synced lyrics or is instrumental, return immediately */
                if (exactRes.syncedLyrics || exactRes.instrumental)
                    return exactRes;
                /* If exact match only has plain lyrics, save as fallback and keep searching for synced */
                if (exactRes.plainLyrics)
                    plainFallback = exactRes;
            }

            /* 2. Try structured search with sanitized title & artist */
            const cleanTitle = sanitizeTitle(title, artist);
            const searchParams = {
                track_name: cleanTitle,
                artist_name: artist || '',
            };

            const searchUrl = `${LRCLIB_BASE}/search?${buildQuery(searchParams)}`;
            let searchRes = await this._httpGet(searchUrl);

            /* If no results, try general search query /api/search?q=... */
            if (!Array.isArray(searchRes) || searchRes.length === 0) {
                const q = [cleanTitle, artist].filter(Boolean).join(' ');
                if (q) {
                    const qUrl = `${LRCLIB_BASE}/search?${buildQuery({ q })}`;
                    searchRes = await this._httpGet(qUrl);
                }
            }

            if (Array.isArray(searchRes) && searchRes.length > 0) {
                /* Filter candidates with synced lyrics */
                const withSynced = searchRes.filter(item => item.syncedLyrics);
                if (withSynced.length > 0) {
                    if (durationSeconds > 0) {
                        withSynced.sort((a, b) => {
                            const diffA = Math.abs((a.duration || 0) - durationSeconds);
                            const diffB = Math.abs((b.duration || 0) - durationSeconds);
                            return diffA - diffB;
                        });

                        /* Prioritize candidates matching duration within ±15s */
                        if (Math.abs((withSynced[0].duration || 0) - durationSeconds) <= 15)
                            return withSynced[0];
                    }

                    return withSynced[0];
                }

                /* No synced candidate found in search, check for plain lyrics fallback */
                if (!plainFallback) {
                    const withPlain = searchRes.filter(item => item.plainLyrics);
                    if (withPlain.length > 0) {
                        if (durationSeconds > 0) {
                            withPlain.sort((a, b) => {
                                const diffA = Math.abs((a.duration || 0) - durationSeconds);
                                const diffB = Math.abs((b.duration || 0) - durationSeconds);
                                return diffA - diffB;
                            });
                        }
                        plainFallback = withPlain[0];
                    }
                }
            }

            return plainFallback;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`media-controls: lyrics query failed: ${e.message}`);
            return null;
        }
    }


    _send(message) {
        return new Promise((resolve, reject) => {
            this._session.send_async(
                message, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, result) => {
                    try {
                        resolve(session.send_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _readChunk(stream) {
        return new Promise((resolve, reject) => {
            stream.read_bytes_async(
                CHUNK_BYTES, GLib.PRIORITY_DEFAULT, this._cancellable,
                (source, result) => {
                    try {
                        resolve(source.read_bytes_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _readBounded(stream) {
        const chunks = [];
        let total = 0;

        for (;;) {
            const chunk = await this._readChunk(stream);
            const size = chunk.get_size();
            if (size === 0)
                break;

            total += size;
            if (total > MAX_LYRICS_BYTES)
                return null;
            chunks.push(chunk.toArray());
        }

        if (total === 0)
            return null;

        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        return new TextDecoder('utf-8').decode(data);
    }

    async _httpGet(url) {
        try {
            const message = Soup.Message.new('GET', url);
            const stream = await this._send(message);

            if (message.get_status() !== Soup.Status.OK) {
                stream.close(null);
                return null;
            }

            const body = await this._readBounded(stream);
            stream.close(null);
            if (!body)
                return null;

            return JSON.parse(body);
        } catch {
            return null;
        }
    }

    /* Disk Cache I/O */
    _cacheFileName(key) {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1);
        return `${hash}.json`;
    }

    async _readFromDisk(key) {
        const fileName = this._cacheFileName(key);
        const file = this._cacheDir.get_child(fileName);

        if (!GLib.file_test(file.get_path(), GLib.FileTest.EXISTS))
            return null;

        return new Promise(resolve => {
            file.load_contents_async(this._cancellable, (source, result) => {
                try {
                    const [, contents] = source.load_contents_finish(result);
                    const decoded = new TextDecoder('utf-8').decode(contents);
                    const parsed = JSON.parse(decoded);

                    let lines = [];
                    let isSynced = false;
                    if (parsed.syncedLyrics) {
                        const lrc = parseLRC(parsed.syncedLyrics);
                        lines = lrc.lines;
                        isSynced = lines.length > 0;
                    }

                    const durationMs = parsed.duration ? Math.round(parsed.duration * 1000) : 0;
                    resolve(new LyricsData({
                        trackKey: key,
                        synced: isSynced,
                        isInstrumental: parsed.instrumental === true,
                        lines,
                        plainLyrics: parsed.plainLyrics || '',
                        durationMs,
                    }));
                } catch {
                    resolve(null);
                }
            });
        });
    }

    async _writeToDisk(key, data) {
        try {
            const fileName = this._cacheFileName(key);
            const file = this._cacheDir.get_child(fileName);
            const jsonStr = JSON.stringify(data);
            const bytes = new GLib.Bytes(new TextEncoder().encode(jsonStr));

            await new Promise((resolve, reject) => {
                file.replace_contents_bytes_async(
                    bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                    this._cancellable,
                    (target, result) => {
                        try {
                            target.replace_contents_finish(result);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
            });

            this._pruneCache();
        } catch {
            /* Non-fatal if writing cache fails */
        }
    }

    _pruneCache() {
        const attributes = `${Gio.FILE_ATTRIBUTE_STANDARD_NAME},${Gio.FILE_ATTRIBUTE_TIME_MODIFIED}`;
        this._cacheDir.enumerate_children_async(
            attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW,
            this._cancellable,
            (dir, result) => {
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(result);
                } catch {
                    return;
                }

                enumerator.next_files_async(
                    MAX_CACHED_FILES * 2, GLib.PRIORITY_LOW, this._cancellable,
                    (source, batchResult) => {
                        let infos;
                        try {
                            infos = source.next_files_finish(batchResult);
                        } catch {
                            return;
                        }
                        if (infos.length <= MAX_CACHED_FILES)
                            return;

                        const mtime = info => info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED);
                        infos.sort((a, b) => Number(mtime(b) - mtime(a)));

                        for (const info of infos.slice(MAX_CACHED_FILES)) {
                            this._cacheDir.get_child(info.get_name()).delete_async(
                                GLib.PRIORITY_LOW, this._cancellable, () => {});
                        }
                    });
            });
    }

    destroy() {
        this._cancellable.cancel();
        this._pending.clear();
        this._memoryCache.clear();
        this._session.abort();
        this._session = null;
        this._currentLyrics = null;
    }
});
