const express = require('express');
const router  = express.Router();

const { protect }      = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimiter');
const { checkSearchLimit, incrementSearchCount, updateUser, findUserById } = require('../store/db');
const {
  searchTikTokAds, getTikTokAdDetails, getAdvertiserAds,
  searchMetaAds, searchGoogleAds,
  getAliExpressHotProducts, getAliExpressCategories
} = require('../services/rapidApi');

// ─── Video Stream Proxy (CORS bypass + Range support for seeking) ─────────────
router.get('/video/stream', async (req, res) => {
  // <video> tag headers nahi bhej sakta, isliye token query param se bhi accept
  const token = req.query.token || (req.headers.authorization||'').replace('Bearer ','');
  if (!token) return res.status(401).json({ success:false, message:'Unauthorized' });

  const { verifyAccessToken } = require('../utils/jwt');
  const decoded = verifyAccessToken(token);
  if (!decoded) return res.status(401).json({ success:false, message:'Token invalid' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ success:false, message:'URL zaroori hai' });

  try {
    const axios       = require('axios');
    const decodedUrl  = decodeURIComponent(url);
    const rangeHeader = req.headers['range'];

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer':    'https://www.tiktok.com/',
      'Origin':     'https://www.tiktok.com',
      'Accept':     '*/*',
    };
    if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

    const videoRes = await axios.get(decodedUrl, {
      responseType: 'stream',
      timeout:      30000,
      headers:      upstreamHeaders,
    });

    const statusCode  = videoRes.status === 206 ? 206 : 200;
    const contentType = videoRes.headers['content-type'] || 'video/mp4';

    const resHeaders = {
      'Content-Type':              contentType,
      'Accept-Ranges':             'bytes',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':             'public, max-age=3600',
    };
    if (videoRes.headers['content-length']) resHeaders['Content-Length'] = videoRes.headers['content-length'];
    if (videoRes.headers['content-range'])  resHeaders['Content-Range']  = videoRes.headers['content-range'];

    res.writeHead(statusCode, resHeaders);
    videoRes.data.pipe(res);
    videoRes.data.on('error', () => { if (!res.writableEnded) res.end(); });
    req.on('close', () => { videoRes.data.destroy(); });
  } catch(err) {
    console.error('Video stream error:', err.message);
    if (!res.headersSent) res.status(502).json({ success:false, message:'Video stream fail: ' + err.message });
  }
});

// ─── Video Download Proxy ─────────────────────────────────────────────────────
router.get('/video/download', protect, async (req, res) => {
  const { url, filename = 'ad-video.mp4' } = req.query;
  if (!url) return res.status(400).json({ success:false, message:'URL zaroori hai' });

  try {
    const axios    = require('axios');
    const videoRes = await axios.get(decodeURIComponent(url), {
      responseType: 'stream',
      timeout:      60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://www.tiktok.com/',
      }
    });

    const contentType   = videoRes.headers['content-type'] || 'video/mp4';
    const contentLength = videoRes.headers['content-length'];

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'no-cache');

    videoRes.data.pipe(res);
    videoRes.data.on('error', (err) => {
      console.error('Download stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ success:false, message:'Stream error' });
    });
  } catch(err) {
    console.error('Video download error:', err.message);
    res.status(500).json({ success:false, message:'Video download fail: ' + err.message });
  }
});

// DEBUG: RapidAPI test (no auth) — production mein hatana
router.get('/debug-api', async (req, res) => {
  const axios = require('axios');
  const KEY   = process.env.RAPIDAPI_KEY;
  const HOST  = process.env.RAPIDAPI_HOST;
  try {
    const r = await axios.get(`https://${HOST}/ads/top/ads`, {
      params:  { page:1, limit:3, country_code:'US', order_by:'impression', period:'30', ad_format:1 },
      headers: { 'x-rapidapi-key':KEY, 'x-rapidapi-host':HOST }
    });
    const d = r.data;
    res.json({
      status:'ok', key_set:!!KEY, host:HOST,
      response_keys: Object.keys(d),
      code:d.code, msg:d.msg,
      data_type: typeof d.data,
      data_keys: d.data ? Object.keys(d.data) : null,
      materials_count: d.data?.data?.materials?.length ?? d.data?.materials?.length ?? 'N/A',
      sample: JSON.stringify(d).substring(0,600)
    });
  } catch(err) {
    res.json({ status:'error', message:err.message, key_set:!!KEY, host:HOST, resp:err.response?.data });
  }
});

// ─── TikTok Ads List ──────────────────────────────────────────────────────────
router.get('/tiktok', protect, async (req, res) => {
  try {
    const { country='US', order='impression', period='30' } = req.query;
    const result = await searchTikTokAds({ country, order, period });
    res.json({ success:true, data:result });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// ─── TikTok Ad Detail ─────────────────────────────────────────────────────────
router.get('/tiktok/:adId', protect, async (req, res) => {
  try {
    const result = await getTikTokAdDetails(req.params.adId);
    res.json({ success:true, data:result });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// ─── Advertiser ke saare ads ──────────────────────────────────────────────────
router.get('/advertiser/:advertiserId', protect, async (req, res) => {
  try {
    const { country='US', period='30' } = req.query;
    const result = await getAdvertiserAds(req.params.advertiserId, { country, period });
    const raw = result?.data?.data?.materials || result?.data?.materials || result?.materials || [];
    res.json({ success:true, data:Array.isArray(raw)?raw:[] });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// ─── AliExpress ───────────────────────────────────────────────────────────────
router.get('/aliexpress', protect, async (req, res) => {
  try {
    const { catId='15', page=1, currency='USD' } = req.query;
    const result = await getAliExpressHotProducts({ catId, page, currency });
    res.json({ success:true, data:result });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

router.get('/aliexpress/categories', protect, async (req, res) => {
  try {
    const result = await getAliExpressCategories();
    res.json({ success:true, data:result });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// ─── Search ───────────────────────────────────────────────────────────────────
router.get('/search', protect, searchLimiter, async (req, res) => {
  try {
    const { keyword='', platform='tiktok', country='US' } = req.query;
    if (!keyword.trim()) return res.status(400).json({ success:false, message:'Keyword daalo' });

    const limitCheck = checkSearchLimit(req.user);
    if (!limitCheck.allowed) return res.status(429).json({ success:false, message:'Daily limit khatam.', upgrade:req.user.plan==='free' });

    let results = [];
    if (platform==='tiktok'||platform==='all') {
      try {
        const tt  = await searchTikTokAds({ keyword, country, order:'impression', period:'30' });
        const raw = tt?.data?.data?.materials || tt?.data?.materials || tt?.materials || [];
        if (Array.isArray(raw)) results.push(...raw);
      } catch(e) { console.error('TikTok search error:', e.message); }
    }
    await incrementSearchCount(req.user.id);
    res.json({ success:true, keyword, platform, total:results.length, remaining:limitCheck.remaining-1, data:results });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// ─── Save Ad ──────────────────────────────────────────────────────────────────
router.post('/save', protect, async (req, res) => {
  try {
    const { adId, adData, folderName='Default' } = req.body;
    if (!adId) return res.status(400).json({ success:false, message:'Ad ID zaroori hai' });

    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success:false, message:'User nahi mila' });

    if (user.plan==='free' && (user.savedAds||[]).length >= 50)
      return res.status(403).json({ success:false, message:'Free plan mein sirf 50 ads.', upgrade:true });

    const savedAds = user.savedAds || [];
    if (savedAds.some(a=>a.id===adId))
      return res.status(409).json({ success:false, message:'Pehle se saved hai' });

    savedAds.push({ id:adId, folder:folderName, savedAt:new Date().toISOString(), ...adData });
    await updateUser(req.user.id, { savedAds });
    res.json({ success:true, message:'Ad save ho gayi!', totalSaved:savedAds.length });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

// ─── Saved Ads ────────────────────────────────────────────────────────────────
router.get('/saved', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    const savedAds = user?.savedAds || [];
    res.json({ success:true, total:savedAds.length, data:savedAds });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

router.delete('/save/:adId', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success:false, message:'User nahi mila' });

    const before   = (user.savedAds||[]).length;
    const savedAds = (user.savedAds||[]).filter(a=>a.id!==req.params.adId);
    if (savedAds.length===before) return res.status(404).json({ success:false, message:'Ad nahi mili' });

    await updateUser(req.user.id, { savedAds });
    res.json({ success:true, message:'Ad remove ho gayi' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

module.exports = router;
