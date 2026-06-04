const express = require('express');
const router  = express.Router();

const { protect } = require('../middleware/auth');
const { findUserById, updateUser, getUserDevices, removeDevice, checkSearchLimit } = require('../store/db');
const { getCacheStats } = require('../services/cache');

// ================================
// GET PROFILE
// GET /api/user/profile
// ================================
router.get('/profile', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });

    const limitInfo = checkSearchLimit(user);
    res.json({
      success: true,
      user: {
        id:        user.id,
        name:      user.name,
        email:     user.email,
        plan:      user.plan,
        createdAt: user.createdAt,
      },
      usage: {
        searchesUsed:      user.searchCount || 0,
        searchLimit:       limitInfo.limit,
        searchesRemaining: limitInfo.remaining,
        savedAds:          user.savedAds?.length || 0,
      },
    });
  } catch (err) {
    console.error('[User] profile error:', err.message);
    res.status(500).json({ success: false, message: 'Profile load fail' });
  }
});

// ================================
// UPDATE PROFILE
// PUT /api/user/profile
// ================================
router.put('/profile', protect, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim().length < 2)
      return res.status(400).json({ success: false, message: 'Valid name daalo' });

    await updateUser(req.user.id, { name: name.trim() });
    res.json({ success: true, message: 'Profile update ho gayi' });
  } catch (err) {
    console.error('[User] update profile error:', err.message);
    res.status(500).json({ success: false, message: 'Profile update fail' });
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
    res.status(500).json({ success: false, message: 'Devices load fail' });
  }
});

// ================================
// REMOVE DEVICE
// DELETE /api/user/devices/:deviceId
// ================================
router.delete('/devices/:deviceId', protect, async (req, res) => {
  try {
    await removeDevice(req.user.id, req.params.deviceId);
    res.json({ success: true, message: 'Device remove ho gayi.' });
  } catch (err) {
    console.error('[User] remove device error:', err.message);
    res.status(500).json({ success: false, message: 'Device remove fail' });
  }
});

// ================================
// PLAN INFO
// GET /api/user/plan
// ================================
router.get('/plan', protect, (req, res) => {
  const plans = {
    free:   { name: 'Free',   price: 0,   searchLimit: 50,    savedAds: 50,    platforms: 2  },
    pro:    { name: 'Pro',    price: 79,  searchLimit: 9999,  savedAds: 99999, platforms: 12 },
    agency: { name: 'Agency', price: 199, searchLimit: 99999, savedAds: 99999, platforms: 12 },
  };

  res.json({
    success:     true,
    currentPlan: req.user.plan,
    planDetails: plans[req.user.plan] || plans.free,
    allPlans:    plans,
  });
});

// ================================
// ADMIN - Cache stats (sirf development mein)
// GET /api/user/cache-stats
// ================================
router.get('/cache-stats', protect, (req, res) => {
  if (process.env.NODE_ENV === 'production')
    return res.status(403).json({ success: false, message: 'Not allowed' });
  res.json({ success: true, cache: getCacheStats() });
});

module.exports = router;
                                   
