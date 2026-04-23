const NodeCache = require('node-cache');

// ================================
// CACHE SETUP
// TTL = 1 hour by default
// ================================
const cache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL_SECONDS) || 3600,
  maxKeys: parseInt(process.env.CACHE_MAX_KEYS) || 1000,
  checkperiod: 120, // Har 2 min expired keys clean karo
  useClones: false
});

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
