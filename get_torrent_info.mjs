import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';

const torrentInput = process.argv[2];
const cacheDir = process.argv[3] || '/tmp';
const torrentMetaDir = path.join(cacheDir, 'torrent_meta');
const MIN_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_EXTRA_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'https://tracker.gbitt.info/announce',
    'https://tracker1.520.jp/announce'
];

if (!torrentInput) {
    console.error(JSON.stringify({
        error: 'No magnet URI or torrent source provided',
        code: 'missing_torrent_source',
        stage: 'input'
    }));
    process.exit(1);
}

try {
    fs.mkdirSync(torrentMetaDir, { recursive: true });
} catch {
    // Cache is an optimization; metadata resolution can continue without it.
}

function emitDiagnostic(event, payload = {}) {
    console.error(`TCloudTorrentInfo ${JSON.stringify({ event, ...payload })}`);
}

function normalizeTimeout() {
    const raw = Number(process.env.TORRENT_METADATA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.max(MIN_TIMEOUT_MS, Math.floor(raw));
}

function base32ToHex(value) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const char of value.toUpperCase()) {
        const idx = alphabet.indexOf(char);
        if (idx === -1) return null;
        bits += idx.toString(2).padStart(5, '0');
    }
    let hex = '';
    for (let i = 0; i + 4 <= bits.length; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex.length >= 40 ? hex.slice(0, 40).toLowerCase() : null;
}

function normalizeInfoHash(rawHash) {
    if (!rawHash) return null;
    const cleaned = String(rawHash).trim();
    if (/^[a-fA-F0-9]{40}$/.test(cleaned)) return cleaned.toLowerCase();
    if (/^[A-Z2-7a-z]{32}$/.test(cleaned)) return base32ToHex(cleaned);
    return null;
}

function parseMagnet(input) {
    if (!String(input).toLowerCase().startsWith('magnet:')) {
        return { isMagnet: false, infoHash: null, name: null, trackers: [] };
    }

    const url = new URL(input);
    const xtValues = url.searchParams.getAll('xt');
    let infoHash = null;
    for (const xt of xtValues) {
        const match = xt.match(/^urn:btih:(.+)$/i);
        if (match) {
            infoHash = normalizeInfoHash(decodeURIComponent(match[1]));
            break;
        }
    }

    return {
        isMagnet: true,
        infoHash,
        name: url.searchParams.get('dn'),
        trackers: url.searchParams.getAll('tr').filter(Boolean)
    };
}

function getExtraTrackers() {
    if (Object.prototype.hasOwnProperty.call(process.env, 'TORRENT_METADATA_EXTRA_TRACKERS')) {
        const raw = process.env.TORRENT_METADATA_EXTRA_TRACKERS || '';
        return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
    return DEFAULT_EXTRA_TRACKERS;
}

function buildTrackerList(originalTrackers) {
    const shouldAddFallbacks = originalTrackers.length < 3;
    const combined = shouldAddFallbacks
        ? [...originalTrackers, ...getExtraTrackers()]
        : [...originalTrackers];
    return Array.from(new Set(combined.map(s => s.trim()).filter(Boolean)));
}

function magnetWithTrackers(input, trackers) {
    const existing = new Set(parseMagnet(input).trackers);
    const additions = [];
    for (const tracker of trackers) {
        if (!existing.has(tracker)) {
            additions.push(`tr=${encodeURIComponent(tracker)}`);
        }
    }
    if (additions.length === 0) return input;
    return `${input}${input.includes('?') ? '&' : '?'}${additions.join('&')}`;
}

function resolveCachedTorrent(infoHash) {
    if (!infoHash) return null;
    const torrentFilePath = path.join(torrentMetaDir, `${infoHash}.torrent`);
    return fs.existsSync(torrentFilePath) ? torrentFilePath : null;
}

function buildResult(torrent, torrentFilePath) {
    return {
        name: torrent.name,
        infoHash: torrent.infoHash,
        totalLength: torrent.length,
        pieceLength: torrent.pieceLength || 0,
        torrent_file: torrentFilePath,
        files: torrent.files.map((file, index) => ({
            index,
            name: file.name,
            path: file.path,
            length: file.length,
            offset: file.offset
        }))
    };
}

function saveTorrentFile(torrent) {
    if (!torrent?.torrentFile || !torrent?.infoHash) return null;
    const torrentFilePath = path.join(torrentMetaDir, `${torrent.infoHash}.torrent`);
    try {
        fs.writeFileSync(torrentFilePath, torrent.torrentFile);
        return torrentFilePath;
    } catch (err) {
        emitDiagnostic('cache_write_failed', { message: err.message, infoHash: torrent.infoHash });
        return null;
    }
}

function destroyClient(client) {
    try {
        client.destroy();
    } catch {
        // Nothing useful to do during process shutdown.
    }
}

function writeJsonAndExit(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0));
}

async function readRemoteTorrent(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching torrent file`);
    }
    return Buffer.from(await response.arrayBuffer());
}

function addTorrent(source, options, timeoutMs, context) {
    return new Promise((resolve, reject) => {
        const client = new WebTorrent();
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            destroyClient(client);
            reject(Object.assign(new Error('Timeout fetching torrent metadata'), {
                code: 'metadata_timeout',
                stage: 'metadata',
                context
            }));
        }, timeoutMs);

        function finish(fn, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            fn(value);
        }

        client.on('error', (err) => {
            destroyClient(client);
            finish(reject, Object.assign(err, {
                code: err.code || 'metadata_error',
                stage: 'metadata',
                context
            }));
        });

        try {
            client.add(source, options, (torrent) => {
                finish(resolve, { client, torrent });
            });
        } catch (err) {
            destroyClient(client);
            finish(reject, Object.assign(err, {
                code: err.code || 'metadata_error',
                stage: 'metadata',
                context
            }));
        }
    });
}

async function resolveWithSource(source, options, timeoutMs, context, knownTorrentPath = null) {
    try {
        emitDiagnostic('metadata_resolve_start', context);
        const result = await addTorrent(source, options, timeoutMs, context);
        const torrentFilePath = knownTorrentPath || saveTorrentFile(result.torrent);
        emitDiagnostic('metadata_resolved', {
            ...context,
            infoHash: result.torrent.infoHash,
            files: result.torrent.files.length,
            torrent_file: torrentFilePath
        });
        return buildResult(result.torrent, torrentFilePath);
    } catch (err) {
        throw err;
    }
}

async function main() {
    const timeoutMs = normalizeTimeout();
    const parsed = parseMagnet(torrentInput);
    const trackers = buildTrackerList(parsed.trackers);

    emitDiagnostic('input_parsed', {
        isMagnet: parsed.isMagnet,
        infoHash: parsed.infoHash,
        tracker_count: trackers.length,
        timeout_ms: timeoutMs
    });

    if (fs.existsSync(torrentInput) && torrentInput.endsWith('.torrent')) {
        const buffer = fs.readFileSync(torrentInput);
        const result = await resolveWithSource(buffer, {}, timeoutMs, {
            source: 'local_torrent_file',
            torrent_file: torrentInput,
            timeout_ms: timeoutMs
        }, torrentInput);
        return writeJsonAndExit(result);
    }

    if (/^https?:\/\//i.test(torrentInput) && torrentInput.toLowerCase().includes('.torrent')) {
        const buffer = await readRemoteTorrent(torrentInput);
        const result = await resolveWithSource(buffer, {}, timeoutMs, {
            source: 'remote_torrent_file',
            torrent_url: torrentInput,
            timeout_ms: timeoutMs
        });
        return writeJsonAndExit(result);
    }

    if (!parsed.isMagnet) {
        throw Object.assign(new Error('Unsupported torrent source'), {
            code: 'unsupported_torrent_source',
            stage: 'input'
        });
    }

    if (parsed.infoHash) {
        const cachedTorrent = resolveCachedTorrent(parsed.infoHash);
        if (cachedTorrent) {
            emitDiagnostic('cache_hit', { infoHash: parsed.infoHash, torrent_file: cachedTorrent });
            try {
                const buffer = fs.readFileSync(cachedTorrent);
                const result = await resolveWithSource(buffer, {}, Math.min(timeoutMs, 30000), {
                    source: 'cache',
                    infoHash: parsed.infoHash,
                    timeout_ms: Math.min(timeoutMs, 30000)
                }, cachedTorrent);
                return writeJsonAndExit(result);
            } catch (err) {
                emitDiagnostic('cache_invalid', {
                    infoHash: parsed.infoHash,
                    torrent_file: cachedTorrent,
                    message: err.message
                });
            }
        } else {
            emitDiagnostic('cache_miss', { infoHash: parsed.infoHash });
        }
    }

    const enrichedMagnet = magnetWithTrackers(torrentInput, trackers);
    const result = await resolveWithSource(enrichedMagnet, { announce: trackers }, timeoutMs, {
        source: 'magnet',
        infoHash: parsed.infoHash,
        timeout_ms: timeoutMs,
        trackers_used: trackers
    });
    return writeJsonAndExit(result);
}

main().catch((err) => {
    const parsed = parseMagnet(torrentInput);
    const trackers = buildTrackerList(parsed.trackers);
    const timeoutMs = normalizeTimeout();
    const payload = {
        error: err.message || 'Failed to fetch torrent metadata',
        code: err.code || 'metadata_error',
        stage: err.stage || 'metadata',
        infoHash: err.context?.infoHash || parsed.infoHash || null,
        timeout_ms: err.context?.timeout_ms || timeoutMs,
        trackers_used: err.context?.trackers_used || trackers,
        hint: err.code === 'metadata_timeout'
            ? 'Torrent may still be valid; metadata was not resolved by this server in time.'
            : undefined
    };
    console.error(JSON.stringify(payload));
    process.exit(1);
});
