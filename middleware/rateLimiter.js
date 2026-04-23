const rateLimit = require('express-rate-limit');

// ================================
// GLOBAL RATE LIMIT
// Har IP ke liye
// ================================
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  message: {
    success: false,
    message: 'Bahut zyada requests. 15 minute baad try karo.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ================================
// AUTH ROUTES LIMIT
// Brute force attacks se bachao
// ================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Sirf 10 login attempts
  message: {
    success: false,
    message: 'Bahut zyada login attempts. 15 minute baad try karo.'
  },
  skipSuccessfulRequests: true, // Successful login count na karo
});

// ================================
// API SEARCH LIMIT
// Per user per plan
// ================================
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 searches per minute max
  keyGenerator: (req) => {
    // User ID se limit karo, IP se nahi
    return req.user ? req.user.id : req.ip;
  },
  message: {
    success: false,
    message: 'Bahut fast search kar rahe ho. Thoda slow karo.'
  }
});

// ================================
// REGISTRATION LIMIT
// Spam accounts se bachao
// ================================
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Ek IP se 5 accounts max per hour
  message: {
    success: false,
    message: 'Bahut zyada accounts banaye. 1 ghante baad try karo.'
  }
});

module.exports = {
  globalLimiter,
  authLimiter,
  searchLimiter,
  registerLimiter
};
