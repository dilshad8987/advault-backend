// routes/auth.js
// Auth routes: /api/auth/register, /api/auth/login, /api/auth/refresh, /api/auth/logout

const express = require('express');
const router  = express.Router();

const admin = require('../utils/firebase');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require('../utils/jwt');
const {
  findUserById,
  findUserByEmail,
  createUser,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  registerDevice,
  getAccountsByDevice,
} = require('../store/db');
const {
  validateStrongPassword,
  isValidEmail,
  isTempEmail,
  protect,
  invalidateUserCache,
  detectVPN,
} = require('../middleware/auth');
const { extractFingerprint } = require('../middleware/botDetection');

// ─── REGISTER ─────────────────────────────────────────────────────────────────
// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Validation
    if (!name || name.trim().length < 2)
      return res.status(400).json({ success: false, message: 'Name is too short.' });
    if (!email || !isValidEmail(email))
      return res.status(400).json({ success: false, message: 'Invalid email.' });
    if (isTempEmail(email))
      return res.status(400).json({ success: false, message: 'Invalid email.' });

    const pwCheck = validateStrongPassword(password);
    if (!pwCheck.valid)
      return res.status(400).json({ success: false, message: pwCheck.message });

    // ─── VPN Check ────────────────────────────────────────────────────────────
    const vpnResult = detectVPN(req);
    if (vpnResult.detected)
      return res.status(403).json({ success: false, message: 'VPN/Proxy not allowed.' });

    // ─── Device Multi-Account Check ───────────────────────────────────────────
    // One account per device
    const fingerprint   = extractFingerprint(req);
    const existingAccts = await getAccountsByDevice(fingerprint);
    if (existingAccts.length >= 1)
      return res.status(403).json({ success: false, message: 'Account already exists on this device.' });

    // Create user in Firebase
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().createUser({
        displayName: name.trim(),
        email:       email.toLowerCase().trim(),
        password,
      });
    } catch (err) {
      if (err.code === 'auth/email-already-exists')
        return res.status(409).json({ success: false, message: 'Email already registered.' });
      throw err;
    }

    // Create user record in MongoDB
    await createUser({
      firebaseUid: firebaseUser.uid,
      name:        name.trim(),
      email:       email.toLowerCase().trim(),
      plan:        'free',
    });

    // Tokens banao
    const payload      = { id: firebaseUser.uid, email: firebaseUser.email, plan: 'free' };
    const accessToken  = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);
    await storeRefreshToken(refreshToken, firebaseUser.uid);

    // Register device fingerprint
    await registerDevice(firebaseUser.uid, fingerprint);

    return res.status(201).json({
      success: true,
      message: 'Welcome to AdVault!',
      accessToken,
      refreshToken,
      user: {
        id:    firebaseUser.uid,
        name:  name.trim(),
        email: firebaseUser.email,
        plan:  'free',
      },
    });
  } catch (err) {
    console.error('[Auth] register error:', err.message);
    return res.status(500).json({ success: false, message: 'Registration failed. Try again.' });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ success: false, message: 'Email and password are required.' });

    if (isTempEmail(email))
      return res.status(400).json({ success: false, message: 'Invalid email.' });

    // Sign in via Firebase REST API
    // FIREBASE_WEB_API_KEY used (not FIREBASE_API_KEY)
    const FIREBASE_API_KEY = process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
    if (!FIREBASE_API_KEY)
      return res.status(500).json({ success: false, message: 'Server configuration error.' });

    const fbRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );

    const fbData = await fbRes.json();

    if (!fbRes.ok) {
      const code = fbData?.error?.message || '';
      if (code.includes('EMAIL_NOT_FOUND') || code.includes('INVALID_PASSWORD') || code.includes('INVALID_LOGIN_CREDENTIALS'))
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      if (code.includes('TOO_MANY_ATTEMPTS'))
        return res.status(429).json({ success: false, message: 'Too many attempts. Try again later.' });
      throw new Error(code);
    }

    // Fetch user data
    const uid  = fbData.localId;
    const user = await findUserById(uid);

    if (!user)
      return res.status(404).json({ success: false, message: 'Account not found.' });

    const payload      = { id: uid, email: user.email, plan: user.plan || 'free' };
    const accessToken  = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);
    await storeRefreshToken(refreshToken, uid);

    const fingerprint = extractFingerprint(req);
    await registerDevice(uid, fingerprint);

    return res.json({
      success: true,
      message: 'Signed in.',
      accessToken,
      refreshToken,
      user: {
        id:    uid,
        name:  user.name,
        email: user.email,
        plan:  user.plan || 'free',
      },
    });
  } catch (err) {
    console.error('[Auth] login error:', err.message);
    return res.status(500).json({ success: false, message: 'Login failed. Try again.' });
  }
});

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(401).json({ success: false, message: 'Session expired.' });

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded?.id)
      return res.status(401).json({ success: false, message: 'Session expired.' });

    const stored = await getRefreshToken(refreshToken);
    if (!stored)
      return res.status(401).json({ success: false, message: 'Session revoked. Sign in again.' });

    const newAccessToken = generateAccessToken({ id: decoded.id, email: decoded.email, plan: decoded.plan });
    return res.json({ success: true, accessToken: newAccessToken });
  } catch (err) {
    console.error('[Auth] refresh error:', err.message);
    return res.status(401).json({ success: false, message: 'Session refresh failed.' });
  }
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
// POST /api/auth/logout
router.post('/logout', protect, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await deleteRefreshToken(refreshToken);
    invalidateUserCache(req.user.id);
    return res.json({ success: true, message: 'Signed out.' });
  } catch (err) {
    console.error('[Auth] logout error:', err.message);
    return res.status(500).json({ success: false, message: 'Sign out failed.' });
  }
});

module.exports = router;
