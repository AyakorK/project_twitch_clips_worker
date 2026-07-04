const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { STORAGE_DIR, STORAGE_LIMIT_BYTES, getQuota, safePath, listDir, getDirSizeBytes } = require('../lib/storage');

const router = express.Router();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const folder = req.query.folder || '';
        let destPath;
        try {
            destPath = safePath(folder);
        } catch {
            return cb(new Error('Invalid folder path'));
        }
        fs.mkdirSync(destPath, { recursive: true });
        cb(null, destPath);
    },
    filename: (req, file, cb) => {
        const sanitized = file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_').trim();
        cb(null, sanitized);
    },
});

function checkQuota(req, res, next) {
    const quota = getQuota();
    if (quota.available <= 0) {
        return res.status(507).json({ error: 'Storage full', quota });
    }
    next();
}

const upload = multer({
    storage,
    limits: { fileSize: STORAGE_LIMIT_BYTES },
});

router.get('/quota', (req, res) => {
    res.json(getQuota());
});

router.get('/list', (req, res) => {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    try {
        const result = listDir(relPath);
        const quota = getQuota();
        res.json({ ...result, quota, currentPath: relPath });
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
        if (fs.existsSync(folderPath)) {
            return res.status(409).json({ error: 'Folder already exists' });
        }
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
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }
    const folder = req.query.folder || '';
    const uploaded = req.files.map(f => ({
        name: f.filename,
        path: path.join(folder, f.filename),
        size: f.size,
        sizeMB: +(f.size / 1024 / 1024).toFixed(2),
    }));
    res.json({ success: true, files: uploaded, quota: getQuota() });
});

router.post('/import', checkQuota, express.json(), async (req, res) => {
    let { url, folder = '', filename } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    const gdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (gdMatch) {
        url = `https://drive.google.com/uc?export=download&id=${gdMatch[1]}`;
    }

    if (!filename) {
        filename = decodeURIComponent(url.split('/').pop().split('?')[0]) || `import_${Date.now()}`;
    }
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
            if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303) {
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
            const quota = getQuota();
            if (contentLength > 0 && contentLength > quota.available) {
                fileStream.destroy();
                fs.unlink(destPath, () => {});
                return res.status(507).json({ error: 'Not enough storage space', quota });
            }

            response.pipe(fileStream);
            fileStream.on('finish', () => {
                const stat = fs.statSync(destPath);
                res.json({
                    success: true,
                    file: {
                        name: filename,
                        path: path.join(folder, filename),
                        size: stat.size,
                        sizeMB: +(stat.size / 1024 / 1024).toFixed(2),
                    },
                    quota: getQuota(),
                });
            });
            fileStream.on('error', err => {
                fs.unlink(destPath, () => {});
                if (!res.headersSent) res.status(500).json({ error: err.message });
            });
        }).on('error', err => {
            fs.unlink(destPath, () => {});
            if (!res.headersSent) res.status(500).json({ error: err.message });
        });
    }

    download(url);
});

router.get('/file', (req, res) => {
    const relPath = (req.query.path || '').replace(/^\/+/, '');
    if (!relPath) return res.status(400).json({ error: 'Missing path' });
    try {
        const fullPath = safePath(relPath);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
        const filename = path.basename(fullPath);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(fullPath).pipe(res);
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
        const newRelPath = path.join(path.dirname(relPath), newName);
        res.json({ success: true, path: newRelPath });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;
