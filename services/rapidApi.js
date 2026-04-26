const axios = require('axios');
const { makeCacheKey, getOrFetch } = require('./cache');

// ─── tiktok-video-no-watermark2 — main client ────────────────────────────────
const TT_KEY  = process.env.RAPIDAPI_KEY;
const TT_HOST = process.env.RAPIDAPI_HOST || 'tiktok-video-no-watermark2.p.rapidapi.com';

const client = axios.create({
  baseURL: `https://${TT_HOST}`,
  headers: {
    'x-rapidapi-key':  TT_KEY,
    'x-rapidapi-host': TT_HOST,
    'Content-Type':    'application/json'
  },
  timeout: 15000
});

// ─── AliExpress client (alag key) ────────────────────────────────────────────
const ALI_HOST = process.env.ALIEXPRESS_HOST || 'free-aliexpress-api.p.rapidapi.com';
const ALI_KEY  = process.env.ALIEXPRESS_KEY || process.env.RAPIDAPI_KEY;

const aliClient = axios.create({
  baseURL: `https://${ALI_HOST}`,
  headers: {
    'x-rapidapi-key':  ALI_KEY,
    'x-rapidapi-host': ALI_HOST,
    'Content-Type':    'application/json'
  },
  timeout: 15000
});

// ─── 1. Top Ads List ──────────────────────────────────────────────────────────
// GET /ads/top/ads
async function searchTikTokAds({ country = 'US', order = 'impression', keyword = '', period = '30' }) {
  const cacheKey = makeCacheKey('tiktok_search', { country, order, keyword, period });
  return getOrFetch(cacheKey, async () => {
    const params = {
      page:         1,
      limit:        20,
      period:       String(period),
      country_code: country,
      ad_language:  'en',
      order_by:     order,
    };
    if (keyword && keyword.trim()) params.keyword = keyword.trim();
    const res = await client.get('/ads/top/ads', { params });
    return res.data;
  });
}

// ─── 2. Ad Detail ─────────────────────────────────────────────────────────────
// GET /ads/top/ads/detail?material_id=xxx
async function getTikTokAdDetails(materialId) {
  const cacheKey = 'tiktok_detail_' + materialId;
  return getOrFetch(cacheKey, async () => {
    const res = await client.get('/ads/top/ads/detail', {
      params: { material_id: materialId }
    });
    return res.data;
  });
}

// ─── 3. Advertiser ke saare ads ───────────────────────────────────────────────
async function getAdvertiserAds(advertiserId, { country = 'US', period = '30' } = {}) {
  const cacheKey = makeCacheKey('advertiser_ads', { advertiserId, country, period });
  return getOrFetch(cacheKey, async () => {
    const res = await client.get('/ads/top/ads', {
      params: {
        page:          1,
        limit:         12,
        period:        String(period),
        country_code:  country,
        order_by:      'impression',
        advertiser_id: advertiserId
      }
    });
    return res.data;
  });
}

// ─── 4. Top Products ──────────────────────────────────────────────────────────
// GET /ads/top/products
async function getTopProducts({
  page       = 1,
  limit      = 20,
  country    = 'US',
  ecomType   = 'l3',
  orderBy    = 'post',
  orderType  = 'desc',
  categoryId = '',
  periodType = 'last',
  last       = 7,
} = {}) {
  const cacheKey = makeCacheKey('top_products', { page, country, ecomType, orderBy, last });
  return getOrFetch(cacheKey, async () => {
    const params = {
      page,
      limit,
      country_code: country,
      ecom_type:    ecomType,
      order_by:     orderBy,
      order_type:   orderType,
      period_type:  periodType,
      last,
    };
    if (categoryId) params.first_ecom_category_id = categoryId;
    const res = await client.get('/ads/top/products', { params });
    return res.data;
  });
}

// ─── 5. Product Detail ────────────────────────────────────────────────────────
// GET /ads/top/products/detail
async function getProductDetail(productId, { country = 'US', periodType = 'last', last = 7 } = {}) {
  const cacheKey = makeCacheKey('product_detail', { productId, country, last });
  return getOrFetch(cacheKey, async () => {
    const res = await client.get('/ads/top/products/detail', {
      params: {
        id:           productId,
        country_code: country,
        period_type:  periodType,
        last,
      }
    });
    return res.data;
  });
}

// ─── 6. Video Info — no-watermark play URL ───────────────────────────────────
// GET /?url=https://www.tiktok.com/@user/video/VIDEO_ID&hd=1
// video_url: actual vid field from ad data (e.g. https://...tiktokcdn...mp4)
// tiktok_url: direct TikTok page URL
async function getTikTokVideoInfo(tiktokUrl) {
  const cacheKey = 'video_info_' + encodeURIComponent(tiktokUrl);
  return getOrFetch(cacheKey, async () => {
    const res = await client.get('/', {
      params: { url: tiktokUrl, hd: 1 }
    });
    return res.data;
  }, 3600);
}

// ─── Legacy wrappers ──────────────────────────────────────────────────────────
async function searchMetaAds({ keyword = '', country = 'US' }) {
  return searchTikTokAds({ keyword, country, order: 'impression', period: '30' });
}

async function searchGoogleAds({ keyword = '', country = 'US' }) {
  return searchTikTokAds({ keyword, country, order: 'impression', period: '30' });
}

// ─── AliExpress ───────────────────────────────────────────────────────────────
async function getAliExpressHotProducts({ catId = '15', page = 1, currency = 'USD', keyword = '' }) {
  const cacheKey = makeCacheKey('aliexpress_hot', { catId, page, currency, keyword });
  return getOrFetch(cacheKey, async () => {
    try {
      const params = {
        cat_id:          catId,
        sort:            'LAST_VOLUME_DESC',
        target_currency: currency,
        target_language: 'EN',
        page:            parseInt(page) || 1,
      };
      if (keyword && keyword.trim()) params.keywords = keyword.trim();
      console.log('AliExpress API call params:', JSON.stringify(params));
      const res = await aliClient.get('/hot_products', { params });
      console.log('AliExpress API response status:', res.status);
      return res.data;
    } catch (err) {
      console.error('AliExpress API error:', err.response?.status, JSON.stringify(err.response?.data));
      throw err;
    }
  });
}

async function getAliExpressCategories() {
  const cacheKey = 'aliexpress_categories';
  return getOrFetch(cacheKey, async () => {
    const res = await aliClient.get('/categories');
    return res.data;
  }, 86400);
}

module.exports = {
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
};
