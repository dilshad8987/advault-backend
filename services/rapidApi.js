// services/rapidApi.js
//
// Sirf 2 kaam:
// 1. TikTok — RapidAPI (tiktok-scraper7)
// 2. AliExpress — RapidAPI (free-aliexpress-api)
//
// Meta — MongoDB se seedha serve hota hai (scraper se)
// Apify — HATAYA GAYA

const axios = require('axios');
const { makeCacheKey, getOrFetch } = require('./cache');

// TikTok Client
const TT_HOST = process.env.RAPIDAPI_HOST || 'tiktok-scraper7.p.rapidapi.com';
const TT_KEY  = process.env.RAPIDAPI_KEY;
const ttClient = axios.create({
  baseURL: "https://" + TT_HOST,
  headers: { 'x-rapidapi-key': TT_KEY, 'x-rapidapi-host': TT_HOST, 'Content-Type': 'application/json' },
  timeout: 15000,
});

// AliExpress Client
const ALI_HOST = process.env.ALIEXPRESS_HOST || 'free-aliexpress-api.p.rapidapi.com';
const ALI_KEY  = process.env.ALIEXPRESS_KEY  || process.env.RAPIDAPI_KEY;
const aliClient = axios.create({
  baseURL: "https://" + ALI_HOST,
  headers: { 'x-rapidapi-key': ALI_KEY, 'x-rapidapi-host': ALI_HOST, 'Content-Type': 'application/json' },
  timeout: 15000,
});

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

// TikTok functions
async function searchTikTokAds({ country='US', order='like', keyword='', period='7' }) {
  return getOrFetch(makeCacheKey('tiktok_search',{country,order,keyword,period}), () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/ads/top/ads', { params:{page:1,limit:20,country_code:country,order_by:order,period,keyword} }).then(r=>r.data)))
  );
}
async function getTikTokAdDetails(materialId) {
  return getOrFetch('tiktok_detail_'+materialId, () =>
    rateLimitedCall(() => withRetry(() => ttClient.get('/ads/top/ads/detail', { params:{material_id:materialId} }).then(r=>r.data)))
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

// AliExpress functions
async function getAliExpressHotProducts({catId='15',page=1,currency='USD',keyword=''}) {
  return getOrFetch(makeCacheKey('aliexpress_hot',{catId,page,currency,keyword}), async () => {
    const params = { cat_id:catId, sort:'LAST_VOLUME_DESC', target_currency:currency, target_language:'EN', page:parseInt(page)||1 };
    if (keyword && keyword.trim()) params.keywords = keyword.trim();
    return aliClient.get('/hot_products', { params }).then(r=>r.data);
  });
}
async function getAliExpressCategories() {
  return getOrFetch('aliexpress_categories', () => aliClient.get('/categories').then(r=>r.data), 86400);
}

// Meta stubs — routes/ads.js mein MongoDB se serve hota hai
async function getMetaPageAds()         { return { data: { ads: [] } }; }
async function searchMetaAdsByKeyword() { return { data: { keyword_results: [] } }; }
async function getMetaPageAdDetails()   { return { data: { ads: [] } }; }
async function searchMetaAds()          { return { data: { keyword_results: [] } }; }
async function searchGoogleAds()        { return {}; }

module.exports = {
  searchTikTokAds, getTikTokAdDetails, getAdvertiserAds,
  getTopProducts, getProductDetail,
  getTrendingVideos, getTrendingHashtags, getTrendingSounds, getTrendingCreators,
  getAliExpressHotProducts, getAliExpressCategories,
  getMetaPageAds, searchMetaAdsByKeyword, getMetaPageAdDetails,
  searchMetaAds, searchGoogleAds,
};
