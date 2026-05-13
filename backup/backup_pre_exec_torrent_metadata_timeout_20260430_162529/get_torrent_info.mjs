import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';

const client = new WebTorrent();
const magnetURI = process.argv[2];
const cacheDir = process.argv[3] || '/tmp';

if (!magnetURI) {
    console.error(JSON.stringify({ error: "No magnet URI provided" }));
    process.exit(1);
}

// Ensure cache directory exists
try { fs.mkdirSync(path.join(cacheDir, 'torrent_meta'), { recursive: true }); } catch {}

// Timeout after 30 seconds
const timeout = setTimeout(() => {
    console.error(JSON.stringify({ error: "Timeout fetching metadata. Link is dead or no seeders." }));
    client.destroy();
    process.exit(1);
}, 30000);

client.add(magnetURI, (torrent) => {
    clearTimeout(timeout);

    // Save .torrent file to disk for reuse by the downloader (skip DHT re-resolution)
    let torrentFilePath = null;
    try {
        const torrentFileBuffer = torrent.torrentFile;
        if (torrentFileBuffer) {
            torrentFilePath = path.join(cacheDir, 'torrent_meta', `${torrent.infoHash}.torrent`);
            fs.writeFileSync(torrentFilePath, torrentFileBuffer);
        }
    } catch (e) {
        // Non-fatal: we can still return info, just without the cached file
    }

    const result = {
        name: torrent.name,
        infoHash: torrent.infoHash,
        totalLength: torrent.length,
        pieceLength: torrent.pieceLength || 0,
        torrent_file: torrentFilePath,
        files: torrent.files.map((file, index) => ({
            index: index,
            name: file.name,
            path: file.path,
            length: file.length,
            offset: file.offset
        }))
    };

    console.log(JSON.stringify(result));

    client.destroy();
    process.exit(0);
});

client.on('error', function (err) {
    console.error(JSON.stringify({ error: err.message }));
    client.destroy();
    process.exit(1);
});
