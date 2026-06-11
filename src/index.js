const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3003;
const AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN;
const TMP_DIR = path.join(__dirname, 'tmp');
const MAX_SEGMENT_DURATION_SECONDS = 60 * 60;
const DOWNLOAD_MARGIN_SEC = 15;

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

function formatTimestamp(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function streamFile(res, filePath, filename, cleanup = []) {
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('close', () => cleanup.forEach((f) => fs.unlink(f, () => {})));
    stream.on('error', () => {
        cleanup.forEach((f) => fs.unlink(f, () => {}));
        if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
    });
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
        streamFile(res, outPath, `${clipSlug}.mp4`, [outPath]);
    });
});

app.get('/segment', auth, (req, res) => {
    const { vodId, from, to } = req.query;

    if (!vodId || !/^\d+$/.test(vodId)) {
        return res.status(400).json({ error: 'Invalid vodId' });
    }

    const fromSec = parseTimestamp(from);
    const toSec = parseTimestamp(to);

    if (fromSec === null || toSec === null) {
        return res.status(400).json({ error: 'Invalid timestamps. Use HH:MM:SS format' });
    }
    if (toSec <= fromSec) {
        return res.status(400).json({ error: 'to must be after from' });
    }
    if (toSec - fromSec > MAX_SEGMENT_DURATION_SECONDS) {
        return res.status(400).json({ error: 'Segment too long (max 1h)' });
    }

    const ts = Date.now();
    const rawPath = path.join(TMP_DIR, `seg_${vodId}_${ts}_raw.mp4`);
    const outPath = path.join(TMP_DIR, `seg_${vodId}_${ts}.mp4`);
    const duration = toSec - fromSec;
    const downloadFrom = Math.max(0, fromSec - DOWNLOAD_MARGIN_SEC);
    const section = `*${formatTimestamp(downloadFrom)}-${formatTimestamp(toSec)}`;

    let actualFromSec = null;

    const ytdlp = spawn('yt-dlp', [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--download-sections', section,
        '--retries', '10',
        '--fragment-retries', '10',
        '--retry-sleep', '3',
        '-o', rawPath,
        '--no-playlist',
        `https://www.twitch.tv/videos/${vodId}`,
    ]);

    ytdlp.stdout.on('data', (d) => {
        const match = d.toString().match(/Downloading \d+ time ranges?: ([\d.]+)-[\d.]+/);
        if (match) actualFromSec = parseFloat(match[1]);
    });
    ytdlp.stderr.on('data', () => {});

    ytdlp.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(rawPath)) {
            return res.status(500).json({ error: 'Download failed' });
        }

        const rawStart = actualFromSec ?? downloadFrom;
        const skipSec = Math.max(0, fromSec - rawStart);

        const args = ['-y'];
        if (skipSec > 0.01) args.push('-ss', skipSec.toFixed(3));
        args.push(
            '-i', rawPath,
            '-t', duration.toFixed(3),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            outPath,
        );

        const ffmpeg = spawn('ffmpeg', args);
        ffmpeg.stderr.on('data', () => {});

        ffmpeg.on('close', (ffCode) => {
            fs.unlink(rawPath, () => {});
            if (ffCode !== 0 || !fs.existsSync(outPath)) {
                return res.status(500).json({ error: 'Processing failed' });
            }
            const filename = `vod${vodId}_${from.replace(/:/g, '')}-${to.replace(/:/g, '')}.mp4`;
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            streamFile(res, outPath, filename, [outPath]);
        });
    });
});

app.listen(PORT, () => {
    if (!AUTH_TOKEN) console.warn('⚠️  WORKER_AUTH_TOKEN not set — API is unprotected!');
});