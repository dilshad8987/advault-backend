const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  fingerprint: { type: String, required: true },
  lastSeen:    { type: Date, default: Date.now },
}, { _id: false });

const userSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  name:        { type: String, required: true, trim: true },
  email:       { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  plan:        { type: String, enum: ['free', 'pro', 'agency'], default: 'free' },

  // Search tracking — har roz reset hoti hai
  searchCount:     { type: Number, default: 0 },
  searchResetDate: { type: String, default: '' }, // "Mon Jun 04 2026"

  // Saved ads
  savedAds: [{ type: String }],

  // Device sessions — User ke andar hi rakhe (alag collection ki zarurat nahi)
  devices: { type: [deviceSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Save se pehle updatedAt update karo
userSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Virtual: id = firebaseUid (backward compatible — baaki code mein user.id kaam karega)
userSchema.virtual('id').get(function () {
  return this.firebaseUid;
});

userSchema.set('toJSON',   { virtuals: true });
userSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
