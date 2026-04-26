const express = require('express');
const router  = express.Router();

const { protect }      = require('../middleware/auth');

// ─── TikTok Scraper API Client ────────────────────────────────────────────────
const axios = require('axios');
const tikScraperClient = axios.create({
  baseURL: 'https://free-tiktok-api-scraper-mobile-version.p.rapidapi.com/tok/v1',
  headers: {
    'x-rapidapi-key':  process.env.TIKTOK_SCRAPER_KEY,
    'x-rapidapi-host': 'free-tiktok-api-scraper-mobile-version.p.rapidapi.com',
    'Content-Type':    'application/json'
  },
  timeout: 12000
});
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

// ─── TikTok Video URL Fetch (via scraper API) ────────────────────────────────
const videoUrlCache = new Map(); // Simple in-memory cache

router.get('/video/url', protect, async (req, res) => {
  const { video_id } = req.query;
  if (!video_id) return res.status(400).json({ success:false, message:'video_id zaroori hai' });

  // Cache check — 1 ghante tak valid
  const cached = videoUrlCache.get(video_id);
  if (cached && Date.now() - cached.ts < 3600000) {
    return res.json({ success:true, play_url: cached.url, from_cache: true });
  }

  // Agar TIKTOK_SCRAPER_KEY set nahi hai toh skip karo
  if (!process.env.TIKTOK_SCRAPER_KEY) {
    return res.status(404).json({ success:false, message:'TIKTOK_SCRAPER_KEY nahi hai', video_id });
  }

  try {
    let playUrl = null;
    let coverUrl = null;

    try {
      const r = await tikScraperClient.get('/video_detail/', {
        params: { aweme_id: video_id },
        timeout: 10000
      });
      const d = r.data;
      const detail = d?.data?.aweme_detail || d?.aweme_detail || d?.data || d;
      playUrl  = detail?.video?.play_addr?.url_list?.[0]
               || detail?.video?.download_addr?.url_list?.[0]
               || detail?.video?.bit_rate?.[0]?.play_addr?.url_list?.[0]
               || null;
      coverUrl = detail?.video?.cover?.url_list?.[0] || null;
    } catch(e1) {
      if (e1.response?.status === 429) {
        // Rate limit — cache empty result thodi der ke liye
        console.error('video_detail 429 rate limit hit');
        return res.status(429).json({ success:false, message:'Rate limit — thodi der baad try karo', video_id });
      }
      try {
        const r2 = await tikScraperClient.get('/video_detail/', { params: { video_id }, timeout: 10000 });
        const d2 = r2.data;
        const detail2 = d2?.data?.aweme_detail || d2?.aweme_detail || d2?.data || d2;
        playUrl = detail2?.video?.play_addr?.url_list?.[0] || null;
      } catch(e2) {
        console.error('video_detail both params failed:', e2.message);
      }
    }

    if (!playUrl) {
      return res.status(404).json({ success:false, message:'Video URL nahi mili', video_id });
    }

    // Cache mein save karo
    videoUrlCache.set(video_id, { url: playUrl, ts: Date.now() });
    res.json({ success:true, play_url: playUrl, cover_url: coverUrl });
  } catch(err) {
    console.error('Video URL fetch error:', err.message);
    res.status(500).json({ success:false, message: err.message });
  }
});


// ─── AI Ad Analysis (RapidAPI Claude) ────────────────────────────────────────
router.post('/ai/analyze', protect, async (req, res) => {
  const { adData } = req.body;
  if (!adData) return res.status(400).json({ success:false, message:'adData zaroori hai' });

  const RAPID_KEY = process.env.RAPIDAPI_AI_KEY || process.env.RAPIDAPI_KEY;
  if (!RAPID_KEY) return res.status(500).json({ success:false, message:'RAPIDAPI_AI_KEY Railway mein set karo' });

  const {
    likes=0, comments=0, ctr=0, impression=0, cost=0,
    title='', objective='', industry='', runDays=0,
    isActive=false, countries=[]
  } = adData;

  const prompt = `You are an expert TikTok advertising analyst. Analyze this ad and return ONLY valid JSON — no markdown, no explanation.

AD DATA:
- Title: "${title}"
- Objective: ${objective||'unknown'}
- Industry: ${industry||'unknown'}
- Likes: ${likes}
- Comments: ${comments}
- CTR: ${ctr}%
- Impressions: ${impression}
- Spend: $${cost}
- Days Running: ${runDays}
- Still Active: ${isActive}
- Countries: ${Array.isArray(countries)?countries.join(', '):'unknown'}

Return ONLY this JSON (no markdown, no extra text):
{"overall_score":<0-100>,"verdict":"<WINNING|AVERAGE|WEAK|VIRAL>","scores":{"hook_strength":<0-25>,"engagement_rate":<0-25>,"spend_efficiency":<0-25>,"longevity":<0-25>},"hook_analysis":"<2 sentences>","target_audience":"<1-2 sentences>","cta_analysis":"<1-2 sentences>","winning_elements":["<item1>","<item2>","<item3>"],"weak_points":["<item1>","<item2>"],"recommendations":["<action1>","<action2>","<action3>"],"competitor_threat":"<LOW|MEDIUM|HIGH>","scaling_potential":"<LOW|MEDIUM|HIGH>","best_for":"<1 sentence>"}`;

  try {
    const response = await axios.post(
      'https://open-ai21.p.rapidapi.com/claude3',
      {
        messages: [{ role: 'user', content: prompt }],
        web_access: false
      },
      {
        headers: {
          'Content-Type':    'application/json',
          'x-rapidapi-host': process.env.RAPIDAPI_AI_HOST || 'open-ai21.p.rapidapi.com',
          'x-rapidapi-key':  RAPID_KEY
        },
        timeout: 30000
      }
    );

    // Response: { result: "...", status: true }
    const raw  = response.data?.result || response.data?.message || response.data?.content || '';
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const clean = text.replace(/```json|```/g, '').trim();

    // Extract JSON from response
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON nahi mila response mein');

    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ success:true, analysis: parsed });

  } catch(err) {
    console.error('AI analyze error:', err.response?.data || err.message);
    res.status(500).json({
      success:  false,
      message:  'AI analysis fail: ' + (err.response?.data?.message || err.message)
    });
  }
});

// DEBUG: AI API test (no auth) — test karo browser se
router.get('/debug-ai', async (req, res) => {
  const KEY = process.env.RAPIDAPI_AI_KEY || process.env.RAPIDAPI_KEY;
  try {
    const r = await axios.post(
      'https://open-ai21.p.rapidapi.com/claude3',
      { messages:[{ role:'user', content:'Say: {"test":"ok","status":"working"}' }], web_access:false },
      { headers:{
          'Content-Type':    'application/json',
          'x-rapidapi-key':  KEY,
          'x-rapidapi-host': 'open-ai21.p.rapidapi.com'
        }, timeout:15000
      }
    );
    res.json({
      status:       'ok',
      key_set:      !!KEY,
      key_prefix:   KEY ? KEY.substring(0,8)+'...' : 'NOT SET',
      raw_response: r.data,
      response_keys: r.data ? Object.keys(r.data) : []
    });
  } catch(err) {
    res.json({
      status:       'error',
      key_set:      !!KEY,
      key_prefix:   KEY ? KEY.substring(0,8)+'...' : 'NOT SET',
      error:        err.message,
      api_response: err.response?.data
    });
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
