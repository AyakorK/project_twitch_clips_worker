const https = require('https');
const fs = require('fs');

const CLIENT_ID = process.env.TWITCH_WEB_CLIENT_ID || 'ue6666qo983tsx6so1t0vnawi233wa';
const VIDEO_ACCESS_TOKEN_HASH = process.env.TWITCH_CLIP_ACCESS_TOKEN_HASH || '4f35f1ac933d76b1da008c806cd5546a7534dfaff83e033a422a81f24e5991b3';

function gqlRequest(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request({
            hostname: 'gql.twitch.tv',
            path: '/gql',
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Client-Id': CLIENT_ID,
                'Content-Length': Buffer.byteLength(data),
            },
        }, res => {
            let chunks = '';
            res.on('data', d => { chunks += d; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(chunks));
                } catch (e) {
                    reject(new Error('Invalid GraphQL response: ' + e.message));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function resolveClipVideoUrl(clipSlug) {
    const body = [{
        operationName: 'VideoAccessToken_Clip',
        variables: { platform: 'web', slug: clipSlug },
        extensions: {
            persistedQuery: { version: 1, sha256Hash: VIDEO_ACCESS_TOKEN_HASH },
        },
    }];

    const result = await gqlRequest(body);
    const clip = result?.[0]?.data?.clip;
    if (!clip) {
        const err = result?.[0]?.errors?.[0]?.message || 'no clip data in response';
        throw new Error(`GraphQL resolve failed: ${err}`);
    }

    const token = clip.playbackAccessToken;
    if (!token?.signature || !token?.value) {
        throw new Error('no playbackAccessToken in clip response');
    }

    const qualities = clip.videoQualities || [];
    if (qualities.length === 0) {
        throw new Error('no video qualities in clip response');
    }

    const best = qualities.reduce((a, b) =>
        (parseInt(b.quality, 10) || 0) > (parseInt(a.quality, 10) || 0) ? b : a
    );

    const authorizedUrl =
        `${best.sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`;

    return authorizedUrl;
}

function downloadFile(url, outPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(outPath);
        https.get(url, res => {
            if (res.statusCode !== 200) {
                file.close();
                fs.unlink(outPath, () => {});
                return reject(new Error(`HTTP ${res.statusCode} downloading clip video`));
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', err => {
            file.close();
            fs.unlink(outPath, () => {});
            reject(err);
        });
    });
}

async function downloadClipViaGraphQL(clipSlug, outPath) {
    const videoUrl = await resolveClipVideoUrl(clipSlug);
    await downloadFile(videoUrl, outPath);
}

module.exports = { downloadClipViaGraphQL, resolveClipVideoUrl };
