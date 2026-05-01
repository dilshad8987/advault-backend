const admin = require('../utils/firebase');

// ─── Shared Device Sessions (auth route + middleware dono use karte hain) ──────
const deviceSessions = new Map();
const refreshTokens = new Map();

// ─── User Fetching ─────────────────────────────────────────────────────────────
async function findUserById(userId) {
  try {
    const doc = await admin.firestore().collection('users').doc(userId).get();
    if (!doc.exists) return null;
    return { ...doc.data(), id: doc.id };
  } catch (err) {
    console.error('[DB] findUserById error:', err.message);
    return null;
  }
}

async function findUserByEmail(email) {
  try {
    const snap = await admin.firestore()
      .collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { ...doc.data(), id: doc.id };
  } catch (err) {
    console.error('[DB] findUserByEmail error:', err.message);
    return null;
  }
}

async function updateUser(userId, updates) {
  try {
    await admin.firestore().collection('users').doc(userId).update({
      ...updates,
      updatedAt: new Date().toISOString()
    });
    return true;
  } catch (err) {
    console.error('[DB] updateUser error:', err.message);
    return false;
  }
}

// ─── Device Session Helpers ────────────────────────────────────────────────────
function registerDevice(userId, fingerprint) {
  if (!deviceSessions.has(userId)) {
    deviceSessions.set(userId, new Set());
  }
  deviceSessions.get(userId).add(fingerprint);
}

function isDeviceAllowed(userId, fingerprint) {
  const devices = deviceSessions.get(userId);
  if (!devices || devices.size === 0) return false;
  return devices.has(fingerprint);
}

function removeDevice(userId, fingerprint) {
  const devices = deviceSessions.get(userId);
  if (devices) devices.delete(fingerprint);
}

function getDeviceCount(userId) {
  return deviceSessions.get(userId)?.size || 0;
}

// ─── Refresh Token Helpers ─────────────────────────────────────────────────────
function storeRefreshToken(token, userId) {
  refreshTokens.set(token, { userId });
}

function getRefreshToken(token) {
  return refreshTokens.get(token) || null;
}

function deleteRefreshToken(token) {
  refreshTokens.delete(token);
}

// ─── Search Count Helpers ──────────────────────────────────────────────────────
const FREE_DAILY_LIMIT = 10;
const PRO_DAILY_LIMIT = 100;

function checkSearchLimit(user) {
  const today = new Date().toDateString();
  const resetNeeded = user.searchResetDate !== today;
  const count = resetNeeded ? 0 : (user.searchCount || 0);
  const limit = user.plan === 'free' ? FREE_DAILY_LIMIT : PRO_DAILY_LIMIT;
  const remaining = Math.max(0, limit - count);
  return { allowed: remaining > 0, remaining, resetNeeded };
}

async function incrementSearchCount(userId) {
  try {
    const today = new Date().toDateString();
    const doc = await admin.firestore().collection('users').doc(userId).get();
    const data = doc.data() || {};
    const resetNeeded = data.searchResetDate !== today;
    await admin.firestore().collection('users').doc(userId).update({
      searchCount: resetNeeded ? 1 : admin.firestore.FieldValue.increment(1),
      searchResetDate: today
    });
  } catch (err) {
    console.error('[DB] incrementSearchCount error:', err.message);
  }
}


// Fix 6: getUserDevices — was missing, routes/user.js use karta hai
function getUserDevices(userId) {
  return Array.from(deviceSessions.get(userId) || []);
}

// getUserDeviceCount — middleware/auth.js use karta hai device limit ke liye
function getUserDeviceCount(userId) {
  return deviceSessions.get(userId)?.size || 0;
}

module.exports = {
  findUserById, findUserByEmail, updateUser,
  deviceSessions, registerDevice, isDeviceAllowed, removeDevice, getDeviceCount, getUserDevices, getUserDeviceCount,
  refreshTokens, storeRefreshToken, getRefreshToken, deleteRefreshToken,
  checkSearchLimit, incrementSearchCount,
};
