// models/AdDataCache.js
const mongoose = require('mongoose');

const adDataCacheSchema = new mongoose.Schema({

  ad_id: {
    type: String,
    required: true,
    unique: true,
  },

  cache_key: {
    type: String,
  },

  video: {
    play_url:  { type: String, default: null },
    cover_url: { type: String, default: null },
    duration:  { type: Number, default: null },
    width:     { type: Number, default: null },
    height:    { type: Number, default: null },
    vid:       { type: String, default: null },
  },

  meta: {
    title:           { type: String, default: '' },
    industry:        { type: String, default: '' },
    objective:       { type: String, default: '' },
    country_code:    { type: String, default: '' },
    ad_language:     { type: String, default: '' },
    is_active:       { type: Boolean, default: false },
    run_days:        { type: Number, default: 0 },
    tiktok_item_url: { type: String, default: null },
    share_url:       { type: String, default: null },
  },

  stats: {
    likes:      { type: Number, default: 0 },
    comments:   { type: Number, default: 0 },
    shares:     { type: Number, default: 0 },
    views:      { type: Number, default: 0 },
    ctr:        { type: Number, default: 0 },
    impression: { type: Number, default: 0 },
    cost:       { type: Number, default: 0 },
    like_rate:  { type: Number, default: 0 },
  },

  advertiser: {
    id:     { type: String, default: null },
    name:   { type: String, default: '' },
    avatar: { type: String, default: null },
  },

  raw_data: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },

  fetched_by_user: { type: String, default: null },

  // TTL — 24hr auto-delete (expires property hi index banata hai)
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400,
  },

}, { timestamps: false });

// Sirf cache_key pe extra index — createdAt ka TTL index mongoose khud banata hai
adDataCacheSchema.index({ cache_key: 1 });

module.exports = mongoose.model('AdDataCache', adDataCacheSchema);
