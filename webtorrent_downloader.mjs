import WebTorrent from 'webtorrent';
import fs from 'fs';

const torrentSource = process.argv[2]; // magnet URI or .torrent file path
const outPath = process.argv[3];
const selectedIndicesArg = process.argv[4];

if (!torrentSource || !outPath) {
    console.error(JSON.stringify({ error: "Missing torrentSource or outPath" }));
    process.exit(1);
}

let selectedIndices = null;
if (selectedIndicesArg && selectedIndicesArg.trim() !== "") {
    selectedIndices = selectedIndicesArg.split(',').map(Number);
}

const client = new WebTorrent();
const DEFAULT_EXTRA_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'https://tracker.gbitt.info/announce',
    'https://tracker1.520.jp/announce'
];

function parseMagnetTrackers(input) {
    if (!String(input).toLowerCase().startsWith('magnet:')) return [];
    try {
        return new URL(input).searchParams.getAll('tr').filter(Boolean);
    } catch {
        return [];
    }
}

function getExtraTrackers() {
    if (Object.prototype.hasOwnProperty.call(process.env, 'TORRENT_METADATA_EXTRA_TRACKERS')) {
        return (process.env.TORRENT_METADATA_EXTRA_TRACKERS || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
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
    if (!String(input).toLowerCase().startsWith('magnet:')) return input;
    const existing = new Set(parseMagnetTrackers(input));
    const additions = [];
    for (const tracker of trackers) {
        if (!existing.has(tracker)) additions.push(`tr=${encodeURIComponent(tracker)}`);
    }
    if (additions.length === 0) return input;
    return `${input}${input.includes('?') ? '&' : '?'}${additions.join('&')}`;
}

// Determine input: if it's a file path to a .torrent, read it as a buffer
let addInput = torrentSource;
let addOptions = { path: outPath, strategy: 'rarest' };
if (fs.existsSync(torrentSource) && torrentSource.endsWith('.torrent')) {
    addInput = fs.readFileSync(torrentSource);
} else if (String(torrentSource).toLowerCase().startsWith('magnet:')) {
    const trackers = buildTrackerList(parseMagnetTrackers(torrentSource));
    addInput = magnetWithTrackers(torrentSource, trackers);
    addOptions = { ...addOptions, announce: trackers };
}

const torrent = client.add(addInput, addOptions);

let lastLogTime = Date.now();
let isPaused = false;
let selectedReadyEmitted = false;

function checkSelectedReady() {
    if (selectedReadyEmitted) return false;
    if (!torrent.files || torrent.files.length === 0) return false;

    const filesToCheck = selectedIndices && selectedIndices.length > 0
        ? selectedIndices.map(i => torrent.files[i]).filter(Boolean)
        : torrent.files;

    for (const file of filesToCheck) {
        if (file.downloaded < file.length) return false;
    }

    // All selected files are ready!
    selectedReadyEmitted = true;

    const readyFiles = filesToCheck.map(f => ({
        path: f.path,
        length: f.length
    }));

    console.log(JSON.stringify({
        type: 'selected_ready',
        files: readyFiles
    }));

    return true;
}

// ─── stdin commands from Python ───
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
    const cmd = data.toString().trim();
    if (cmd === 'pause') {
        isPaused = true;
        torrent.pause();
        console.log(JSON.stringify({ type: 'paused' }));
    } else if (cmd === 'resume') {
        isPaused = false;
        torrent.resume();
        console.log(JSON.stringify({ type: 'resumed' }));
    } else if (cmd === 'cancel') {
        client.destroy();
        process.exit(0);
    }
});

// ─── Torrent events ───
torrent.on('infoHash', () => {
    console.log(JSON.stringify({ type: 'info', infoHash: torrent.infoHash }));
});

torrent.on('metadata', () => {
    // Calculate sizes
    let selectedLogicalTotal = 0;
    let requiredPieceBytesTotal = 0;
    let minimumOverheadBytes = 0;
    const pieceLength = torrent.pieceLength || 0;
    const requiredPieces = new Set();
    let selectedFileCount = 0;
    let selectedFilePaths = [];

    if (selectedIndices && selectedIndices.length > 0) {
        selectedFileCount = selectedIndices.length;
        selectedIndices.forEach(idx => {
            const file = torrent.files[idx];
            if (file) {
                selectedLogicalTotal += file.length;
                selectedFilePaths.push(file.path);
                if (pieceLength > 0) {
                    const startPiece = Math.floor(file.offset / pieceLength);
                    const endPiece = Math.floor((file.offset + file.length - 1) / pieceLength);
                    for (let p = startPiece; p <= endPiece; p++) {
                        requiredPieces.add(p);
                    }
                }
            }
        });

        const totalPieces = torrent.pieces ? torrent.pieces.length : Math.ceil(torrent.length / pieceLength);
        for (const p of requiredPieces) {
            const isLast = (p === totalPieces - 1);
            requiredPieceBytesTotal += isLast ? (torrent.length % pieceLength || pieceLength) : pieceLength;
        }
        minimumOverheadBytes = requiredPieceBytesTotal > selectedLogicalTotal ? requiredPieceBytesTotal - selectedLogicalTotal : 0;
    } else {
        selectedFileCount = torrent.files ? torrent.files.length : 0;
        selectedFilePaths = torrent.files ? torrent.files.map(f => f.path) : [];
        selectedLogicalTotal = torrent.length;
        requiredPieceBytesTotal = torrent.length;
    }

    console.log(JSON.stringify({
        type: 'metadata',
        name: torrent.name,
        length: selectedLogicalTotal,
        pieceLength: pieceLength,
        requiredPieceBytesTotal: requiredPieceBytesTotal,
        totalTorrentLength: torrent.length,
        minimumOverheadBytes: minimumOverheadBytes,
        selectedFileCount: selectedFileCount,
        selectedFilePaths: selectedFilePaths,
        files: torrent.files ? torrent.files.map(f => f.path) : []
    }));
});

torrent.on('ready', () => {
    if (selectedIndices && selectedIndices.length > 0) {
        // Deselect ALL files first
        torrent.files.forEach((file, idx) => {
            file.deselect();
        });
        
        // Then select ONLY the target files with high priority
        selectedIndices.forEach(idx => {
            if (torrent.files[idx]) {
                torrent.files[idx].select(10);
            }
        });

        console.log(JSON.stringify({
            type: 'selection_applied',
            strategy: 'selective_deselect',
            selectedCount: selectedIndices.length,
            totalFiles: torrent.files.length
        }));
    } else {
        console.log(JSON.stringify({
            type: 'selection_applied',
            strategy: 'full_download'
        }));
    }
});

torrent.on('download', (bytes) => {
    if (isPaused) return;

    // Check if selected files are ready
    checkSelectedReady();

    const now = Date.now();
    if (now - lastLogTime >= 1000) {
        emitProgress();
        lastLogTime = now;
    }
});

function emitProgress() {
    // Logical progress of selected files
    let selectedLogicalDone = 0;
    let selectedLogicalTotal = 0;
    if (selectedIndices && selectedIndices.length > 0) {
        selectedIndices.forEach(idx => {
            if (torrent.files[idx]) {
                selectedLogicalDone += torrent.files[idx].downloaded;
                selectedLogicalTotal += torrent.files[idx].length;
            }
        });
    } else {
        selectedLogicalDone = torrent.downloaded;
        selectedLogicalTotal = torrent.length;
    }

    const torrentDownloaded = torrent.downloaded;
    let currentOverheadBytes = 0;
    if (selectedIndices && selectedIndices.length > 0) {
        currentOverheadBytes = torrentDownloaded > selectedLogicalDone ? torrentDownloaded - selectedLogicalDone : 0;
    }

    const filePercent = selectedLogicalTotal > 0 ? (selectedLogicalDone / selectedLogicalTotal) * 100 : 0;
    const torrentPercent = torrent.length > 0 ? (torrentDownloaded / torrent.length) * 100 : 0;

    console.log(JSON.stringify({
        type: 'piece_progress',
        percent: filePercent,
        torrentPercent: torrentPercent,
        speed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        selectedLogicalBytesDone: selectedLogicalDone,
        selectedLogicalBytesTotal: selectedLogicalTotal,
        swarmDownloadedBytes: torrentDownloaded,
        swarmTotalBytes: torrent.length,
        currentOverheadBytes: currentOverheadBytes,
        numPeers: torrent.numPeers,
        // Legacy compat
        downloaded: selectedLogicalDone,
        total: selectedLogicalTotal,
        torrentDownloaded: torrentDownloaded,
        torrentLength: torrent.length,
        timeRemaining: torrent.timeRemaining
    }));
}

// Periodic progress poll — ensures UI updates even during initial peer discovery
// when no 'download' events fire yet
let progressInterval = setInterval(() => {
    if (isPaused) return;
    if (!torrent.ready) return;
    emitProgress();
}, 2000);

torrent.on('done', () => {
    checkSelectedReady();
    clearInterval(progressInterval);
    console.log(JSON.stringify({ type: 'done' }));
    client.destroy();
    process.exit(0);
});

torrent.on('error', (err) => {
    console.error(JSON.stringify({ type: 'error', message: err.message }));
    client.destroy();
    process.exit(1);
});

// For partial downloads, poll to check if selected files are complete.
// EXIT IMMEDIATELY once they're done — this is what prevents wasting bandwidth.
if (selectedIndices && selectedIndices.length > 0) {
    const checkInterval = setInterval(() => {
        if (isPaused) return;
        if (!torrent.files || torrent.files.length === 0) return;

        let allDone = true;
        for (const idx of selectedIndices) {
            if (torrent.files[idx]) {
                if (torrent.files[idx].downloaded < torrent.files[idx].length) {
                    allDone = false;
                    break;
                }
            }
        }
        if (allDone && torrent.files.length > 0) {
            clearInterval(checkInterval);
            clearInterval(progressInterval);
            if (!selectedReadyEmitted) {
                checkSelectedReady();
            }
            // Brief delay for Python to process selected_ready, then exit
            setTimeout(() => {
                console.log(JSON.stringify({ type: 'done' }));
                client.destroy();
                process.exit(0);
            }, 2000);
        }
    }, 500); // Check every 500ms for fast response
}
