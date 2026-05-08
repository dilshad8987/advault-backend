// services/r2.js
//
// SIMPLE 2-FOLDER SYSTEM:
//   meta-ads/    → images  (meta-ads/LIBRARY_ID.jpg)
//   meta-videos/ → videos  (meta-videos/LIBRARY_ID.mp4)
//
// Koi dedup/, vdedup/, img/, vid/ folder nahi — sab hata diye gaye
// Duplicate detection: Library ID se check — already hai toh skip
//
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const https  = require('https');
const http   = require('http');

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

// ─── R2 Key exist check ───────────────────────────────────────────────────────
async function r2KeyExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e) {
    return false;
  }
}

// ─── Single upload ───────────────────────────────────────────────────────────
async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer,
    ContentType: contentType, CacheControl: 'public, max-age=31536000',
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

// ─── Image URL quality fix (1080x1080) ───────────────────────────────────────
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

// ─── Video URL quality fix (vbr cap hatao) ────────────────────────────────────
function fixVideoQualityUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('vbr')) {
      parsed.searchParams.set('vbr', '0'); // bitrate cap hatao
    }
    return parsed.toString();
  } catch (e) {
    return url;
  }
}

// ─── Download buffer ──────────────────────────────────────────────────────────
function downloadBuffer(url, isVideo) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http')) return resolve(null);
    // Image ke liye 1080p fix, video ke liye vbr fix
    const fixedUrl = isVideo ? fixVideoQualityUrl(url) : fixImageQualityUrl(url);
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

// ─── IMAGE save: meta-ads/LIBRARY_ID.jpg ─────────────────────────────────────
// Already uploaded hai → seedha URL return, download nahi hoga
async function saveImageToR2(libraryId, imageUrl) {
  try {
    // Already uploaded check (library ID se)
    const jpgKey = `meta-ads/${libraryId}.jpg`;
    const pngKey = `meta-ads/${libraryId}.png`;
    if (await r2KeyExists(jpgKey)) return `${R2_PUBLIC_URL}/${jpgKey}`;
    if (await r2KeyExists(pngKey)) return `${R2_PUBLIC_URL}/${pngKey}`;

    // Download (1080p quality URL se)
    const result = await downloadBuffer(imageUrl, false);
    if (!result) return null;

    // Sirf EK jagah upload — meta-ads/ folder mein
    const ext      = result.contentType.includes('png') ? 'png' : 'jpg';
    const finalKey = `meta-ads/${libraryId}.${ext}`;
    const url      = await uploadToR2(finalKey, result.buffer, result.contentType);
    console.log(`   ✅ Image uploaded: ${libraryId}`);
    return url;
  } catch (err) {
    console.error(`   ❌ Image upload fail (${libraryId}):`, err.message);
    return null;
  }
}

// ─── VIDEO save: meta-videos/LIBRARY_ID.mp4 ──────────────────────────────────
// Already uploaded hai → seedha URL return, download nahi hoga
async function saveVideoToR2(libraryId, videoUrl) {
  try {
    if (!videoUrl) return null;

    // Already uploaded check (library ID se)
    const videoKey = `meta-videos/${libraryId}.mp4`;
    if (await r2KeyExists(videoKey)) {
      console.log(`   ✓ Video already uploaded: ${libraryId}`);
      return `${R2_PUBLIC_URL}/${videoKey}`;
    }

    // Download (best quality URL se)
    const result = await downloadBuffer(videoUrl, true);
    if (!result) return null;

    // Sirf EK jagah upload — meta-videos/ folder mein
    const ct  = result.contentType.includes('video') ? result.contentType : 'video/mp4';
    const url = await uploadToR2(videoKey, result.buffer, ct);
    console.log(`   📹 Video uploaded: ${libraryId} (${(result.buffer.length/1024/1024).toFixed(1)}MB)`);
    return url;
  } catch (err) {
    console.error(`   ❌ Video upload fail (${libraryId}):`, err.message);
    return null;
  }
}

module.exports = { saveImageToR2, saveVideoToR2, uploadToR2, fixImageQualityUrl };
