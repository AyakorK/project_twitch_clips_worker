const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '../../tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

setInterval(() => {
    fs.readdir(TMP_DIR, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(TMP_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtimeMs > 10 * 60 * 1000) fs.unlink(filePath, () => {});
            });
        });
    });
}, 30 * 60 * 1000);

function streamFile(res, filePath, cleanup = []) {
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => cleanup.forEach(f => fs.unlink(f, () => {})));
    stream.on('error', () => {
        cleanup.forEach(f => fs.unlink(f, () => {}));
        if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
    });
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, res => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

function fetchText(url) {
    return fetchBuffer(url).then(b => b.toString('utf8'));
}

function tmpPath(prefix, ext) {
    return path.join(TMP_DIR, `${prefix}_${Date.now()}.${ext}`);
}

module.exports = { TMP_DIR, streamFile, fetchBuffer, fetchText, tmpPath };
