const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth');
const { findUserById, updateUser, getUserDevices, removeDevice, checkSearchLimit } = require('../store/db');
const { getCacheStats } = require('../services/cache');

// ================================
// GET PROFILE
// GET /api/user/profile
// ================================
router.get('/profile', protect, (req, res) => {
  const user = findUserById(req.user.id);
  const limitInfo = checkSearchLimit(user);

  res.json({
    success: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      plan: user.plan,
      createdAt: user.createdAt
    },
    usage: {
      searchesUsed: user.searchCount || 0,
      searchLimit: limitInfo.limit,
      searchesRemaining: limitInfo.remaining,
      savedAds: user.savedAds?.length || 0
    }
  });
});

// ================================
// UPDATE PROFILE
// PUT /api/user/profile
// ================================
router.put('/profile', protect, (req, res) => {
  const { name } = req.body;

  if (!name || name.trim().length < 2) {
    return res.status(400).json({ success: false, message: 'Valid name daalo' });
  }

  updateUser(req.user.email, { name: name.trim() });
  res.json({ success: true, message: 'Profile update ho gayi' });
});

// ================================
// GET DEVICES
// GET /api/user/devices
// ================================
router.get('/devices', protect, (req, res) => {
  const devices = getUserDevices(req.user.id);
  res.json({
    success: true,
    devices: devices.map((d, i) => ({
      id: d,
      label: `Device ${i + 1}`,
      isCurrent: d === req.fingerprint
    }))
  });
});

// ================================
// REMOVE DEVICE (Force logout another device)
// DELETE /api/user/devices/:deviceId
// ================================
router.delete('/devices/:deviceId', protect, (req, res) => {
  const { deviceId } = req.params;
  removeDevice(req.user.id, deviceId);
  res.json({ success: true, message: 'Device remove ho gayi. Ab wahan se login karke naya device add kar sakte ho.' });
});

// ================================
// PLAN INFO
// GET /api/user/plan
// ================================
router.get('/plan', protect, (req, res) => {
  const plans = {
    free:   { name: 'Free',   price: 0,    searchLimit: 50,    savedAds: 50,    platforms: 2 },
    pro:    { name: 'Pro',    price: 79,   searchLimit: 9999,  savedAds: 99999, platforms: 12 },
    agency: { name: 'Agency', price: 199,  searchLimit: 99999, savedAds: 99999, platforms: 12 }
  };

  res.json({
    success: true,
    currentPlan: req.user.plan,
    planDetails: plans[req.user.plan] || plans.free,
    allPlans: plans
  });
});

// ================================
// ADMIN - Cache stats (sirf development mein)
// GET /api/user/cache-stats
// ================================
router.get('/cache-stats', protect, (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, message: 'Not allowed' });
  }
  res.json({ success: true, cache: getCacheStats() });
});

module.exports = router;
