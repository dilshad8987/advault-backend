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

// ─── Email Validators — sirf Gmail allowed ─────────────────────────────────────
// Valid: arsh@gmail.com, arsh63@gmail.com
// Invalid: arsh@yahoo.com, arsh.k@gmail.com, arsh@tempmail.com
function isValidEmail(email) {
  return /^[a-zA-Z0-9]+@gmail\.com$/.test(email?.trim());
}

// isTempEmail — TEMP_DOMAINS list hata di, sirf gmail allowed hai ab
function isTempEmail(email) {
  return !isValidEmail(email);
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
    // Fix 5: Railway/Cloudflare khud 2 IPs add karte hain, isliye threshold >3 rakha
    if (ips.length > 3) return { detected: true, reason: 'Multiple IP chain mili (VPN/proxy chain)' };
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

    const cacheKey    = `${user.firebaseUid}:${fingerprint}`;
    const cachedDevice = getCached(deviceCache, cacheKey, DEVICE_TTL);

    if (!cachedDevice) {
      // Fix 3: user.id virtual .lean() ke saath kaam nahi karta, firebaseUid use karo
      const allowed = await isDeviceAllowed(user.firebaseUid, fingerprint);
      if (!allowed) await registerDevice(user.firebaseUid, fingerprint);
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
