const { spawn, execFile } = require('child_process');
const fs = require('fs');

const OVERRIDE_PATH = process.env.TWITCH_HASH_OVERRIDE_PATH || '/home/clip-worker/twitch-hash-override.json';
const YTDLP_TWITCH_EXTRACTOR = process.env.YTDLP_TWITCH_EXTRACTOR_PATH || '/usr/local/bin/yt-dlp/yt_dlp/extractor/twitch.py';

const PERSISTED_QUERY_ERROR = /PersistedQueryNotFound|KeyError\('data'\)/i;

function loadOverride() {
    try {
        return JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function runYtDlp(args) {
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

function applyHashOverride() {
    const override = loadOverride();
    if (!override || !override.ShareClipRenderStatus) {
        return { applied: false, reason: 'no override configured at ' + OVERRIDE_PATH };
    }

    let content;
    try {
        content = fs.readFileSync(YTDLP_TWITCH_EXTRACTOR, 'utf8');
    } catch (e) {
        return { applied: false, reason: `cannot read extractor file: ${e.message}` };
    }

    if (content.includes(override.ShareClipRenderStatus)) {
        return { applied: false, reason: 'override hash already present, but still failing — hash may itself be stale' };
    }

    const knownOldHashes = override.knownOldHashes || [];
    let patched = content;
    let changed = false;

    for (const oldHash of knownOldHashes) {
        if (patched.includes(oldHash)) {
            patched = patched.split(oldHash).join(override.ShareClipRenderStatus);
            changed = true;
        }
    }

    if (!changed) {
        return { applied: false, reason: 'no known old hash found in extractor file — needs manual check' };
    }

    fs.writeFileSync(YTDLP_TWITCH_EXTRACTOR, patched, 'utf8');
    return { applied: true };
}

async function downloadClipWithAutoHeal(clipSlug, outPath) {
    const baseArgs = [
        '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--retries', '10',
        '--fragment-retries', '10',
        '--retry-sleep', '3',
        '-o', outPath,
        '--no-playlist',
        `https://clips.twitch.tv/${clipSlug}`,
    ];

    let attempt = await runYtDlp(baseArgs);
    if (attempt.code === 0 && fs.existsSync(outPath)) {
        return { success: true };
    }

    if (!PERSISTED_QUERY_ERROR.test(attempt.stderr)) {
        return { success: false, error: 'Download failed', stderr: attempt.stderr };
    }

    console.warn('[auto-heal] Twitch persisted query error detected — trying yt-dlp -U');
    await updateYtDlp();

    attempt = await runYtDlp(baseArgs);
    if (attempt.code === 0 && fs.existsSync(outPath)) {
        console.warn('[auto-heal] Resolved via yt-dlp -U');
        return { success: true, healed: 'update' };
    }

    if (!PERSISTED_QUERY_ERROR.test(attempt.stderr)) {
        return { success: false, error: 'Download failed', stderr: attempt.stderr };
    }

    console.warn('[auto-heal] Still broken after update — trying hash override');
    const patch = applyHashOverride();
    if (!patch.applied) {
        console.error('[auto-heal] Could not apply hash override:', patch.reason);
        return { success: false, error: 'TWITCH_API_BROKEN', stderr: attempt.stderr, detail: patch.reason };
    }

    attempt = await runYtDlp(baseArgs);
    if (attempt.code === 0 && fs.existsSync(outPath)) {
        console.warn('[auto-heal] Resolved via hash override patch');
        return { success: true, healed: 'hash-override' };
    }

    return { success: false, error: 'TWITCH_API_BROKEN', stderr: attempt.stderr };
}

module.exports = { downloadClipWithAutoHeal };
