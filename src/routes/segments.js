const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const { tmpPath, fetchBuffer, streamFile } = require('../lib/fs');
const { getM3u8Url, getSegmentsInRange } = require('../lib/twitch');

const router = express.Router();

function parseTimestamp(ts) {
    if (!ts) return null;
    const match = ts.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, h, m, s] = match.map(Number);
    return h * 3600 + m * 60 + s;
}

router.get('/', async (req, res) => {
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

    const tsPath = tmpPath(`seg_${vodId}`, 'ts');
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
        fs.unlink(tsPath, () => {});
        fs.unlink(mp4Path, () => {});
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

module.exports = router;
