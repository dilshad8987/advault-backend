// server.js
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const mongoose = require('mongoose');

const app = express();
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://advault.in',                   // Apex domain
  process.env.FRONTEND_URL,               // www.advault.in (Railway env)
  'https://advault-frontend.vercel.app',  // Vercel fallback
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow server-to-server requests (no origin)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn('[CORS] Blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id'],
  credentials: true,
}));

app.use(helmet());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// MongoDB injection sanitization — har route pe automatically apply hoga
const { sanitizeBody } = require('./middleware/auth');
app.use(sanitizeBody);
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── MongoDB + Midnight Reset ─────────────────────────────────────────────────
async function connectMongoDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('⚠️  MONGODB_URI not set — caching disabled');
    return;
  }
  try {
    await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB_NAME || 'advault',
      serverSelectionTimeoutMS: 5000,
    });
    console.log('✅ MongoDB connected');

    const { startMidnightReset } = require('./services/mongoAdCache');
    startMidnightReset();

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    console.warn('   Caching disabled — direct API calls will be made');
  }
}
connectMongoDB();

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/ads',  require('./routes/ads'));
app.use('/api/user', require('./routes/user'));

app.get('/health', (req, res) => {
  res.json({
    status:  'OK',
    server:  'AdVault Backend',
    time:    new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

app.use('*', (req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

app.use((err, req, res, next) => {
  console.error('Server Error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Server error' : err.message,
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('\n✅ AdVault Backend running on port ' + PORT + ' pe');
  console.log('🔗 Health: http://localhost:' + PORT + '/health\n');

  // Cleanup scheduler — roz raat 12 baje
  const { startCleanupScheduler } = require('./services/cleanupService');
  startCleanupScheduler();
});
      
