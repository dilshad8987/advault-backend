// routes/auth.js
// FIXED: Yeh file pehle sirf middleware exports kar rahi thi — koi router.post/get nahi tha
// Ab proper Express router hai jisme register/login/logout/refresh/me sab routes hain
// INCLUDES: strong password, temp email block, VPN detection, Firestore deviceOwner

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const admin   = require('../utils/firebase');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { authLimiter, registerLimiter } = require('../middleware/rateLimiter');
const { botDetection, extractFingerprint } = require('../middleware/botDetection');
const { protect, invalidateUserCache } = require('../middleware/auth');
const {
  registerDevice, removeDevice,
  storeRefreshToken, deleteRefreshToken,
} = require('../store/db');

// ─── Helpers imported from middleware/auth.js ─────────────────────────────────
const {
  validateStrongPassword,
  isTempEmail,
  detectVPN,
  isValidEmail,
} = require('../middleware/auth');

// ─── Fix 1: deviceOwner — Firestore-backed (restart-safe) ────────────────────
// Pehle: const deviceOwner = new Map() — server restart pe wipe ho jaata tha
// Ab: Firestore 'device_owners' collection — persist hota hai
const DEVICE_OWNER_COLLECTION = 'device_owners';

async function getDeviceOwner(fingerprint) {
  try {
    const doc = await admin.firestore().collection(DEVICE_OWNER_COLLECTION).doc(fingerprint).get();
    return doc.exists ? (doc.data().userId || null) : null;
  } catch { return null; }
}

async function setDeviceOwner(fingerprint, userId) {
  try {
    await admin.firestore().collection(DEVICE_OWNER_COLLECTION).doc(fingerprint).set({
      userId,
      registeredAt: new Date().toISOString(),
    });
  } catch (err) { console.error('[DeviceOwner] set error:', err.message); }
}

async function deleteDeviceOwner(fingerprint) {
  try {
    await admin.firestore().collection(DEVICE_OWNER_COLLECTION).doc(fingerprint).delete();
  } catch (err) { console.error('[DeviceOwner] delete error:', err.message); }
}

// ================================
// REGISTER
// ================================
router.post('/register', registerLimiter, botDetection, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'Name, email aur password zaroori hain' });

    // Fix 2: Strong password (uppercase + lowercase + number + special)
    const pwCheck = validateStrongPassword(password);
    if (!pwCheck.valid)
      return res.status(400).json({ success: false, message: pwCheck.message });

    // Fix 3: Temp/disposable email block
    if (!isValidEmail(email))
      return res.status(400).json({ success: false, message: 'Valid email format daalo.' });
    if (isTempEmail(email))
      return res.status(400).json({ success: false, message: 'Temporary ya disposable email allowed nahi hai. Real email use karo.' });

    // Fix 4: VPN/Proxy detection on register
    const vpnCheck = detectVPN(req);
    if (vpnCheck.detected)
      return res.status(403).json({ success: false, message: 'VPN ya Proxy se registration allowed nahi hai. Direct connection use karo.' });

    // Fix 1: deviceOwner Firestore se check — restart-safe
    const fingerprint   = extractFingerprint(req);
    const existingOwner = await getDeviceOwner(fingerprint);
    if (existingOwner) {
      return res.status(403).json({
        success: false,
        message: 'Is device pe pehle se ek account registered hai. Naya account nahi ban sakta.',
        code: 'DEVICE_ALREADY_REGISTERED'
      });
    }

    let firebaseUser;
    try {
      firebaseUser = await admin.auth().createUser({ email, password, displayName: name });
    } catch (err) {
      if (err.code === 'auth/email-already-exists')
        return res.status(409).json({ success: false, message: 'Email pehle se registered hai' });
      throw err;
    }

    await admin.firestore().collection('users').doc(firebaseUser.uid).set({
      id: firebaseUser.uid,
      name, email,
      plan: 'free',
      searchCount: 0,
      searchResetDate: new Date().toDateString(),
      savedAds: [],
      createdAt: new Date().toISOString()
    });

    // Fix 1: Firestore mein persist karo
    await setDeviceOwner(fingerprint, firebaseUser.uid);
    registerDevice(firebaseUser.uid, fingerprint);

    const accessToken  = generateAccessToken({ id: firebaseUser.uid, email });
    const refreshToken = generateRefreshToken({ id: firebaseUser.uid });
    storeRefreshToken(refreshToken, firebaseUser.uid);

    res.status(201).json({
      success: true,
      message: 'Account ban gaya!',
      accessToken, refreshToken,
      user: { id: firebaseUser.uid, name, email, plan: 'free', savedAds: [], createdAt: new Date().toISOString() }
    });

  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ success: false, message: 'Register fail: ' + err.message });
  }
});

// ================================
// LOGIN
// ================================
router.post('/login', authLimiter, botDetection, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ success: false, message: 'Email aur password daalo' });

    // Fix 3: Temp email block on login too
    if (isTempEmail(email))
      return res.status(400).json({ success: false, message: 'Temporary email allowed nahi hai.' });

    // Optional: VPN block on login (env se toggle)
    if (process.env.BLOCK_VPN_ON_LOGIN === 'true') {
      const vpnCheck = detectVPN(req);
      if (vpnCheck.detected)
        return res.status(403).json({ success: false, message: 'VPN ya Proxy se login allowed nahi hai.' });
    }

    let firebaseUser;
    try {
      firebaseUser = await admin.auth().getUserByEmail(email);
    } catch {
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    }

    const webApiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!webApiKey)
      return res.status(500).json({ success: false, message: 'Server config error' });

    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey}`,
        { email, password, returnSecureToken: true }
      );
    } catch (err) {
      const msg = err.response?.data?.error?.message || '';
      if (msg.includes('TOO_MANY_ATTEMPTS'))
        return res.status(429).json({ success: false, message: 'Bahut zyada attempts. Thodi der baad try karo.' });
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    }

    // Fix 1: deviceOwner Firestore se check
    const fingerprint   = extractFingerprint(req);
    const existingOwner = await getDeviceOwner(fingerprint);
    if (existingOwner && existingOwner !== firebaseUser.uid) {
      return res.status(403).json({
        success: false,
        message: 'Is device pe pehle se alag account registered hai. Wahi account use karo.',
        code: 'DEVICE_TAKEN'
      });
    }

    const userDoc  = await admin.firestore().collection('users').doc(firebaseUser.uid).get();
    const userData = userDoc.data() || {};

    await setDeviceOwner(fingerprint, firebaseUser.uid);
    registerDevice(firebaseUser.uid, fingerprint);

    const accessToken  = generateAccessToken({ id: firebaseUser.uid, email });
    const refreshToken = generateRefreshToken({ id: firebaseUser.uid });
    storeRefreshToken(refreshToken, firebaseUser.uid);

    res.json({
      success: true,
      message: 'Login successful!',
      accessToken, refreshToken,
      user: {
        id: firebaseUser.uid,
        name: userData.name || firebaseUser.displayName,
        email,
        plan: userData.plan || 'free',
        savedAds: userData.savedAds || [],
        createdAt: userData.createdAt
      }
    });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Login fail: ' + err.message });
  }
});

// ================================
// FORGOT PASSWORD
// ================================
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email daalo' });

    try {
      await admin.auth().getUserByEmail(email);
    } catch {
      return res.status(404).json({ success: false, message: 'Yeh email registered nahi hai.' });
    }

    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${process.env.FIREBASE_WEB_API_KEY}`,
        { requestType: 'PASSWORD_RESET', email }
      );
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Email bhejne mein error hua.' });
    }

    res.json({ success: true, message: 'Password reset email bhej diya! Inbox check karo.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================================
// REFRESH TOKEN
// ================================
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(401).json({ success: false, message: 'Refresh token nahi mila' });

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded)
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });

    const newAccessToken = generateAccessToken({ id: decoded.id });
    res.json({ success: true, accessToken: newAccessToken });
  } catch {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================================
// LOGOUT
// ================================
router.post('/logout', protect, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const userId      = req.user.id;
    const fingerprint = req.fingerprint;

    if (refreshToken) deleteRefreshToken(refreshToken);
    removeDevice(userId, fingerprint);
    invalidateUserCache(userId);

    // Fix 1: Firestore se device free karo
    const owner = await getDeviceOwner(fingerprint);
    if (owner === userId) {
      await deleteDeviceOwner(fingerprint);
    }

    res.json({ success: true, message: 'Logout ho gaye' });
  } catch {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================================
// ME
// ================================
router.get('/me', protect, async (req, res) => {
  try {
    const userDoc  = await admin.firestore().collection('users').doc(req.user.id).get();
    const userData = userDoc.data() || {};
    res.json({ success: true, user: { ...userData, password: undefined } });
  } catch {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================================
// UPDATE PROFILE (name)
// ================================
router.patch('/update-profile', protect, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim().length < 2)
      return res.status(400).json({ success: false, message: 'Valid naam daalo (min 2 chars)' });
    await admin.firestore().collection('users').doc(req.user.id).update({ name: name.trim(), updatedAt: new Date().toISOString() });
    res.json({ success: true, message: 'Profile update ho gayi', user: { name: name.trim() } });
  } catch {
    res.status(500).json({ success: false, message: 'Update fail' });
  }
});

// ================================
// CHANGE PASSWORD
// ================================
router.patch('/change-password', protect, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword)
      return res.status(400).json({ success: false, message: 'Dono passwords daalo' });

    // Fix 2: New password bhi strong hona chahiye
    const pwCheck = validateStrongPassword(newPassword);
    if (!pwCheck.valid)
      return res.status(400).json({ success: false, message: pwCheck.message });

    // Verify old password via Firebase
    const userDoc  = await admin.firestore().collection('users').doc(req.user.id).get();
    const email    = userDoc.data()?.email;
    const webApiKey = process.env.FIREBASE_WEB_API_KEY;

    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey}`,
        { email, password: oldPassword, returnSecureToken: true }
      );
    } catch {
      return res.status(401).json({ success: false, message: 'Purana password galat hai' });
    }

    await admin.auth().updateUser(req.user.id, { password: newPassword });
    res.json({ success: true, message: 'Password change ho gaya!' });
  } catch {
    res.status(500).json({ success: false, message: 'Password change fail' });
  }
});

module.exports = router;
