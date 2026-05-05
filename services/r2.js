// services/r2.js
// Cloudflare R2 — images permanently store karo
// AWS SDK use karta hai (manual signing nahi)

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const http  = require('http');

// R2 Config
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID     || 'cfat_SZOb5ZnYbSivmXG4vSzP9kTCVjOop7KKhkkcM6NJe408d8ec';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '2d8f79f1ff50e293d86ce775b545eefbb71cf9473a855840125b6c8a3c3c09a7';
const R2_ENDPOINT   = process.env.R2_ENDPOINT          || 'https://cba0322ebe41f069531f19935bb88974.r2.cloudflarestorage.com';
const R2_BUCKET     = process.env.R2_BUCKET_NAME       || 'advaultmedia';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL        || 'https://cba0322ebe41f069531f19935bb88974.r2.cloudflarestorage.com/advaultmedia';

// S3 Client (R2 compatible)
const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  forcePathStyle: true,
});

// R2 mein upload karo
async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket:       R2_BUCKET,
    Key:          key,
    Body:         buffer,
    ContentType:  contentType,
    CacheControl: 'public, max-age=31536000',
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

// Facebook CDN se download karo
function downloadBuffer(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http')) return resolve(null);

    const fixedUrl = url
      .replace('s60x60', 's600x600')
      .replace('dst-jpg_s60x60', 'dst-jpg_s600x600')
      .replace('_s60x60', '_s600x600')
      .replace('p60x60', 'p600x600');

    const client = fixedUrl.startsWith('https') ? https : http;
    const req = client.get(fixedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Referer':    'https://www.facebook.com/',
        'Accept':     'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve);
      }
      if (res.statusCode !== 200) return resolve(null);
      const contentType = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 8 * 1024 * 1024) return resolve(null);
        resolve({ buffer, contentType });
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Main: image URL → R2 permanent URL
async function saveImageToR2(libraryId, imageUrl) {
  try {
    if (!imageUrl) return null;
    const ext = imageUrl.includes('.png') ? 'png' : 'jpg';
    const key = `meta-ads/${libraryId}.${ext}`;
    const result = await downloadBuffer(imageUrl);
    if (!result) return null;
    const r2Url = await uploadToR2(key, result.buffer, result.contentType);
    console.log(`   📸 R2 saved: ${libraryId} (${Math.round(result.buffer.length / 1024)}KB)`);
    return r2Url;
  } catch (err) {
    console.error(`   ✗ R2 fail (${libraryId}):`, err.message);
    return null;
  }
}

module.exports = { saveImageToR2, uploadToR2 };
