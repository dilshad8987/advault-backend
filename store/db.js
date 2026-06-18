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
  search:          10,   // TikTok + Meta keyword search
  ad_detail:       30,   // TikTok + Meta detail open (sirf pehli baar)
  save_ad:         10,   // TikTok + Meta ad save
  video_download:  10,   // TikTok + Meta video download
  load_more:        5,   // TikTok + Meta load more
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
    const planLimit = getPlanCredits(plan);
    const user = await User.create({
      firebaseUid,
      name,
      email,
      plan,
      credits:          planLimit,
      creditsUsed:      0,
      creditsResetDate: getNextResetDate(), // Aaj se 28 din baad
    });
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

const RESET_DAYS = 28; // Har 28 din mein credits reset

// Reset date: registration ke baad exactly 28 din — ISO date string "YYYY-MM-DD"
function getNextResetDate(fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setDate(d.getDate() + RESET_DAYS);
  return d.toISOString().slice(0, 10); // "2026-07-11"
}

// Check karo kya reset due hai (date compare)
function isResetDue(creditsResetDate) {
  if (!creditsResetDate) return true;
  return new Date() >= new Date(creditsResetDate);
}

// Get plan's credit allocation
function getPlanCredits(plan) {
  return PLAN_CREDITS[plan] || PLAN_CREDITS.free;
}

// Check if user has enough credits for an action
function checkCredits(user, action = 'search') {
  const cost        = CREDIT_COSTS[action] || 1;
  const resetNeeded = isResetDue(user.creditsResetDate);

  // Reset due ho to full credits treat karo
  const remaining = resetNeeded
    ? getPlanCredits(user.plan)
    : Math.max(0, user.credits ?? getPlanCredits(user.plan));

  return {
    allowed:         remaining >= cost,
    remaining,
    cost,
    limit:           getPlanCredits(user.plan),
    used:            resetNeeded ? 0 : (user.creditsUsed || 0),
    resetNeeded,
    nextResetDate:   user.creditsResetDate || null,
  };
}

// Deduct credits for an action — returns { success, remaining, used }
// Optimized: 3 DB calls → 2 DB calls (sync + fetch merged into one findOne)
async function deductCredits(userId, action = 'search') {
  try {
    if (!isMongoReady()) return { success: false };
    const cost = CREDIT_COSTS[action] || 1;

    // Step 1: Ek hi call mein user fetch karo + reset check karo
    const user = await User.findOne(
      { firebaseUid: userId },
      { credits: 1, creditsUsed: 1, creditsResetDate: 1, plan: 1 }
    ).lean();

    if (!user) return { success: false };

    const resetNeeded    = isResetDue(user.creditsResetDate);
    const planLimit      = getPlanCredits(user.plan);
    const currentCredits = resetNeeded ? planLimit : (user.credits ?? planLimit);

    // Credits check — agar kam hain toh reject karo
    if (currentCredits < cost) {
      return { success: false, remaining: currentCredits, insufficient: true };
    }

    // Step 2: Atomic update — reset + deduct ek saath agar zaroori ho
    const updateQuery = resetNeeded
      ? {
          $set: {
            credits:          planLimit - cost,
            creditsUsed:      cost,
            creditsResetDate: getNextResetDate(),
            viewedAdIds:      [], // Reset pe viewed history clear — fresh start
            updatedAt:        new Date(),
          },
        }
      : {
          $inc: { credits: -cost, creditsUsed: cost },
          $set: { updatedAt: new Date() },
        };

    // Agar reset nahi hai: credits >= cost condition lagao (double-spend protect)
    const matchQuery = resetNeeded
      ? { firebaseUid: userId }
      : { firebaseUid: userId, credits: { $gte: cost } };

    const result = await User.findOneAndUpdate(matchQuery, updateQuery, { new: true });

    if (!result) {
      // Race condition: kisi aur request ne pehle deduct kar liya
      const fresh = await User.findOne({ firebaseUid: userId }, { credits: 1 }).lean();
      return { success: false, remaining: fresh?.credits ?? 0, insufficient: true };
    }

    console.log(`[Credits] Deducted: ${userId} -${cost} (${action}) → ${result.credits} left`);
    return {
      success:       true,
      remaining:     result.credits,
      used:          result.creditsUsed,
      nextResetDate: result.creditsResetDate,
    };
  } catch (err) {
    console.error('[DB] deductCredits error:', err.message);
    return { success: false };
  }
}

// Sync: agar 28 din guzar gaye to credits reset karo
// Note: deductCredits ab apne andar reset handle karta hai — yeh function
// sirf manual/admin reset ke liye raha hai (e.g. plan upgrade pe call karo)
async function syncCreditsIfNeeded(userId) {
  try {
    if (!isMongoReady()) return;
    const user = await User.findOne({ firebaseUid: userId });
    if (!user) return;

    if (!isResetDue(user.creditsResetDate)) return; // Reset nahi chahiye

    const planLimit = getPlanCredits(user.plan);
    user.credits          = planLimit;
    user.creditsUsed      = 0;
    user.creditsResetDate = getNextResetDate(); // Aaj se agla 28 din
    user.viewedAdIds      = []; // Reset pe viewed history clear — fresh start
    await user.save();
    console.log(`[Credits] Manual Reset: ${userId} → ${planLimit} credits, viewedAdIds cleared, next: ${user.creditsResetDate}`);
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

  // Helpers
  getNextResetDate,
  RESET_DAYS,
};
