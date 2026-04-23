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

  if (!userAgent) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  if (WHITELIST_AGENTS.some(w => userAgent.includes(w))) {
    return next();
  }

  const isBot = BOT_PATTERNS.some(pattern => pattern.test(userAgent));
  if (isBot) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  next();
}

function extractFingerprint(req) {
  const parts = [
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.headers['accept-encoding'] || '',
    req.ip || ''
  ];

  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const clientDeviceId = req.headers['x-device-id'];
  return clientDeviceId
    ? clientDeviceId + '_' + Math.abs(hash)
    : 'server_' + Math.abs(hash);
}

const requestLog = new Map();

function suspiciousActivityDetector(req, res, next) {
  const ip = req.ip;
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

  if (log.count > 200) {
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please slow down.'
    });
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, log] of requestLog.entries()) {
    if (now - log.firstSeen > 5 * 60 * 1000) {
      requestLog.delete(ip);
    }
  }
}, 5 * 60 * 1000);

module.exports = { botDetection, extractFingerprint, suspiciousActivityDetector };
