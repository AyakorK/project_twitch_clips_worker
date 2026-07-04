const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3003;
const AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN;
const TMP_DIR = path.join(__dirname, 'tmp');

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

setInterval(() => {
    fs.readdir(TMP_DIR, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach((file) => {
            const filePath = path.join(TMP_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtimeMs > 10 * 60 * 1000) fs.unlink(filePath, () => {});
            });
        });
    });
}, 30 * 60 * 1000);

app.use(cors({
    origin: true,
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['x-worker-token', 'Content-Type'],
    credentials: false,
}));

function auth(req, res, next) {
    if (!AUTH_TOKEN) return next();
    const token = req.headers['x-worker-token'] || req.query.token;
    if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

function parseTimestamp(ts) {
    if (!ts) return null;
    const match = ts.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, h, m, s] = match.map(Number);
    return h * 3600 + m * 60 + s;
}

function streamFile(res, filePath, cleanup = []) {
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => cleanup.forEach((f) => fs.unlink(f, () => {})));
    stream.on('error', () => {
        cleanup.forEach((f) => fs.unlink(f, () => {}));
        if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
    });
}

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}`)));
                return;
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

function getM3u8Url(vodId) {
    return new Promise((resolve, reject) => {
        const ytdlp = spawn('yt-dlp', [
            '--get-url',
            '-f', 'bestvideo[ext=mp4]/best[ext=mp4]/best',
            `https://www.twitch.tv/videos/${vodId}`,
        ]);
        let url = '';
        let stderr = '';
        ytdlp.stdout.on('data', d => { url += d.toString().trim(); });
        ytdlp.stderr.on('data', d => { stderr += d.toString(); });
        ytdlp.on('close', code => {
            if (code !== 0 || !url) {
                console.error('[yt-dlp error]', stderr);
                return reject(new Error(`yt-dlp failed: ${stderr.substring(0, 300)}`));
            }
            resolve(url.trim());
        });
    });
}

async function getSegmentsInRange(m3u8Url, fromSec, toSec) {
    const m3u8 = await fetchText(m3u8Url);
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    const lines = m3u8.split('\n');
    const segments = [];
    let currentTime = 0;
    let segDuration = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            segDuration = parseFloat(line.replace('#EXTINF:', '').split(',')[0]);
        } else if (line && !line.startsWith('#')) {
            const segStart = currentTime;
            const segEnd = currentTime + segDuration;
            if (segEnd > fromSec && segStart < toSec) {
                const url = line.startsWith('http') ? line : baseUrl + line;
                segments.push({ url, start: segStart, end: segEnd });
            }
            currentTime += segDuration;
            segDuration = 0;
        }
    }
    return segments;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/clip/:clipSlug', auth, (req, res) => {
    const { clipSlug } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(clipSlug)) {
        return res.status(400).json({ error: 'Invalid clip slug' });
    }

    const outPath = path.join(TMP_DIR, `clip_${clipSlug}_${Date.now()}.mp4`);

    const ytdlp = spawn('yt-dlp', [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--retries', '10',
        '--fragment-retries', '10',
        '--retry-sleep', '3',
        '-o', outPath,
        '--no-playlist',
        `https://clips.twitch.tv/${clipSlug}`,
    ]);

    ytdlp.stdout.on('data', () => {});
    ytdlp.stderr.on('data', () => {});

    ytdlp.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(outPath)) {
            return res.status(500).json({ error: 'Download failed' });
        }
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${clipSlug}.mp4"`);
        streamFile(res, outPath, [outPath]);
    });
});

app.get('/segment', auth, async (req, res) => {
    const { vodId, from, to } = req.query;

    if (!vodId || !/^\d+$/.test(vodId)) {
        return res.status(400).json({ error: 'Invalid vodId' });
    }

    const fromSec = parseTimestamp(from);
    const toSec = parseTimestamp(to);

    if (fromSec === null || toSec === null) {
        return res.status(400).json({ error: 'Invalid timestamps' });
    }
    if (toSec <= fromSec) {
        return res.status(400).json({ error: 'to must be after from' });
    }
    // if (toSec - fromSec > 3600) {
    //     return res.status(400).json({ error: 'Segment too long (max 1h)' });
    // }

    const tsPath  = path.join(TMP_DIR, `seg_${vodId}_${Date.now()}.ts`);
    const mp4Path = tsPath.replace('.ts', '.mp4');

    try {
        const m3u8Url = await getM3u8Url(vodId);
        const segments = await getSegmentsInRange(m3u8Url, fromSec, toSec);

        if (segments.length === 0) {
            return res.status(404).json({ error: 'No segments in range' });
        }

        const tsStream = fs.createWriteStream(tsPath);
        for (let i = 0; i < segments.length; i += 8) {
            const batch = segments.slice(i, i + 8);
            const bufs = await Promise.all(batch.map(seg => fetchBuffer(seg.url)));
            for (const buf of bufs) tsStream.write(buf);
        }
        await new Promise((resolve, reject) => {
            tsStream.end();
            tsStream.on('finish', resolve);
            tsStream.on('error', reject);
        });

        await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', [
                '-y', '-i', tsPath,
                '-c', 'copy',
                '-movflags', '+faststart',
                mp4Path,
            ]);
            ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
        });

        fs.unlink(tsPath, () => {});

        const filename = `${vodId}_${from.replace(/:/g, '')}-${to.replace(/:/g, '')}.mp4`;
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', fs.statSync(mp4Path).size);
        streamFile(res, mp4Path, [mp4Path]);

    } catch (e) {
        console.error('[segment error]', e.message);
        console.error(e.stack);
        fs.unlink(tsPath, () => {});
        fs.unlink(mp4Path, () => {});
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    if (!AUTH_TOKEN) console.warn('⚠️  WORKER_AUTH_TOKEN not set — API is unprotected!');
});