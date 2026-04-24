const express = require('express');
const router = express.Router();
const axios = require('axios');
const admin = require('../utils/firebase');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { authLimiter, registerLimiter } = require('../middleware/rateLimiter');
const { botDetection, extractFingerprint } = require('../middleware/botDetection');
const { protect, invalidateUserCache } = require('../middleware/auth');
const {
  registerDevice, removeDevice,
  storeRefreshToken, getRefreshToken, deleteRefreshToken
} = require('../store/db');

// ─── Device → userId mapping ───────────────────────────────────────────────────
// Ek device pe sirf ek account allowed
// Key: fingerprint, Value: userId
const deviceOwner = new Map();

// ================================
// REGISTER
// ================================
router.post('/register', registerLimiter, botDetection, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'Name, email aur password zaroori hain' });
    if (password.length < 8)
      return res.status(400).json({ success: false, message: 'Password 8 characters ka hona chahiye' });
    if (!email.includes('@'))
      return res.status(400).json({ success: false, message: 'Valid email daalo' });

    // Is device pe pehle se koi account hai?
    const fingerprint = extractFingerprint(req);
    const existingOwner = deviceOwner.get(fingerprint);
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
      console.error('Firebase createUser error:', err.message);
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

    // Device ko is user ke saath permanently bind karo
    deviceOwner.set(fingerprint, firebaseUser.uid);
    registerDevice(firebaseUser.uid, fingerprint);

    const accessToken  = generateAccessToken({ id: firebaseUser.uid, email });
    const refreshToken = generateRefreshToken({ id: firebaseUser.uid });
    storeRefreshToken(refreshToken, firebaseUser.uid);

    res.status(201).json({
      success: true,
      message: 'Account ban gaya!',
      accessToken, refreshToken,
      user: {
        id: firebaseUser.uid, name, email,
        plan: 'free', savedAds: [],
        createdAt: new Date().toISOString()
      }
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

    // Step 1: Firebase se user check karo
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().getUserByEmail(email);
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    }

    // Step 2: Password verify karo (axios — node-fetch nahi)
    const webApiKey = process.env.FIREBASE_WEB_API_KEY;
    if (!webApiKey) {
      console.error('FIREBASE_WEB_API_KEY missing!');
      return res.status(500).json({ success: false, message: 'Server config error' });
    }

    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey}`,
        { email, password, returnSecureToken: true }
      );
    } catch (err) {
      const msg = err.response?.data?.error?.message || '';
      console.error('Firebase verify error:', msg);
      if (msg.includes('TOO_MANY_ATTEMPTS'))
        return res.status(429).json({ success: false, message: 'Bahut zyada attempts. Thodi der baad try karo.' });
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    }

    // Step 3: Device check — kya is device pe koi ALAG account registered hai?
    const fingerprint = extractFingerprint(req);
    const existingOwner = deviceOwner.get(fingerprint);

    if (existingOwner && existingOwner !== firebaseUser.uid) {
      return res.status(403).json({
        success: false,
        message: 'Is device pe pehle se alag account registered hai. Wahi account use karo.',
        code: 'DEVICE_TAKEN'
      });
    }

    // Step 4: User data fetch karo
    const userDoc = await admin.firestore().collection('users').doc(firebaseUser.uid).get();
    const userData = userDoc.data() || {};

    // Device bind karo (agar nahi hai toh)
    deviceOwner.set(fingerprint, firebaseUser.uid);
    registerDevice(firebaseUser.uid, fingerprint);

    // Step 5: Tokens generate karo
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

    // Pehle check karo — registered hai ya nahi
    try {
      await admin.auth().getUserByEmail(email);
    } catch {
      // FIX: Success message nahi — clear error batao
      return res.status(404).json({
        success: false,
        message: 'Yeh email registered nahi hai. Pehle account banao.'
      });
    }

    // Registered hai toh reset email bhejo
    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${process.env.FIREBASE_WEB_API_KEY}`,
        { requestType: 'PASSWORD_RESET', email }
      );
    } catch (err) {
      console.error('Reset email error:', err.response?.data || err.message);
      return res.status(500).json({ success: false, message: 'Email bhejne mein error hua. Dobara try karo.' });
    }

    res.json({ success: true, message: 'Password reset email bhej diya! Inbox check karo.' });

  } catch (err) {
    console.error('Forgot password error:', err.message);
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

    // Server restart safe — JWT valid hai toh allow karo
    const newAccessToken = generateAccessToken({ id: decoded.id });
    res.json({ success: true, accessToken: newAccessToken });

  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================================
// LOGOUT
// ================================
router.post('/logout', protect, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const userId = req.user.id;
    const fingerprint = req.fingerprint;

    if (refreshToken) deleteRefreshToken(refreshToken);
    removeDevice(userId, fingerprint);
    invalidateUserCache(userId);

    // Logout pe device free karo taaki user naya account bana sake
    if (deviceOwner.get(fingerprint) === userId) {
      deviceOwner.delete(fingerprint);
    }

    res.json({ success: true, message: 'Logout ho gaye' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================================
// ME
// ================================
router.get('/me', protect, async (req, res) => {
  try {
    const userDoc = await admin.firestore().collection('users').doc(req.user.id).get();
    const userData = userDoc.data() || {};
    res.json({ success: true, user: { ...userData, password: undefined } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
