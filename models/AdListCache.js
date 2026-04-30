// models/AdListCache.js
// TTL index hata diya — ab raat 12 baje manually delete + fresh load hoga
const mongoose = require('mongoose');

const adListCacheSchema = new mongoose.Schema({

  cache_key: {
    type: String,
    required: true,
    unique: true,
  },

  params: {
    country: { type: String, default: 'US' },
    order:   { type: String, default: 'like' },
    period:  { type: String, default: '7' },
  },

  total: { type: Number, default: 0 },

  raw_response: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },

  fetched_by_user: { type: String, default: null },

  createdAt: {
    type: Date,
    default: Date.now,
  },

}, { timestamps: false });

module.exports = mongoose.model('AdListCache', adListCacheSchema);
