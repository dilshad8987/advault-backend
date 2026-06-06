// middleware/auth.js
// UPDATED: validateStrongPassword, isTempEmail, detectVPN, isValidEmail
// Exports for routes/auth.js

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
    return { valid: false, message: 'Password is required.' };
  if (password.length < 8)
    return { valid: false, message: 'Min 8 characters.' };
  if (!/[A-Z]/.test(password))
    return { valid: false, message: 'Add an uppercase letter.' };
  if (!/[a-z]/.test(password))
    return { valid: false, message: 'Add a lowercase letter.' };
  if (!/\d/.test(password))
    return { valid: false, message: 'Add a number.' };
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password))
    return { valid: false, message: 'Add a special character.' };
  return { valid: true };
}

// ─── Email Validators — sirf Gmail allowed ─────────────────────────────────────
// Valid: arsh@gmail.com, arsh63@gmail.com
// Invalid: arsh@yahoo.com, arsh.k@gmail.com, arsh@tempmail.com
function isValidEmail(email) {
  return /^[a-zA-Z0-9]+@gmail\.com$/.test(email?.trim());
}

// isTempEmail — only Gmail allowed now
function isTempEmail(email) {
  return !isValidEmail(email);
}

// ─── Fix 4: VPN / Proxy Detection ─────────────────────────────────────────────
function detectVPN(req) {
  const via     = req.headers['via'];
  const proxyId = req.headers['x-proxy-id'];
  if (via)     return { detected: true, reason: 'HTTP proxy detected.' };
  if (proxyId) return { detected: true, reason: 'Proxy detected.' };

  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map(ip => ip.trim());
    // Railway/Cloudflare add extra IPs, threshold >3
    if (ips.length > 3) return { detected: true, reason: 'VPN/proxy chain detected.' };
  }

  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const vpnAgents = ['nordvpn','expressvpn','surfshark','protonvpn','cyberghost','ipvanish','purevpn'];
  if (vpnAgents.some(v => ua.includes(v)))
    return { detected: true, reason: 'VPN client detected.' };

  return { detected: false };
}

// ─── Main Auth Middleware ──────────────────────────────────────────────────────
async function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const token   = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (!decoded?.id)
      return res.status(401).json({ success: false, message: 'Session expired.' });

    const fingerprint = extractFingerprint(req);
    const user        = await getCachedUser(decoded.id);
    if (!user)
      return res.status(401).json({ success: false, message: 'User not found.' });

    const cacheKey    = `${user.firebaseUid}:${fingerprint}`;
    const cachedDevice = getCached(deviceCache, cacheKey, DEVICE_TTL);

    if (!cachedDevice) {
      // user.id virtual fails with .lean(), use firebaseUid
      const allowed = await isDeviceAllowed(user.firebaseUid, fingerprint);
      if (!allowed) await registerDevice(user.firebaseUid, fingerprint);
      setCache(deviceCache, cacheKey, true);
    }

    req.user        = user;
    req.fingerprint = fingerprint;
    next();
  } catch (err) {
    console.error('[Auth] protect error:', err.message);
    return res.status(401).json({ success: false, message: 'Authentication failed.' });
  }
}

// ─── Plan Guards ───────────────────────────────────────────────────────────────
function requirePro(req, res, next) {
  if (req.user.plan === 'free')
    return res.status(403).json({ success: false, message: 'Pro plan required.', upgrade: true });
  next();
}

function requireAgency(req, res, next) {
  if (req.user.plan !== 'agency')
    return res.status(403).json({ success: false, message: 'Agency plan required.', upgrade: true });
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
