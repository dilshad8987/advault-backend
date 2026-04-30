// services/mongoAdCache.js
//
// 1. ADS LIST CACHE — puri list MongoDB mein save/retrieve
// 2. INDIVIDUAL AD CACHE — video URL, likes, comments, sab kuch cached
// 3. MIDNIGHT RESET — raat 12 baje sharp:
//       - Purana saara data delete
//       - Fresh data API se fetch
//       - MongoDB mein save
//    Phir agले din raat 12 baje yahi repeat

const mongoose    = require('mongoose');
const axios       = require('axios');
const AdListCache = require('../models/AdListCache');
const AdDataCache = require('../models/AdDataCache');

function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}
function makeListCacheKey(country, order, period) {
  return `${country}_${order}_${period}`;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// RapidAPI client
const ttClient = axios.create({
  baseURL: `https://${process.env.RAPIDAPI_HOST || 'tiktok-scraper7.p.rapidapi.com'}`,
  headers: {
    'x-rapidapi-key':  process.env.RAPIDAPI_KEY,
    'x-rapidapi-host': process.env.RAPIDAPI_HOST || 'tiktok-scraper7.p.rapidapi.com',
  },
  timeout: 30000,
});

// Saari combinations jo load karni hain
const ALL_COUNTRIES = ['US', 'GB', 'IN', 'AU', 'CA', 'FR', 'DE'];
const ALL_ORDERS    = ['like', 'impression', 'comment'];
const ALL_PERIODS   = ['7', '30'];

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: ADS LIST CACHE
// ═══════════════════════════════════════════════════════════════════════════════

async function getOrFetchAdsList(country, order, period, fetchFn, userId = null) {
  if (!isMongoConnected()) {
    const result = await fetchFn();
    return { data: result, from_cache: false, cache_type: 'none' };
  }

  const cacheKey = makeListCacheKey(country, order, period);

  try {
    const cached = await AdListCache.findOne({ cache_key: cacheKey });
    if (cached) {
      console.log(`✅ MongoDB List Cache HIT: ${cacheKey} (${cached.total} ads)`);
      return { data: cached.raw_response, from_cache: true, cache_type: 'mongodb' };
    }

    console.log(`🌐 MongoDB List Cache MISS: ${cacheKey} — API call ho rahi hai`);
    const apiResult = await fetchFn();
    const materials = apiResult?.data?.data?.materials || apiResult?.data?.materials || apiResult?.materials || [];

    try {
      await AdListCache.create({
        cache_key: cacheKey,
        params: { country, order, period },
        total: Array.isArray(materials) ? materials.length : 0,
        raw_response: apiResult,
        fetched_by_user: userId,
      });
      console.log(`💾 Ads list saved: ${cacheKey} (${materials.length} ads)`);
      if (Array.isArray(materials) && materials.length > 0) {
        saveIndividualAdsBackground(materials, cacheKey, userId);
      }
    } catch (saveErr) {
      if (saveErr.code === 11000) {
        const existing = await AdListCache.findOne({ cache_key: cacheKey });
        if (existing) return { data: existing.raw_response, from_cache: true, cache_type: 'mongodb' };
      }
    }

    return { data: apiResult, from_cache: false, cache_type: 'mongodb' };
  } catch (err) {
    console.error('getOrFetchAdsList error:', err.message);
    const result = await fetchFn();
    return { data: result, from_cache: false, cache_type: 'none' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: INDIVIDUAL AD + VIDEO URL CACHE
// ═══════════════════════════════════════════════════════════════════════════════

async function getOrFetchAdDetail(adId, fetchFn, userId = null) {
  if (!isMongoConnected()) {
    return { data: await fetchFn(), from_cache: false };
  }
  try {
    const cached = await AdDataCache.findOne({ ad_id: adId });
    if (cached) {
      console.log(`✅ MongoDB Ad Cache HIT: ${adId}`);
      return { data: cached.raw_data, video: cached.video, stats: cached.stats, meta: cached.meta, advertiser: cached.advertiser, from_cache: true };
    }
    const apiResult = await fetchFn();
    await saveAdToCache(adId, apiResult, null, userId);
    return { data: apiResult, from_cache: false };
  } catch (err) {
    return { data: await fetchFn(), from_cache: false };
  }
}

async function getOrFetchVideoUrl(adId, fetchFn, userId = null) {
  if (!isMongoConnected()) {
    return { ...await fetchFn(), from_cache: false, cache_type: 'none' };
  }
  try {
    const cached = await AdDataCache.findOne({ ad_id: adId });
    if (cached && cached.video?.play_url) {
      console.log(`✅ MongoDB Video URL HIT: ${adId}`);
      return { play_url: cached.video.play_url, cover_url: cached.video.cover_url, from_cache: true, cache_type: 'mongodb' };
    }

    console.log(`🌐 MongoDB Video URL MISS: ${adId}`);
    const { play_url, cover_url } = await fetchFn();
    if (!play_url) throw new Error('Video URL nahi mili');

    if (cached) {
      await AdDataCache.updateOne({ ad_id: adId }, { $set: { 'video.play_url': play_url, 'video.cover_url': cover_url || null } });
    } else {
      try {
        await AdDataCache.create({ ad_id: adId, video: { play_url, cover_url: cover_url || null }, fetched_by_user: userId });
      } catch (e) { if (e.code !== 11000) console.error('Video cache save error:', e.message); }
    }
    return { play_url, cover_url: cover_url || null, from_cache: false, cache_type: 'mongodb' };
  } catch (err) {
    if (err.name?.includes('Mongo')) return { ...await fetchFn(), from_cache: false, cache_type: 'none' };
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: SAVE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function saveAdToCache(adId, rawData, cacheKey = null, userId = null) {
  try {
    const ad          = rawData?.data?.data || rawData?.data || rawData || {};
    const videoInfo   = ad.video_info || {};
    const videoUrlObj = videoInfo.video_url || {};
    let playUrl = null;

    if (typeof videoUrlObj === 'object' && !Array.isArray(videoUrlObj)) {
      playUrl = videoUrlObj['720p'] || videoUrlObj['540p'] || videoUrlObj['480p'] || videoUrlObj['360p'] || Object.values(videoUrlObj)[0] || null;
    } else if (typeof videoUrlObj === 'string') {
      playUrl = videoUrlObj || null;
    }

    await AdDataCache.findOneAndUpdate(
      { ad_id: adId },
      {
        $set: {
          ad_id: adId,
          cache_key: cacheKey,
          video:      { play_url: playUrl, cover_url: videoInfo.cover || videoInfo.origin_cover || null, duration: videoInfo.duration || null, width: videoInfo.width || null, height: videoInfo.height || null, vid: videoInfo.vid || null },
          stats:      { likes: ad.like_count || 0, comments: ad.comment_count || 0, shares: ad.share_count || 0, views: ad.play_count || 0, ctr: ad.ctr || 0, impression: ad.impression || 0, cost: ad.cost || 0, like_rate: ad.like_rate || 0 },
          meta:       { title: ad.ad_title || ad.title || '', industry: ad.industry_key || ad.industry || '', objective: ad.objective || '', country_code: ad.country_code || '', ad_language: ad.ad_language || '', is_active: ad.is_active || false, run_days: ad.first_shown_date ? Math.floor((Date.now()/1000 - ad.first_shown_date) / 86400) : 0, tiktok_item_url: ad.tiktok_item_url || ad.share_url || null, share_url: ad.share_url || null },
          advertiser: { id: ad.advertiser_id || null, name: ad.advertiser_name || '', avatar: ad.avatar_url || null },
          raw_data: rawData,
          fetched_by_user: userId,
          createdAt: new Date(),
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (err) {
    if (err.code !== 11000) console.error(`saveAdToCache error (${adId}):`, err.message);
  }
}

function saveIndividualAdsBackground(materials, cacheKey, userId) {
  setImmediate(async () => {
    let saved = 0;
    for (const ad of materials) {
      const adId = ad.material_id || ad.id || ad.ad_id;
      if (!adId) continue;
      try { await saveAdToCache(String(adId), ad, cacheKey, userId); saved++; } catch (e) {}
    }
    console.log(`📦 Background save complete: ${saved}/${materials.length} ads cached individually`);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: CACHE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function invalidateAdCache(adId) {
  try { const r = await AdDataCache.deleteOne({ ad_id: adId }); return r.deletedCount > 0; }
  catch (err) { return false; }
}

async function invalidateListCache(country, order, period) {
  try { const r = await AdListCache.deleteOne({ cache_key: makeListCacheKey(country, order, period) }); return r.deletedCount > 0; }
  catch (err) { return false; }
}

async function getCacheStats() {
  try {
    const [listCount, adCount] = await Promise.all([AdListCache.countDocuments(), AdDataCache.countDocuments()]);
    const newestList = await AdListCache.findOne().sort({ createdAt: -1 }).select('cache_key createdAt');
    const newestAd   = await AdDataCache.findOne().sort({ createdAt: -1 }).select('ad_id createdAt');
    return { cached_lists: listCount, cached_ads: adCount, newest_list: newestList ? { key: newestList.cache_key, at: newestList.createdAt } : null, newest_ad: newestAd ? { id: newestAd.ad_id, at: newestAd.createdAt } : null, next_reset: 'Raat 12 baje (midnight)' };
  } catch (err) { return { error: err.message }; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: MIDNIGHT RESET
// Raat 12 baje:
//   1. Saara purana data delete
//   2. Saari combinations fresh API se fetch
//   3. MongoDB mein save
//   Agले din phir yahi
// ═══════════════════════════════════════════════════════════════════════════════

async function deleteAllCache() {
  try {
    const [lists, ads] = await Promise.all([
      AdListCache.deleteMany({}),
      AdDataCache.deleteMany({}),
    ]);
    console.log(`🗑️  Midnight reset: ${lists.deletedCount} lists + ${ads.deletedCount} ads deleted`);
  } catch (err) {
    console.error('deleteAllCache error:', err.message);
  }
}

async function fetchAndSaveOneCombination(country, order, period) {
  const cacheKey = makeListCacheKey(country, order, period);
  try {
    const response  = await ttClient.get('/ads/top/ads', {
      params: { page: 1, limit: 20, country_code: country, order_by: order, period },
    });
    const apiResult = response.data;
    const materials = apiResult?.data?.data?.materials || apiResult?.data?.materials || apiResult?.materials || [];

    await AdListCache.create({
      cache_key: cacheKey,
      params: { country, order, period },
      total: materials.length,
      raw_response: apiResult,
      fetched_by_user: 'midnight_reset',
    });

    // Har ad individually bhi save karo with video URL + stats + comments
    for (const ad of materials) {
      const adId = String(ad.material_id || ad.id || '');
      if (!adId) continue;
      try { await saveAdToCache(adId, ad, cacheKey, 'midnight_reset'); } catch (e) {}
    }

    console.log(`✅ Loaded: ${cacheKey} (${materials.length} ads)`);
    return true;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log(`⏳ Rate limit — 60s wait...`);
      await sleep(60000);
    } else {
      console.error(`❌ Failed: ${cacheKey} — ${err.message}`);
    }
    return false;
  }
}

async function runMidnightReset() {
  if (!isMongoConnected()) return;

  console.log('\n🌙 ========================================');
  console.log('🌙 MIDNIGHT RESET shuru ho raha hai...');
  console.log('🌙 ========================================\n');

  // Step 1: Saara purana data delete
  await deleteAllCache();

  // Step 2: Saari combinations fresh fetch karo
  let saved = 0;
  const total = ALL_COUNTRIES.length * ALL_ORDERS.length * ALL_PERIODS.length;
  console.log(`📥 ${total} combinations load ho rahi hain...\n`);

  for (const country of ALL_COUNTRIES) {
    for (const order of ALL_ORDERS) {
      for (const period of ALL_PERIODS) {
        const ok = await fetchAndSaveOneCombination(country, order, period);
        if (ok) saved++;
        await sleep(2000); // rate limit se bachne ke liye
      }
    }
  }

  console.log(`\n🌙 ========================================`);
  console.log(`🌙 MIDNIGHT RESET complete!`);
  console.log(`🌙 ${saved}/${total} combinations loaded`);
  console.log(`🌙 Agli reset: kal raat 12 baje`);
  console.log(`🌙 ========================================\n`);
}

/**
 * Raat 12 baje tak kitna time bacha hai calculate karo
 */
function msUntilMidnight() {
  const now       = new Date();
  const midnight  = new Date();
  midnight.setHours(24, 0, 0, 0); // aaj ki raat 12 baje
  return midnight.getTime() - now.getTime();
}

/**
 * Server.js mein call karo — yeh sab set up kar dega:
 * 1. Server start pe pehli baar saara data load
 * 2. Raat 12 baje → delete + fresh load
 * 3. Har roz repeat
 */
function startMidnightReset() {
  const msLeft = msUntilMidnight();
  const hoursLeft = (msLeft / 1000 / 60 / 60).toFixed(1);

  console.log(`🌙 Midnight reset scheduled — ${hoursLeft} ghante mein hoga (raat 12 baje)`);

  // Pehli baar server start pe data load karo (30 sec baad)
  setTimeout(async () => {
    console.log('📥 Server start — pehli baar saara data load ho raha hai...');
    const total = ALL_COUNTRIES.length * ALL_ORDERS.length * ALL_PERIODS.length;
    let saved = 0;

    for (const country of ALL_COUNTRIES) {
      for (const order of ALL_ORDERS) {
        for (const period of ALL_PERIODS) {
          // Agar already cached hai toh skip
          const cacheKey = makeListCacheKey(country, order, period);
          const existing = await AdListCache.findOne({ cache_key: cacheKey });
          if (existing) { console.log(`⏭️  Skip (already cached): ${cacheKey}`); continue; }

          const ok = await fetchAndSaveOneCombination(country, order, period);
          if (ok) saved++;
          await sleep(2000);
        }
      }
    }
    console.log(`✅ Initial load complete: ${saved}/${total} combinations`);
  }, 30 * 1000);

  // Raat 12 baje pehli baar reset
  setTimeout(async () => {
    await runMidnightReset();

    // Phir har 24 ghante mein (exactly raat 12 baje)
    setInterval(async () => {
      await runMidnightReset();
    }, 24 * 60 * 60 * 1000);

  }, msLeft);
}

module.exports = {
  getOrFetchAdsList,
  invalidateListCache,
  getOrFetchAdDetail,
  getOrFetchVideoUrl,
  invalidateAdCache,
  saveAdToCache,
  getCacheStats,
  startMidnightReset, // server.js mein call karo
};
