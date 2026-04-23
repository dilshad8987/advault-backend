const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimiter');
const { checkSearchLimit, incrementSearchCount, updateUser, findUserById } = require('../store/db');
const {
  searchTikTokAds,
  getTikTokAdDetails,
  searchMetaAds,
  searchGoogleAds,
  getAliExpressHotProducts,
  getAliExpressCategories
} = require('../services/rapidApi');

router.get('/tiktok', protect, async (req, res) => {
  try {
    const { country = 'US', order = 'impression', period = '30' } = req.query;
    const result = await searchTikTokAds({ country, order, period });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/tiktok/:adId', protect, async (req, res) => {
  try {
    const result = await getTikTokAdDetails(req.params.adId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/aliexpress', protect, async (req, res) => {
  try {
    const { catId = '15', page = 1, currency = 'USD' } = req.query;
    const result = await getAliExpressHotProducts({ catId, page, currency });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/aliexpress/categories', protect, async (req, res) => {
  try {
    const result = await getAliExpressCategories();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/search', protect, searchLimiter, async (req, res) => {
  try {
    const { keyword = '', platform = 'tiktok', country = 'US' } = req.query;

    if (!keyword.trim()) {
      return res.status(400).json({ success: false, message: 'Keyword daalo' });
    }

    const limitCheck = checkSearchLimit(req.user);
    if (!limitCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: 'Daily limit khatam. Kal try karo ya Pro lo.',
        upgrade: req.user.plan === 'free'
      });
    }

    let results = [];

    if (platform === 'tiktok' || platform === 'all') {
      try {
        const tt = await searchTikTokAds({ keyword, country, order: 'impression', period: '30' });
        const raw = tt?.data?.data?.materials
                 || tt?.data?.materials
                 || tt?.materials
                 || [];
        if (Array.isArray(raw)) results.push(...raw);
      } catch(e) { console.error('TikTok search error:', e.message); }
    }

    incrementSearchCount(req.user.email);

    res.json({
      success: true,
      keyword,
      platform,
      total: results.length,
      remaining: limitCheck.remaining - 1,
      data: results
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/save', protect, async (req, res) => {
  try {
    const { adId, adData, folderName = 'Default' } = req.body;

    if (!adId) {
      return res.status(400).json({ success: false, message: 'Ad ID zaroori hai' });
    }

    const user = findUserById(req.user.id);

    if (user.plan === 'free' && user.savedAds.length >= 50) {
      return res.status(403).json({
        success: false,
        message: 'Free plan mein sirf 50 ads. Pro upgrade karo.',
        upgrade: true
      });
    }

    const alreadySaved = user.savedAds.some(a => a.id === adId);
    if (alreadySaved) {
      return res.status(409).json({ success: false, message: 'Pehle se saved hai' });
    }

    user.savedAds.push({
      id: adId,
      folder: folderName,
      savedAt: new Date().toISOString(),
      ...adData
    });

    updateUser(user.email, { savedAds: user.savedAds });
    res.json({ success: true, message: 'Ad save ho gayi!', totalSaved: user.savedAds.length });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/saved', protect, (req, res) => {
  const user = findUserById(req.user.id);
  res.json({ success: true, total: user.savedAds.length, data: user.savedAds });
});

router.delete('/save/:adId', protect, (req, res) => {
  const user = findUserById(req.user.id);
  const before = user.savedAds.length;
  user.savedAds = user.savedAds.filter(a => a.id !== req.params.adId);

  if (user.savedAds.length === before) {
    return res.status(404).json({ success: false, message: 'Ad nahi mili' });
  }

  updateUser(user.email, { savedAds: user.savedAds });
  res.json({ success: true, message: 'Ad remove ho gayi' });
});

module.exports = router;
