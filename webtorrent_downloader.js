const WebTorrent = require('webtorrent');
const client = new WebTorrent();

const magnetURI = process.argv[2];
const outPath = process.argv[3];
const selectedIndicesArg = process.argv[4];

if (!magnetURI || !outPath) {
    console.error(JSON.stringify({ error: "Missing magnetURI or outPath" }));
    process.exit(1);
}

let selectedIndices = null;
if (selectedIndicesArg && selectedIndicesArg.trim() !== "") {
    selectedIndices = selectedIndicesArg.split(',').map(Number);
}

const torrent = client.add(magnetURI, { path: outPath });

let lastLogTime = Date.now();

torrent.on('infoHash', () => {
    console.log(JSON.stringify({ type: 'info', infoHash: torrent.infoHash }));
});

torrent.on('metadata', () => {
    if (selectedIndices) {
        torrent.files.forEach(file => file.deselect());

        selectedIndices.forEach(idx => {
            if (torrent.files[idx]) {
                torrent.files[idx].select();
            }
        });
    }

    console.log(JSON.stringify({
        type: 'metadata',
        name: torrent.name,
        length: torrent.length,
        files: torrent.files.map(f => f.name)
    }));
});

torrent.on('download', (bytes) => {
    const now = Date.now();
    if (now - lastLogTime >= 1000) {
        console.log(JSON.stringify({
            type: 'progress',
            percent: torrent.progress * 100,
            speed: torrent.downloadSpeed,
            downloaded: torrent.downloaded,
            total: torrent.length,
            timeRemaining: torrent.timeRemaining
        }));
        lastLogTime = now;
    }
});

torrent.on('done', () => {
    console.log(JSON.stringify({ type: 'done' }));
    client.destroy();
    process.exit(0);
});

torrent.on('error', (err) => {
    console.error(JSON.stringify({ type: 'error', message: err.message }));
    client.destroy();
    process.exit(1);
});
