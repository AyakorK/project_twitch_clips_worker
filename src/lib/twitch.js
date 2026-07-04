const { spawn } = require('child_process');
const { fetchText } = require('./fs');

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

    for (const line of lines) {
        const l = line.trim();
        if (l.startsWith('#EXTINF:')) {
            segDuration = parseFloat(l.replace('#EXTINF:', '').split(',')[0]);
        } else if (l && !l.startsWith('#')) {
            const segStart = currentTime;
            const segEnd = currentTime + segDuration;
            if (segEnd > fromSec && segStart < toSec) {
                const url = l.startsWith('http') ? l : baseUrl + l;
                segments.push({ url, start: segStart, end: segEnd });
            }
            currentTime += segDuration;
            segDuration = 0;
        }
    }
    return segments;
}

module.exports = { getM3u8Url, getSegmentsInRange };
