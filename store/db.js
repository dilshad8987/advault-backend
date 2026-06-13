const mongoose = require('mongoose');
const User     = require('../models/User');

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 din

// ─── Credit System Constants ──────────────────────────────────────────────────
const PLAN_CREDITS = {
  free:  200,
  pro:   2000,
  elite: 10000,
};

const CREDIT_COSTS = {
  search:          10,
  ad_detail:       30,
  save_ad:         10,
  video_download:  10,
  load_more:       10,
};

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


// ─── Credit System Helpers ────────────────────────────────────────────────────

// Current month string: "June 2026"
function getCurrentMonth() {
  const d = new Date();
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// Get plan's monthly credit allocation
function getPlanCredits(plan) {
  return PLAN_CREDITS[plan] || PLAN_CREDITS.free;
}

// Check if user has enough credits for an action
function checkCredits(user, action = 'search') {
  const cost        = CREDIT_COSTS[action] || 1;
  const thisMonth   = getCurrentMonth();
  const resetNeeded = user.creditsResetDate !== thisMonth;

  // If reset needed, treat as full credits
  const remaining = resetNeeded
    ? getPlanCredits(user.plan)
    : Math.max(0, user.credits ?? getPlanCredits(user.plan));

  return {
    allowed:   remaining >= cost,
    remaining,
    cost,
    limit:     getPlanCredits(user.plan),
    used:      resetNeeded ? 0 : (user.creditsUsed || 0),
    resetNeeded,
  };
}

// Deduct credits for an action — returns { success, remaining, used }
async function deductCredits(userId, action = 'search') {
  try {
    if (!isMongoReady()) return { success: false };
    const cost      = CREDIT_COSTS[action] || 1;
    const thisMonth = getCurrentMonth();
    const user      = await User.findOne({ firebaseUid: userId });
    if (!user) return { success: false };

    const resetNeeded = user.creditsResetDate !== thisMonth;
    const planLimit   = getPlanCredits(user.plan);

    if (resetNeeded) {
      // Fresh month — reset credits, then deduct
      user.credits          = Math.max(0, planLimit - cost);
      user.creditsUsed      = cost;
      user.creditsResetDate = thisMonth;
    } else {
      const current = user.credits ?? planLimit;
      if (current < cost) return { success: false, remaining: current };
      user.credits     = Math.max(0, current - cost);
      user.creditsUsed = (user.creditsUsed || 0) + cost;
    }

    await user.save();
    return { success: true, remaining: user.credits, used: user.creditsUsed };
  } catch (err) {
    console.error('[DB] deductCredits error:', err.message);
    return { success: false };
  }
}

// Sync user's credits if month has reset (call on login/profile load)
async function syncCreditsIfNeeded(userId) {
  try {
    if (!isMongoReady()) return;
    const thisMonth = getCurrentMonth();
    const user      = await User.findOne({ firebaseUid: userId });
    if (!user || user.creditsResetDate === thisMonth) return;

    const planLimit = getPlanCredits(user.plan);
    user.credits          = planLimit;
    user.creditsUsed      = 0;
    user.creditsResetDate = thisMonth;
    await user.save();
  } catch (err) {
    console.error('[DB] syncCreditsIfNeeded error:', err.message);
  }
}

// Legacy — kept for backward compat, routes will be updated to use credits
function checkSearchLimit(user) {
  return checkCredits(user, 'search');
}
async function incrementSearchCount(userId) {
  await deductCredits(userId, 'search');
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

  // Credit System
  checkCredits,
  deductCredits,
  syncCreditsIfNeeded,
  getPlanCredits,
  CREDIT_COSTS,
  PLAN_CREDITS,

  // Legacy aliases (backward compat)
  checkSearchLimit,
  incrementSearchCount,
};
