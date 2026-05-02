const axios = require('axios');
const { makeCacheKey, getOrFetch } = require('./cache');

// ─── tiktok-scraper7 client ───────────────────────────────────────────────────
const TT_KEY  = process.env.RAPIDAPI_KEY;
const TT_HOST = 'tiktok-scraper7.p.rapidapi.com';

const client = axios.create({
  baseURL: `https://${TT_HOST}`,
  headers: {
    'x-rapidapi-key':  TT_KEY,
    'x-rapidapi-host': TT_HOST,
    'Content-Type':    'application/json'
  },
  timeout: 20000
});

// ─── AliExpress client ────────────────────────────────────────────────────────
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

// ─── Rate limit queue ─────────────────────────────────────────────────────────
let _queue    = Promise.resolve();
let _lastCall = 0;
const MIN_INTERVAL = 1200;

function rateLimitedCall(fn) {
  _queue = _queue.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL - (Date.now() - _lastCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastCall = Date.now();
    return fn();
  });
  return _queue;
}

// ─── Retry on 429 ────────────────────────────────────────────────────────────
async function withRetry(fn, retries = 2, delayMs = 3000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.response?.status === 429 && i < retries) {
        console.log(`⏳ 429 rate limit — retry ${i+1}/${retries} in ${delayMs*(i+1)}ms`);
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ─── 1. Top Ads — GET /ads/top/ads ───────────────────────────────────────────
async function searchTikTokAds({ country = 'US', order = 'like', keyword = '', period = '7' }) {
  const cacheKey = makeCacheKey('tiktok_search', { country, order, keyword, period });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const params = {
        page:         1,
        limit:        20,
        period:       String(period),
        country_code: country,
        ad_language:  'en',
        order_by:     order || 'like',
        ad_format:    1,
      };
      if (keyword && keyword.trim()) params.keyword = keyword.trim();
      const res = await client.get('/ads/top/ads', { params });
      return res.data;
    }));
  });
}

// ─── 2. Ad Detail — GET /ads/top/ads/detail ──────────────────────────────────
async function getTikTokAdDetails(materialId) {
  const cacheKey = 'tiktok_detail_' + materialId;
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await client.get('/ads/top/ads/detail', {
        params: { material_id: materialId }
      });
      return res.data;
    }));
  });
}

// ─── 3. Advertiser Ads ────────────────────────────────────────────────────────
async function getAdvertiserAds(advertiserId, { country = 'US', period = '7' } = {}) {
  const cacheKey = makeCacheKey('advertiser_ads', { advertiserId, country, period });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await client.get('/ads/top/ads', {
        params: {
          page:          1,
          limit:         12,
          period:        String(period),
          country_code:  country,
          order_by:      'like',
          advertiser_id: advertiserId,
          ad_format:     1,
        }
      });
      return res.data;
    }));
  });
}

// ─── 4. Top Products — GET /ads/top/products ─────────────────────────────────
async function getTopProducts({
  page = 1, limit = 20, country = 'US', ecomType = 'l3',
  orderBy = 'post', orderType = 'desc', categoryId = '',
  periodType = 'last', last = 7,
} = {}) {
  const cacheKey = makeCacheKey('top_products', { page, country, ecomType, orderBy, last });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const params = {
        page, limit,
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
    }));
  });
}

// ─── 5. Product Detail — GET /ads/top/products/detail ────────────────────────
async function getProductDetail(productId, { country = 'US', periodType = 'last', last = 7 } = {}) {
  const cacheKey = makeCacheKey('product_detail', { productId, country, last });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await client.get('/ads/top/products/detail', {
        params: { id: productId, country_code: country, period_type: periodType, last }
      });
      return res.data;
    }));
  });
}

// ─── 6. Trending Videos — GET /feed/search ───────────────────────────────────
async function getTrendingVideos({ keyword = 'fyp', region = 'us', count = 10, cursor = 0 } = {}) {
  const cacheKey = makeCacheKey('trending_videos', { keyword, region, count, cursor });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await client.get('/feed/search', {
        params: { keywords: keyword, region, count, cursor, publish_time: 0, sort_type: 0 }
      });
      return res.data;
    }));
  });
}

// ─── 7. Trending Hashtags — GET /trending/hashtag ────────────────────────────
async function getTrendingHashtags({ region = 'US' } = {}) {
  const cacheKey = makeCacheKey('trending_hashtag', { region });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await client.get('/trending/hashtag', { params: { region } });
      return res.data;
    }));
  });
}

// ─── 8. Trending Sounds — GET /trending/sound ────────────────────────────────
async function getTrendingSounds({ region = 'US' } = {}) {
  const cacheKey = makeCacheKey('trending_sound', { region });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await client.get('/trending/sound', { params: { region } });
      return res.data;
    }));
  });
}

// ─── 9. Trending Creators — GET /trending/creator ────────────────────────────
async function getTrendingCreators({ region = 'US' } = {}) {
  const cacheKey = makeCacheKey('trending_creator', { region });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await client.get('/trending/creator', { params: { region } });
      return res.data;
    }));
  });
}

// ─── 10. Video Info (no-watermark) ───────────────────────────────────────────
async function getTikTokVideoInfo(tiktokUrl) {
  const cacheKey = 'video_info_' + encodeURIComponent(tiktokUrl);
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await client.get('/video/info', { params: { url: tiktokUrl, hd: 1 } });
      return res.data;
    }));
  }, 3600);
}


// ─── Meta Ads Library API ─────────────────────────────────────────────────────
// RapidAPI: facebook-scraper-api4.p.rapidapi.com
const META_HOST = 'facebook-scraper-api4.p.rapidapi.com';
const META_KEY  = process.env.RAPIDAPI_KEY; // same key ya alag META_RAPIDAPI_KEY

const metaClient = axios.create({
  baseURL: `https://${META_HOST}`,
  headers: {
    'x-rapidapi-key':  process.env.META_RAPIDAPI_KEY || META_KEY,
    'x-rapidapi-host': META_HOST,
    'Content-Type':    'application/json',
  },
  timeout: 20000,
});

// Fetch ads for a specific Facebook page
async function getMetaPageAds({ pageId = '', country = 'ALL', activeStatus = 'ALL', cursor = '' } = {}) {
  const cKey = makeCacheKey('meta_page_ads', { pageId, country, activeStatus, cursor });
  return getOrFetch(cKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await metaClient.post('/fetch_search_ads_pages', {
        query: '',
        ad_page_id: pageId,
        country,
        activeStatus,
        end_cursor: cursor || '',
        after_time: '',
        before_time: '',
        sort_data: '',
      });
      return res.data;
    }));
  }, 3600); // 1 hour cache
}

// Search Meta ads by keyword
async function searchMetaAdsByKeyword({ keyword = '', country = 'ALL', activeStatus = 'ACTIVE' } = {}) {
  const cKey = makeCacheKey('meta_search_ads', { keyword, country, activeStatus });
  return getOrFetch(cKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      console.log('[Meta] Fetching keyword:', keyword, '| country:', country, '| status:', activeStatus);
      const res = await metaClient.get('/fetch_search_ads_keywords', {
        params: {
          query:        keyword,
          country,
          activeStatus,
          end_cursor:   '',
          sort_data:    'RELEVANCE_DESC',
        },
      });
      console.log('[Meta] Raw response keys:', Object.keys(res.data || {}));
      console.log('[Meta] Raw response (first 500 chars):', JSON.stringify(res.data).slice(0, 500));
      return res.data;
    }));
  }, 3600);
}

// Get all ads for a specific page (detail endpoint)
async function getMetaPageAdDetails({ pageId = '' } = {}) {
  const cKey = 'meta_page_detail_' + pageId;
  return getOrFetch(cKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const res = await metaClient.get('/fetch_page_ad_details', {
        params: { page_id: pageId },
      });
      return res.data;
    }));
  }, 3600);
}

// ─── Legacy wrappers ──────────────────────────────────────────────────────────
async function searchMetaAds({ keyword = '', country = 'US' }) {
  return searchTikTokAds({ keyword, country, order: 'like', period: '7' });
}
async function searchGoogleAds({ keyword = '', country = 'US' }) {
  return searchTikTokAds({ keyword, country, order: 'like', period: '7' });
}

// ─── AliExpress ───────────────────────────────────────────────────────────────
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

async function getAliExpressCategories() {
  return getOrFetch('aliexpress_categories', async () => {
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
  getTrendingVideos,
  getTrendingHashtags,
  getTrendingSounds,
  getTrendingCreators,
  searchMetaAds,
  searchGoogleAds,
  getAliExpressHotProducts,
  getAliExpressCategories,
  getMetaPageAds,
  searchMetaAdsByKeyword,
  getMetaPageAdDetails,
};
