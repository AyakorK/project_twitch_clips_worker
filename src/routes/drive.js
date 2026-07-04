const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { STORAGE_DIR, STORAGE_LIMIT_BYTES, getQuota, safePath, listDir } = require('../lib/storage');

const router = express.Router();

const mimeMap = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
    '.flac': 'audio/flac', '.ogg': 'audio/ogg',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const folder = req.query.folder || '';
        let destPath;
        try { destPath = safePath(folder); } catch { return cb(new Error('Invalid folder path')); }
        fs.mkdirSync(destPath, { recursive: true });
        cb(null, destPath);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_').trim());
    },
});

function checkQuota(req, res, next) {
    const quota = getQuota();
    if (quota.available <= 0) return res.status(507).json({ error: 'Storage full', quota });
    next();
}

const upload = multer({ storage, limits: { fileSize: STORAGE_LIMIT_BYTES } });

router.get('/quota', (req, res) => res.json(getQuota()));

router.get('/list', (req, res) => {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    try {
        const result = listDir(relPath);
        res.json({ ...result, quota: getQuota(), currentPath: relPath });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/folder', (req, res) => {
    const parent = (req.query.path || '').replace(/^\/+/, '');
    const name = (req.query.name || '').replace(/[^a-zA-Z0-9._\-\s]/g, '_').trim();
    if (!name) return res.status(400).json({ error: 'Invalid folder name' });
    try {
        const folderPath = safePath(parent, name);
        if (fs.existsSync(folderPath)) return res.status(409).json({ error: 'Folder already exists' });
        fs.mkdirSync(folderPath, { recursive: true });
        res.json({ success: true, path: path.join(parent, name) });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/folder', (req, res) => {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    if (!relPath) return res.status(400).json({ error: 'Missing path' });
    try {
        const fullPath = safePath(relPath);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
        fs.rmSync(fullPath, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/upload', checkQuota, upload.array('files', 20), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const folder = req.query.folder || '';
    const uploaded = req.files.map(f => ({
        name: f.filename, path: path.join(folder, f.filename),
        size: f.size, sizeMB: +(f.size / 1024 / 1024).toFixed(2),
    }));
    res.json({ success: true, files: uploaded, quota: getQuota() });
});

router.post('/import', checkQuota, express.json(), async (req, res) => {
    let { url, folder = '', filename } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const gdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (gdMatch) url = `https://drive.google.com/uc?export=download&id=${gdMatch[1]}`;

    if (!filename) filename = decodeURIComponent(url.split('/').pop().split('?')[0]) || `import_${Date.now()}`;
    filename = filename.replace(/[^a-zA-Z0-9._\-\s]/g, '_').trim();

    let destPath;
    try {
        const folderPath = safePath(folder);
        fs.mkdirSync(folderPath, { recursive: true });
        destPath = path.join(folderPath, filename);
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }

    function download(downloadUrl, redirectCount = 0) {
        if (redirectCount > 5) return res.status(400).json({ error: 'Too many redirects' });
        const lib = downloadUrl.startsWith('https') ? https : http;
        const fileStream = fs.createWriteStream(destPath);

        lib.get(downloadUrl, response => {
            if ([301, 302, 303].includes(response.statusCode)) {
                fileStream.destroy();
                fs.unlink(destPath, () => {});
                return download(response.headers.location, redirectCount + 1);
            }
            if (response.statusCode !== 200) {
                fileStream.destroy();
                fs.unlink(destPath, () => {});
                return res.status(400).json({ error: `Download failed: HTTP ${response.statusCode}` });
            }
            const contentLength = parseInt(response.headers['content-length'] || '0');
            if (contentLength > 0 && contentLength > getQuota().available) {
                fileStream.destroy();
                fs.unlink(destPath, () => {});
                return res.status(507).json({ error: 'Not enough storage space', quota: getQuota() });
            }
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                const stat = fs.statSync(destPath);
                res.json({ success: true, file: { name: filename, path: path.join(folder, filename), size: stat.size, sizeMB: +(stat.size / 1024 / 1024).toFixed(2) }, quota: getQuota() });
            });
            fileStream.on('error', err => { fs.unlink(destPath, () => {}); if (!res.headersSent) res.status(500).json({ error: err.message }); });
        }).on('error', err => { fs.unlink(destPath, () => {}); if (!res.headersSent) res.status(500).json({ error: err.message }); });
    }

    download(url);
});

router.post('/import-folder', express.json(), checkQuota, (req, res) => {
    const { url, destination = '' } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const folderMatch = url.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderMatch) return res.status(400).json({ error: 'URL Google Drive invalide — doit contenir /folders/ID' });

    let destPath;
    try {
        destPath = safePath(destination);
        fs.mkdirSync(destPath, { recursive: true });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const gdown = spawn('/home/clip-worker/venv/bin/python3', [
        '-m', 'gdown',
        '--folder', url, '-O', destPath,
    ], {
        env: {
            ...process.env,
            PATH: `/home/clip-worker/venv/bin:${process.env.PATH}`,
            VIRTUAL_ENV: '/home/clip-worker/venv',
        }
    });

    gdown.stdout.on('data', data => {
        const msg = data.toString().trim();
        if (msg) send({ type: 'log', message: msg });
    });

    gdown.stderr.on('data', data => {
        const msg = data.toString().trim();
        if (msg) send({ type: 'log', message: msg });
    });

    gdown.on('close', code => {
        if (code === 0) {
            send({ type: 'done', quota: getQuota() });
        } else {
            send({ type: 'error', message: `gdown s'est arrêté avec le code ${code}` });
        }
        res.end();
    });

    gdown.on('error', err => {
        send({ type: 'error', message: err.message });
        res.end();
    });

    req.on('close', () => {
        try { gdown.kill(); } catch {}
    });
});

router.get('/file', (req, res) => {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    if (!relPath) return res.status(400).json({ error: 'Missing path' });
    try {
        const fullPath = safePath(relPath);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fullPath)}"`);
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(fullPath).pipe(res);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/preview', (req, res) => {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    if (!relPath) return res.status(400).json({ error: 'Missing path' });
    try {
        const fullPath = safePath(relPath);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });

        const ext = path.extname(fullPath).toLowerCase();
        const mime = mimeMap[ext] || 'application/octet-stream';
        const range = req.headers.range;

        if (range && (mime.startsWith('video/') || mime.startsWith('audio/'))) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = end - start + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': mime,
            });
            fs.createReadStream(fullPath, { start, end }).pipe(res);
        } else {
            res.setHeader('Content-Type', mime);
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Accept-Ranges', 'bytes');
            fs.createReadStream(fullPath).pipe(res);
        }
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/file', (req, res) => {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    if (!relPath) return res.status(400).json({ error: 'Missing path' });
    try {
        const fullPath = safePath(relPath);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
        fs.unlinkSync(fullPath);
        res.json({ success: true, quota: getQuota() });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.patch('/rename', express.json(), (req, res) => {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    const newName = (req.query.name || '').replace(/[^a-zA-Z0-9._\-\s]/g, '_').trim();
    if (!relPath || !newName) return res.status(400).json({ error: 'Missing path or name' });
    try {
        const fullPath = safePath(relPath);
        const newPath = path.join(path.dirname(fullPath), newName);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
        fs.renameSync(fullPath, newPath);
        res.json({ success: true, path: path.join(path.dirname(relPath), newName) });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
