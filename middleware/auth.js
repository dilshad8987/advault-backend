const { verifyAccessToken } = require('../utils/jwt');
const { findUserById, isDeviceAllowed } = require('../store/db');
const { extractFingerprint } = require('./botDetection');

// ─── In-Memory Cache ───────────────────────────────────────────────────────────
const userCache = new Map();
const deviceCache = new Map();

const USER_TTL = 5 * 60 * 1000;      // 5 min
const DEVICE_TTL = 10 * 60 * 1000;   // 10 min

function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(cache, key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// Cache clear karo jab user logout/update ho
function invalidateUserCache(userId) {
  userCache.delete(userId);
  // Us user ki saari device entries bhi hatao
  for (const key of deviceCache.keys()) {
    if (key.startsWith(`${userId}:`)) deviceCache.delete(key);
  }
}

// ─── Cached Fetchers ───────────────────────────────────────────────────────────
async function getCachedUser(userId) {
  const cached = getCached(userCache, userId, USER_TTL);
  if (cached) return cached;

  const user = await findUserById(userId);
  if (user) setCache(userCache, userId, user);
  return user;
}

async function getCachedDeviceCheck(userId, fingerprint) {
  const key = `${userId}:${fingerprint}`;
  const cached = getCached(deviceCache, key, DEVICE_TTL);
  if (cached !== null) return cached;

  const allowed = await isDeviceAllowed(userId, fingerprint);
  setCache(deviceCache, key, allowed);
  return allowed;
}

// ─── Main Middleware ───────────────────────────────────────────────────────────
async function protect(req, res, next) {
  try {
    // 1. Header check
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Login karo pehle' });
    }

    // 2. Token verify (sync — no DB call)
    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (!decoded?.id) {
      return res.status(401).json({ success: false, message: 'Token expire ho gaya. Dobara login karo.' });
    }

    // 3. Fingerprint extract karo aur user fetch karo — PARALLEL
    const fingerprint = extractFingerprint(req);
    const user = await getCachedUser(decoded.id);

    if (!user) {
      return res.status(401).json({ success: false, message: 'User nahi mila' });
    }

    // 4. Device check — cached
    const deviceAllowed = await getCachedDeviceCheck(user._id.toString(), fingerprint);
    if (!deviceAllowed) {
      return res.status(403).json({
        success: false,
        message: 'Yeh device registered nahi hai.',
        code: 'DEVICE_NOT_ALLOWED'
      });
    }

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
