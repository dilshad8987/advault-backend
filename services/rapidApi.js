// ─── rapidApi.js ──────────────────────────────────────────────────────────────
//
// IMPORTANT:
//   - AliExpress: yahan se (RapidAPI — same as pehle, koi change nahi)
//   - TikTok + Meta: apifyService.js se aata hai
//
// Yeh file backwards-compatible wrapper hai —
// routes/ads.js mein koi bhi change nahi karna padega.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');
const { makeCacheKey, getOrFetch } = require('./cache');

// ─── AliExpress client (RapidAPI — same as pehle) ─────────────────────────────
const ALI_HOST = process.env.ALIEXPRESS_HOST || 'free-aliexpress-api.p.rapidapi.com';
const ALI_KEY  = process.env.ALIEXPRESS_KEY  || process.env.RAPIDAPI_KEY;

const aliClient = axios.create({
  baseURL: `https://${ALI_HOST}`,
  headers: {
    'x-rapidapi-key':  ALI_KEY,
    'x-rapidapi-host': ALI_HOST,
    'Content-Type':    'application/json'
  },
  timeout: 15000
});

// ─── AliExpress: Hot Products ─────────────────────────────────────────────────
async function getAliExpressHotProducts({ catId = '15', page = 1, currency = 'USD', keyword = '' }) {
  const cacheKey = makeCacheKey('aliexpress_hot', { catId, page, currency, keyword });
  return getOrFetch(cacheKey, async () => {
    try {
      const params = {
        cat_id: catId, sort: 'LAST_VOLUME_DESC',
        target_currency: currency, target_language: 'EN',
        page: parseInt(page) || 1,
      };
      if (keyword && keyword.trim()) params.keywords = keyword.trim();
      const res = await aliClient.get('/hot_products', { params });
      return res.data;
    } catch (err) {
      console.error('AliExpress API error:', err.response?.status, JSON.stringify(err.response?.data));
      throw err;
    }
  });
}

// ─── AliExpress: Categories ───────────────────────────────────────────────────
async function getAliExpressCategories() {
  return getOrFetch('aliexpress_categories', async () => {
    const res = await aliClient.get('/categories');
    return res.data;
  }, 86400);
}

// ─── TikTok + Meta: Apify se forward ─────────────────────────────────────────
// Yeh sab apifyService se re-export ho rahe hain
const {
  searchTikTokAds,
  getTikTokAdDetails,
  getAdvertiserAds,
  getTopProducts,
  getProductDetail,
  getTikTokVideoInfo,
  getTrendingVideos,
  getTrendingHashtags,
  getTrendingSounds,
  getTrendingCreators,
  searchMetaAds,
  searchGoogleAds,
  getMetaPageAds,
  searchMetaAdsByKeyword,
  getMetaPageAdDetails,
} = require('./apifyService');

module.exports = {
  // TikTok + Meta (Apify se)
  searchTikTokAds,
  getTikTokAdDetails,
  getAdvertiserAds,
  getTopProducts,
  getProductDetail,
  getTikTokVideoInfo,
  getTrendingVideos,
  getTrendingHashtags,
  getTrendingSounds,
  getTrendingCreators,
  searchMetaAds,
  searchGoogleAds,
  getMetaPageAds,
  searchMetaAdsByKeyword,
  getMetaPageAdDetails,
  // AliExpress (RapidAPI — same as pehle)
  getAliExpressHotProducts,
  getAliExpressCategories,
};
