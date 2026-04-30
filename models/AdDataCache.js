// models/AdDataCache.js
// 
// Pura ad ka data store karta hai MongoDB mein — video URL, comments,
// likes, cover, title, industry — sab kuch.
//
// Pehla user API call karta hai → sab MongoDB mein save
// Baaki sab users → MongoDB se direct data (no API call)
// 24 ghante baad → MongoDB TTL auto-delete → fresh API call hogi

const mongoose = require('mongoose');

const adDataCacheSchema = new mongoose.Schema({

  // ─── Unique identifier ───────────────────────────────────────────────────
  // material_id ya ad_id — har ad ka unique key
  ad_id: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // ─── Cache key — query se match karne ke liye ────────────────────────────
  // Example: "tiktok_search:country=US&order=like&period=7"
  cache_key: {
    type: String,
    index: true,
  },

  // ─── Video Data ──────────────────────────────────────────────────────────
  video: {
    play_url:    { type: String, default: null }, // Main video URL
    cover_url:   { type: String, default: null }, // Thumbnail
    duration:    { type: Number, default: null }, // seconds
    width:       { type: Number, default: null },
    height:      { type: Number, default: null },
    vid:         { type: String, default: null }, // internal video ID
  },

  // ─── Ad Metadata ─────────────────────────────────────────────────────────
  meta: {
    title:        { type: String, default: '' },
    industry:     { type: String, default: '' },
    objective:    { type: String, default: '' },
    country_code: { type: String, default: '' },
    ad_language:  { type: String, default: '' },
    is_active:    { type: Boolean, default: false },
    run_days:     { type: Number, default: 0 },
    tiktok_item_url: { type: String, default: null },
    share_url:    { type: String, default: null },
  },

  // ─── Engagement / Stats ───────────────────────────────────────────────────
  stats: {
    likes:       { type: Number, default: 0 },
    comments:    { type: Number, default: 0 },
    shares:      { type: Number, default: 0 },
    views:       { type: Number, default: 0 },
    ctr:         { type: Number, default: 0 },
    impression:  { type: Number, default: 0 },
    cost:        { type: Number, default: 0 },
    like_rate:   { type: Number, default: 0 },
  },

  // ─── Advertiser Info ─────────────────────────────────────────────────────
  advertiser: {
    id:     { type: String, default: null },
    name:   { type: String, default: '' },
    avatar: { type: String, default: null },
  },

  // ─── Raw full data (fallback — frontend ko koi bhi field mile) ───────────
  // Yeh pura original API response store karta hai
  raw_data: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },

  // ─── Fetch tracking ──────────────────────────────────────────────────────
  fetched_by_user: { type: String, default: null }, // pehla user jisne fetch kiya

  // ─── TTL Index ───────────────────────────────────────────────────────────
  // MongoDB 24 ghante baad automatically delete karega
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400, // 24 hours = 86400 seconds
  },
});

// TTL index — MongoDB background process auto-cleanup karti hai
adDataCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

// Cache key pe bhi index — ads list queries ke liye
adDataCacheSchema.index({ cache_key: 1 });

module.exports = mongoose.model('AdDataCache', adDataCacheSchema);
