// models/AdListCache.js
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

  // TTL — 24hr auto-delete (expires property hi index banata hai)
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400,
  },

}, { timestamps: false });

// Note: cache_key unique:true se index ban jata hai
// createdAt expires:86400 se TTL index ban jata hai
// Alag se koi index define nahi kiya — isliye duplicate warning nahi aayegi

module.exports = mongoose.model('AdListCache', adListCacheSchema);
