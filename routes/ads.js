const express = require('express');
const router  = express.Router();
const axios   = require('axios');

const { protect }      = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimiter');
const { checkSearchLimit, incrementSearchCount, updateUser, findUserById } = require('../store/db');
const {
  searchTikTokAds,
  getTikTokAdDetails,
  getAdvertiserAds,
  getTopProducts,
  getProductDetail,
  getTikTokVideoInfo,
  searchMetaAds,
  searchGoogleAds,
  getAliExpressHotProducts,
  getAliExpressCategories,
} = require('../services/rapidApi');

// ─── tiktok-video-no-watermark2 client (video URL fetch) ─────────────────────
const TT_KEY  = process.env.TIKTOK_VIDEO_KEY || process.env.RAPIDAPI_KEY;
const TT_HOST = 'tiktok-video-no-watermark2.p.rapidapi.com';
const ttVideoClient = axios.create({
  baseURL: `https://${TT_HOST}`,
  headers: {
    'x-rapidapi-key':  TT_KEY,
    'x-rapidapi-host': TT_HOST,
    'Content-Type':    'application/json'
  },
  timeout: 15000
});

// ─── Video Stream Proxy (CORS bypass + Range support) ────────────────────────
router.get('/video/stream', async (req, res) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { verifyAccessToken } = require('../utils/jwt');
  const decoded = verifyAccessToken(token);
  if (!decoded) return res.status(401).json({ success: false, message: 'Token invalid' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: 'URL zaroori hai' });

  try {
    const decodedUrl  = decodeURIComponent(url);
    const rangeHeader = req.headers['range'];

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
      'Content-Type':               contentType,
      'Accept-Ranges':              'bytes',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':              'public, max-age=3600',
    };
    if (videoRes.headers['content-length']) resHeaders['Content-Length'] = videoRes.headers['content-length'];
    if (videoRes.headers['content-range'])  resHeaders['Content-Range']  = videoRes.headers['content-range'];

    res.writeHead(statusCode, resHeaders);
    videoRes.data.pipe(res);
    videoRes.data.on('error', () => { if (!res.writableEnded) res.end(); });
    req.on('close', () => { videoRes.data.destroy(); });
  } catch (err) {
    console.error('Video stream error:', err.message);
    if (!res.headersSent) res.status(502).json({ success: false, message: 'Video stream fail: ' + err.message });
  }
});

// ─── Video Download Proxy ─────────────────────────────────────────────────────
router.get('/video/download', protect, async (req, res) => {
  const { url, filename = 'ad-video.mp4' } = req.query;
  if (!url) return res.status(400).json({ success: false, message: 'URL zaroori hai' });

  try {
    const videoRes = await axios.get(decodeURIComponent(url), {
      responseType: 'stream',
      timeout:      60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://www.tiktok.com/',
      }
    });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', videoRes.headers['content-type'] || 'video/mp4');
    if (videoRes.headers['content-length']) res.setHeader('Content-Length', videoRes.headers['content-length']);
    res.setHeader('Cache-Control', 'no-cache');

    videoRes.data.pipe(res);
    videoRes.data.on('error', (err) => {
      console.error('Download stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ success: false, message: 'Stream error' });
    });
  } catch (err) {
    console.error('Video download error:', err.message);
    res.status(500).json({ success: false, message: 'Video download fail: ' + err.message });
  }
});

// ─── Video URL Fetch (tiktok-video-no-watermark2 GET /) ──────────────────────
// Uses: GET /?url=https://www.tiktok.com/@user/video/VIDEO_ID&hd=1
const videoUrlCache = new Map();

router.get('/video/url', protect, async (req, res) => {
  // video_id = ad ka material_id/ad_id
  // vid_url  = ad.video_info.vid (direct CDN URL — agar available ho)
  const { video_id, vid_url, tiktok_url } = req.query;
  if (!video_id) return res.status(400).json({ success: false, message: 'video_id zaroori hai' });

  // Cache check — 1 ghante tak valid
  const cached = videoUrlCache.get(video_id);
  if (cached && Date.now() - cached.ts < 3600000) {
    return res.json({ success: true, play_url: cached.url, cover_url: cached.cover, from_cache: true });
  }

  try {
    let playUrl  = null;
    let coverUrl = null;

    // Strategy 1: tiktok_url se GET /?url=...&hd=1 — fresh no-watermark URL
    // tiktok_url = frontend se pass hota hai (ad.tiktok_item_url ya constructed)
    if (tiktok_url) {
      try {
        const decodedTiktokUrl = decodeURIComponent(tiktok_url);
        console.log('Fetching video via tiktok_url:', decodedTiktokUrl);
        const r = await ttVideoClient.get('/', {
          params: { url: decodedTiktokUrl, hd: 1 }
        });
        const d = r.data?.data || r.data;
        playUrl  = d?.play || d?.hdplay || d?.wmplay || null;
        coverUrl = d?.cover || d?.origin_cover || null;
        if (playUrl) console.log('✅ Got play URL from tiktok_url strategy');
      } catch (e1) {
        console.log('tiktok_url strategy failed:', e1.response?.status, e1.message);
      }
    }

    // Strategy 2: Ad Detail API se tiktok_item_url nikalo, phir play URL fetch karo
    if (!playUrl) {
      try {
        const detailRes = await ttVideoClient.get('/ads/top/ads/detail', {
          params: { material_id: video_id }
        });
        const d = detailRes.data?.data || detailRes.data;
        const itemUrl = d?.tiktok_item_url || d?.share_url || d?.item_url || null;
        if (itemUrl) {
          console.log('Got tiktok_item_url from detail:', itemUrl);
          const r2 = await ttVideoClient.get('/', {
            params: { url: itemUrl, hd: 1 }
          });
          const d2 = r2.data?.data || r2.data;
          playUrl  = d2?.play || d2?.hdplay || d2?.wmplay || null;
          coverUrl = d2?.cover || d2?.origin_cover || d?.video_info?.cover || null;
          if (playUrl) console.log('✅ Got play URL from detail+fetch strategy');
        }
      } catch (e2) {
        console.log('Detail strategy failed:', e2.message);
      }
    }

    if (!playUrl) {
      return res.status(404).json({ success: false, message: 'Video URL nahi mili — TikTok pe dekho', video_id });
    }

    // Cache mein save karo (30 min — URLs expire hote hain)
    videoUrlCache.set(video_id, { url: playUrl, cover: coverUrl, ts: Date.now() });
    res.json({ success: true, play_url: playUrl, cover_url: coverUrl });

  } catch (err) {
    if (err.response?.status === 429) {
      return res.status(429).json({ success: false, message: 'Rate limit — thodi der baad try karo' });
    }
    console.error('Video URL fetch error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── AI Ad Analysis ───────────────────────────────────────────────────────────
router.post('/ai/analyze', protect, async (req, res) => {
  const { adData } = req.body;
  if (!adData) return res.status(400).json({ success: false, message: 'adData zaroori hai' });

  const RAPID_KEY = process.env.RAPIDAPI_AI_KEY || process.env.RAPIDAPI_KEY;
  if (!RAPID_KEY) return res.status(500).json({ success: false, message: 'RAPIDAPI_AI_KEY set karo' });

  const {
    likes = 0, comments = 0, ctr = 0, impression = 0, cost = 0,
    title = '', objective = '', industry = '', runDays = 0,
    isActive = false, countries = []
  } = adData;

  const prompt = `You are an expert TikTok advertising analyst. Analyze this ad and return ONLY valid JSON — no markdown, no explanation.

AD DATA:
- Title: "${title}"
- Objective: ${objective || 'unknown'}
- Industry: ${industry || 'unknown'}
- Likes: ${likes}
- Comments: ${comments}
- CTR: ${ctr}%
- Impressions: ${impression}
- Spend: $${cost}
- Days Running: ${runDays}
- Still Active: ${isActive}
- Countries: ${Array.isArray(countries) ? countries.join(', ') : 'unknown'}

Return ONLY this JSON (no markdown, no extra text):
{"overall_score":<0-100>,"verdict":"<WINNING|AVERAGE|WEAK|VIRAL>","scores":{"hook_strength":<0-25>,"engagement_rate":<0-25>,"spend_efficiency":<0-25>,"longevity":<0-25>},"hook_analysis":"<2 sentences>","target_audience":"<1-2 sentences>","cta_analysis":"<1-2 sentences>","winning_elements":["<item1>","<item2>","<item3>"],"weak_points":["<item1>","<item2>"],"recommendations":["<action1>","<action2>","<action3>"],"competitor_threat":"<LOW|MEDIUM|HIGH>","scaling_potential":"<LOW|MEDIUM|HIGH>","best_for":"<1 sentence>"}`;

  try {
    const response = await axios.post(
      'https://open-ai21.p.rapidapi.com/claude3',
      { messages: [{ role: 'user', content: prompt }], web_access: false },
      {
        headers: {
          'Content-Type':    'application/json',
          'x-rapidapi-host': process.env.RAPIDAPI_AI_HOST || 'open-ai21.p.rapidapi.com',
          'x-rapidapi-key':  RAPID_KEY
        },
        timeout: 30000
      }
    );

    const raw   = response.data?.result || response.data?.message || response.data?.content || '';
    const text  = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const clean = text.replace(/```json|```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON nahi mila response mein');

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ success: true, analysis: parsed });

  } catch (err) {
    console.error('AI analyze error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: 'AI analysis fail: ' + (err.response?.data?.message || err.message) });
  }
});

// ─── TikTok Ads List ──────────────────────────────────────────────────────────
router.get('/tiktok', protect, async (req, res) => {
  try {
    const { country = 'US', order = 'impression', period = '30' } = req.query;
    const result = await searchTikTokAds({ country, order, period });
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── TikTok Ad Detail ─────────────────────────────────────────────────────────
router.get('/tiktok/:adId', protect, async (req, res) => {
  try {
    const result = await getTikTokAdDetails(req.params.adId);
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Advertiser ke saare ads ──────────────────────────────────────────────────
router.get('/advertiser/:advertiserId', protect, async (req, res) => {
  try {
    const { country = 'US', period = '30' } = req.query;
    const result = await getAdvertiserAds(req.params.advertiserId, { country, period });
    const raw = result?.data?.data?.materials || result?.data?.materials || result?.materials || [];
    res.json({ success: true, data: Array.isArray(raw) ? raw : [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Top Products ─────────────────────────────────────────────────────────────
// GET /api/ads/products?country=US&orderBy=post&last=7&page=1
router.get('/products', protect, async (req, res) => {
  try {
    const {
      page       = 1,
      limit      = 20,
      country    = 'US',
      ecomType   = 'l3',
      orderBy    = 'post',
      orderType  = 'desc',
      categoryId = '',
      periodType = 'last',
      last       = 7,
    } = req.query;

    const result = await getTopProducts({ page, limit, country, ecomType, orderBy, orderType, categoryId, periodType, last });
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Product Detail ───────────────────────────────────────────────────────────
// GET /api/ads/products/:productId?country=US&last=7
router.get('/products/:productId', protect, async (req, res) => {
  try {
    const { country = 'US', periodType = 'last', last = 7 } = req.query;
    const result = await getProductDetail(req.params.productId, { country, periodType, last });
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── AliExpress ───────────────────────────────────────────────────────────────
router.get('/aliexpress', protect, async (req, res) => {
  try {
    const { catId = '15', page = 1, currency = 'USD', keyword = '' } = req.query;
    const result = await getAliExpressHotProducts({ catId, page, currency, keyword });
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/aliexpress/categories', protect, async (req, res) => {
  try {
    const result = await getAliExpressCategories();
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Search ───────────────────────────────────────────────────────────────────
router.get('/search', protect, searchLimiter, async (req, res) => {
  try {
    const { keyword = '', platform = 'tiktok', country = 'US' } = req.query;
    if (!keyword.trim()) return res.status(400).json({ success: false, message: 'Keyword daalo' });

    const limitCheck = checkSearchLimit(req.user);
    if (!limitCheck.allowed) return res.status(429).json({ success: false, message: 'Daily limit khatam.', upgrade: req.user.plan === 'free' });

    let results = [];
    if (platform === 'tiktok' || platform === 'all') {
      try {
        const tt  = await searchTikTokAds({ keyword, country, order: 'impression', period: '30' });
        const raw = tt?.data?.data?.materials || tt?.data?.materials || tt?.materials || [];
        if (Array.isArray(raw)) results.push(...raw);
      } catch (e) { console.error('TikTok search error:', e.message); }
    }

    await incrementSearchCount(req.user.id);
    res.json({ success: true, keyword, platform, total: results.length, remaining: limitCheck.remaining - 1, data: results });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Save Ad ──────────────────────────────────────────────────────────────────
router.post('/save', protect, async (req, res) => {
  try {
    const { adId, adData, folderName = 'Default' } = req.body;
    if (!adId) return res.status(400).json({ success: false, message: 'Ad ID zaroori hai' });

    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });

    if (user.plan === 'free' && (user.savedAds || []).length >= 50)
      return res.status(403).json({ success: false, message: 'Free plan mein sirf 50 ads.', upgrade: true });

    const savedAds = user.savedAds || [];
    if (savedAds.some(a => a.id === adId))
      return res.status(409).json({ success: false, message: 'Pehle se saved hai' });

    savedAds.push({ id: adId, folder: folderName, savedAt: new Date().toISOString(), ...adData });
    await updateUser(req.user.id, { savedAds });
    res.json({ success: true, message: 'Ad save ho gayi!', totalSaved: savedAds.length });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Saved Ads ────────────────────────────────────────────────────────────────
router.get('/saved', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    const savedAds = user?.savedAds || [];
    res.json({ success: true, total: savedAds.length, data: savedAds });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/save/:adId', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });

    const before   = (user.savedAds || []).length;
    const savedAds = (user.savedAds || []).filter(a => a.id !== req.params.adId);
    if (savedAds.length === before) return res.status(404).json({ success: false, message: 'Ad nahi mili' });

    await updateUser(req.user.id, { savedAds });
    res.json({ success: true, message: 'Ad remove ho gayi' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── DEBUG — production mein bhi chalega temporarily ─────────────────────────
router.get('/debug-api', async (req, res) => {
  try {
    // Step 1: Top ads fetch karo
    const r = await ttVideoClient.get('/ads/top/ads', {
      params: { page: 1, limit: 1, country_code: 'US', order_by: 'impression', period: '30' }
    });
    const materials = r.data?.data?.data?.materials || r.data?.data?.materials || [];
    const firstAd   = materials[0] || {};
    const materialId = firstAd.material_id || firstAd.id || '';

    // Step 2: Ad detail fetch karo
    let detailData = null;
    if (materialId) {
      try {
        const d = await ttVideoClient.get('/ads/top/ads/detail', {
          params: { material_id: materialId }
        });
        detailData = d.data?.data || d.data;
      } catch(e) { detailData = { error: e.message }; }
    }

    res.json({
      status: 'ok',
      first_ad_keys: Object.keys(firstAd),
      video_info_keys: firstAd.video_info ? Object.keys(firstAd.video_info) : 'NO video_info',
      tiktok_item_url: firstAd.tiktok_item_url || 'NOT FOUND',
      share_url:       firstAd.share_url       || 'NOT FOUND',
      item_url:        firstAd.item_url        || 'NOT FOUND',
      video_vid:       firstAd.video_info?.vid ? firstAd.video_info.vid.substring(0, 80) + '...' : 'NOT FOUND',
      material_id:     materialId,
      detail_keys:     detailData ? Object.keys(detailData) : [],
      detail_video_info: detailData?.video_info ? Object.keys(detailData.video_info) : 'NO video_info in detail',
      detail_tiktok_url: detailData?.tiktok_item_url || detailData?.share_url || 'NOT FOUND in detail',
    });
  } catch (err) {
    res.json({ status: 'error', message: err.message, api_response: err.response?.data });
  }
});

module.exports = router;
