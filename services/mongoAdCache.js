// services/mongoAdCache.js
//
// Yeh service do kaam karti hai:
//
// 1. ADS LIST CACHE (/api/ads/tiktok)
//    User A → API call → puri list MongoDB mein save
//    User B → MongoDB se same list (no API call)
//    24 hr baad → auto-delete → fresh API call
//
// 2. INDIVIDUAL AD CACHE (/api/ads/tiktok/:adId + /video/url)
//    Koi bhi ad ka detail fetch karo → MongoDB mein save
//    Doosra user same ad khola → MongoDB se milega
//    Video URL, comments, likes, cover — sab cached

const mongoose = require('mongoose');
const AdListCache = require('../models/AdListCache');
const AdDataCache = require('../models/AdDataCache');

// ─── Helper: MongoDB connected hai? ──────────────────────────────────────────
function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: ADS LIST CACHE
// /api/ads/tiktok?country=US&order=like&period=7
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ads list cache key banao
 */
function makeListCacheKey(country, order, period) {
  return `${country}_${order}_${period}`;
}

/**
 * Ads list — MongoDB se lo ya API se fetch karke save karo
 * 
 * @param {string} country
 * @param {string} order
 * @param {string} period
 * @param {Function} fetchFn - RapidAPI call function
 * @param {string} userId - optional
 */
async function getOrFetchAdsList(country, order, period, fetchFn, userId = null) {
  if (!isMongoConnected()) {
    console.warn('⚠️  MongoDB nahi — direct API call for ads list');
    const result = await fetchFn();
    return { data: result, from_cache: false, cache_type: 'none' };
  }

  const cacheKey = makeListCacheKey(country, order, period);

  try {
    // Step 1: MongoDB mein check karo
    const cached = await AdListCache.findOne({ cache_key: cacheKey });

    if (cached) {
      console.log(`✅ MongoDB List Cache HIT: ${cacheKey} (${cached.total} ads)`);
      return {
        data: cached.raw_response,
        from_cache: true,
        cache_type: 'mongodb',
        cached_at: cached.createdAt,
      };
    }

    // Step 2: Cache miss — RapidAPI se fetch karo
    console.log(`🌐 MongoDB List Cache MISS: ${cacheKey} — API call ho rahi hai`);
    const apiResult = await fetchFn();

    // Total ads count nikalo
    const materials = apiResult?.data?.data?.materials
                   || apiResult?.data?.materials
                   || apiResult?.materials
                   || [];

    // Step 3: MongoDB mein save karo
    try {
      await AdListCache.create({
        cache_key: cacheKey,
        params: { country, order, period },
        total: Array.isArray(materials) ? materials.length : 0,
        raw_response: apiResult,
        fetched_by_user: userId,
      });
      console.log(`💾 Ads list saved to MongoDB: ${cacheKey} (${materials.length} ads, 24hr TTL)`);

      // Individual ads bhi save karo background mein
      if (Array.isArray(materials) && materials.length > 0) {
        saveIndividualAdsBackground(materials, cacheKey, userId);
      }

    } catch (saveErr) {
      if (saveErr.code === 11000) {
        // Race condition — doosre request ne pehle save kar diya
        const existing = await AdListCache.findOne({ cache_key: cacheKey });
        if (existing) {
          return { data: existing.raw_response, from_cache: true, cache_type: 'mongodb' };
        }
      } else {
        console.error('AdListCache save error:', saveErr.message);
      }
    }

    return { data: apiResult, from_cache: false, cache_type: 'mongodb' };

  } catch (err) {
    console.error('getOrFetchAdsList error:', err.message);
    // MongoDB fail → direct API call
    const result = await fetchFn();
    return { data: result, from_cache: false, cache_type: 'none' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: INDIVIDUAL AD CACHE
// /api/ads/tiktok/:adId  +  /api/ads/video/url
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Individual ad detail — MongoDB se lo ya API se fetch karke save karo
 * 
 * @param {string} adId - material_id
 * @param {Function} fetchFn - API call function
 * @param {string} userId
 */
async function getOrFetchAdDetail(adId, fetchFn, userId = null) {
  if (!isMongoConnected()) {
    const result = await fetchFn();
    return { data: result, from_cache: false };
  }

  try {
    const cached = await AdDataCache.findOne({ ad_id: adId });

    if (cached) {
      console.log(`✅ MongoDB Ad Cache HIT: ${adId}`);
      return {
        data: cached.raw_data,          // pura original data
        video: cached.video,            // structured video info
        stats: cached.stats,            // likes, comments, etc.
        meta: cached.meta,              // title, industry, etc.
        advertiser: cached.advertiser,  // advertiser info
        from_cache: true,
        cached_at: cached.createdAt,
      };
    }

    // Cache miss — API se fetch karo
    console.log(`🌐 MongoDB Ad Cache MISS: ${adId}`);
    const apiResult = await fetchFn();

    // Data extract aur save karo
    await saveAdToCache(adId, apiResult, null, userId);

    return { data: apiResult, from_cache: false };

  } catch (err) {
    console.error('getOrFetchAdDetail error:', err.message);
    return { data: await fetchFn(), from_cache: false };
  }
}

/**
 * Video URL — MongoDB se lo ya API se fetch karke save karo
 * Agar ad already cached hai → uski video URL update karo
 *
 * @param {string} adId
 * @param {Function} fetchFn - returns { play_url, cover_url }
 * @param {string} userId
 */
async function getOrFetchVideoUrl(adId, fetchFn, userId = null) {
  if (!isMongoConnected()) {
    const result = await fetchFn();
    return { ...result, from_cache: false, cache_type: 'none' };
  }

  try {
    // Pehle check karo — kya ad already cached hai aur usmein video URL hai?
    const cached = await AdDataCache.findOne({ ad_id: adId });

    if (cached && cached.video?.play_url) {
      console.log(`✅ MongoDB Video URL HIT: ${adId}`);
      return {
        play_url: cached.video.play_url,
        cover_url: cached.video.cover_url,
        from_cache: true,
        cache_type: 'mongodb',
      };
    }

    // Fetch karo
    console.log(`🌐 MongoDB Video URL MISS: ${adId}`);
    const { play_url, cover_url } = await fetchFn();

    if (!play_url) throw new Error('Video URL nahi mili API se');

    // Save ya update karo
    if (cached) {
      // Ad exist karta hai — sirf video update karo
      await AdDataCache.updateOne(
        { ad_id: adId },
        { $set: { 'video.play_url': play_url, 'video.cover_url': cover_url || null } }
      );
      console.log(`🔄 Video URL updated in existing ad cache: ${adId}`);
    } else {
      // Nayi entry banao — sirf video URL ke saath
      try {
        await AdDataCache.create({
          ad_id: adId,
          video: { play_url, cover_url: cover_url || null },
          fetched_by_user: userId,
        });
        console.log(`💾 New ad video cached: ${adId} (24hr TTL)`);
      } catch (e) {
        if (e.code !== 11000) console.error('Video cache save error:', e.message);
      }
    }

    return { play_url, cover_url: cover_url || null, from_cache: false, cache_type: 'mongodb' };

  } catch (err) {
    if (err.name?.includes('Mongo')) {
      const result = await fetchFn();
      return { ...result, from_cache: false, cache_type: 'none' };
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: DATA EXTRACTION + SAVE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ek ad object ko parse karke MongoDB mein save karo
 * (List se ya Detail API se dono ke liye kaam karta hai)
 */
async function saveAdToCache(adId, rawData, cacheKey = null, userId = null) {
  try {
    // Raw data se structured fields extract karo
    const ad = rawData?.data?.data || rawData?.data || rawData || {};

    // Video info
    const videoInfo = ad.video_info || {};
    const videoUrlObj = videoInfo.video_url || {};
    let playUrl = null;

    if (typeof videoUrlObj === 'object' && !Array.isArray(videoUrlObj)) {
      playUrl = videoUrlObj['720p'] || videoUrlObj['540p']
             || videoUrlObj['480p'] || videoUrlObj['360p']
             || Object.values(videoUrlObj)[0] || null;
    } else if (typeof videoUrlObj === 'string') {
      playUrl = videoUrlObj || null;
    }

    const videoData = {
      play_url:  playUrl,
      cover_url: videoInfo.cover || videoInfo.origin_cover || null,
      duration:  videoInfo.duration || null,
      width:     videoInfo.width || null,
      height:    videoInfo.height || null,
      vid:       videoInfo.vid || null,
    };

    // Stats
    const statsData = {
      likes:      ad.like_count      || ad.likes      || 0,
      comments:   ad.comment_count   || ad.comments   || 0,
      shares:     ad.share_count     || ad.shares     || 0,
      views:      ad.play_count      || ad.views      || 0,
      ctr:        ad.ctr             || 0,
      impression: ad.impression      || 0,
      cost:       ad.cost            || 0,
      like_rate:  ad.like_rate       || 0,
    };

    // Meta
    const metaData = {
      title:           ad.ad_title     || ad.title       || '',
      industry:        ad.industry_key || ad.industry     || '',
      objective:       ad.objective    || '',
      country_code:    ad.country_code || '',
      ad_language:     ad.ad_language  || '',
      is_active:       ad.is_active    || false,
      run_days:        ad.first_shown_date ? Math.floor((Date.now()/1000 - ad.first_shown_date) / 86400) : 0,
      tiktok_item_url: ad.tiktok_item_url || ad.share_url || null,
      share_url:       ad.share_url        || null,
    };

    // Advertiser
    const advData = {
      id:     ad.advertiser_id   || null,
      name:   ad.advertiser_name || '',
      avatar: ad.avatar_url      || null,
    };

    await AdDataCache.findOneAndUpdate(
      { ad_id: adId },
      {
        $set: {
          ad_id: adId,
          cache_key: cacheKey,
          video: videoData,
          stats: statsData,
          meta: metaData,
          advertiser: advData,
          raw_data: rawData,
          fetched_by_user: userId,
          createdAt: new Date(), // TTL reset
        }
      },
      { upsert: true, new: true }
    );

  } catch (err) {
    if (err.code !== 11000) {
      console.error(`saveAdToCache error (${adId}):`, err.message);
    }
  }
}

/**
 * Ads list se sab individual ads background mein save karo
 * (non-blocking — user ko wait nahi karni)
 */
function saveIndividualAdsBackground(materials, cacheKey, userId) {
  // setImmediate se next tick mein chalao — current request block nahi hogi
  setImmediate(async () => {
    let saved = 0;
    for (const ad of materials) {
      const adId = ad.material_id || ad.id || ad.ad_id;
      if (!adId) continue;

      try {
        await saveAdToCache(String(adId), ad, cacheKey, userId);
        saved++;
      } catch (e) {
        // Silent fail — individual save fail hona ok hai
      }
    }
    console.log(`📦 Background save complete: ${saved}/${materials.length} ads cached individually`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: CACHE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ek specific ad ka cache manually delete karo
 */
async function invalidateAdCache(adId) {
  try {
    const r = await AdDataCache.deleteOne({ ad_id: adId });
    return r.deletedCount > 0;
  } catch (err) {
    console.error('invalidateAdCache error:', err.message);
    return false;
  }
}

/**
 * Ek specific list ka cache manually delete karo
 */
async function invalidateListCache(country, order, period) {
  try {
    const key = makeListCacheKey(country, order, period);
    const r = await AdListCache.deleteOne({ cache_key: key });
    return r.deletedCount > 0;
  } catch (err) {
    console.error('invalidateListCache error:', err.message);
    return false;
  }
}

/**
 * Cache stats — kitna data cached hai
 */
async function getCacheStats() {
  try {
    const [listCount, adCount] = await Promise.all([
      AdListCache.countDocuments(),
      AdDataCache.countDocuments(),
    ]);

    const newestList = await AdListCache.findOne().sort({ createdAt: -1 }).select('cache_key createdAt');
    const newestAd   = await AdDataCache.findOne().sort({ createdAt: -1 }).select('ad_id createdAt');

    return {
      cached_lists: listCount,
      cached_ads: adCount,
      newest_list: newestList ? { key: newestList.cache_key, at: newestList.createdAt } : null,
      newest_ad:   newestAd   ? { id:  newestAd.ad_id,       at: newestAd.createdAt   } : null,
      ttl: '24 hours — auto-delete by MongoDB TTL index',
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  // List cache
  getOrFetchAdsList,
  invalidateListCache,
  // Individual ad cache
  getOrFetchAdDetail,
  getOrFetchVideoUrl,
  invalidateAdCache,
  saveAdToCache,
  // Stats
  getCacheStats,
};
