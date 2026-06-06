const mongoose = require('mongoose');
const User     = require('../models/User');

const REFRESH_TTL_MS     = 7 * 24 * 60 * 60 * 1000; // 7 din
const FREE_DAILY_LIMIT   = 10;
const PRO_DAILY_LIMIT    = 100;
const AGENCY_DAILY_LIMIT = 500;

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

// ─── User Helpers ──────────────────────────────────────────────────────────────

async function findUserById(firebaseUid) {
  try {
    if (!isMongoReady()) return null;
    const user = await User.findOne({ firebaseUid }).lean();
    return user || null;
  } catch (err) {
    console.error('[DB] findUserById error:', err.message);
    return null;
  }
}

async function findUserByEmail(email) {
  try {
    if (!isMongoReady()) return null;
    const user = await User.findOne({ email: email.toLowerCase().trim() }).lean();
    return user || null;
  } catch (err) {
    console.error('[DB] findUserByEmail error:', err.message);
    return null;
  }
}

async function createUser({ firebaseUid, name, email, plan = 'free' }) {
  try {
    if (!isMongoReady()) throw new Error('MongoDB connected nahi hai');
    const user = await User.create({ firebaseUid, name, email, plan });
    return user.toObject();
  } catch (err) {
    console.error('[DB] createUser error:', err.message);
    throw err;
  }
}

async function updateUser(firebaseUid, updates) {
  try {
    if (!isMongoReady()) return false;
    await User.updateOne(
      { firebaseUid },
      { $set: { ...updates, updatedAt: new Date() } }
    );
    return true;
  } catch (err) {
    console.error('[DB] updateUser error:', err.message);
    return false;
  }
}

// ─── Refresh Token Helpers ─────────────────────────────────────────────────────
// Tokens User document ke andar refreshTokens array mein store hote hain
// Login pe purane expired tokens bhi saaf ho jaate hain ($pull)

async function storeRefreshToken(token, userId) {
  try {
    if (!isMongoReady()) return;
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const now       = new Date();

    // Fix 1: $push + $pull same array pe ek saath nahi chalte MongoDB mein
    // Pehle expired tokens hata do, phir naya push karo
    await User.updateOne(
      { firebaseUid: userId },
      { $pull: { refreshTokens: { expiresAt: { $lt: now } } } }
    );
    await User.updateOne(
      { firebaseUid: userId },
      {
        $push: { refreshTokens: { token, expiresAt } },
        $set:  { updatedAt: now },
      }
    );
  } catch (err) {
    console.error('[DB] storeRefreshToken error:', err.message);
  }
}

async function getRefreshToken(token) {
  try {
    if (!isMongoReady()) return null;
    // Fix 2: firebaseUid projection mein add kiya — warna user.firebaseUid undefined aata tha
    const user = await User.findOne(
      { 'refreshTokens.token': token },
      { 'refreshTokens.$': 1, firebaseUid: 1 }
    ).lean();
    if (!user?.refreshTokens?.[0]) return null;

    const doc = user.refreshTokens[0];
    // Expired hai toh hata do aur null return karo
    if (new Date() > doc.expiresAt) {
      await deleteRefreshToken(token);
      return null;
    }
    return { token: doc.token, userId: user.firebaseUid, expiresAt: doc.expiresAt };
  } catch (err) {
    console.error('[DB] getRefreshToken error:', err.message);
    return null;
  }
}

async function deleteRefreshToken(token) {
  try {
    if (!isMongoReady()) return;
    await User.updateOne(
      { 'refreshTokens.token': token },
      { $pull: { refreshTokens: { token } } }
    );
  } catch (err) {
    console.error('[DB] deleteRefreshToken error:', err.message);
  }
}

// ─── Device Session Helpers ────────────────────────────────────────────────────

async function registerDevice(userId, fingerprint) {
  try {
    if (!isMongoReady()) return;
    // Agar naya device hai toh push karo
    await User.updateOne(
      { firebaseUid: userId, 'devices.fingerprint': { $ne: fingerprint } },
      {
        $push: { devices: { fingerprint, lastSeen: new Date() } },
        $set:  { updatedAt: new Date() },
      }
    );
    // Agar already exist karta hai toh lastSeen update karo
    await User.updateOne(
      { firebaseUid: userId, 'devices.fingerprint': fingerprint },
      { $set: { 'devices.$.lastSeen': new Date() } }
    );
  } catch (err) {
    console.error('[DB] registerDevice error:', err.message);
  }
}

async function isDeviceAllowed(userId, fingerprint) {
  try {
    if (!isMongoReady()) return true;
    const user = await User.findOne(
      { firebaseUid: userId, 'devices.fingerprint': fingerprint },
      { _id: 1 }
    ).lean();
    return !!user;
  } catch (err) {
    console.error('[DB] isDeviceAllowed error:', err.message);
    return true;
  }
}

async function removeDevice(userId, fingerprint) {
  try {
    if (!isMongoReady()) return;
    await User.updateOne(
      { firebaseUid: userId },
      { $pull: { devices: { fingerprint } } }
    );
  } catch (err) {
    console.error('[DB] removeDevice error:', err.message);
  }
}

async function getUserDevices(userId) {
  try {
    if (!isMongoReady()) return [];
    const user = await User.findOne({ firebaseUid: userId }, { devices: 1 }).lean();
    return (user?.devices || []).map(d => d.fingerprint);
  } catch (err) {
    console.error('[DB] getUserDevices error:', err.message);
    return [];
  }
}

async function getDeviceCount(userId) {
  try {
    if (!isMongoReady()) return 0;
    const user = await User.findOne({ firebaseUid: userId }, { devices: 1 }).lean();
    return user?.devices?.length || 0;
  } catch (err) {
    return 0;
  }
}
// Ek device fingerprint pe kitne accounts hain — VPN se multiple account block karne ke liye
async function getAccountsByDevice(fingerprint) {
  try {
    if (!isMongoReady()) return [];
    const users = await User.find(
      { 'devices.fingerprint': fingerprint },
      { firebaseUid: 1, email: 1, createdAt: 1 }
    ).lean();
    return users || [];
  } catch (err) {
    console.error('[DB] getAccountsByDevice error:', err.message);
    return [];
  }
}


// ─── Search Count Helpers ──────────────────────────────────────────────────────

function getPlanLimit(plan) {
  if (plan === 'agency') return AGENCY_DAILY_LIMIT;
  if (plan === 'pro')    return PRO_DAILY_LIMIT;
  return FREE_DAILY_LIMIT;
}

function checkSearchLimit(user) {
  const today       = new Date().toDateString();
  const resetNeeded = user.searchResetDate !== today;
  const count       = resetNeeded ? 0 : (user.searchCount || 0);
  const limit       = getPlanLimit(user.plan);
  const remaining   = Math.max(0, limit - count);
  return { allowed: remaining > 0, remaining, limit, resetNeeded };
}

async function incrementSearchCount(userId) {
  try {
    if (!isMongoReady()) return;
    const today = new Date().toDateString();
    const user  = await User.findOne({ firebaseUid: userId });
    if (!user) return;
    const resetNeeded    = user.searchResetDate !== today;
    user.searchCount     = resetNeeded ? 1 : (user.searchCount || 0) + 1;
    user.searchResetDate = today;
    await user.save();
  } catch (err) {
    console.error('[DB] incrementSearchCount error:', err.message);
  }
}

module.exports = {
  // User
  findUserById,
  findUserByEmail,
  createUser,
  updateUser,

  // Refresh Tokens
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,

  // Device Sessions
  registerDevice,
  isDeviceAllowed,
  removeDevice,
  getUserDevices,
  getDeviceCount,
  getUserDeviceCount: getDeviceCount,
  getAccountsByDevice, // alias — backward compat

  // Search
  checkSearchLimit,
  incrementSearchCount,
};
