const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { findUserById, updateUser } = require('../store/db');

// ─── GET all alerts ───────────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    res.json({ success: true, data: user.alerts || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── CREATE alert ─────────────────────────────────────────────────────────────
// type: 'competitor' | 'niche'
// value: brand name ya niche keyword
router.post('/', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);

    // Free plan: max 2 alerts
    const alerts = user.alerts || [];
    if (user.plan === 'free' && alerts.length >= 2) {
      return res.status(403).json({ success: false, message: 'Free plan mein sirf 2 alerts. Pro upgrade karo!', upgrade: true });
    }

    const { type, value, platform = 'tiktok' } = req.body;
    if (!type || !value) return res.status(400).json({ success: false, message: 'type aur value zaroori hain' });
    if (!['competitor', 'niche'].includes(type)) return res.status(400).json({ success: false, message: 'type: competitor ya niche hona chahiye' });

    const newAlert = {
      id: 'alert_' + Date.now(),
      type,
      value: value.trim(),
      platform,
      active: true,
      createdAt: new Date().toISOString(),
      lastChecked: null,
      triggeredCount: 0,
      recentMatches: [],
    };

    alerts.push(newAlert);
    await updateUser(req.user.id, { alerts });
    res.json({ success: true, message: `${type === 'competitor' ? 'Competitor' : 'Niche'} alert set ho gaya!`, data: newAlert });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE alert ─────────────────────────────────────────────────────────────
router.delete('/:alertId', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    const alerts = (user.alerts || []).filter(a => a.id !== req.params.alertId);
    await updateUser(req.user.id, { alerts });
    res.json({ success: true, message: 'Alert delete ho gaya' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── TOGGLE alert active/inactive ────────────────────────────────────────────
router.patch('/:alertId/toggle', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    const alerts = (user.alerts || []).map(a =>
      a.id === req.params.alertId ? { ...a, active: !a.active } : a
    );
    await updateUser(req.user.id, { alerts });
    const updated = alerts.find(a => a.id === req.params.alertId);
    res.json({ success: true, active: updated?.active, message: `Alert ${updated?.active ? 'on' : 'off'} ho gaya` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── CHECK alert (manual trigger — search for new ads) ───────────────────────
router.post('/:alertId/check', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    const alert = (user.alerts || []).find(a => a.id === req.params.alertId);
    if (!alert) return res.status(404).json({ success: false, message: 'Alert nahi mila' });

    // RapidAPI se search karo alert ki value ke liye
    const { searchTikTokAds } = require('../services/rapidApi');
    let results = [];
    try {
      const res2 = await searchTikTokAds({ keyword: alert.value, country: 'US', order: 'impression', period: '7' });
      const raw = res2?.data?.data?.materials || res2?.data?.materials || [];
      results = Array.isArray(raw) ? raw.slice(0, 5) : [];
    } catch (e) {
      console.error('Alert check search failed:', e.message);
    }

    // Update lastChecked
    const alerts = (user.alerts || []).map(a => {
      if (a.id !== req.params.alertId) return a;
      return {
        ...a,
        lastChecked: new Date().toISOString(),
        triggeredCount: (a.triggeredCount || 0) + (results.length > 0 ? 1 : 0),
        recentMatches: results.slice(0, 3).map(ad => ({
          id: ad.material_id || ad.id,
          title: ad.ad_title || ad.title || '',
          cover: ad.video_info?.cover || '',
          foundAt: new Date().toISOString(),
        })),
      };
    });

    await updateUser(req.user.id, { alerts });
    res.json({ success: true, found: results.length, data: results, message: results.length > 0 ? `${results.length} naye ads mile!` : 'Abhi koi naye ads nahi mile' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
