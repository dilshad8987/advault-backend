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
  syncCreditsIfNeeded,
  getPlanCredits,
  getNextResetDate,
} = require('../store/db');
const {
  validateStrongPassword,
  isValidEmail,
  isTempEmail,
  protect,
  invalidateUserCache,
  detectVPN,
  sanitizeInput,
} = require('../middleware/auth');
const { extractFingerprint } = require('../middleware/botDetection');
const crypto         = require('crypto');
const bcrypt         = require('bcryptjs');
const Otp            = require('../models/Otp');
const { sendResetEmail, sendLoginAlertEmail } = require('../services/emailService');

// ─── REGISTER ─────────────────────────────────────────────────────────────────
// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const rawBody = sanitizeInput(req.body);
    const { name, email, password } = rawBody;

    if (!name || name.trim().length < 2)
      return res.status(400).json({ success: false, message: 'Name is too short.' });
    if (!email || !isValidEmail(email))
      return res.status(400).json({ success: false, message: 'Invalid email.' });

    const pwCheck = validateStrongPassword(password);
    if (!pwCheck.valid)
      return res.status(400).json({ success: false, message: pwCheck.message });

    const vpnResult = detectVPN(req);
    if (vpnResult.detected)
      return res.status(403).json({ success: false, message: 'VPN/Proxy not allowed.' });

    const fingerprint   = extractFingerprint(req);
    const existingAccts = await getAccountsByDevice(fingerprint);
    if (existingAccts.length >= 3)
      return res.status(403).json({ success: false, message: 'Max accounts reached on this device.' });

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

    await createUser({
      firebaseUid: firebaseUser.uid,
      name:        name.trim(),
      email:       email.toLowerCase().trim(),
      plan:        'free',
    });

    const payload      = { id: firebaseUser.uid, email: firebaseUser.email, plan: 'free' };
    const accessToken  = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);
    await storeRefreshToken(refreshToken, firebaseUser.uid);
    await registerDevice(firebaseUser.uid, fingerprint);

    return res.status(201).json({
      success: true,
      message: 'Welcome to AdVault!',
      accessToken,
      refreshToken,
      user: { id: firebaseUser.uid, name: name.trim(), email: firebaseUser.email, plan: 'free' },
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
    const rawBody = sanitizeInput(req.body);
    const { email, password } = rawBody;

    if (!email || !password)
      return res.status(400).json({ success: false, message: 'Email and password are required.' });

    if (isTempEmail(email))
      return res.status(400).json({ success: false, message: 'Invalid email.' });

    // Firebase REST API se sign-in karo (Admin SDK se password verify nahi hota)
    // Fix: .env mein variable ka naam FIREBASE_WEB_API_KEY hai, FIREBASE_API_KEY nahi
    const FIREBASE_API_KEY = process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
    if (!FIREBASE_API_KEY)
      return res.status(500).json({ success: false, message: 'Server config error: FIREBASE_WEB_API_KEY missing' });

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
        return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
      if (code.includes('TOO_MANY_ATTEMPTS'))
        return res.status(429).json({ success: false, message: 'Bahut zyada login attempts. Thodi der baad try karo.' });
      throw new Error(code);
    }

    // Firestore se user data fetch karo
    const uid  = fbData.localId;
    const user = await findUserById(uid);

    if (!user)
      return res.status(404).json({ success: false, message: 'User record nahi mila. Support se contact karo.' });

    const payload      = { id: uid, email: user.email, plan: user.plan || 'free' };
    const accessToken  = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);
    await storeRefreshToken(refreshToken, uid);

    const fingerprint = extractFingerprint(req);

    // ── New Device Detection ──────────────────────────────────────────────────
    // Check karo kya yeh device pehle kabhi login ki hai
    const { isDeviceAllowed } = require('../store/db');
    const isKnownDevice = await isDeviceAllowed(uid, fingerprint);

    await registerDevice(uid, fingerprint);

    // Naya device — suspicious login alert email bhejo
    if (!isKnownDevice) {
      const uaStr  = req.headers['user-agent'] || '';
      const ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown').split(',')[0].trim();
      const time   = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';

      // Simple UA parsing
      const browser = uaStr.includes('Chrome') ? 'Chrome'
                    : uaStr.includes('Firefox') ? 'Firefox'
                    : uaStr.includes('Safari') ? 'Safari'
                    : uaStr.includes('Edge') ? 'Edge'
                    : 'Unknown Browser';
      const os      = uaStr.includes('Windows') ? 'Windows'
                    : uaStr.includes('Android') ? 'Android'
                    : uaStr.includes('iPhone') || uaStr.includes('iPad') ? 'iOS'
                    : uaStr.includes('Mac') ? 'macOS'
                    : uaStr.includes('Linux') ? 'Linux'
                    : 'Unknown OS';

      // Fire-and-forget — login block nahi hoga alert ki wajah se
      sendLoginAlertEmail(user.email, user.name || 'User', { time, browser, os, ip }).catch(err =>
        console.error('[Auth] login alert email failed:', err.message)
      );
    }
    // ─────────────────────────────────────────────────────────────────────────

    await syncCreditsIfNeeded(uid);
    const freshUser = await findUserById(uid);

    return res.json({
      success: true,
      message: 'Login ho gaye!',
      accessToken,
      refreshToken,
      user: {
        id:    uid,
        name:  freshUser.name,
        email: freshUser.email,
        plan:  freshUser.plan || 'free',
      },
    });
  } catch (err) {
    console.error('[Auth] login error:', err.message);
    return res.status(500).json({ success: false, message: 'Login fail hua. Dobara try karo.' });
  }
});

// ─── REFRESH TOKEN ────────────────────────────────────────────────────────────
// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(401).json({ success: false, message: 'Refresh token chahiye' });

    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded?.id)
      return res.status(401).json({ success: false, message: 'Refresh token invalid ya expire' });

    const stored = await getRefreshToken(refreshToken);
    if (!stored)
      return res.status(401).json({ success: false, message: 'Token revoke ho chuka hai. Dobara login karo.' });

    const newAccessToken = generateAccessToken({ id: decoded.id, email: decoded.email, plan: decoded.plan });
    return res.json({ success: true, accessToken: newAccessToken });
  } catch (err) {
    console.error('[Auth] refresh error:', err.message);
    return res.status(401).json({ success: false, message: 'Token refresh fail' });
  }
});

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
// POST /api/auth/logout
router.post('/logout', protect, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await deleteRefreshToken(refreshToken);
    invalidateUserCache(req.user.id);
    return res.json({ success: true, message: 'Logout ho gaye' });
  } catch (err) {
    console.error('[Auth] logout error:', err.message);
    return res.status(500).json({ success: false, message: 'Logout fail' });
  }
});

// ─── GOOGLE LOGIN ─────────────────────────────────────────────────────────────
// POST /api/auth/google
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken)
      return res.status(400).json({ success: false, message: 'idToken required.' });

    // Firebase Admin SDK se verify karo
    const decoded = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name: googleName, picture } = decoded;

    if (!email)
      return res.status(400).json({ success: false, message: 'Google account mein email nahi mili.' });

    // User exists? Warna create karo
    let user = await findUserById(uid);

    if (!user) {
      await createUser({
        firebaseUid: uid,
        name:        googleName || email.split('@')[0],
        email:       email.toLowerCase(),
        plan:        'free',
        provider:    'google',
        photoURL:    picture || null,
      });
      user = await findUserById(uid);
    }

    const payload      = { id: uid, email: user.email, plan: user.plan || 'free' };
    const accessToken  = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);
    await storeRefreshToken(refreshToken, uid);

    const fingerprint = extractFingerprint(req);
    await registerDevice(uid, fingerprint);

    await syncCreditsIfNeeded(uid);
    const freshGUser = await findUserById(uid);

    return res.json({
      success: true,
      message: 'Google login successful!',
      accessToken,
      refreshToken,
      user: {
        id:    uid,
        name:  freshGUser.name,
        email: freshGUser.email,
        plan:  freshGUser.plan || 'free',
      },
    });
  } catch (err) {
    console.error('[Auth] google login error:', err.message);
    if (err.code === 'auth/id-token-expired')
      return res.status(401).json({ success: false, message: 'Google token expired. Dobara try karo.' });
    return res.status(500).json({ success: false, message: 'Google login fail hua.' });
  }
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email))
      return res.status(400).json({ success: false, message: 'Invalid email.' });

    // Check user exists
    const user = await findUserByEmail(email.toLowerCase().trim());
    // Always return success — don't reveal if email exists
    if (!user) return res.status(200).json({ success: true, message: 'If this email exists, a reset link has been sent.' });

    // Generate secure token
    const token     = crypto.randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(token, 10);

    // Save to DB — expires in 10 minutes
    await Otp.findOneAndUpdate(
      { email: email.toLowerCase().trim() },
      {
        otpHash:   tokenHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts:  0,
        verified:  false,
        _regData:  'reset',
      },
      { upsert: true, returnDocument: 'after' }
    );

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(email.toLowerCase().trim())}`;
    await sendResetEmail(email.toLowerCase().trim(), user.name || 'User', resetLink);

    return res.status(200).json({ success: true, message: 'If this email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('[Auth] forgot-password error:', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
  }
});

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────
// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword)
      return res.status(400).json({ success: false, message: 'All fields are required.' });

    const pwCheck = validateStrongPassword(newPassword);
    if (!pwCheck.valid)
      return res.status(400).json({ success: false, message: pwCheck.message });

    const record = await Otp.findOne({ email: email.toLowerCase().trim(), _regData: 'reset', verified: false });
    if (!record) return res.status(400).json({ success: false, message: 'Reset link is invalid or expired.' });
    if (new Date() > record.expiresAt) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(400).json({ success: false, message: 'Reset link has expired. Request a new one.' });
    }
    if (record.attempts >= 3) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(429).json({ success: false, message: 'Too many attempts. Request a new reset link.' });
    }

    const match = await bcrypt.compare(token, record.otpHash);
    if (!match) {
      await Otp.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
      return res.status(400).json({ success: false, message: 'Reset link is invalid or expired.' });
    }

    // Update password in Firebase
    const firebaseUser = await admin.auth().getUserByEmail(email.toLowerCase().trim());
    await admin.auth().updateUser(firebaseUser.uid, { password: newPassword });

    // Delete reset token
    await Otp.deleteOne({ _id: record._id });

    return res.status(200).json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (err) {
    console.error('[Auth] reset-password error:', err.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
  }
});

module.exports = router;
