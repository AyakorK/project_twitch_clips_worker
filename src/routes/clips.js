const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const { tmpPath, streamFile } = require('../lib/fs');

const router = express.Router();

router.get('/:clipSlug', (req, res) => {
    const { clipSlug } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(clipSlug)) {
        return res.status(400).json({ error: 'Invalid clip slug' });
    }

    const outPath = tmpPath(`clip_${clipSlug}`, 'mp4');

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

    ytdlp.on('close', code => {
        if (code !== 0 || !fs.existsSync(outPath)) {
            return res.status(500).json({ error: 'Download failed' });
        }
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${clipSlug}.mp4"`);
        streamFile(res, outPath, [outPath]);
    });
});

module.exports = router;
