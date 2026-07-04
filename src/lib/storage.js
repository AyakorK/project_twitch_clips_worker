const fs = require('fs');
const path = require('path');

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '../../storage');
const META_PATH = path.join(STORAGE_DIR, '.meta.json');
const STORAGE_LIMIT_BYTES = parseInt(process.env.STORAGE_LIMIT_MB || '15000') * 1024 * 1024;

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

function readMeta() {
    try {
        return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    } catch {
        return { files: {}, folders: {} };
    }
}

function writeMeta(meta) {
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
}

function getDirSizeBytes(dirPath) {
    let total = 0;
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            total += getDirSizeBytes(full);
        } else {
            try { total += fs.statSync(full).size; } catch {}
        }
    }
    return total;
}

function getQuota() {
    const used = getDirSizeBytes(STORAGE_DIR);
    return {
        used,
        limit: STORAGE_LIMIT_BYTES,
        available: Math.max(0, STORAGE_LIMIT_BYTES - used),
        usedMB: Math.round(used / 1024 / 1024),
        limitMB: Math.round(STORAGE_LIMIT_BYTES / 1024 / 1024),
        availableMB: Math.round(Math.max(0, STORAGE_LIMIT_BYTES - used) / 1024 / 1024),
        percentUsed: Math.round((used / STORAGE_LIMIT_BYTES) * 100),
    };
}

function safePath(...parts) {
    const joined = path.join(STORAGE_DIR, ...parts);
    const resolved = path.resolve(joined);
    if (!resolved.startsWith(path.resolve(STORAGE_DIR))) {
        throw new Error('Path traversal detected');
    }
    return resolved;
}

function listDir(relPath = '') {
    const dirPath = safePath(relPath);
    if (!fs.existsSync(dirPath)) return { folders: [], files: [] };

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const folders = [];
    const files = [];

    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const entryRelPath = path.join(relPath, entry.name);
        const entryFullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            const size = getDirSizeBytes(entryFullPath);
            folders.push({ name: entry.name, path: entryRelPath, size, sizeMB: Math.round(size / 1024 / 1024) });
        } else {
            let size = 0;
            let mtime = null;
            try { const stat = fs.statSync(entryFullPath); size = stat.size; mtime = stat.mtime; } catch {}
            files.push({
                name: entry.name,
                path: entryRelPath,
                size,
                sizeMB: +(size / 1024 / 1024).toFixed(2),
                mtime,
                ext: path.extname(entry.name).toLowerCase(),
            });
        }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    return { folders, files };
}

module.exports = {
    STORAGE_DIR,
    STORAGE_LIMIT_BYTES,
    readMeta, writeMeta,
    getQuota, safePath, listDir,
    getDirSizeBytes,
};
