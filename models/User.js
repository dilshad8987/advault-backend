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
  savedAds: [{ type: String }],

  // Viewed ads — credit sirf pehli baar deduct hoti hai
  viewedAdIds: [{ type: String }],

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
