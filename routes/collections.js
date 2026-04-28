const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { findUserById, updateUser } = require('../store/db');

// ─── Helper: get collections from user ───────────────────────────────────────
function getUserCollections(user) {
  return user.collections || [];
}

// ─── GET all collections ──────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    const collections = getUserCollections(user);
    res.json({ success: true, data: collections });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── CREATE collection ────────────────────────────────────────────────────────
router.post('/', protect, async (req, res) => {
  try {
    const { name, emoji = '📁', color = '#6c47ff' } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Collection name daalo' });

    const user = await findUserById(req.user.id);
    const collections = getUserCollections(user);

    // Free plan: max 3 collections
    if (user.plan === 'free' && collections.length >= 3) {
      return res.status(403).json({ success: false, message: 'Free plan mein sirf 3 collections. Pro upgrade karo!', upgrade: true });
    }

    const newCol = {
      id: 'col_' + Date.now(),
      name: name.trim(),
      emoji,
      color,
      ads: [],
      sharedWith: [],
      createdAt: new Date().toISOString(),
    };

    collections.push(newCol);
    await updateUser(req.user.id, { collections });
    res.json({ success: true, message: 'Collection ban gayi!', data: newCol });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE collection ────────────────────────────────────────────────────────
router.delete('/:colId', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    const collections = getUserCollections(user).filter(c => c.id !== req.params.colId);
    await updateUser(req.user.id, { collections });
    res.json({ success: true, message: 'Collection delete ho gayi' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── RENAME collection ────────────────────────────────────────────────────────
router.patch('/:colId', protect, async (req, res) => {
  try {
    const { name, emoji, color } = req.body;
    const user = await findUserById(req.user.id);
    const collections = getUserCollections(user).map(c => {
      if (c.id !== req.params.colId) return c;
      return { ...c, ...(name && { name }), ...(emoji && { emoji }), ...(color && { color }) };
    });
    await updateUser(req.user.id, { collections });
    res.json({ success: true, message: 'Collection update ho gayi' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADD ad to collection ─────────────────────────────────────────────────────
router.post('/:colId/ads', protect, async (req, res) => {
  try {
    const { adId, adData } = req.body;
    if (!adId) return res.status(400).json({ success: false, message: 'adId zaroori hai' });

    const user = await findUserById(req.user.id);
    const collections = getUserCollections(user);
    const col = collections.find(c => c.id === req.params.colId);
    if (!col) return res.status(404).json({ success: false, message: 'Collection nahi mili' });

    if (col.ads.some(a => a.id === adId)) {
      return res.status(409).json({ success: false, message: 'Ad pehle se is collection mein hai' });
    }

    col.ads.push({ id: adId, addedAt: new Date().toISOString(), note: '', ...adData });
    await updateUser(req.user.id, { collections });
    res.json({ success: true, message: 'Ad collection mein add ho gayi!', total: col.ads.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── REMOVE ad from collection ────────────────────────────────────────────────
router.delete('/:colId/ads/:adId', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    const collections = getUserCollections(user).map(c => {
      if (c.id !== req.params.colId) return c;
      return { ...c, ads: c.ads.filter(a => a.id !== req.params.adId) };
    });
    await updateUser(req.user.id, { collections });
    res.json({ success: true, message: 'Ad remove ho gayi' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADD/UPDATE note on ad ────────────────────────────────────────────────────
router.patch('/:colId/ads/:adId/note', protect, async (req, res) => {
  try {
    const { note } = req.body;
    const user = await findUserById(req.user.id);
    const collections = getUserCollections(user).map(c => {
      if (c.id !== req.params.colId) return c;
      return {
        ...c,
        ads: c.ads.map(a => a.id === req.params.adId ? { ...a, note: note || '', noteUpdatedAt: new Date().toISOString() } : a)
      };
    });
    await updateUser(req.user.id, { collections });
    res.json({ success: true, message: 'Note save ho gaya!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── SHARE collection with team (Pro only) ────────────────────────────────────
router.post('/:colId/share', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (user.plan === 'free') {
      return res.status(403).json({ success: false, message: 'Team sharing Pro plan mein available hai', upgrade: true });
    }

    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email daalo' });

    const collections = getUserCollections(user).map(c => {
      if (c.id !== req.params.colId) return c;
      const sharedWith = c.sharedWith || [];
      if (!sharedWith.includes(email)) sharedWith.push(email);
      return { ...c, sharedWith };
    });

    await updateUser(req.user.id, { collections });
    res.json({ success: true, message: `Collection ${email} ke saath share ho gayi!` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
