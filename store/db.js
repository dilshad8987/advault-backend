const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ================================
// MONGODB CONNECT
// ================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected!'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ================================
// USER SCHEMA
// ================================
const userSchema = new mongoose.Schema({
  name:            { type: String, required: true },
  email:           { type: String, required: true, unique: true, lowercase: true },
  password:        { type: String, required: true },
  plan:            { type: String, default: 'free' },
  searchCount:     { type: Number, default: 0 },
  searchResetDate: { type: String, default: '' },
  savedAds:        { type: Array,  default: [] },
  devices:         { type: Array,  default: [] },
  refreshTokens:   { type: Array,  default: [] },
  createdAt:       { type: Date,   default: Date.now }
});

const User = mongoose.model('User', userSchema);

// ================================
// HELPER
// ================================
function sanitizeUser(user) {
  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.password;
  delete obj.refreshTokens;
  return obj;
}

// ================================
// USER FUNCTIONS
// ================================
async function createUser({ name, email, password }) {
  const existing = await User.findOne({ email });
  if (existing) throw new Error('Email pehle se registered hai');

  const hashedPassword = await bcrypt.hash(password, 12);
  const user = await User.create({
    name,
    email,
    password: hashedPassword,
    id: 'user_' + Date.now()
  });
  return sanitizeUser(user);
}

async function findUserByEmail(email) {
  return User.findOne({ email });
}

async function findUserById(id) {
  return User.findById(id) || User.findOne({ id });
}

async function verifyPassword(plain, hashed) {
  return bcrypt.compare(plain, hashed);
}

async function updateUser(email, updates) {
  const user = await User.findOneAndUpdate(
    { email },
    { $set: updates },
    { new: true }
  );
  return user ? sanitizeUser(user) : null;
}

// ================================
// DEVICE FUNCTIONS
// ================================
async function registerDevice(userId, fingerprint) {
  const user = await User.findById(userId) || await User.findOne({ id: userId });
  if (!user) return false;

  const maxDevices = parseInt(process.env.MAX_DEVICES_PER_USER) || 1;

  if (user.devices.includes(fingerprint)) return true;
  if (user.devices.length >= maxDevices) return false;

  user.devices.push(fingerprint);
  await user.save();
  return true;
}

async function isDeviceAllowed(userId, fingerprint) {
  const user = await User.findById(userId) || await User.findOne({ id: userId });
  if (!user) return false;
  return user.devices.includes(fingerprint);
}

async function removeDevice(userId, fingerprint) {
  await User.findOneAndUpdate(
    { $or: [{ _id: userId }, { id: userId }] },
    { $pull: { devices: fingerprint } }
  );
}

async function getUserDevices(userId) {
  const user = await User.findById(userId) || await User.findOne({ id: userId });
  return user?.devices || [];
}

// ================================
// REFRESH TOKEN FUNCTIONS
// ================================
async function saveRefreshToken(userId, token) {
  await User.findOneAndUpdate(
    { $or: [{ _id: userId }, { id: userId }] },
    { $push: { refreshTokens: token } }
  );
}

async function getRefreshToken(token) {
  const user = await User.findOne({ refreshTokens: token });
  if (!user) return null;
  return { userId: user._id.toString(), token };
}

async function deleteRefreshToken(token) {
  await User.findOneAndUpdate(
    { refreshTokens: token },
    { $pull: { refreshTokens: token } }
  );
}

// ================================
// SEARCH LIMIT
// ================================
async function checkSearchLimit(user) {
  const limits = { free: 50, pro: 9999, agency: 99999 };
  const today = new Date().toDateString();

  if (user.searchResetDate !== today) {
    await updateUser(user.email, { searchCount: 0, searchResetDate: today });
    user.searchCount = 0;
  }

  const limit = limits[user.plan] || 50;
  return {
    allowed: user.searchCount < limit,
    remaining: Math.max(0, limit - user.searchCount),
    limit
  };
}

async function incrementSearchCount(email) {
  await User.findOneAndUpdate(
    { email },
    { $inc: { searchCount: 1 } }
  );
}

module.exports = {
  createUser,
  findUserByEmail,
  findUserById,
  verifyPassword,
  sanitizeUser,
  updateUser,
  registerDevice,
  isDeviceAllowed,
  removeDevice,
  getUserDevices,
  saveRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  checkSearchLimit,
  incrementSearchCount
};
