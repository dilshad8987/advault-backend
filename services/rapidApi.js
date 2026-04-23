const axios = require('axios');
const { makeCacheKey, getOrFetch } = require('./cache');

const KEY      = process.env.RAPIDAPI_KEY;
const HOST     = process.env.RAPIDAPI_HOST;
const ALI_HOST = process.env.ALIEXPRESS_HOST;

const client = axios.create({
  baseURL: 'https://' + HOST,
  headers: {
    'x-rapidapi-key': KEY,
    'x-rapidapi-host': HOST,
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

const aliClient = axios.create({
  baseURL: 'https://' + ALI_HOST,
  headers: {
    'x-rapidapi-key': KEY,
    'x-rapidapi-host': ALI_HOST,
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

async function searchTikTokAds({ country = 'US', order = 'impression', keyword = '', period = '30' }) {
  const cacheKey = makeCacheKey('tiktok_search', { country, order, keyword, period });
  return getOrFetch(cacheKey, async () => {
    const res = await client.get('/ads/top/ads', {
      params: {
        page: 1,
        limit: 20,
        country_code: country,
        ad_language: 'en',
        order_by: order,
        period: period,
        ad_format: 1,
        keyword: keyword
      }
    });
    return res.data;
  });
}

async function getTikTokAdDetails(adId) {
  const cacheKey = 'tiktok_detail_' + adId;
  return getOrFetch(cacheKey, async () => {
    const res = await client.get('/ads/detail', {
      params: { ad_id: adId }
    });
    return res.data;
  });
}

async function searchMetaAds({ keyword = '', country = 'US' }) {
  const cacheKey = makeCacheKey('meta_search', { keyword, country });
  return getOrFetch(cacheKey, async () => {
    const res = await client.get('/ads/top/ads', {
      params: {
        page: 1,
        limit: 20,
        country_code: country,
        ad_language: 'en',
        order_by: 'impression',
        period: 30,
        ad_format: 1,
        keyword: keyword
      }
    });
    return res.data;
  });
}

async function searchGoogleAds({ keyword = '', country = 'US' }) {
  const cacheKey = makeCacheKey('google_search', { keyword, country });
  return getOrFetch(cacheKey, async () => {
    const res = await client.get('/ads/top/ads', {
      params: {
        page: 1,
        limit: 20,
        country_code: country,
        order_by: 'impression',
        period: 30,
        keyword: keyword
      }
    });
    return res.data;
  });
}

async function getAliExpressHotProducts({ catId = '15', page = 1, currency = 'USD' }) {
  const cacheKey = makeCacheKey('aliexpress_hot', { catId, page, currency });
  return getOrFetch(cacheKey, async () => {
    const res = await aliClient.get('/hot_products', {
      params: {
        cat_id: catId,
        sort: 'LAST_VOLUME_DESC',
        target_currency: currency,
        target_language: 'EN',
        page
      }
    });
    return res.data;
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
  searchMetaAds,
  searchGoogleAds,
  getAliExpressHotProducts,
  getAliExpressCategories
};
