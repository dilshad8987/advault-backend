// middleware/botDetection.js
// Fix 5: extractFingerprint — weak djb2 hash replaced with crypto SHA-256 + 8 signals
// Pehle: sirf IP + User-Agent pe based 32-bit hash (spoof karna easy)
// Ab: SHA-256 on 8 HTTP headers (spoof karna bahut mushkil)

const crypto = require('crypto');

const BOT_PATTERNS = [
  /bot/i, /crawler/i, /spider/i, /scraper/i,
  /wget/i, /python-requests/i,
  /postman/i, /insomnia/i, /httpie/i,
  /go-http-client/i, /java\//i, /ruby/i,
  /perl/i, /libwww/i, /scrapy/i
];

const WHITELIST_AGENTS = [];

function botDetection(req, res, next) {
  if (process.env.BOT_BLOCK_ENABLED !== 'true') return next();

  const userAgent = req.headers['user-agent'] || '';
  if (!userAgent)
    return res.status(403).json({ success: false, message: 'Access denied' });

  if (WHITELIST_AGENTS.some(w => userAgent.includes(w))) return next();

  const isBot = BOT_PATTERNS.some(pattern => pattern.test(userAgent));
  if (isBot)
    return res.status(403).json({ success: false, message: 'Access denied' });

  next();
}

// Fix 5: SHA-256 hash on 8 signals instead of weak djb2 on 4
function extractFingerprint(req) {
  const signals = [
    req.ip || '',
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.headers['accept-encoding'] || '',
    req.headers['accept'] || '',
    req.headers['sec-ch-ua'] || '',              // Chrome UA hint (OS/browser version)
    req.headers['sec-ch-ua-platform'] || '',     // OS hint (Windows/macOS/Linux)
    req.headers['sec-fetch-site'] || '',         // request origin context
  ];

  const raw  = signals.join('|||');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);

  // x-device-id = client UUID (localStorage pe stored)
  // Server hash ke saath combine — never trusted alone
  const clientDeviceId = req.headers['x-device-id'];
  return clientDeviceId
    ? `client_${clientDeviceId}_${hash}`
    : `server_${hash}`;
}

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
    return res.status(429).json({ success: false, message: 'Too many requests. Please slow down.' });

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, log] of requestLog.entries()) {
    if (now - log.firstSeen > 5 * 60 * 1000) requestLog.delete(ip);
  }
}, 5 * 60 * 1000);

module.exports = { botDetection, extractFingerprint, suspiciousActivityDetector };
