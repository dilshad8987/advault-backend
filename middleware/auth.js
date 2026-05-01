// middleware/auth.js
// UPDATED: validateStrongPassword, isTempEmail, detectVPN, isValidEmail
// yahan se export hoti hain taaki routes/auth.js import kar sake

const { verifyAccessToken } = require('../utils/jwt');
const { findUserById, isDeviceAllowed, registerDevice } = require('../store/db');
const { extractFingerprint } = require('./botDetection');

// ─── In-Memory Cache ───────────────────────────────────────────────────────────
const userCache   = new Map();
const deviceCache = new Map();
const USER_TTL    = 5  * 60 * 1000;
const DEVICE_TTL  = 10 * 60 * 1000;

function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { cache.delete(key); return null; }
  return entry.value;
}
function setCache(cache, key, value) {
  cache.set(key, { value, ts: Date.now() });
}
function invalidateUserCache(userId) {
  userCache.delete(userId);
  for (const key of deviceCache.keys()) {
    if (key.startsWith(`${userId}:`)) deviceCache.delete(key);
  }
}
async function getCachedUser(userId) {
  const cached = getCached(userCache, userId, USER_TTL);
  if (cached) return cached;
  const user = await findUserById(userId);
  if (user) setCache(userCache, userId, user);
  return user;
}

// ─── Fix 2: Strong Password Validator ─────────────────────────────────────────
// Rules: min 8 chars, uppercase, lowercase, number, special char
function validateStrongPassword(password) {
  if (!password || typeof password !== 'string')
    return { valid: false, message: 'Password daalna zaroori hai.' };
  if (password.length < 8)
    return { valid: false, message: 'Password kam se kam 8 characters ka hona chahiye.' };
  if (!/[A-Z]/.test(password))
    return { valid: false, message: 'Password mein kam se kam 1 uppercase letter hona chahiye (A-Z).' };
  if (!/[a-z]/.test(password))
    return { valid: false, message: 'Password mein kam se kam 1 lowercase letter hona chahiye (a-z).' };
  if (!/\d/.test(password))
    return { valid: false, message: 'Password mein kam se kam 1 number hona chahiye (0-9).' };
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password))
    return { valid: false, message: 'Password mein kam se kam 1 special character hona chahiye (!@#$%^&* etc).' };
  return { valid: true };
}

// ─── Fix 3: Email Validators ───────────────────────────────────────────────────
function isValidEmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email);
}

const TEMP_EMAIL_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','tempmail.com','throwam.com',
  'yopmail.com','sharklasers.com','guerrillamailblock.com','grr.la',
  'guerrillamail.info','guerrillamail.biz','guerrillamail.de','guerrillamail.net',
  'guerrillamail.org','spam4.me','trashmail.com','trashmail.me','trashmail.net',
  'trashmail.at','trashmail.io','trashmail.org','trashmail.xyz',
  'dispostable.com','mailnull.com','maildrop.cc','spamgourmet.com',
  'fakeinbox.com','mailnesia.com','discard.email','discardmail.com',
  'temp-mail.org','temp-mail.io','tempinbox.com','10minutemail.com',
  '10minutemail.net','emailondeck.com','getairmail.com','mohmal.com',
  'mytempemail.com','put2.net','spam.la','spamfree24.org','spamhole.com',
  'spaml.de','spaml.com','tempail.com','tempalias.com','tempr.email',
  'throwam.com','trash-mail.com','trashdevil.com','trashdevil.de',
  'wegwerfmail.de','wegwerfmail.net','wegwerfmail.org','whyspam.me',
  'yopmail.fr','yopmail.pp.ua','luxusmail.org','junkmail.gq',
  'spamcorpse.com','spamspot.com','burnermail.io','harakirimail.com',
  'throwaway.email','owlpic.com','drdrb.net','drdrb.com',
]);

function isTempEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return true;
  return TEMP_EMAIL_DOMAINS.has(domain);
}

// ─── Fix 4: VPN / Proxy Detection ─────────────────────────────────────────────
function detectVPN(req) {
  const via     = req.headers['via'];
  const proxyId = req.headers['x-proxy-id'];
  if (via)     return { detected: true, reason: 'HTTP Proxy header mila (Via)' };
  if (proxyId) return { detected: true, reason: 'Proxy ID header mila' };

  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map(ip => ip.trim());
    if (ips.length > 2) return { detected: true, reason: 'Multiple IP chain mili (VPN/proxy chain)' };
  }

  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const vpnAgents = ['nordvpn','expressvpn','surfshark','protonvpn','cyberghost','ipvanish','purevpn'];
  if (vpnAgents.some(v => ua.includes(v)))
    return { detected: true, reason: 'VPN client user-agent detect hua' };

  return { detected: false };
}

// ─── Main Auth Middleware ──────────────────────────────────────────────────────
async function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'Login karo pehle' });

    const token   = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (!decoded?.id)
      return res.status(401).json({ success: false, message: 'Token expire ho gaya. Dobara login karo.' });

    const fingerprint = extractFingerprint(req);
    const user        = await getCachedUser(decoded.id);
    if (!user)
      return res.status(401).json({ success: false, message: 'User nahi mila' });

    const cacheKey    = `${user.id}:${fingerprint}`;
    const cachedDevice = getCached(deviceCache, cacheKey, DEVICE_TTL);

    if (!cachedDevice) {
      const allowed = isDeviceAllowed(user.id, fingerprint);
      if (!allowed) registerDevice(user.id, fingerprint);
      setCache(deviceCache, cacheKey, true);
    }

    req.user        = user;
    req.fingerprint = fingerprint;
    next();
  } catch (err) {
    console.error('[Auth] protect error:', err.message);
    return res.status(401).json({ success: false, message: 'Authentication fail' });
  }
}

// ─── Plan Guards ───────────────────────────────────────────────────────────────
function requirePro(req, res, next) {
  if (req.user.plan === 'free')
    return res.status(403).json({ success: false, message: 'Pro plan chahiye', upgrade: true });
  next();
}

function requireAgency(req, res, next) {
  if (req.user.plan !== 'agency')
    return res.status(403).json({ success: false, message: 'Agency plan chahiye', upgrade: true });
  next();
}

module.exports = {
  protect,
  requirePro,
  requireAgency,
  invalidateUserCache,
  // Exported for routes/auth.js use
  validateStrongPassword,
  isValidEmail,
  isTempEmail,
  detectVPN,
};
