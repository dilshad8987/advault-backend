// services/r2.js
// Cloudflare R2 — images/videos permanently store karo
// AWS S3 compatible API use karta hai

const https = require('https');
const http  = require('http');
const crypto = require('crypto');

// ─── R2 Config (Railway env vars se) ─────────────────────────────────────────
const R2_ACCOUNT_ID      = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID   = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY      = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET          = process.env.R2_BUCKET_NAME || 'advault-media';
const R2_ENDPOINT        = process.env.R2_ENDPOINT; // https://ACCOUNTID.r2.cloudflarestorage.com
const R2_PUBLIC_URL      = process.env.R2_PUBLIC_URL || ''; // optional public domain

// ─── AWS Signature V4 (R2 iske saath kaam karta hai) ─────────────────────────
function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function getSigningKey(dateStamp, region, service) {
  const kDate    = hmac('AWS4' + R2_SECRET_KEY, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function signRequest({ method, path, query = '', headers, body, date }) {
  const region  = 'auto';
  const service = 's3';
  const dateStamp   = date.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDateTime = date.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';

  const canonicalHeaders = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => k.toLowerCase() + ':' + v.trim())
    .join('\n') + '\n';

  const signedHeaders = Object.keys(headers)
    .sort()
    .map(k => k.toLowerCase())
    .join(';');

  const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDateTime,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = getSigningKey(dateStamp, region, service);
  const signature  = hmac(signingKey, stringToSign, 'hex');

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDateTime,
    payloadHash,
  };
}

// ─── R2 mein file upload karo ─────────────────────────────────────────────────
async function uploadToR2(key, buffer, contentType) {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY) {
    throw new Error('R2 credentials missing — .env check karo');
  }

  const endpointUrl = new URL(R2_ENDPOINT);
  const host        = endpointUrl.host;
  const date        = new Date();

  const headers = {
    'Host':           host,
    'Content-Type':   contentType,
    'Content-Length': String(buffer.length),
  };

  const path = `/${R2_BUCKET}/${key}`;

  const { authorization, amzDateTime, payloadHash } = signRequest({
    method: 'PUT',
    path,
    headers: { ...headers, 'x-amz-date': date.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z' },
    body: buffer,
    date,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path,
      method:  'PUT',
      headers: {
        ...headers,
        'Authorization':    authorization,
        'x-amz-date':       amzDateTime,
        'x-amz-content-sha256': payloadHash,
        'Cache-Control':    'public, max-age=31536000', // 1 saal
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(getPublicUrl(key));
        } else {
          reject(new Error(`R2 upload fail: ${res.statusCode} — ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// ─── R2 public URL banao ─────────────────────────────────────────────────────
function getPublicUrl(key) {
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
  }
  // Default: endpoint URL se serve
  return `${R2_ENDPOINT.replace(/\/$/, '')}/${R2_BUCKET}/${key}`;
}

// ─── Facebook CDN se image download karke R2 mein upload karo ────────────────
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    if (!url || !url.startsWith('http')) return resolve(null);

    // High quality URL
    const fixedUrl = url
      .replace('s60x60', 's600x600')
      .replace('dst-jpg_s60x60', 'dst-jpg_s600x600')
      .replace('_s60x60', '_s600x600')
      .replace('p60x60', 'p600x600');

    const client = fixedUrl.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Referer':    'https://www.facebook.com/',
        'Accept':     'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: 15000,
    };

    const req = client.get(fixedUrl, options, (res) => {
      // Redirect handle karo
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return resolve(null);

      const contentType = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 8 * 1024 * 1024) return resolve(null); // 8MB limit
        resolve({ buffer, contentType });
      });
      res.on('error', () => resolve(null));
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── Main function — image URL leke R2 URL return karo ───────────────────────
async function saveImageToR2(libraryId, imageUrl) {
  try {
    if (!imageUrl) return null;

    // Unique key — library_id se
    const ext = imageUrl.includes('.png') ? 'png' : 'jpg';
    const key = `meta-ads/${libraryId}.${ext}`;

    // Download karo
    const result = await downloadBuffer(imageUrl);
    if (!result) return null;

    // R2 mein upload karo
    const r2Url = await uploadToR2(key, result.buffer, result.contentType);
    console.log(`   ✓ R2 image saved: ${libraryId} (${Math.round(result.buffer.length / 1024)}KB)`);
    return r2Url;

  } catch (err) {
    console.error(`   ✗ R2 upload fail (${libraryId}):`, err.message);
    return null;
  }
}

module.exports = { saveImageToR2, uploadToR2, getPublicUrl };
