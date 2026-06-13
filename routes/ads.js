const express  = require('express');
const { saveImageToR2 } = require('../services/r2');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');

const { protect }       = require('../middleware/auth');
const { searchLimiter } = require('../middleware/rateLimiter');
const { checkCredits, deductCredits, checkSearchLimit, incrementSearchCount, updateUser, findUserById } = require('../store/db');


// ─── TikTok RapidAPI Client (inline) ─────────────────────────────────────────
const TT_HOST  = process.env.RAPIDAPI_HOST || 'tiktok-scraper7.p.rapidapi.com';
const TT_KEY   = process.env.RAPIDAPI_KEY;
const ttClient = axios.create({
  baseURL: 'https://' + TT_HOST,
  headers: { 'x-rapidapi-key': TT_KEY, 'x-rapidapi-host': TT_HOST, 'Content-Type': 'application/json' },
  timeout: 15000,
});

const { makeCacheKey, getOrFetch } = require('../services/cache');

let _queue = Promise.resolve();
let _lastCall = 0;
function rateLimitedCall(fn) {
  _queue = _queue.then(async () => {
    const wait = Math.max(0, 1500 - (Date.now() - _lastCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
    return fn();
  });
  return _queue;
}
async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (err.response?.status === 429 && i < retries) { await new Promise(r => setTimeout(r, 3000*(i+1))); continue; }
      throw err;
    }
  }
}

async function searchTikTokAds({ country='US', order='like', keyword='', period='7' }) {
  return getOrFetch(makeCacheKey('tiktok_search',{country,order,keyword,period}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/ads/top/ads', { params:{page:1,limit:20,country_code:country,order_by:order,period,keyword} }).then(r=>r.data)))
  );
}
async function getAdvertiserAds(advertiserId, {country='US',period='7'}={}) {
  return getOrFetch(makeCacheKey('advertiser_ads',{advertiserId,country,period}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/ads/top/ads/by-advertiser', { params:{advertiser_id:advertiserId,country_code:country,period} }).then(r=>r.data)))
  );
}
async function getTopProducts({page=1,limit=20,country='US',orderBy='post',last=7}={}) {
  return getOrFetch(makeCacheKey('top_products',{page,country,orderBy,last}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/ads/top/products', { params:{page,limit,country_code:country,order_by:orderBy,period:last} }).then(r=>r.data)))
  );
}
async function getProductDetail(productId, {country='US',last=7}={}) {
  return getOrFetch(makeCacheKey('product_detail',{productId,country,last}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/ads/top/products/detail', { params:{product_id:productId,country_code:country,period:last} }).then(r=>r.data)))
  );
}
async function getTrendingVideos({keyword='fyp',region='us',count=10,cursor=0}={}) {
  return getOrFetch(makeCacheKey('trending_videos',{keyword,region,count,cursor}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/trending/videos', { params:{keyword,region,count,cursor} }).then(r=>r.data)))
  );
}
async function getTrendingHashtags({region='US'}={}) {
  return getOrFetch(makeCacheKey('trending_hashtag',{region}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/trending/hashtags', { params:{region} }).then(r=>r.data)))
  );
}
async function getTrendingSounds({region='US'}={}) {
  return getOrFetch(makeCacheKey('trending_sound',{region}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/trending/sounds', { params:{region} }).then(r=>r.data)))
  );
}
async function getTrendingCreators({region='US'}={}) {
  return getOrFetch(makeCacheKey('trending_creator',{region}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/trending/creators', { params:{region} }).then(r=>r.data)))
  );
}
async function getMetaPageAds()         { return { data: { ads: [] } }; }
async function getMetaPageAdDetails()   { return { data: { ads: [] } }; }


// ─── MongoDB Cache Service ────────────────────────────────────────────────────
const {
  getOrFetchAdsList,
  getOrFetchAdDetail,
  getOrFetchVideoUrl,
  invalidateAdCache,
  invalidateListCache,
  getCacheStats,
} = require('../services/mongoAdCache');

// ─── TikTok Video Info (RapidAPI se) ─────────────────────────────────────────
const ttVideoClient = require('axios').create({
  baseURL: 'https://' + (process.env.RAPIDAPI_HOST || 'tiktok-scraper7.p.rapidapi.com'),
  headers: {
    'x-rapidapi-key':  process.env.RAPIDAPI_KEY,
    'x-rapidapi-host': process.env.RAPIDAPI_HOST || 'tiktok-scraper7.p.rapidapi.com',
  },
  timeout: 15000,
});

async function getTikTokVideoInfo(tiktokUrl) {
  try {
    const r = await ttVideoClient.get('/', { params: { url: tiktokUrl, hd: 1 } });
    const d = r.data?.data || r.data;
    return { data: { play: d?.play || d?.hdplay || null, cover: d?.cover || null } };
  } catch(e) {
    return { data: {} };
  }
}

// ─── Video Stream Proxy ───────────────────────────────────────────────────────
router.get('/video/stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, message: 'URL zaroori hai' });

  const decodedUrlCheck = decodeURIComponent(url);
  const isR2 = decodedUrlCheck.includes('r2.dev') || decodedUrlCheck.includes('pub-');

  // R2 videos public hain — token check skip karo
  // Non-R2 (TikTok etc.) ke liye token verify karo
  if (!isR2) {
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { verifyAccessToken } = require('../utils/jwt');
    const decoded = verifyAccessToken(token);
    if (!decoded) return res.status(401).json({ success: false, message: 'Token invalid' });
  }

  try {
    const decodedUrl  = decodeURIComponent(url);
    const rangeHeader = req.headers['range'];
    const isR2Url = decodedUrl.includes('r2.dev') || decodedUrl.includes('pub-');
    const upstreamHeaders = isR2Url
      ? { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
      : {
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

  // Credit check
  const creditCheck = checkCredits(req.user, 'video_download');
  if (!creditCheck.allowed)
    return res.status(429).json({
      success:  false,
      message:  'Credits khatam ho gaye.',
      creditsRemaining: 0,
      upgrade:  true,
    });

  // Deduct before streaming
  deductCredits(req.user.id, 'video_download').catch(() => {});

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
        // Apify se video info fetch karo
        const sourceUrl = tiktok_url
          ? decodeURIComponent(tiktok_url)
          : `https://www.tiktok.com/video/${video_id}`;

        const info = await getTikTokVideoInfo(sourceUrl);
        const d    = info?.data || info;

        const playUrl  = d?.play  || d?.hdplay || d?.wmplay || null;
        const coverUrl = d?.cover || d?.origin_cover       || null;

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
// ─── TikTok Ads — MongoDB scraped (tiktokads collection) + RapidAPI fallback ──
let TikTokAd;
try { TikTokAd = mongoose.model('TikTokAd'); }
catch(e) {
  const ttSchema = new mongoose.Schema({
    ad_id:          { type: String, required: true, unique: true, index: true },
    source:         { type: String, default: 'tiktok_creative_center' },
    platform:       { type: String, default: 'tiktok' },
    country:        { type: String, default: 'US', index: true },
    period_days:    { type: Number, default: 7 },
    brand:          { type: String, default: '' },
    title:          { type: String, default: '' },
    body:           { type: String, default: '' },
    cta:            { type: String, default: '' },
    cover_url:      { type: String, default: '' },
    video_url:      { type: String, default: '' },
    r2_cover_url:   { type: String, default: '' },
    r2_video_url:   { type: String, default: '' },
    like_count:     { type: Number, default: 0 },
    comment_count:  { type: Number, default: 0 },
    share_count:    { type: Number, default: 0 },
    play_count:     { type: Number, default: 0 },
    ctr:            { type: Number, default: 0 },
    cost:           { type: Number, default: 0 },
    objective:      { type: String, default: '' },
    industry:       { type: String, default: '' },
    is_active:      { type: Boolean, default: true },
    ad_type:        { type: String, default: 'video' },
    status:         { type: String, default: 'Active' },
    trending_score: { type: Number, default: 0, index: true },
    is_dropshipping:{ type: Boolean, default: false },
    is_phash_duplicate: { type: Boolean, default: false },
    image_phash:    { type: String, default: null },
    video_phashes:  [{ type: String }],
    phash_bucket:   { type: String, default: null },
    video_duration: { type: Number, default: null },
    audio_hash:     { type: String, default: null },
    view_count:     { type: Number, default: 0 },
    hidden:         { type: Boolean, default: false },
    featured:       { type: Boolean, default: false },
    priority:       { type: Number, default: 0 },
    scraped_at:     { type: Date, default: Date.now, index: true },
    first_seen:     { type: Date, default: null },
  }, { timestamps: true, strict: false });
  TikTokAd = mongoose.model('TikTokAd', ttSchema, 'tiktokads');
}

// Normalize tiktokads doc → frontend format
function normalizeTikTokForFrontend(ad) {
  // Video URL: R2 pehle (permanent), phir original CDN
  const videoUrl = (ad.r2_video_url && ad.r2_video_url.trim())
    ? ad.r2_video_url
    : (ad.video_url || '');
  // Cover: R2 pehle, phir original
  const coverUrl = (ad.r2_cover_url && ad.r2_cover_url.trim())
    ? ad.r2_cover_url
    : (ad.cover_url || '');

  return {
    id:             ad.ad_id || String(ad._id),
    material_id:    ad.ad_id,
    ad_title:       ad.title || ad.brand || 'No Title',
    brand_name:     ad.brand || 'Unknown',
    like:           ad.like_count     || 0,
    comment:        ad.comment_count  || 0,
    share:          ad.share_count    || 0,
    play_count:     ad.play_count     || 0,
    ctr:            ad.ctr            || 0,
    cost:           ad.cost           || 0,
    objective:      ad.objective      || '',
    objective_key:  ad.objective      || '',
    industry_key:   ad.industry       || '',
    industry:       ad.industry       || '',
    is_active:      ad.is_active !== false,
    country:        ad.country        || 'US',
    trending_score: ad.trending_score || 0,
    is_dropshipping:ad.is_dropshipping|| false,
    period_days:    ad.period_days    || 7,
    // ✅ video_info — AdCard expects this format
    video_info: {
      cover:         coverUrl,
      origin_cover:  coverUrl,
      play_url:      videoUrl,
      video_url:     videoUrl,
      hdplay:        videoUrl,
      duration:      ad.video_duration || 0,
      vid:           ad.ad_id || '',
      video_url_map: videoUrl ? { '720p': videoUrl, '540p': videoUrl } : {},
    },
    // Direct video/cover fields (redundant but safe)
    r2_video_url:   ad.r2_video_url || '',
    r2_cover_url:   ad.r2_cover_url || '',
    video_url:      videoUrl,
    cover_url:      coverUrl,
    has_video:      !!(videoUrl && videoUrl.trim()),
    scraped_at:     ad.scraped_at,
    first_seen:     ad.first_seen,
    _source:        'mongodb_tiktok',
    _raw:           ad,
  };
}

router.get('/tiktok', protect, async (req, res) => {
  const { country = 'US', order = 'like', period = '7', page = 1, limit = 20 } = req.query;

  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ success: false, message: 'Database connected nahi hai' });
    }

    // ── Country fallback: agar requested country ka data nahi hai to US use karo ──
    const requestedCountry = (country && country !== 'ALL') ? country.toUpperCase() : null;
    const { dropshipping = 'false' } = req.query;
    const buildQuery = (c) => {
      const q = {
        hidden: { $ne: true },
        is_phash_duplicate: { $ne: true },
        // Sirf ads jinke paas video ya cover hai
        $or: [
          { r2_video_url: { $ne: '' } },
          { video_url:    { $ne: '' } },
          { cover_url:    { $ne: '' } },
        ],
      };
      if (c) q.country = c;
      // Dropshipping filter
      if (dropshipping === 'true') q.is_dropshipping = true;
      return q;
    };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortByOrder = order === 'ctr' ? { ctr: -1 } : order === 'cost' ? { cost: -1 } : { like_count: -1, trending_score: -1 };

    const runPipeline = async (q) => {
      const pipeline = [
        { $match: q },
        { $sort: { trending_score: -1, like_count: -1, scraped_at: -1 } },
        { $group: { _id: '$brand', docs: { $push: '$$ROOT' }, top: { $first: '$trending_score' } } },
        { $sort: { top: -1 } },
        { $project: { docs: { $slice: ['$docs', 3] } } },
        { $unwind: '$docs' },
        { $replaceRoot: { newRoot: '$docs' } },
        { $sort: { trending_score: -1, scraped_at: -1 } },
        { $skip: skip },
        { $limit: parseInt(limit) },
      ];
      return TikTokAd.aggregate(pipeline);
    };

    // Pehle requested country try karo
    let adsRaw = [];
    let usedCountry = requestedCountry;
    if (requestedCountry) {
      adsRaw = await runPipeline(buildQuery(requestedCountry));
    }

    // Agar 0 ads mila to US fallback
    if (adsRaw.length === 0 && requestedCountry !== 'US') {
      console.log(`[TikTok] ${requestedCountry} empty — US fallback`);
      usedCountry = 'US';
      adsRaw = await runPipeline(buildQuery('US'));
    }

    // Agar US bhi empty — country filter hata do
    if (adsRaw.length === 0) {
      console.log('[TikTok] US bhi empty — no country filter');
      usedCountry = 'ALL';
      adsRaw = await runPipeline(buildQuery(null));
    }

    const totalRaw = await TikTokAd.countDocuments(buildQuery(usedCountry === 'ALL' ? null : usedCountry));

    console.log(`[TikTok] Serve: ${adsRaw.length} ads (country: ${usedCountry})`);
    return res.json({
      success: true,
      source: 'mongodb_scraped',
      country_used: usedCountry,
      data: { materials: adsRaw.map(normalizeTikTokForFrontend) },
      total: totalRaw,
      page: parseInt(page),
    });

  } catch (err) {
    console.error('[TikTok Route] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── TikTok Ad Detail ─────────────────────────────────────────────────────────
router.get('/tiktok/:adId', protect, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ success: false, message: 'Database connected nahi hai' });
    }

    // Credit check
    const creditCheck = checkCredits(req.user, 'ad_detail');
    if (!creditCheck.allowed)
      return res.status(429).json({
        success:  false,
        message:  'Credits khatam ho gaye.',
        creditsRemaining: 0,
        upgrade:  true,
      });

    const ad = await TikTokAd.findOne({ ad_id: req.params.adId }).lean();
    if (!ad) {
      return res.status(404).json({ success: false, message: 'Ad nahi mili' });
    }

    // Deduct credits + increment view count (background)
    deductCredits(req.user.id, 'ad_detail').catch(() => {});
    TikTokAd.updateOne(
      { ad_id: req.params.adId },
      { $inc: { view_count: 1 }, $set: { last_viewed: new Date() } }
    ).catch(() => {});
    return res.json({ success: true, source: 'mongodb', data: normalizeTikTokForFrontend(ad) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── TikTok Stats ─────────────────────────────────────────────────────────────

// ─── Debug: MongoDB data check ────────────────────────────────────────────────
router.get('/debug/tiktok', async (req, res) => {
  try {
    const total      = await TikTokAd.countDocuments();
    const withR2     = await TikTokAd.countDocuments({ r2_video_url: { $ne: '' } });
    const withVideo  = await TikTokAd.countDocuments({ video_url:    { $ne: '' } });
    const countries  = await TikTokAd.distinct('country');
    const sample     = await TikTokAd.findOne({ r2_video_url: { $ne: '' } })
      .select('ad_id brand r2_video_url r2_cover_url country trending_score').lean();
    const sampleNoR2 = await TikTokAd.findOne({ r2_video_url: '' })
      .select('ad_id brand video_url cover_url country').lean();
    res.json({ total, withR2Video: withR2, withVideoUrl: withVideo, countries, sample, sampleNoR2 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/tiktok/stats/overview', protect, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.json({ success: true, data: { total: 0 } });
    const [total, withVideo, countries, newest] = await Promise.all([
      TikTokAd.countDocuments(),
      TikTokAd.countDocuments({ r2_video_url: { $ne: '' } }),
      TikTokAd.distinct('country'),
      TikTokAd.findOne().sort({ scraped_at: -1 }).select('scraped_at brand').lean(),
    ]);
    res.json({ success: true, data: { total, with_video: withVideo, countries, newest } });
  } catch(err) { res.status(500).json({ success: false, message: err.message }); }
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

// MongoDB MetaAd model (scraper se aata hai)
let MetaAd;
try {
  MetaAd = require('../models/MetaAd');
} catch(e) {
  MetaAd = null;
}

// MongoDB scraped data ko frontend ke format mein convert karo
function normalizeForFrontend(ad) {
  // ── Format detect: scraper 'ad_type' save karta hai, model 'format' bhi rakhta hai ──
  const adType    = ad.ad_type || ad.format || '';
  const hasR2Video   = !!(ad.r2_video_url && ad.r2_video_url.trim());
  const hasOrigVideo = !!(ad.video && ad.video.trim());
  const isVideo   = adType === 'video' || hasR2Video || hasOrigVideo;

  // ── Image URL: R2 permanent URL pehle, phir original Facebook CDN ──────────
  // Video ads ke liye bhi image hoti hai (thumbnail) — r2_image_url mein hoti hai
  const imageUrl = ad.r2_image_url || ad.image || null;

  // ── Video URL: R2 pehle, phir original ─────────────────────────────────────
  // Fix: empty string "" ko bhi handle karo — sirf trim ke baad check karo
  const videoUrl = (ad.r2_video_url && ad.r2_video_url.trim())
    ? ad.r2_video_url
    : ((ad.video && ad.video.trim()) ? ad.video : null);

  return {
    id:                      ad.library_id || String(ad._id),
    page_name:               ad.brand      || 'Unknown Page',
    ad_title:                ad.title      || '',
    ad_body:                 ad.body       || '',
    ad_creative_bodies:      ad.body       ? [ad.body]       : [],
    ad_creative_link_titles: ad.title      ? [ad.title] : (ad.link_title ? [ad.link_title] : []),
    ad_delivery_start_time:  ad.start_date || ad.scraped_at  || null,
    ad_delivery_stop_time:   ad.end_date   || null,
    spend:                   ad.spend                 || null,
    impressions:             ad.impression            || null,
    estimated_spend:         ad.estimated_spend       || null,
    estimated_impressions:   ad.estimated_impressions || null,
    estimated_industry:      ad.estimated_industry    || null,
    estimated_cpm:           ad.estimated_cpm         || null,
    likes:                   ad.likes      || 0,
    ctr:                     ad.ctr        || null,
    currency:                ad.currency   || 'USD',
    ad_snapshot_url:         imageUrl,
    image:                   imageUrl,
    r2_image_url:            ad.r2_image_url || null,
    video_url:               videoUrl,
    r2_video_url:            ad.r2_video_url || null,
    video:                   videoUrl,
    is_video:                isVideo,
    format:                  adType || (isVideo ? 'video' : 'image'),
    snapshot_url:            ad.snapshot_url || null,
    bylines:                 ad.cta_text   || '',
    platforms:               ad.platforms  || [],
    active:                  ad.active,
    status:                  ad.status     || (ad.active ? 'Active' : 'Inactive'),
    keyword:                 ad.keyword    || '',
    country:                 ad.country    || '',
    trending_score:          ad.trending_score || 0,
    priority:                ad.priority   || 0,
    featured:                ad.featured   || false,
    run_days:                ad.run_days   || 0,
    scraped_at:              ad.scraped_at || null,
    // pHash info — frontend ke liye
    is_phash_duplicate:      ad.is_phash_duplicate || false,
    duplicate_of:            ad.duplicate_of       || null,
    similarity_score:        ad.similarity_score   || null,
    _source:                 'mongodb_scraped',
    _raw:                    ad,
  };
}

// GET /api/ads/meta — MongoDB se serve karo
router.get('/meta', protect, async (req, res) => {
  const {
    keyword      = '',
    country      = 'ALL',
    activeStatus = 'ACTIVE',
    page         = 1,
    limit        = 20,
  } = req.query;

  try {
    // Pehle MongoDB se try karo
    if (MetaAd && mongoose.connection.readyState === 1) {
      const query = {};

      // Keyword filter
      if (keyword && keyword.trim() && keyword.trim() !== 'product') {
        query.$or = [
          { brand:   { $regex: keyword.trim(), $options: 'i' } },
          { body:    { $regex: keyword.trim(), $options: 'i' } },
          { keyword: { $regex: keyword.trim(), $options: 'i' } },
        ];
      }

      // Country filter
      if (country && country !== 'ALL') {
        query.country = country.toUpperCase();
      }

      // Active status filter
      if (activeStatus === 'ACTIVE') query.active = true;

      // Hidden aur visual duplicate ads mat dikhao
      query.hidden             = { $ne: true };
      query.is_phash_duplicate = { $ne: true };  // ← duplicate ads filter out

      const skip  = (parseInt(page) - 1) * parseInt(limit);
      const lim   = parseInt(limit);

      // ── Brand diversity pipeline ─────────────────────────────────────────
      // Ek hi brand ke 3 se zyada ads ek page pe na aayein
      // + Same r2_video_url wale ads filter (creative duplicates)
      const pipeline = [
        { $match: query },
        { $sort: { trending_score: -1, priority: -1, featured: -1, scraped_at: -1 } },
        // Creative dedup: same r2_video_url ho to sirf ek dikhao
        { $group: {
          _id:   { $ifNull: ['$r2_video_url', '$library_id'] },  // same video = same group
          doc:   { $first: '$$ROOT' },
        }},
        { $replaceRoot: { newRoot: '$doc' } },
        { $sort: { trending_score: -1, priority: -1, scraped_at: -1 } },
        // Brand diversity: har brand se max 3 ads
        { $group: {
          _id:  '$brand',
          docs: { $push: '$$ROOT' },
          top:  { $first: '$trending_score' },
        }},
        { $sort: { top: -1 } },
        { $project: { docs: { $slice: ['$docs', 3] } } },
        { $unwind: '$docs' },
        { $replaceRoot: { newRoot: '$docs' } },
        { $sort: { trending_score: -1, scraped_at: -1 } },
        { $skip: skip },
        { $limit: lim },
      ];

      const countPipeline = [
        { $match: query },
        { $count: 'total' },
      ];

      const [adsRaw, countRaw] = await Promise.all([
        MetaAd.aggregate(pipeline),
        MetaAd.aggregate(countPipeline),
      ]);

      const total = countRaw[0]?.total || 0;

      if (adsRaw.length > 0) {
        const normalized = adsRaw.map(normalizeForFrontend);
        console.log('[Meta Route] MongoDB se serve: ' + normalized.length + ' unique ads');
        return res.json({ success: true, data: normalized, total, page: parseInt(page), source: 'mongodb' });
      }

      console.log('[Meta Route] MongoDB mein koi ad nahi — Apify fallback');
    }

    // MongoDB mein koi data nahi — empty return karo
    console.log('[Meta Route] MongoDB empty — koi data nahi');
    res.json({ success: true, data: [], total: 0, source: 'mongodb_empty', message: 'Scraper se data abhi nahi aaya — kal subah 6 baje aayega' });

  } catch (err) {
    if (err.response?.status === 429)
      return res.status(429).json({ success: false, message: 'Rate limit — thodi der baad try karo' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/ads/image-proxy — R2 permanent URL serve karo (CDN fallback bhi)
router.get('/image-proxy', async (req, res) => {
  const { id, url } = req.query;

  try {
    // Step 1: MongoDB se R2 URL check karo — seedha redirect (fastest)
    if (id && MetaAd && mongoose.connection.readyState === 1) {
      const ad = await MetaAd.findOne({ library_id: id }).select('r2_image_url image').lean();
      if (ad?.r2_image_url && ad.r2_image_url !== '' && ad.r2_image_url !== 'expired') {
        res.setHeader('Cache-Control', 'public, max-age=604800');
        return res.redirect(302, ad.r2_image_url);
      }
    }

    // Step 2: Fallback — CDN se fetch try karo
    let imageUrl = url ? decodeURIComponent(url) : null;
    if (!imageUrl && id && MetaAd && mongoose.connection.readyState === 1) {
      const ad = await MetaAd.findOne({ library_id: id }).select('image').lean();
      if (ad?.image) imageUrl = ad.image;
    }

    if (!imageUrl) {
      return res.status(404).json({ success: false, message: 'Image nahi mili' });
    }

    const fixedUrl = imageUrl
      .replace('s60x60', 's600x600')
      .replace('dst-jpg_s60x60', 'dst-jpg_s600x600')
      .replace('_s60x60', '_s600x600')
      .replace('p60x60', 'p600x600');

    const response = await axios.get(fixedUrl, {
      responseType: 'stream',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Referer': 'https://www.facebook.com/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.data.pipe(res);
    response.data.on('error', () => res.status(500).end());

  } catch (err) {
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(pixel);
  }
});

// POST /api/ads/meta/:id/view — view count track karo
router.post('/meta/:id/view', protect, async (req, res) => {
  try {
    const { trackAdView } = require('../services/cleanupService');
    trackAdView(req.params.id);
    if (MetaAd && mongoose.connection.readyState === 1) {
      await MetaAd.updateOne(
        { library_id: req.params.id },
        { $inc: { view_count: 1 }, $set: { last_viewed: new Date() } }
      );
    }
    res.json({ success: true });
  } catch(e) {
    res.json({ success: true }); // silently fail
  }
});

// GET /api/ads/meta/stats — kitne ads hain DB mein
router.get('/meta/stats', protect, async (req, res) => {
  try {
    if (!MetaAd || mongoose.connection.readyState !== 1) {
      return res.json({ success: true, data: { total: 0, source: 'no_db' } });
    }
    const total    = await MetaAd.countDocuments();
    const active   = await MetaAd.countDocuments({ active: true });
    const newest   = await MetaAd.findOne().sort({ scraped_at: -1 }).select('scraped_at brand').lean();
    const keywords = await MetaAd.distinct('keyword');
    const countries = await MetaAd.distinct('country');
    res.json({ success: true, data: { total, active, newest, keywords, countries } });
  } catch (err) {
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

// GET /api/ads/meta/brand/:brandName — Same brand ke saare Meta ads
router.get('/meta/brand/:brandName', protect, async (req, res) => {
  try {
    const brandName  = decodeURIComponent(req.params.brandName || '').trim();
    const excludeId  = req.query.exclude || '';
    const limitCount = Math.min(parseInt(req.query.limit) || 20, 50);

    if (!brandName) return res.status(400).json({ success: false, message: 'Brand name chahiye' });

    if (!MetaAd || mongoose.connection.readyState !== 1) {
      return res.json({ success: true, data: [], total: 0 });
    }

    const query = {
      brand: { $regex: `^${brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      hidden: { $ne: true },
      is_phash_duplicate: { $ne: true },
    };
    if (excludeId) {
      query.library_id = { $ne: excludeId };
    }

    const ads = await MetaAd.find(query)
      .sort({ active: -1, scraped_at: -1 })
      .limit(limitCount)
      .lean();

    const normalized = ads.map(normalizeForFrontend);
    res.json({ success: true, data: normalized, total: normalized.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Search ───────────────────────────────────────────────────────────────────
router.get('/search', protect, searchLimiter, async (req, res) => {
  try {
    const { keyword = '', platform = 'tiktok', country = 'US' } = req.query;
    if (!keyword.trim()) return res.status(400).json({ success: false, message: 'Keyword daalo' });

    const creditCheck = checkCredits(req.user, 'search');
    if (!creditCheck.allowed)
      return res.status(429).json({
        success:  false,
        message:  'Credits khatam ho gaye.',
        creditsRemaining: 0,
        upgrade:  true,
      });

    let results = [];
    if (platform === 'tiktok' || platform === 'all') {
      try {
        const tt  = await searchTikTokAds({ keyword, country, order: 'impression', period: '30' });
        const raw = tt?.data?.data?.materials || tt?.data?.materials || tt?.materials || [];
        if (Array.isArray(raw)) results.push(...raw);
      } catch (e) { console.error('TikTok search error:', e.message); }
    }

    const deducted = await deductCredits(req.user.id, 'search');
    res.json({
      success:          true,
      keyword,
      platform,
      total:            results.length,
      creditsRemaining: deducted.remaining ?? (creditCheck.remaining - creditCheck.cost),
      creditsUsed:      creditCheck.cost,
      data:             results,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Save / Saved Ads ─────────────────────────────────────────────────────────
router.post('/save', protect, async (req, res) => {
  try {
    const { adId, adData, folderName = 'Default' } = req.body;
    if (!adId) return res.status(400).json({ success: false, message: 'Ad ID zaroori hai' });

    // Credit check
    const creditCheck = checkCredits(req.user, 'save_ad');
    if (!creditCheck.allowed)
      return res.status(429).json({
        success:  false,
        message:  'Credits khatam ho gaye.',
        creditsRemaining: 0,
        upgrade:  true,
      });

    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila' });

    const savedAds = user.savedAds || [];
    if (savedAds.some(a => a.id === adId))
      return res.status(409).json({ success: false, message: 'Pehle se saved hai' });

    savedAds.push({ id: adId, folder: folderName, savedAt: new Date().toISOString(), ...adData });
    await updateUser(req.user.id, { savedAds });
    deductCredits(req.user.id, 'save_ad').catch(() => {});
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
    // Apify se test fetch
    const result = await searchTikTokAds({ country: 'US', order: 'like', period: '30' });
    const materials = result?.data?.data?.materials || [];
    const firstAd   = materials[0] || {};
    res.json({
      status: 'ok',
      source: 'mongodb',
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      material_id: firstAd.material_id || firstAd.id || '',
      first_ad_keys: Object.keys(firstAd),
    });
  } catch (err) {
    res.json({ status: 'error', message: err.message });
  }
});

module.exports = router;
