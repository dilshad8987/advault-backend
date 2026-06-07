const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  email:     { type: String, required: true, index: true },
  otpHash:   { type: String, required: true },
  expiresAt: { type: Date,   required: true, index: { expireAfterSeconds: 0 } }, // auto-delete
  attempts:  { type: Number, default: 0 },
  verified:  { type: Boolean, default: false },
  _regData:  { type: String },  // temporary registration data
});

module.exports = mongoose.model('Otp', otpSchema);
