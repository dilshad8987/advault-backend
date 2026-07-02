// models/User.js
const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true },
  lastSeen:    { type: Date, default: Date.now },
}, { _id: false });

const refreshTokenSchema = new mongoose.Schema({
  token:     { type: String, required: true },
  expiresAt: { type: Date,   required: true },
}, { _id: false });

const savedAdSchema = new mongoose.Schema({
  id:       { type: String, required: true },
  folder:   { type: String, default: 'Default' },
  savedAt:  { type: Date,   default: Date.now },
  title:    { type: String, default: '' },
  brand:    { type: String, default: '' },
  cover:    { type: String, default: '' },
  platform: { type: String, default: 'tiktok' },
}, { _id: false, strict: false }); // strict:false — adData se aane wale extra fields bhi store ho jayein

const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  name:        { type: String, required: true, trim: true },
  email:       { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  plan:        { type: String, enum: ['free', 'pro', 'elite'], default: 'free' },

  // Credit system — monthly reset
  credits:          { type: Number, default: 200 },   // remaining credits
  creditsUsed:      { type: Number, default: 0 },      // used this month
  creditsResetDate: { type: String, default: '' },     // "Month YYYY" format

  // Legacy — backward compat (unused, do not remove yet)
  searchCount:     { type: Number, default: 0 },
  searchResetDate: { type: String, default: '' },

  // Saved ads
  savedAds: { type: [savedAdSchema], default: [] },

  // Viewed ads — credit sirf pehli baar deduct hoti hai
  viewedAdIds: [{ type: String }],

  // Registration IP — ek IP se sirf ek account
  registrationIp: { type: String, default: '' },

  // Registration fingerprint — permanent record (combined + parts)
  registrationFingerprint: { type: String, default: '', index: true }, // combined hash
  registrationServerHash:  { type: String, default: '', index: true }, // server-only hash (VPN bypass detect)
  registrationClientHash:  { type: String, default: '', index: true }, // client hardware hash
  registrationClientId:    { type: String, default: '', index: true }, // x-device-id UUID
  registrationEmail:       { type: String, default: '', index: true }, // normalized email

  // Device sessions
  devices: { type: [deviceSchema], default: [] },

  // Refresh tokens — User ke andar hi, alag collection nahi
  refreshTokens: { type: [refreshTokenSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

userSchema.pre('save', async function () {
  this.updatedAt = new Date();
});

// Virtual: id = firebaseUid (backward compatible)
userSchema.virtual('id').get(function () {
  return this.firebaseUid;
});

userSchema.set('toJSON',   { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
