const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const { tmpPath, streamFile } = require('../lib/fs');

const router = express.Router();

function parseCropParam(value) {
    const n = parseFloat(value);
    if (Number.isNaN(n) || n < 0 || n > 1) return null;
    return n;
}

router.get('/:clipSlug/vertical', (req, res) => {
    const { clipSlug } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(clipSlug)) {
        return res.status(400).json({ error: 'Invalid clip slug' });
    }

    const x = parseCropParam(req.query.x);
    const y = parseCropParam(req.query.y);
    const w = parseCropParam(req.query.w);
    const h = parseCropParam(req.query.h);

    if ([x, y, w, h].some(v => v === null) || x + w > 1 || y + h > 1) {
        return res.status(400).json({ error: 'Invalid crop rect' });
    }

    const rawPath = tmpPath(`clip_${clipSlug}_raw`, 'mp4');
    const outPath = tmpPath(`clip_${clipSlug}_vertical`, 'mp4');

    const ytdlp = spawn('yt-dlp', [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--retries', '10',
        '--fragment-retries', '10',
        '--retry-sleep', '3',
        '-o', rawPath,
        '--no-playlist',
        `https://clips.twitch.tv/${clipSlug}`,
    ]);

    ytdlp.on('close', code => {
        if (code !== 0 || !fs.existsSync(rawPath)) {
            return res.status(500).json({ error: 'Download failed' });
        }

        const filter =
            `[0:v]crop=iw*${w}:ih*${h}:iw*${x}:ih*${y},scale=1080:608:force_original_aspect_ratio=increase,crop=1080:608[cam];` +
            `[0:v]scale=1080:1312:force_original_aspect_ratio=increase,crop=1080:1312[game];` +
            `[cam][game]vstack=inputs=2[out]`;

        const ff = spawn('ffmpeg', [
            '-y', '-i', rawPath,
            '-filter_complex', filter,
            '-map', '[out]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-c:a', 'aac',
            outPath,
        ]);

        let stderr = '';
        ff.stderr.on('data', d => { stderr += d.toString(); });

        ff.on('close', ffCode => {
            fs.unlink(rawPath, () => {});
            if (ffCode !== 0 || !fs.existsSync(outPath)) {
                console.error('[vertical ffmpeg error]', stderr.slice(-500));
                return res.status(500).json({ error: 'Export failed' });
            }
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${clipSlug}_vertical.mp4"`);
            streamFile(res, outPath, [outPath]);
        });
    });
});

module.exports = router;