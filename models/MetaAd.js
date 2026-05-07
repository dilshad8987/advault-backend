const mongoose = require('mongoose');

const metaAdSchema = new mongoose.Schema({
  library_id:       { type: String, required: true, unique: true, index: true },
  brand:            { type: String, default: '', index: true },
  page_url:         { type: String, default: '' },
  body:             { type: String, default: '' },
  link_title:       { type: String, default: '' },
  link_url:         { type: String, default: '' },
  link_description: { type: String, default: '' },
  cta_text:         { type: String, default: '' },
  cta_url:          { type: String, default: '' },
  format:           { type: String, default: '' }, // image / video / carousel

  images:       [{ url: String }],
  videos:       [{ url: String, thumbnail: String }],
  image:        { type: String, default: '' },        // Original Facebook CDN URL
  r2_image_url: { type: String, default: '' },        // Cloudflare R2 permanent image URL
  video:        { type: String, default: '' },        // Original video URL
  r2_video_url: { type: String, default: '' },        // Cloudflare R2 permanent video URL ← NEW
  snapshot_url: { type: String, default: '' },

  platforms:       [{ type: String }],
  total_platforms: { type: Number, default: 0 },

  active:     { type: Boolean, default: true, index: true },
  start_date: { type: Date,    default: null },
  end_date:   { type: Date,    default: null },
  run_days:   { type: Number,  default: 0 },

  likes:    { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  shares:   { type: Number, default: 0 },

  keyword:        { type: String, default: '', index: true },
  search_keyword: { type: String, default: '', index: true },
  country:        { type: String, default: 'US', index: true },

  priority:    { type: Number,  default: 0 },
  featured:    { type: Boolean, default: false },
  hidden:      { type: Boolean, default: false },
  view_count:  { type: Number,  default: 0, index: true },
  last_viewed: { type: Date,    default: null },

  scraped_at: { type: Date, default: Date.now, index: true },
  scrape_run: { type: String, default: '' },
  raw_data:   { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

metaAdSchema.index({ country: 1, active: 1, scraped_at: -1 });
metaAdSchema.index({ search_keyword: 1, active: 1 });

module.exports = mongoose.model('MetaAd', metaAdSchema);
