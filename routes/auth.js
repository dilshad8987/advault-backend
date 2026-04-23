const express = require('express');
const router = express.Router();
const admin = require('../utils/firebase');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { authLimiter, registerLimiter } = require('../middleware/rateLimiter');
const { botDetection, extractFingerprint } = require('../middleware/botDetection');
const { protect } = require('../middleware/auth');

// Device sessions — memory mein (Redis baad mein)
const deviceSessions = new Map();
const refreshTokens = new Map();

// ================================
// REGISTER
// ================================
router.post('/register', registerLimiter, botDetection, async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email aur password zaroori hain' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password 8 characters ka hona chahiye' });
    }
    if (!email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email daalo' });
    }

    // Firebase Auth mein create karo
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().createUser({
        email,
        password,
        displayName: name
      });
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        return res.status(409).json({ success: false, message: 'Email pehle se registered hai' });
      }
      throw err;
    }

    // Firestore mein user data save karo
    await admin.firestore().collection('users').doc(firebaseUser.uid).set({
      id: firebaseUser.uid,
      name,
      email,
      plan: 'free',
      searchCount: 0,
      searchResetDate: new Date().toDateString(),
      savedAds: [],
      devices: [],
      createdAt: new Date().toISOString()
    });

    // Device register karo
    const fingerprint = extractFingerprint(req);
    const maxDevices = parseInt(process.env.MAX_DEVICES_PER_USER) || 1;

    if (!deviceSessions.has(firebaseUser.uid)) {
      deviceSessions.set(firebaseUser.uid, new Set());
    }
    deviceSessions.get(firebaseUser.uid).add(fingerprint);

    // JWT tokens banao
    const accessToken  = generateAccessToken({ id: firebaseUser.uid, email });
    const refreshToken = generateRefreshToken({ id: firebaseUser.uid });
    refreshTokens.set(refreshToken, { userId: firebaseUser.uid });

    const user = {
      id: firebaseUser.uid,
      name,
      email,
      plan: 'free',
      savedAds: [],
      createdAt: new Date().toISOString()
    };

    res.status(201).json({
      success: true,
      message: 'Account ban gaya!',
      accessToken,
      refreshToken,
      user
    });

  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================================
// LOGIN
// ================================
router.post('/login', authLimiter, botDetection, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email aur password daalo' });
    }

    // Firebase se user dhundo
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().getUserByEmail(email);
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    }

    // Firebase REST API se password verify karo
    const fetch = require('node-fetch');
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }
    );

    const verifyData = await verifyRes.json();
    if (verifyData.error) {
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    }

    // Firestore se user data lo
    const userDoc = await admin.firestore().collection('users').doc(firebaseUser.uid).get();
    const userData = userDoc.data() || {};

    // Device check
    const fingerprint = extractFingerprint(req);
    const maxDevices = parseInt(process.env.MAX_DEVICES_PER_USER) || 1;

    if (!deviceSessions.has(firebaseUser.uid)) {
      deviceSessions.set(firebaseUser.uid, new Set());
    }

    const devices = deviceSessions.get(firebaseUser.uid);
    if (!devices.has(fingerprint) && devices.size >= maxDevices) {
      return res.status(403).json({
        success: false,
        message: 'Ek account sirf ek device pe login ho sakta hai.',
        code: 'DEVICE_LIMIT'
      });
    }
    devices.add(fingerprint);

    // JWT tokens banao
    const accessToken  = generateAccessToken({ id: firebaseUser.uid, email });
    const refreshToken = generateRefreshToken({ id: firebaseUser.uid });
    refreshTokens.set(refreshToken, { userId: firebaseUser.uid });

    const user = {
      id: firebaseUser.uid,
      name: userData.name || firebaseUser.displayName,
      email,
      plan: userData.plan || 'free',
      savedAds: userData.savedAds || [],
      createdAt: userData.createdAt
    };

    res.json({
      success: true,
      message: 'Login successful!',
      accessToken,
      refreshToken,
      user
    });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ================================
// FORGOT PASSWORD
// Firebase khud email bhejta hai
// ================================
router.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email daalo' });

    // Check karo user exist karta hai
    try {
      await admin.auth().getUserByEmail(email);
    } catch {
      return res.status(404).json({ success: false, message: 'Email registered nahi hai' });
    }

    // Firebase reset link generate karo
    const fetch = require('node-fetch');
    const resetRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${process.env.FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email })
      }
    );

    const resetData = await resetRes.json();
    if (resetData.error) {
      return res.status(500).json({ success: false, message: 'Email bhejne mein error' });
    }

    res.json({ success: true, message: 'Password reset email bhej diya!' });

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
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'Refresh token nahi mila' });
    }

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    const stored = refreshTokens.get(refreshToken);
    if (!stored) {
      return res.status(401).json({ success: false, message: 'Token expire ho gaya' });
    }

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
    const fingerprint = req.fingerprint;

    if (refreshToken) refreshTokens.delete(refreshToken);

    const devices = deviceSessions.get(req.user.id);
    if (devices) devices.delete(fingerprint);

    res.json({ success: true, message: 'Logout ho gaye' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ME
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
