// models/AdListCache.js
//
// Puri ads LIST ko store karta hai per query combination
// Example: country=US + order=like + period=7 ka poora result ek document mein
//
// Isse /api/ads/tiktok ka response bhi cache hoga — 
// pehla user → API call → sab save
// baaki users → MongoDB se direct list

const mongoose = require('mongoose');

const adListCacheSchema = new mongoose.Schema({

  // Unique key: "US_like_7" type combination
  cache_key: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Query params jo is list ke liye use hue
  params: {
    country: { type: String, default: 'US' },
    order:   { type: String, default: 'like' },
    period:  { type: String, default: '7' },
  },

  // Kitne ads hain
  total: { type: Number, default: 0 },

  // Pura raw API response — sab kuch andar hai
  // (materials array, pagination, etc.)
  raw_response: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },

  // Fetch tracking
  fetched_by_user: { type: String, default: null },

  // TTL — 24 ghante baad auto-delete
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400,
  },
});

adListCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('AdListCache', adListCacheSchema);
