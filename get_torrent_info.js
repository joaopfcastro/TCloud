const WebTorrent = require('webtorrent');

const client = new WebTorrent();
const magnetURI = process.argv[2];

if (!magnetURI) {
    console.error(JSON.stringify({ error: "No magnet URI provided" }));
    process.exit(1);
}

// Timeout after 30 seconds
const timeout = setTimeout(() => {
    console.error(JSON.stringify({ error: "Timeout fetching metadata" }));
    client.destroy();
    process.exit(1);
}, 30000);

client.add(magnetURI, (torrent) => {
    clearTimeout(timeout);
    const result = {
        name: torrent.name,
        infoHash: torrent.infoHash,
        totalLength: torrent.length,
        files: torrent.files.map((file, index) => ({
            index: index,
            name: file.name,
            path: file.path,
            length: file.length
        }))
    };

    console.log(JSON.stringify(result));

    // We just want metadata, so destroy it
    client.destroy();
    process.exit(0);
});

client.on('error', function (err) {
    console.error(JSON.stringify({ error: err.message }));
    client.destroy();
    process.exit(1);
});
