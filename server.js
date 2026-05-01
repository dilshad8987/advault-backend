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
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5000',
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // No origin = Postman / mobile / server-to-server — allow karo
    if (!origin) return callback(null, true);
    // Exact match ya koi bhi .vercel.app subdomain
    const allowed =
      allowedOrigins.includes(origin) ||
      origin.endsWith('.vercel.app');
    if (allowed) return callback(null, true);
    return callback(new Error('CORS: origin allowed nahi hai — ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(helmet());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ─── MongoDB + Midnight Reset ─────────────────────────────────────────────────
async function connectMongoDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('⚠️  MONGODB_URI set nahi hai — caching disabled');
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
    console.error('❌ MongoDB connection fail:', err.message);
    console.warn('   Caching disabled — direct API calls hongi');
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

app.use('*', (req, res) => res.status(404).json({ success: false, message: 'Route nahi mili' }));

app.use((err, req, res, next) => {
  console.error('Server Error:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Server error' : err.message,
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('\n✅ AdVault Backend chal raha hai port ' + PORT + ' pe');
  console.log('🔗 Health check: http://localhost:' + PORT + '/health\n');
});
