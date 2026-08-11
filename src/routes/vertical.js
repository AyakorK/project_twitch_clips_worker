const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const { tmpPath, streamFile } = require('../lib/fs');
const { downloadClipWithAutoHeal } = require('../lib/twitchAutoHeal');

const router = express.Router();
const jobs = new Map();

function parseCropParam(value) {
    const n = parseFloat(value);
    if (Number.isNaN(n) || n < 0 || n > 1) return null;
    return n;
}

function cleanupJob(jobId, delayMs = 5 * 60 * 1000) {
    setTimeout(() => {
        const job = jobs.get(jobId);
        if (job?.outPath) fs.unlink(job.outPath, () => {});
        jobs.delete(jobId);
    }, delayMs);
}

router.post('/:clipSlug/vertical/start', express.json(), (req, res) => {
    const { clipSlug } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(clipSlug)) {
        return res.status(400).json({ error: 'Invalid clip slug' });
    }

    const { x, y, w, h, duration } = req.body || {};
    const cx = parseCropParam(x), cy = parseCropParam(y), cw = parseCropParam(w), ch = parseCropParam(h);
    const durationSec = parseFloat(duration);

    if ([cx, cy, cw, ch].some(v => v === null) || cx + cw > 1 || cy + ch > 1) {
        return res.status(400).json({ error: 'Invalid crop rect' });
    }
    if (Number.isNaN(durationSec) || durationSec <= 0) {
        return res.status(400).json({ error: 'Invalid duration' });
    }

    const jobId = crypto.randomUUID();
    const rawPath = tmpPath(`clip_${clipSlug}_raw`, 'mp4');
    const outPath = tmpPath(`clip_${clipSlug}_vertical`, 'mp4');

    jobs.set(jobId, { status: 'downloading', progress: 0, outPath: null, error: null });
    res.json({ jobId });

    (async () => {
        const job = jobs.get(jobId);
        const result = await downloadClipWithAutoHeal(clipSlug, rawPath);

        if (!result.success) {
            console.error('[vertical yt-dlp error]', result.stderr ? result.stderr.slice(-500) : result.detail);
            job.status = 'error';
            job.error = result.error;
            cleanupJob(jobId);
            return;
        }

        if (result.healed) {
            console.warn(`[vertical] auto-heal succeeded via: ${result.healed}`);
        }

        job.status = 'encoding';
        job.progress = 20;

        const filter =
            `[0:v]crop=iw*${cw}:ih*${ch}:iw*${cx}:ih*${cy},scale=720:404:force_original_aspect_ratio=increase,crop=720:404[cam];` +
            `[0:v]scale=720:876:force_original_aspect_ratio=increase,crop=720:876[game];` +
            `[cam][game]vstack=inputs=2[out]`;

        const ff = spawn('ffmpeg', [
            '-y', '-i', rawPath,
            '-filter_complex', filter,
            '-map', '[out]',
            '-map', '0:a?',
            '-r', '30',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-bf', '0',
            '-crf', '25',
            '-c:a', 'aac',
            '-progress', 'pipe:1',
            '-nostats',
            outPath,
        ]);

        let stderr = '';
        ff.stderr.on('data', d => { stderr += d.toString(); });

        ff.stdout.on('data', d => {
            const match = d.toString().match(/out_time_ms=(\d+)/);
            if (match) {
                const outSec = parseInt(match[1], 10) / 1000000;
                const pct = Math.min(99, 20 + Math.round((outSec / durationSec) * 80));
                const j = jobs.get(jobId);
                if (j) j.progress = pct;
            }
        });

        ff.on('close', ffCode => {
            fs.unlink(rawPath, () => {});
            const j = jobs.get(jobId);
            if (!j) return;
            if (ffCode !== 0 || !fs.existsSync(outPath)) {
                console.error('[vertical ffmpeg error]', stderr.slice(-500));
                j.status = 'error';
                j.error = 'Export failed';
                cleanupJob(jobId);
                return;
            }
            j.status = 'done';
            j.progress = 100;
            j.outPath = outPath;
            cleanupJob(jobId);
        });
    })();
});

router.get('/vertical/progress/:jobId', (req, res) => {
    const { jobId } = req.params;
    if (!jobs.has(jobId)) return res.status(404).json({ error: 'Job not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = () => {
        const j = jobs.get(jobId);
        if (!j) {
            res.write(`data: ${JSON.stringify({ status: 'error', error: 'Job expired' })}\n\n`);
            clearInterval(interval);
            return res.end();
        }
        res.write(`data: ${JSON.stringify({ status: j.status, progress: j.progress, error: j.error })}\n\n`);
        if (j.status === 'done' || j.status === 'error') {
            clearInterval(interval);
            res.end();
        }
    };

    const interval = setInterval(send, 400);
    send();
    req.on('close', () => clearInterval(interval));
});

router.get('/vertical/result/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs.get(jobId);
    if (!job || job.status !== 'done' || !job.outPath || !fs.existsSync(job.outPath)) {
        return res.status(404).json({ error: 'Result not ready' });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="clip_vertical.mp4"`);
    streamFile(res, job.outPath, [job.outPath]);
    jobs.delete(jobId);
});

module.exports = router;