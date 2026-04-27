const NodeCache = require('node-cache');

// ================================
// CACHE SETUP
// TTL = 1 hour by default
// ================================
const TWENTY_FOUR_HOURS = 86400;

const cache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL_SECONDS) || TWENTY_FOUR_HOURS,
  maxKeys: parseInt(process.env.CACHE_MAX_KEYS) || 1000,
  checkperiod: 300,
  useClones: false
});

// Har raat 12 baje cache reset — fresh ads aayengi
function scheduleMidnightReset() {
  const now  = new Date();
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  const ms = next - now;
  setTimeout(() => {
    console.log('🔄 Midnight cache reset — fresh ads fetch hogi ab');
    cache.flushAll();
    scheduleMidnightReset();
  }, ms);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  console.log(`⏰ Next cache reset in ${h}h ${m}m (midnight)`);
}
scheduleMidnightReset();

// ================================
// CACHE STATS
// ================================
cache.on('set', (key) => {
  // console.log(`Cache SET: ${key}`);
});

cache.on('expired', (key) => {
  // console.log(`Cache EXPIRED: ${key}`);
});

// ================================
// HELPER FUNCTIONS
// ================================

// Cache key banao query se
function makeCacheKey(prefix, params) {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return `${prefix}:${sorted}`;
}

// Cache se get karo ya API call karo
async function getOrFetch(key, fetchFn, ttl = null) {
  // Cache mein hai?
  const cached = cache.get(key);
  if (cached !== undefined) {
    console.log(`✅ Cache HIT: ${key}`);
    return { data: cached, fromCache: true };
  }

  // Nahi hai toh fetch karo
  console.log(`🌐 Cache MISS: ${key} - API call ho rahi hai`);
  const data = await fetchFn();

  // Cache mein save karo
  if (ttl) {
    cache.set(key, data, ttl);
  } else {
    cache.set(key, data);
  }

  return { data, fromCache: false };
}

// Manual cache set
function setCache(key, value, ttl = null) {
  if (ttl) {
    cache.set(key, value, ttl);
  } else {
    cache.set(key, value);
  }
}

// Manual cache get
function getCache(key) {
  return cache.get(key);
}

// Cache delete
function deleteCache(key) {
  cache.del(key);
}

// Cache stats
function getCacheStats() {
  return {
    keys: cache.keys().length,
    stats: cache.getStats()
  };
}

// Cache flush (admin ke liye)
function flushCache() {
  cache.flushAll();
}

module.exports = {
  makeCacheKey,
  getOrFetch,
  setCache,
  getCache,
  deleteCache,
  getCacheStats,
  flushCache
};
