// services/r2.js
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

// ─── R2 credentials ──────────────────────────────────────────────────────────
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT   = process.env.R2_ENDPOINT;
const R2_BUCKET     = process.env.R2_BUCKET_NAME || 'advaultmedia';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  forcePathStyle: true,
});

function bufferHash(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

async function r2KeyExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e) {
    return false;
  }
}

async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer,
    ContentType: contentType, CacheControl: 'public, max-age=31536000',
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

function fixImageQualityUrl(url) {
  if (!url) return url;
  return url
    .replace(/stp=dst-jpg_s\d+x\d+/g,  'stp=dst-jpg_s1080x1080')
    .replace(/stp=dst-jpg_p\d+x\d+/g,  'stp=dst-jpg_p1080x1080')
    .replace(/_s60x60/g,   '_s1080x1080')
    .replace(/_s160x160/g, '_s1080x1080')
    .replace(/_s320x320/g, '_s1080x1080')
    .replace(/_s600x600/g, '_s1080x1080')
    .replace(/s60x60/g,    's1080x1080')
    .replace(/p60x60/g,    'p1080x1080')
    .replace(/p160x160/g,  'p1080x1080');
}

function downloadBuffer(url, isVideo) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http')) return resolve(null);
    const fixedUrl = isVideo ? url : fixImageQualityUrl(url);
    const client   = fixedUrl.startsWith('https') ? https : http;
    const maxSize  = isVideo ? 200 * 1024 * 1024 : 15 * 1024 * 1024;

    const req = client.get(fixedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Referer':    'https://www.facebook.com/',
        'Accept':     isVideo ? 'video/*,*/*' : 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: isVideo ? 120000 : 20000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location, isVideo).then(resolve);
      }
      if (res.statusCode !== 200) return resolve(null);
      const ct     = res.headers['content-type'] || (isVideo ? 'video/mp4' : 'image/jpeg');
      const chunks = [];
      let   size   = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxSize) { req.destroy(); resolve(null); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 1000) return resolve(null);
        resolve({ buffer: buf, contentType: ct });
      });
      res.on('error', () => resolve(null));
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// IMAGE: library_id key + hash dedup
async function saveImageToR2(libraryId, imageUrl) {
  try {
    const libKeyJpg = `meta-ads/img/${libraryId}.jpg`;
    const libKeyPng = `meta-ads/img/${libraryId}.png`;
    if (await r2KeyExists(libKeyJpg)) return `${R2_PUBLIC_URL}/${libKeyJpg}`;
    if (await r2KeyExists(libKeyPng)) return `${R2_PUBLIC_URL}/${libKeyPng}`;

    const result = await downloadBuffer(imageUrl, false);
    if (!result) return null;

    const ext      = result.contentType.includes('png') ? 'png' : 'jpg';
    const finalKey = `meta-ads/img/${libraryId}.${ext}`;
    const hash     = bufferHash(result.buffer);
    const hashKey  = `meta-ads/dedup/${hash}.${ext}`;

    if (await r2KeyExists(hashKey)) {
      console.log(`   DEDUP image (${libraryId}) hash:${hash.slice(0,8)}`);
      await uploadToR2(finalKey, result.buffer, result.contentType);
      return `${R2_PUBLIC_URL}/${finalKey}`;
    }

    await Promise.all([
      uploadToR2(finalKey, result.buffer, result.contentType),
      uploadToR2(hashKey,  result.buffer, result.contentType),
    ]);
    console.log(`   OK image (${libraryId})`);
    return `${R2_PUBLIC_URL}/${finalKey}`;
  } catch (err) {
    console.error(`   FAIL image (${libraryId}):`, err.message);
    return null;
  }
}

// VIDEO: library_id key + hash dedup
async function saveVideoToR2(libraryId, videoUrl) {
  try {
    if (!videoUrl) return null;
    const libKey = `meta-ads/vid/${libraryId}.mp4`;
    if (await r2KeyExists(libKey)) return `${R2_PUBLIC_URL}/${libKey}`;

    const result = await downloadBuffer(videoUrl, true);
    if (!result) return null;

    const ct       = result.contentType.includes('video') ? result.contentType : 'video/mp4';
    const hash     = bufferHash(result.buffer);
    const hashKey  = `meta-ads/vdedup/${hash}.mp4`;

    if (await r2KeyExists(hashKey)) {
      console.log(`   DEDUP video (${libraryId}) hash:${hash.slice(0,8)}`);
      await uploadToR2(libKey, result.buffer, ct);
      return `${R2_PUBLIC_URL}/${libKey}`;
    }

    await Promise.all([
      uploadToR2(libKey,  result.buffer, ct),
      uploadToR2(hashKey, result.buffer, ct),
    ]);
    console.log(`   OK video (${libraryId}) size:${(result.buffer.length/1024/1024).toFixed(1)}MB`);
    return `${R2_PUBLIC_URL}/${libKey}`;
  } catch (err) {
    console.error(`   FAIL video (${libraryId}):`, err.message);
    return null;
  }
}

module.exports = { saveImageToR2, saveVideoToR2, uploadToR2, fixImageQualityUrl };
