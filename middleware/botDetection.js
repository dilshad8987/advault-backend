// middleware/botDetection.js
// v2 — Maximum strength fingerprinting
// 12 server-side signals + client hardware signals (canvas/webgl/screen/timezone)
// SHA-256 hash — spoof karna practically impossible

const crypto = require('crypto');

const BOT_PATTERNS = [
  /bot/i, /crawler/i, /spider/i, /scraper/i,
  /wget/i, /python-requests/i,
  /postman/i, /insomnia/i, /httpie/i,
  /go-http-client/i, /java\//i, /ruby/i,
  /perl/i, /libwww/i, /scrapy/i,
];

const WHITELIST_AGENTS = [];

function botDetection(req, res, next) {
  if (process.env.BOT_BLOCK_ENABLED !== 'true') return next();
  const userAgent = req.headers['user-agent'] || '';
  if (!userAgent)
    return res.status(403).json({ success: false, message: 'Access denied' });
  if (WHITELIST_AGENTS.some(w => userAgent.includes(w))) return next();
  const isBot = BOT_PATTERNS.some(p => p.test(userAgent));
  if (isBot)
    return res.status(403).json({ success: false, message: 'Access denied' });
  next();
}

// ─── FINGERPRINT v2 ────────────────────────────────────────────────────────────
// Server-side signals (12): immutable browser/OS headers
// Client-side signals (4):  canvas hash, webgl hash, screen, timezone
//   — frontend se x-fp-* headers me aate hain (Auth.jsx me add karna hoga)
//
// Final fingerprint = SHA-256(server_hash + client_hash)
// Har signal alag-alag bhi store hota hai taaki partial match bhi pakad sake

function extractFingerprint(req) {
  // ── Server signals ──────────────────────────────────────────────────────────
  const serverSignals = [
    req.headers['user-agent']          || '',   // Browser + version + OS
    req.headers['accept-language']     || '',   // Browser language (en-US, hi-IN...)
    req.headers['accept-encoding']     || '',   // gzip, br, deflate support
    req.headers['accept']              || '',   // MIME type preferences
    req.headers['sec-ch-ua']           || '',   // Chrome brand + version
    req.headers['sec-ch-ua-platform']  || '',   // "Windows" / "macOS" / "Android"
    req.headers['sec-ch-ua-mobile']    || '',   // "?0" ya "?1"
    req.headers['sec-ch-ua-arch']      || '',   // CPU arch: x86, arm
    req.headers['sec-ch-ua-bitness']   || '',   // "64" ya "32"
    req.headers['sec-fetch-site']      || '',   // cross-site / same-origin
    req.headers['sec-fetch-mode']      || '',   // navigate / cors
    req.headers['connection']          || '',   // keep-alive / close
  ];

  // ── Client hardware signals (frontend se aate hain) ────────────────────────
  const canvasHash  = req.headers['x-fp-canvas']   || '';  // Canvas 2D pixel hash
  const webglHash   = req.headers['x-fp-webgl']    || '';  // WebGL renderer hash
  const screenSig   = req.headers['x-fp-screen']   || '';  // "1920x1080x24"
  const timezoneSig = req.headers['x-fp-tz']       || '';  // "Asia/Kolkata"
  const cpuCores    = req.headers['x-fp-cpu']      || '';  // navigator.hardwareConcurrency
  const memSig      = req.headers['x-fp-mem']      || '';  // navigator.deviceMemory
  const touchSig    = req.headers['x-fp-touch']    || '';  // maxTouchPoints
  const clientId    = req.headers['x-device-id']   || '';  // localStorage UUID

  const clientSignals = [canvasHash, webglHash, screenSig, timezoneSig, cpuCores, memSig, touchSig];

  // ── Hash banao ─────────────────────────────────────────────────────────────
  const serverRaw  = serverSignals.join('|||');
  const clientRaw  = clientSignals.join('|||');
  const serverHash = crypto.createHash('sha256').update(serverRaw).digest('hex').slice(0, 32);
  const clientHash = crypto.createHash('sha256').update(clientRaw).digest('hex').slice(0, 32);

  // Combined fingerprint — dono ka hash
  const combined = crypto.createHash('sha256')
    .update(`${serverHash}|||${clientHash}`)
    .digest('hex')
    .slice(0, 48);

  // ── Metadata — DB me store karne ke liye ───────────────────────────────────
  const meta = {
    serverHash,
    clientHash,
    combined,
    hasClientSignals: clientSignals.some(s => s.length > 0),
    // x-device-id ke saath prefixed fingerprint (most reliable)
    primary: clientId ? `c_${clientId}_${combined}` : `s_${combined}`,
  };

  return meta;
}

// ── Suspicious activity detector ───────────────────────────────────────────────
const requestLog = new Map();

function suspiciousActivityDetector(req, res, next) {
  const ip  = req.ip;
  const now = Date.now();
  const window = 60 * 1000;
  if (!requestLog.has(ip)) {
    requestLog.set(ip, { count: 1, firstSeen: now });
    return next();
  }
  const log = requestLog.get(ip);
  if (now - log.firstSeen > window) {
    requestLog.set(ip, { count: 1, firstSeen: now });
    return next();
  }
  log.count++;
  if (log.count > 200)
    return res.status(429).json({ success: false, message: 'Too many requests.' });
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, log] of requestLog.entries()) {
    if (now - log.firstSeen > 5 * 60 * 1000) requestLog.delete(ip);
  }
}, 5 * 60 * 1000);

module.exports = { botDetection, extractFingerprint, suspiciousActivityDetector };
