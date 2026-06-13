const express = require('express');
const router  = express.Router();

const { protect, sanitizeInput } = require('../middleware/auth');
const { findUserById, updateUser, getUserDevices, removeDevice, checkCredits, syncCreditsIfNeeded, getPlanCredits, PLAN_CREDITS, CREDIT_COSTS } = require('../store/db');
const { getCacheStats } = require('../services/cache');

// ================================
// GET PROFILE
// GET /api/user/profile
// ================================
router.get('/profile', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // Sync credits if new month
    await syncCreditsIfNeeded(user.firebaseUid);
    // Reload after potential sync
    const freshUser = await findUserById(req.user.id);

    const planLimit      = getPlanCredits(freshUser.plan);
    const creditsUsed    = freshUser.creditsUsed || 0;
    const creditsLeft    = freshUser.credits ?? planLimit;

    res.json({
      success: true,
      user: {
        id:        freshUser.id,
        name:      freshUser.name,
        email:     freshUser.email,
        plan:      freshUser.plan,
        createdAt: freshUser.createdAt,
      },
      usage: {
        creditsUsed,
        creditsRemaining: creditsLeft,
        creditsLimit:     planLimit,
        creditsResetDate: freshUser.creditsResetDate,
        savedAds:         freshUser.savedAds?.length || 0,
        creditCosts:      CREDIT_COSTS,
      },
    });
  } catch (err) {
    console.error('[User] profile error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load profile.' });
  }
});

// ================================
// UPDATE PROFILE
// PUT /api/user/profile
// ================================
router.put('/profile', protect, async (req, res) => {
  try {
    const { name } = sanitizeInput(req.body);
    if (!name || name.trim().length < 2)
      return res.status(400).json({ success: false, message: 'Invalid name.' });

    await updateUser(req.user.id, { name: name.trim() });
    res.json({ success: true, message: 'Profile updated.' });
  } catch (err) {
    console.error('[User] update profile error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
});

// ================================
// GET DEVICES
// GET /api/user/devices
// ================================
router.get('/devices', protect, async (req, res) => {
  try {
    const devices = await getUserDevices(req.user.id);
    res.json({
      success: true,
      devices: devices.map((d, i) => ({
        id:        d,
        label:     `Device ${i + 1}`,
        isCurrent: d === req.fingerprint,
      })),
    });
  } catch (err) {
    console.error('[User] devices error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load devices.' });
  }
});

// ================================
// REMOVE DEVICE
// DELETE /api/user/devices/:deviceId
// ================================
router.delete('/devices/:deviceId', protect, async (req, res) => {
  try {
    await removeDevice(req.user.id, req.params.deviceId);
    res.json({ success: true, message: 'Device removed.' });
  } catch (err) {
    console.error('[User] remove device error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove device.' });
  }
});

// ================================
// PLAN INFO
// GET /api/user/plan
// ================================
router.get('/plan', protect, (req, res) => {
  const plans = {
    free:  { name: 'Free',  price: 0,   priceINR: 0,   credits: 200,   platforms: 2  },
    pro:   { name: 'Pro',   price: 299, priceINR: 299, credits: 2000,  platforms: 5  },
    elite: { name: 'Elite', price: 999, priceINR: 999, credits: 10000, platforms: 12 },
  };

  res.json({
    success:     true,
    currentPlan: req.user.plan,
    planDetails: plans[req.user.plan] || plans.free,
    allPlans:    plans,
    creditCosts: CREDIT_COSTS,
  });
});

// ================================
// ADMIN - Cache stats (dev only)
// GET /api/user/cache-stats
// ================================
router.get('/cache-stats', protect, (req, res) => {
  if (process.env.NODE_ENV === 'production')
    return res.status(403).json({ success: false, message: 'Not allowed' });
  res.json({ success: true, cache: getCacheStats() });
});

module.exports = router;
                                   
