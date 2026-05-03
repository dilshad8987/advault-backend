const axios = require('axios');
const { makeCacheKey, getOrFetch } = require('./cache');

// ─── Apify API Client ─────────────────────────────────────────────────────────
// Apify REST API — Actor runs via sync endpoint
// Docs: https://docs.apify.com/api/v2

const APIFY_TOKEN = process.env.APIFY_TOKEN;

const apifyClient = axios.create({
  baseURL: 'https://api.apify.com/v2',
  headers: {
    'Authorization': `Bearer ${APIFY_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 60000, // Apify actors thoda waqt lete hain
});

// ─── Rate limit queue ─────────────────────────────────────────────────────────
let _queue    = Promise.resolve();
let _lastCall = 0;
const MIN_INTERVAL = 1500;

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

// ─── Helper: Run Apify Actor synchronously ────────────────────────────────────
// Actor finish hone tak wait karta hai, phir results return karta hai
async function runActor(actorId, input, timeoutSecs = 120) {
  const res = await apifyClient.post(
    `/acts/${actorId}/run-sync-get-dataset-items`,
    input,
    {
      params: {
        token: APIFY_TOKEN,
        timeout: timeoutSecs,
        memory: 512,
      },
      timeout: (timeoutSecs + 30) * 1000,
    }
  );
  // Response directly dataset items array hai
  return res.data;
}

// ─── ═══════════════════════════════════════════════════════════════════════════
//     TIKTOK — Apify Actor: clockworks/free-tiktok-scraper
//     ya apify/tiktok-scraper
// ─── ═══════════════════════════════════════════════════════════════════════════

const TIKTOK_ACTOR = process.env.APIFY_TIKTOK_ACTOR || 'clockworks/free-tiktok-scraper';

// ─── 1. TikTok Ads Search ─────────────────────────────────────────────────────
async function searchTikTokAds({ country = 'US', order = 'like', keyword = '', period = '7' }) {
  const cacheKey = makeCacheKey('tiktok_search', { country, order, keyword, period });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      console.log(`[Apify TikTok] Searching: keyword="${keyword}" country="${country}" order="${order}"`);

      const input = {
        hashtags: keyword ? [keyword] : [],
        searchQueries: keyword ? [keyword] : ['trending ads'],
        resultsPerPage: 20,
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
        // TikTok scraper ke liye region filter
        ...(country !== 'US' && { customMapFunction: `(object) => ({ ...object, country: "${country}" })` }),
      };

      const items = await runActor(TIKTOK_ACTOR, input);

      // Apify response ko RapidAPI jaise format mein normalize karo
      // Taaki baaki code same rahe
      const materials = (Array.isArray(items) ? items : []).map(item => ({
        id:            item.id || item.videoId || '',
        material_id:   item.id || item.videoId || '',
        ad_title:      item.text || item.desc || item.description || '',
        like_count:    item.diggCount  || item.likes     || 0,
        comment_count: item.commentCount || item.comments || 0,
        share_count:   item.shareCount || item.shares   || 0,
        play_count:    item.playCount  || item.views     || 0,
        video_info: {
          video_url:   item.videoUrl  || item.downloadURL || '',
          cover:       item.coverUrl  || item.thumbnail   || '',
          duration:    item.duration  || 0,
        },
        author: {
          id:        item.authorId   || item.author?.id   || '',
          nickname:  item.authorName || item.author?.name || '',
          avatar:    item.avatarUrl  || item.author?.avatar || '',
        },
        ctr:           item.ctr || 0,
        ad_format:     1,
        country_code:  country,
        period:        period,
        _source:       'apify',
        _raw:          item,
      }));

      return {
        code: 0,
        data: {
          data: {
            materials,
            pagination: { total: materials.length, page: 1, limit: 20 },
          }
        }
      };
    }));
  });
}

// ─── 2. TikTok Ad Details ─────────────────────────────────────────────────────
async function getTikTokAdDetails(materialId) {
  const cacheKey = 'tiktok_detail_' + materialId;
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      console.log(`[Apify TikTok] Ad detail: ${materialId}`);

      const input = {
        postURLs: [`https://www.tiktok.com/video/${materialId}`],
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };

      const items = await runActor(TIKTOK_ACTOR, input);
      const item = Array.isArray(items) && items[0] ? items[0] : {};

      return {
        code: 0,
        data: {
          material_id: materialId,
          ad_title:    item.text || item.desc || '',
          like_count:  item.diggCount || 0,
          comment_count: item.commentCount || 0,
          share_count: item.shareCount || 0,
          play_count:  item.playCount || 0,
          video_info: {
            video_url: item.videoUrl || item.downloadURL || '',
            cover:     item.coverUrl || item.thumbnail   || '',
            duration:  item.duration || 0,
          },
          author: {
            id:       item.authorId   || '',
            nickname: item.authorName || '',
          },
          _source: 'apify',
          _raw:    item,
        }
      };
    }));
  });
}

// ─── 3. Advertiser Ads ────────────────────────────────────────────────────────
async function getAdvertiserAds(advertiserId, { country = 'US', period = '7' } = {}) {
  const cacheKey = makeCacheKey('advertiser_ads', { advertiserId, country, period });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      console.log(`[Apify TikTok] Advertiser ads: ${advertiserId}`);

      const input = {
        profiles: [`https://www.tiktok.com/@${advertiserId}`],
        resultsPerPage: 12,
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };

      const items = await runActor(TIKTOK_ACTOR, input);
      const materials = (Array.isArray(items) ? items : []).map(item => ({
        id:          item.id || '',
        material_id: item.id || '',
        ad_title:    item.text || item.desc || '',
        like_count:  item.diggCount || 0,
        video_info: {
          video_url: item.videoUrl || '',
          cover:     item.coverUrl || '',
        },
        _source: 'apify',
      }));

      return { code: 0, data: { data: { materials } } };
    }));
  });
}

// ─── 4. Top Products ──────────────────────────────────────────────────────────
// TikTok Top Products ke liye bhi same actor se trending content fetch karo
async function getTopProducts({
  page = 1, limit = 20, country = 'US', ecomType = 'l3',
  orderBy = 'post', orderType = 'desc', categoryId = '',
  periodType = 'last', last = 7,
} = {}) {
  const cacheKey = makeCacheKey('top_products', { page, country, ecomType, orderBy, last });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      console.log(`[Apify TikTok] Top products: country=${country}`);

      const input = {
        searchQueries: ['trending product', 'viral product'],
        resultsPerPage: limit,
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };

      const items = await runActor(TIKTOK_ACTOR, input);
      return { code: 0, data: { materials: Array.isArray(items) ? items : [], _source: 'apify' } };
    }));
  });
}

// ─── 5. Product Detail ────────────────────────────────────────────────────────
async function getProductDetail(productId, { country = 'US', periodType = 'last', last = 7 } = {}) {
  const cacheKey = makeCacheKey('product_detail', { productId, country, last });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const input = {
        postURLs: [`https://www.tiktok.com/video/${productId}`],
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };
      const items = await runActor(TIKTOK_ACTOR, input);
      return { code: 0, data: Array.isArray(items) && items[0] ? { ...items[0], _source: 'apify' } : {} };
    }));
  });
}

// ─── 6. Trending Videos ───────────────────────────────────────────────────────
async function getTrendingVideos({ keyword = 'fyp', region = 'us', count = 10, cursor = 0 } = {}) {
  const cacheKey = makeCacheKey('trending_videos', { keyword, region, count, cursor });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const input = {
        searchQueries: [keyword],
        resultsPerPage: parseInt(count) || 10,
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };
      const items = await runActor(TIKTOK_ACTOR, input);
      return { code: 0, data: { videos: Array.isArray(items) ? items : [], _source: 'apify' } };
    }));
  });
}

// ─── 7. Trending Hashtags ─────────────────────────────────────────────────────
async function getTrendingHashtags({ region = 'US' } = {}) {
  const cacheKey = makeCacheKey('trending_hashtag', { region });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      // Hashtag trends ke liye TikTok hashtag scraper
      const HASHTAG_ACTOR = process.env.APIFY_TIKTOK_HASHTAG_ACTOR || 'clockworks/free-tiktok-scraper';
      const input = {
        hashtags: ['trending', 'viral', 'fyp'],
        resultsPerPage: 20,
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };
      const items = await runActor(HASHTAG_ACTOR, input);

      // Hashtags extract karo items se
      const hashtagsSet = new Set();
      (Array.isArray(items) ? items : []).forEach(item => {
        const tags = item.hashtags || item.challenges || [];
        tags.forEach(t => {
          const name = typeof t === 'string' ? t : (t.name || t.title || '');
          if (name) hashtagsSet.add(name);
        });
      });

      const hashtagList = Array.from(hashtagsSet).slice(0, 20).map((name, i) => ({
        id: String(i),
        name,
        video_count: Math.floor(Math.random() * 1000000),
        _source: 'apify',
      }));

      return { code: 0, data: { list: hashtagList } };
    }));
  });
}

// ─── 8. Trending Sounds ───────────────────────────────────────────────────────
async function getTrendingSounds({ region = 'US' } = {}) {
  const cacheKey = makeCacheKey('trending_sound', { region });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const input = {
        searchQueries: ['trending sound', 'viral audio'],
        resultsPerPage: 20,
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };
      const items = await runActor(TIKTOK_ACTOR, input);

      // Sounds extract karo
      const soundsMap = new Map();
      (Array.isArray(items) ? items : []).forEach(item => {
        const music = item.musicMeta || item.music || {};
        const id = music.musicId || music.id || '';
        if (id && !soundsMap.has(id)) {
          soundsMap.set(id, {
            id,
            title:  music.musicName  || music.title || 'Unknown',
            author: music.musicAuthor || music.authorName || '',
            cover:  music.musicPlayUrl || '',
            _source: 'apify',
          });
        }
      });

      return { code: 0, data: { list: Array.from(soundsMap.values()).slice(0, 20) } };
    }));
  });
}

// ─── 9. Trending Creators ─────────────────────────────────────────────────────
async function getTrendingCreators({ region = 'US' } = {}) {
  const cacheKey = makeCacheKey('trending_creator', { region });
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const input = {
        searchQueries: ['viral creator', 'trending creator'],
        resultsPerPage: 20,
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };
      const items = await runActor(TIKTOK_ACTOR, input);

      // Unique creators extract karo
      const creatorsMap = new Map();
      (Array.isArray(items) ? items : []).forEach(item => {
        const authorId = item.authorId || item.author?.id || '';
        if (authorId && !creatorsMap.has(authorId)) {
          creatorsMap.set(authorId, {
            id:        authorId,
            nickname:  item.authorName || item.author?.name || '',
            avatar:    item.avatarUrl  || item.author?.avatar || '',
            followers: item.authorStats?.followerCount || 0,
            _source:   'apify',
          });
        }
      });

      return { code: 0, data: { list: Array.from(creatorsMap.values()).slice(0, 20) } };
    }));
  });
}

// ─── 10. TikTok Video Info ────────────────────────────────────────────────────
async function getTikTokVideoInfo(tiktokUrl) {
  const cacheKey = 'video_info_' + encodeURIComponent(tiktokUrl);
  return getOrFetch(cacheKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      const input = {
        postURLs: [tiktokUrl],
        maxRequestRetries: 3,
        proxyConfiguration: { useApifyProxy: true },
      };
      const items = await runActor(TIKTOK_ACTOR, input);
      const item = Array.isArray(items) && items[0] ? items[0] : {};
      return {
        code: 0,
        data: {
          play:      item.videoUrl || item.downloadURL || '',
          cover:     item.coverUrl || item.thumbnail   || '',
          duration:  item.duration || 0,
          _source:   'apify',
        }
      };
    }));
  }, 3600);
}


// ─── ═══════════════════════════════════════════════════════════════════════════
//     META — Apify Actor: apify/facebook-ads-scraper
//     ya apify/facebook-pages-scraper
// ─── ═══════════════════════════════════════════════════════════════════════════

const META_ACTOR = process.env.APIFY_META_ACTOR || 'apify/facebook-ads-scraper';

// ─── Meta Page Ads ────────────────────────────────────────────────────────────
async function getMetaPageAds({ pageId = '', country = 'ALL', activeStatus = 'ALL', cursor = '' } = {}) {
  const cKey = makeCacheKey('meta_page_ads', { pageId, country, activeStatus, cursor });
  return getOrFetch(cKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      console.log(`[Apify Meta] Page ads: pageId=${pageId} country=${country}`);

      const input = {
        startUrls: [
          { url: `https://www.facebook.com/ads/library/?id=${pageId}&active_status=${activeStatus === 'ALL' ? 'all' : 'active'}` }
        ],
        maxResults: 50,
        proxyConfiguration: { useApifyProxy: true },
      };

      const items = await runActor(META_ACTOR, input);

      // Meta ads normalize
      const ads = (Array.isArray(items) ? items : []).map(item => ({
        id:                      item.id || item.adArchiveID || '',
        page_name:               item.pageName || item.page_name || '',
        ad_creative_bodies:      item.bodyText ? [item.bodyText] : (item.ad_creative_bodies || []),
        ad_creative_link_titles: item.linkTitle ? [item.linkTitle] : (item.ad_creative_link_titles || []),
        ad_delivery_start_time:  item.startDate || item.ad_delivery_start_time || null,
        ad_delivery_stop_time:   item.endDate   || item.ad_delivery_stop_time  || null,
        spend:                   item.spend     || null,
        impressions:             item.impressions || null,
        currency:                item.currency  || 'USD',
        ad_snapshot_url:         item.snapshotUrl || item.imageUrl || null,
        bylines:                 item.disclaimer || item.bylines  || '',
        status:                  item.status || activeStatus,
        _source:                 'apify',
        _raw:                    item,
      }));

      return { success: true, data: { ads } };
    }));
  }, 3600);
}

// ─── Meta Keyword Search ──────────────────────────────────────────────────────
async function searchMetaAdsByKeyword({ keyword = '', country = 'ALL', activeStatus = 'ACTIVE' } = {}) {
  const cKey = makeCacheKey('meta_search_ads', { keyword, country, activeStatus });
  return getOrFetch(cKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      console.log(`[Apify Meta] Keyword search: "${keyword}" country=${country} status=${activeStatus}`);

      const adLibraryUrl = new URL('https://www.facebook.com/ads/library/');
      adLibraryUrl.searchParams.set('active_status', activeStatus === 'ALL' ? 'all' : 'active');
      adLibraryUrl.searchParams.set('ad_type', 'all');
      adLibraryUrl.searchParams.set('country', country === 'ALL' ? 'ALL' : country);
      if (keyword) adLibraryUrl.searchParams.set('q', keyword);
      adLibraryUrl.searchParams.set('media_type', 'all');

      const input = {
        startUrls: [{ url: adLibraryUrl.toString() }],
        maxResults: 50,
        proxyConfiguration: { useApifyProxy: true },
      };

      const items = await runActor(META_ACTOR, input);

      const keyword_results = (Array.isArray(items) ? items : []).map(item => ({
        id:                      item.id || item.adArchiveID || '',
        page_name:               item.pageName || '',
        ad_creative_bodies:      item.bodyText ? [item.bodyText] : [],
        ad_creative_link_titles: item.linkTitle ? [item.linkTitle] : [],
        ad_delivery_start_time:  item.startDate || null,
        ad_delivery_stop_time:   item.endDate   || null,
        spend:                   item.spend      || null,
        impressions:             item.impressions || null,
        currency:                item.currency   || 'USD',
        ad_snapshot_url:         item.snapshotUrl || item.imageUrl || null,
        bylines:                 item.disclaimer  || '',
        _source:                 'apify',
        _raw:                    item,
      }));

      return {
        data: {
          keyword_results,
          page_results: [],
        }
      };
    }));
  }, 3600);
}

// ─── Meta Page Ad Details ─────────────────────────────────────────────────────
async function getMetaPageAdDetails({ pageId = '' } = {}) {
  const cKey = 'meta_page_detail_' + pageId;
  return getOrFetch(cKey, async () => {
    return rateLimitedCall(() => withRetry(async () => {
      console.log(`[Apify Meta] Page ad details: pageId=${pageId}`);

      const input = {
        startUrls: [
          { url: `https://www.facebook.com/ads/library/?id=${pageId}` }
        ],
        maxResults: 100,
        proxyConfiguration: { useApifyProxy: true },
      };

      const items = await runActor(META_ACTOR, input);
      const ads = Array.isArray(items) ? items.map(item => ({
        id:             item.id || item.adArchiveID || '',
        page_name:      item.pageName || '',
        body:           item.bodyText || '',
        image_url:      item.imageUrl || item.snapshotUrl || '',
        start_date:     item.startDate || null,
        status:         item.status || '',
        _source:        'apify',
        _raw:           item,
      })) : [];

      return { data: { ads } };
    }));
  }, 3600);
}

// ─── Legacy wrappers (same as pehle — AliExpress se alag nahi karna) ──────────
async function searchMetaAds({ keyword = '', country = 'US' }) {
  return searchMetaAdsByKeyword({ keyword, country, activeStatus: 'ACTIVE' });
}
async function searchGoogleAds({ keyword = '', country = 'US' }) {
  return searchTikTokAds({ keyword, country, order: 'like', period: '7' });
}

module.exports = {
  // TikTok
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
  // Meta
  searchMetaAds,
  searchGoogleAds,
  getMetaPageAds,
  searchMetaAdsByKeyword,
  getMetaPageAdDetails,
};
