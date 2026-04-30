// models/AdDataCache.js
// TTL index hata diya — ab raat 12 baje manually delete + fresh load hoga
const mongoose = require('mongoose');

const adDataCacheSchema = new mongoose.Schema({

  ad_id: {
    type: String,
    required: true,
    unique: true,
  },

  cache_key: {
    type: String,
    index: true,
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

  createdAt: {
    type: Date,
    default: Date.now,
  },

}, { timestamps: false });

module.exports = mongoose.model('AdDataCache', adDataCacheSchema);
