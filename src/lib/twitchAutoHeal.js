const { spawn, execFile } = require('child_process');
const fs = require('fs');
const { downloadClipViaGraphQL } = require('./twitchClipResolver');

const PERSISTED_QUERY_ERROR = /PersistedQueryNotFound|KeyError\('data'\)/i;

function runYtDlp(clipSlug, outPath) {
    const args = [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--retries', '10',
        '--fragment-retries', '10',
        '--retry-sleep', '3',
        '-o', outPath,
        '--no-playlist',
        `https://clips.twitch.tv/${clipSlug}`,
    ];
    return new Promise((resolve) => {
        const proc = spawn('yt-dlp', args);
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => resolve({ code, stderr }));
    });
}

function updateYtDlp() {
    return new Promise((resolve) => {
        execFile('yt-dlp', ['-U'], (err, stdout, stderr) => resolve({ stdout, stderr, err }));
    });
}

async function downloadClipWithAutoHeal(clipSlug, outPath) {
    let attempt = await runYtDlp(clipSlug, outPath);
    if (attempt.code === 0 && fs.existsSync(outPath)) {
        return { success: true };
    }

    if (!PERSISTED_QUERY_ERROR.test(attempt.stderr)) {
        return { success: false, error: 'Download failed', stderr: attempt.stderr };
    }

    console.warn('[auto-heal] Twitch persisted query error detected — trying yt-dlp -U');
    await updateYtDlp();

    attempt = await runYtDlp(clipSlug, outPath);
    if (attempt.code === 0 && fs.existsSync(outPath)) {
        console.warn('[auto-heal] Resolved via yt-dlp -U');
        return { success: true, healed: 'update' };
    }

    console.warn('[auto-heal] Still broken after update — trying direct GraphQL resolver');
    try {
        await downloadClipViaGraphQL(clipSlug, outPath);
        if (fs.existsSync(outPath)) {
            console.warn('[auto-heal] Resolved via direct GraphQL resolver');
            return { success: true, healed: 'graphql-fallback' };
        }
        throw new Error('output file missing after download');
    } catch (e) {
        console.error('[auto-heal] GraphQL fallback also failed:', e.message);
        return { success: false, error: 'TWITCH_API_BROKEN', stderr: attempt.stderr, detail: e.message };
    }
}

module.exports = { downloadClipWithAutoHeal };