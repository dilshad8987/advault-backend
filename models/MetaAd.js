// models/MetaAd.js
// Facebook Ads Library se scraped ads ka permanent store
const mongoose = require('mongoose');

const metaAdSchema = new mongoose.Schema({

  // Facebook se mila unique ID
  library_id: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Brand / Page
  brand:     { type: String, default: '', index: true },
  page_url:  { type: String, default: '' },

  // Ad content
  body:             { type: String, default: '' },
  link_title:       { type: String, default: '' },
  link_url:         { type: String, default: '' },
  link_description: { type: String, default: '' },
  cta_text:         { type: String, default: '' },
  cta_url:          { type: String, default: '' },
  format:           { type: String, default: '' }, // image / video / carousel

  // Media
  images:       [{ url: String }],
  videos:       [{ url: String, thumbnail: String }],
  image:        { type: String, default: '' },
  video:        { type: String, default: '' },
  snapshot_url: { type: String, default: '' },

  // Platforms
  platforms:      [{ type: String }], // ["Facebook", "Instagram", ...]
  total_platforms: { type: Number, default: 0 },

  // Status & dates
  active:     { type: Boolean, default: true, index: true },
  start_date: { type: Date,    default: null },
  end_date:   { type: Date,    default: null },
  run_days:   { type: Number,  default: 0 },   // calculated field

  // Engagement (jo available ho)
  likes:    { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  shares:   { type: Number, default: 0 },

  // Search context
  search_keyword: { type: String, default: '', index: true },
  country:        { type: String, default: 'US', index: true },

  // Scrape info
  scraped_at:  { type: Date, default: Date.now, index: true },
  scrape_run:  { type: String, default: '' }, // daily run ID

  // Raw response
  raw_data: { type: mongoose.Schema.Types.Mixed, default: {} },

}, { timestamps: true });

// Compound index for fast queries
metaAdSchema.index({ country: 1, active: 1, scraped_at: -1 });
metaAdSchema.index({ search_keyword: 1, active: 1 });

module.exports = mongoose.model('MetaAd', metaAdSchema);
