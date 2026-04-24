const rateLimit = require('express-rate-limit');

// Railway reverse proxy ke peeche hai — trust proxy zaroori hai
// Yeh server.js mein set hoga, rateLimiter mein validateIp band karo
const proxyOptions = {
  validate: { xForwardedForHeader: false }  // X-Forwarded-For warning band karo
};

// ================================
// GLOBAL RATE LIMIT
// ================================
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { success: false, message: 'Bahut zyada requests. 15 minute baad try karo.' },
  standardHeaders: true,
  legacyHeaders: false,
  ...proxyOptions
});

// ================================
// AUTH ROUTES LIMIT
// ================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Bahut zyada login attempts. 15 minute baad try karo.' },
  skipSuccessfulRequests: true,
  ...proxyOptions
});

// ================================
// SEARCH LIMIT
// ================================
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user ? req.user.id : req.ip,
  message: { success: false, message: 'Bahut fast search kar rahe ho. Thoda slow karo.' },
  ...proxyOptions
});

// ================================
// REGISTRATION LIMIT
// ================================
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Bahut zyada accounts banaye. 1 ghante baad try karo.' },
  ...proxyOptions
});

module.exports = { globalLimiter, authLimiter, searchLimiter, registerLimiter };
