// services/r2.js
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const http  = require('http');

// ─── R2 credentials — Railway env vars se load karo ─────────────────────────
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT   = process.env.R2_ENDPOINT;
const R2_BUCKET     = process.env.R2_BUCKET_NAME     || 'advaultmedia';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
  forcePathStyle: true,
});

async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: buffer,
    ContentType: contentType, CacheControl: 'public, max-age=31536000',
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

function downloadImage(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith('http')) return resolve(null);
    const fixedUrl = url
      .replace('s60x60','s600x600').replace('dst-jpg_s60x60','dst-jpg_s600x600')
      .replace('_s60x60','_s600x600').replace('p60x60','p600x600');
    const client = fixedUrl.startsWith('https') ? https : http;
    const req = client.get(fixedUrl, {
      headers: { 'User-Agent':'Mozilla/5.0','Referer':'https://www.facebook.com/','Accept':'image/*' },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return downloadImage(res.headers.location).then(resolve);
      if (res.statusCode !== 200) return resolve(null);
      const ct = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length > 8*1024*1024) return resolve(null);
        resolve({ buffer: buf, contentType: ct });
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function saveImageToR2(libraryId, imageUrl) {
  try {
    const result = await downloadImage(imageUrl);
    if (!result) return null;
    const ext = result.contentType.includes('png') ? 'png' : 'jpg';
    const key = `meta-ads/${libraryId}.${ext}`;
    const r2Url = await uploadToR2(key, result.buffer, result.contentType);
    return r2Url;
  } catch (err) {
    console.error(`   ✗ R2 fail (${libraryId}):`, err.message);
    return null;
  }
}

module.exports = { saveImageToR2, uploadToR2 };
