const { verifyAccessToken } = require('../utils/jwt');
const { findUserById, isDeviceAllowed, registerDevice } = require('../store/db');
const { extractFingerprint } = require('./botDetection');

// ─── In-Memory Cache ───────────────────────────────────────────────────────────
const userCache = new Map();
const deviceCache = new Map();
const USER_TTL   = 5  * 60 * 1000;
const DEVICE_TTL = 10 * 60 * 1000;

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

// ─── Main Middleware ───────────────────────────────────────────────────────────
async function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Login karo pehle' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (!decoded?.id) {
      return res.status(401).json({ success: false, message: 'Token expire ho gaya. Dobara login karo.' });
    }

    const fingerprint = extractFingerprint(req);
    const user = await getCachedUser(decoded.id);

    if (!user) {
      return res.status(401).json({ success: false, message: 'User nahi mila' });
    }

    // ─── Device Check — Self-Healing ──────────────────────────────────────────
    // Server restart pe deviceSessions wipe ho jaata hai.
    // Agar valid token hai toh user already authenticated hai —
    // device silently re-register kar do taaki 403 na aaye.
    const cacheKey = `${user.id}:${fingerprint}`;
    const cachedDevice = getCached(deviceCache, cacheKey, DEVICE_TTL);

    if (!cachedDevice) {
      const allowed = isDeviceAllowed(user.id, fingerprint);
      if (!allowed) {
        // Token valid hai — device sirf server restart ki wajah se missing hai, re-register karo
        registerDevice(user.id, fingerprint);
      }
      setCache(deviceCache, cacheKey, true);
    }
    // ─────────────────────────────────────────────────────────────────────────

    req.user = user;
    req.fingerprint = fingerprint;
    next();

  } catch (err) {
    console.error('[Auth] protect error:', err.message);
    return res.status(401).json({ success: false, message: 'Authentication fail' });
  }
}

// ─── Plan Guards ───────────────────────────────────────────────────────────────
function requirePro(req, res, next) {
  if (req.user.plan === 'free') {
    return res.status(403).json({ success: false, message: 'Pro plan chahiye', upgrade: true });
  }
  next();
}

function requireAgency(req, res, next) {
  if (req.user.plan !== 'agency') {
    return res.status(403).json({ success: false, message: 'Agency plan chahiye', upgrade: true });
  }
  next();
}

module.exports = { protect, requirePro, requireAgency, invalidateUserCache };
