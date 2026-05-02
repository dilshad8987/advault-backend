// routes/ads.js — FULL DATA MongoDB Caching
//
// Ab sirf video URL nahi — POORA AD DATA cached hai:
// - Video URL, cover, duration
// - Likes, comments, shares, views, CTR
// - Title, industry, objective
// - Advertiser info
// - Pura raw response bhi
//
// FLOW:
// User A  → /api/ads/tiktok → API call → sab MongoDB mein save (24hr TTL)
// User B  → /api/ads/tiktok → MongoDB se milega (no API call!)
// User C  → /api/ads/tiktok/:adId → MongoDB se milega
// User D  → /api/ads/video/url → MongoDB se video URL milegi
// 24hr baad → MongoDB TTL auto-delete → fresh cycle

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');

const { protect }       = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimiter');
const { checkSearchLimit, incrementSearchCount, updateUser, findUserById } = require('../store/db');

const {
  searchTikTokAds,
  getTikTokAdDetails,
  getAdvertiserAds,
  getTopProducts,
  getProductDetail,
  getTrendingVideos,
  getTrendingHashtags,
  getTrendingSounds,
  getTrendingCreators,
  getAliExpressHotProducts,
  getAliExpressCategories,
  getMetaPageAds,
  searchMetaAdsByKeyword,
  getMetaPageAdDetails,
} = require('../services/rapidApi');

// ─── MongoDB Cache Service ────────────────────────────────────────────────────
const {
  getOrFetchAdsList,
  getOrFetchAdDetail,
  getOrFetchVideoUrl,
  invalidateAdCache,
  invalidateListCache,
  getCacheStats,
} = require('../services/mongoAdCache');

// ─── TikTok API client (video URL ke liye) ────────────────────────────────────
const TT_KEY  = process.env.RAPIDAPI_KEY;
const TT_HOST = 'tiktok-scraper7.p.rapidapi.com';
const ttVideoClient = axios.create({
  baseURL: `https://${TT_HOST}`,
  headers: {
    'x-rapidapi-key':  TT_KEY,
    'x-rapidapi-host': TT_HOST,
    'Content-Type':    'application/json',
  },
  timeout: 15000,
});

// ─── Video Stream Proxy ───────────────────────────────────────────────────────
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
      responseType: 'stream', timeout: 30000, headers: upstreamHeaders,
    });

    const statusCode  = videoRes.status === 206 ? 206 : 200;
    const contentType = videoRes.headers['content-type'] || 'video/mp4';
    const resHeaders  = {
      'Content-Type':                contentType,
      'Accept-Ranges':               'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=3600',
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
      responseType: 'stream', timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer':    'https://www.tiktok.com/',
      },
    });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', videoRes.headers['content-type'] || 'video/mp4');
    if (videoRes.headers['content-length']) res.setHeader('Content-Length', videoRes.headers['content-length']);
    res.setHeader('Cache-Control', 'no-cache');
    videoRes.data.pipe(res);
    videoRes.data.on('error', () => {
      if (!res.headersSent) res.status(500).json({ success: false, message: 'Stream error' });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Video download fail: ' + err.message });
  }
});

// ─── Video URL — MongoDB Cached ───────────────────────────────────────────────
router.get('/video/url', protect, async (req, res) => {
  const { video_id, tiktok_url } = req.query;
  if (!video_id) return res.status(400).json({ success: false, message: 'video_id zaroori hai' });

  try {
    const result = await getOrFetchVideoUrl(
      video_id,
      async () => {
        let playUrl  = null;
        let coverUrl = null;

        if (tiktok_url) {
          try {
            const r = await ttVideoClient.get('/', {
              params: { url: decodeURIComponent(tiktok_url), hd: 1 },
            });
            const d = r.data?.data || r.data;
            playUrl  = d?.play || d?.hdplay || d?.wmplay || null;
            coverUrl = d?.cover || d?.origin_cover || null;
          } catch (e) {
            console.log('tiktok_url strategy failed:', e.message);
          }
        }

        if (!playUrl) {
          try {
            const detailRes = await ttVideoClient.get('/ads/top/ads/detail', {
              params: { material_id: video_id },
            });
            const d = detailRes.data?.data || detailRes.data;
            const videoUrlObj = d?.video_info?.video_url;
            coverUrl = d?.video_info?.cover || coverUrl || null;

            if (videoUrlObj && typeof videoUrlObj === 'object') {
              playUrl = videoUrlObj['720p'] || videoUrlObj['540p']
                     || videoUrlObj['480p'] || videoUrlObj['360p']
                     || Object.values(videoUrlObj)[0] || null;
            } else if (typeof videoUrlObj === 'string') {
              playUrl = videoUrlObj;
            }
          } catch (e) {
            console.log('Detail strategy failed:', e.message);
          }
        }

        if (!playUrl) throw new Error('Video URL nahi mili — TikTok pe dekho');
        return { play_url: playUrl, cover_url: coverUrl };
      },
      req.user?.id || null
    );

    res.json({
      success:    true,
      play_url:   result.play_url,
      cover_url:  result.cover_url,
      from_cache: result.from_cache,
      cache_type: result.cache_type,
    });

  } catch (err) {
    if (err.response?.status === 429)
      return res.status(429).json({ success: false, message: 'Rate limit — thodi der baad try karo' });
    if (err.message?.includes('Video URL nahi mili'))
      return res.status(404).json({ success: false, message: err.message, video_id });
    console.error('Video URL fetch error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Cache Invalidate ─────────────────────────────────────────────────────────
router.post('/cache/invalidate', protect, async (req, res) => {
  const { ad_id, country, order, period } = req.body;
  try {
    const result = {};
    if (ad_id) result.ad_deleted = await invalidateAdCache(ad_id);
    if (country && order && period) result.list_deleted = await invalidateListCache(country, order, period);
    res.json({ success: true, message: 'Cache clear — agli request fresh data legi', ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Cache Stats ──────────────────────────────────────────────────────────────
router.get('/cache/stats', protect, async (req, res) => {
  try {
    res.json({ success: true, data: await getCacheStats() });
  } catch (err) {
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
    isActive = false, countries = [],
  } = adData;

  const prompt = `You are an expert TikTok advertising analyst. Analyze this ad and return ONLY valid JSON — no markdown, no explanation.\n\nAD DATA:\n- Title: "${title}"\n- Objective: ${objective || 'unknown'}\n- Industry: ${industry || 'unknown'}\n- Likes: ${likes}\n- Comments: ${comments}\n- CTR: ${ctr}%\n- Impressions: ${impression}\n- Spend: $${cost}\n- Days Running: ${runDays}\n- Still Active: ${isActive}\n- Countries: ${Array.isArray(countries) ? countries.join(', ') : 'unknown'}\n\nReturn ONLY this JSON:\n{"overall_score":<0-100>,"verdict":"<WINNING|AVERAGE|WEAK|VIRAL>","scores":{"hook_strength":<0-25>,"engagement_rate":<0-25>,"spend_efficiency":<0-25>,"longevity":<0-25>},"hook_analysis":"<2 sentences>","target_audience":"<1-2 sentences>","cta_analysis":"<1-2 sentences>","winning_elements":["<item1>","<item2>","<item3>"],"weak_points":["<item1>","<item2>"],"recommendations":["<action1>","<action2>","<action3>"],"competitor_threat":"<LOW|MEDIUM|HIGH>","scaling_potential":"<LOW|MEDIUM|HIGH>","best_for":"<1 sentence>"}`;

  try {
    const response = await axios.post(
      'https://open-ai21.p.rapidapi.com/claude3',
      { messages: [{ role: 'user', content: prompt }], web_access: false },
      {
        headers: {
          'Content-Type':    'application/json',
          'x-rapidapi-host': process.env.RAPIDAPI_AI_HOST || 'open-ai21.p.rapidapi.com',
          'x-rapidapi-key':  RAPID_KEY,
        },
        timeout: 30000,
      }
    );
    const raw   = response.data?.result || response.data?.message || response.data?.content || '';
    const text  = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const clean = text.replace(/```json|```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON nahi mila');
    res.json({ success: true, analysis: JSON.parse(jsonMatch[0]) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'AI analysis fail: ' + (err.response?.data?.message || err.message) });
  }
});

// ─── TikTok Ads List — MONGODB CACHED ────────────────────────────────────────
router.get('/tiktok', protect, async (req, res) => {
  const { country = 'US', order = 'like', period = '7' } = req.query;

  try {
    const cacheResult = await getOrFetchAdsList(
      country, order, period,
      async () => {
        try {
          return await searchTikTokAds({ country, order, period });
        } catch (primaryErr) {
          if (country !== 'US') {
            try { return await searchTikTokAds({ country: 'US', order, period }); }
            catch (e) {}
          }
          if (period !== '30') {
            try { return await searchTikTokAds({ country: 'US', order: 'like', period: '30' }); }
            catch (e) {}
          }
          throw primaryErr;
        }
      },
      req.user?.id || null
    );

    res.json({
      success:    true,
      from_cache: cacheResult.from_cache,
      cache_type: cacheResult.cache_type,
      data:       cacheResult.data,
    });
  } catch (err) {
    if (err.response?.status === 429)
      return res.status(429).json({ success: false, message: 'Rate limit — thodi der baad try karo' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── TikTok Ad Detail — MONGODB CACHED ───────────────────────────────────────
router.get('/tiktok/:adId', protect, async (req, res) => {
  try {
    const result = await getOrFetchAdDetail(
      req.params.adId,
      () => getTikTokAdDetails(req.params.adId),
      req.user?.id || null
    );
    res.json({ success: true, from_cache: result.from_cache, data: result.data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Advertiser Ads ───────────────────────────────────────────────────────────
router.get('/advertiser/:advertiserId', protect, async (req, res) => {
  try {
    const { country = 'US', period = '30' } = req.query;
    const result = await getAdvertiserAds(req.params.advertiserId, { country, period });
    const raw = result?.data?.data?.materials || result?.data?.materials || result?.materials || [];
    res.json({ success: true, data: Array.isArray(raw) ? raw : [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Top Products ─────────────────────────────────────────────────────────────
router.get('/products', protect, async (req, res) => {
  try {
    const { page = 1, limit = 20, country = 'US', ecomType = 'l3', orderBy = 'post',
            orderType = 'desc', categoryId = '', periodType = 'last', last = 7 } = req.query;
    const result = await getTopProducts({ page, limit, country, ecomType, orderBy, orderType, categoryId, periodType, last });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Product Detail ───────────────────────────────────────────────────────────
router.get('/products/:productId', protect, async (req, res) => {
  try {
    const { country = 'US', periodType = 'last', last = 7 } = req.query;
    const result = await getProductDetail(req.params.productId, { country, periodType, last });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Meta Ads Library ─────────────────────────────────────────────────────────

// GET /api/ads/meta — search by keyword (trending/discovery)
router.get('/meta', protect, async (req, res) => {
  const { keyword = 'product', country = 'ALL', activeStatus = 'ACTIVE' } = req.query;
  try {
    const result = await searchMetaAdsByKeyword({ keyword, country, activeStatus });

    // Actual API shape: { data: { keyword_results: [...], page_results: [...] } }
    // keyword_results = direct ad objects (preferred, but often empty)
    // page_results    = Facebook page objects with ad info
    const inner = result?.data || result;
    let raw = [];

    if (Array.isArray(inner?.keyword_results) && inner.keyword_results.length > 0) {
      raw = inner.keyword_results;
    } else if (Array.isArray(inner?.page_results) && inner.page_results.length > 0) {
      raw = inner.page_results.map(p => ({
        id:                      p.page_id || p.id,
        page_name:               p.page_name || p.name || '',
        ad_creative_bodies:      p.ad_body ? [p.ad_body] : (p.description ? [p.description] : [p.page_name || '']),
        ad_creative_link_titles: p.page_name ? [p.page_name] : [],
        ad_delivery_start_time:  p.page_created_time || null,
        ad_delivery_stop_time:   null,
        spend:                   p.spend || null,
        impressions:             p.impressions || null,
        currency:                p.currency || 'USD',
        ad_snapshot_url:         p.image_uri || p.profile_picture_url || null,
        bylines:                 p.category || '',
        _raw:                    p,
      }));
    } else if (Array.isArray(inner?.ads)) {
      raw = inner.ads;
    } else if (Array.isArray(inner)) {
      raw = inner;
    }

    res.json({ success: true, data: raw, total: raw.length });
  } catch (err) {
    if (err.response?.status === 429)
      return res.status(429).json({ success: false, message: 'Rate limit — thodi der baad try karo' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/ads/meta/page/:pageId — specific page ke ads
router.get('/meta/page/:pageId', protect, async (req, res) => {
  const { country = 'ALL', activeStatus = 'ALL', cursor = '' } = req.query;
  try {
    const result = await getMetaPageAds({
      pageId: req.params.pageId,
      country,
      activeStatus,
      cursor,
    });
    const raw = result?.data?.ads || result?.ads || result?.data || [];
    res.json({ success: true, data: Array.isArray(raw) ? raw : [], total: Array.isArray(raw) ? raw.length : 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/ads/meta/page/:pageId/details — page ad library details
router.get('/meta/page/:pageId/details', protect, async (req, res) => {
  try {
    const result = await getMetaPageAdDetails({ pageId: req.params.pageId });
    const raw = result?.data?.ads || result?.ads || result?.data || [];
    res.json({ success: true, data: Array.isArray(raw) ? raw : [], raw: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── AliExpress ───────────────────────────────────────────────────────────────
router.get('/aliexpress', protect, async (req, res) => {
  try {
    const { catId = '15', page = 1, currency = 'USD', keyword = '' } = req.query;
    const result = await getAliExpressHotProducts({ catId, page, currency, keyword });
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

// ─── Search ───────────────────────────────────────────────────────────────────
router.get('/search', protect, searchLimiter, async (req, res) => {
  try {
    const { keyword = '', platform = 'tiktok', country = 'US' } = req.query;
    if (!keyword.trim()) return res.status(400).json({ success: false, message: 'Keyword daalo' });

    const limitCheck = checkSearchLimit(req.user);
    if (!limitCheck.allowed)
      return res.status(429).json({ success: false, message: 'Daily limit khatam.', upgrade: req.user.plan === 'free' });

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
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Save / Saved Ads ─────────────────────────────────────────────────────────
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
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/saved', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    res.json({ success: true, total: (user?.savedAds || []).length, data: user?.savedAds || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/save/:adId', protect, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });
    const savedAds = (user.savedAds || []).filter(a => a.id !== req.params.adId);
    if (savedAds.length === (user.savedAds || []).length)
      return res.status(404).json({ success: false, message: 'Ad nahi mili' });
    await updateUser(req.user.id, { savedAds });
    res.json({ success: true, message: 'Ad remove ho gayi' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Related Products ─────────────────────────────────────────────────────────
router.get('/related/:adId', protect, async (req, res) => {
  try {
    const { adId } = req.params;
    const { industry = '', keyword = '', country = 'US', exclude = '', limit = 12 } = req.query;
    const excludeSet = new Set([adId, ...exclude.split(',').filter(Boolean)]);
    let relatedAds = [];

    const searchQuery = keyword.trim() || industry.trim();
    if (searchQuery) {
      try {
        const res1 = await searchTikTokAds({ keyword: searchQuery, country, order: 'impression', period: '30' });
        const raw = res1?.data?.data?.materials || res1?.data?.materials || res1?.materials || [];
        if (Array.isArray(raw)) relatedAds.push(...raw);
      } catch (e) {}
    }

    if (relatedAds.length < 6) {
      try {
        const res2 = await searchTikTokAds({ country, order: 'impression', period: '30' });
        const raw2 = res2?.data?.data?.materials || res2?.data?.materials || res2?.materials || [];
        if (Array.isArray(raw2)) relatedAds.push(...raw2);
      } catch (e) {}
    }

    const seen = new Set();
    const filtered = relatedAds
      .filter(a => {
        const id = a.id || a.ad_id || a.material_id;
        if (!id || excludeSet.has(String(id)) || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, parseInt(limit) || 12);

    res.json({ success: true, total: filtered.length, data: filtered });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Trending ─────────────────────────────────────────────────────────────────
router.get('/trending/videos', protect, async (req, res) => {
  try {
    const { keyword = 'fyp', region = 'us', count = 10, cursor = 0 } = req.query;
    res.json({ success: true, data: await getTrendingVideos({ keyword, region, count, cursor }) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/trending/hashtags', protect, async (req, res) => {
  try {
    res.json({ success: true, data: await getTrendingHashtags({ region: req.query.region || 'US' }) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/trending/sounds', protect, async (req, res) => {
  try {
    res.json({ success: true, data: await getTrendingSounds({ region: req.query.region || 'US' }) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/trending/creators', protect, async (req, res) => {
  try {
    res.json({ success: true, data: await getTrendingCreators({ region: req.query.region || 'US' }) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Debug ────────────────────────────────────────────────────────────────────
router.get('/debug-api', async (req, res) => {
  try {
    const r = await ttVideoClient.get('/ads/top/ads', {
      params: { page: 1, limit: 1, country_code: 'US', order_by: 'impression', period: '30' },
    });
    const materials  = r.data?.data?.data?.materials || r.data?.data?.materials || [];
    const firstAd    = materials[0] || {};
    res.json({
      status: 'ok',
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      material_id: firstAd.material_id || firstAd.id || '',
      first_ad_keys: Object.keys(firstAd),
    });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

module.exports = router;
