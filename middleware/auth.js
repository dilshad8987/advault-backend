const { verifyAccessToken } = require('../utils/jwt');
const { findUserById, isDeviceAllowed } = require('../store/db');
const { extractFingerprint } = require('./botDetection');

async function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Login karo pehle' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Token expire ho gaya. Dobara login karo.' });
    }

    const user = await findUserById(decoded.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User nahi mila' });
    }

    const fingerprint = extractFingerprint(req);
    const deviceAllowed = await isDeviceAllowed(user._id.toString(), fingerprint);

    if (!deviceAllowed) {
      return res.status(403).json({
        success: false,
        message: 'Yeh device registered nahi hai.',
        code: 'DEVICE_NOT_ALLOWED'
      });
    }

    req.user = user;
    req.fingerprint = fingerprint;
    next();

  } catch (err) {
    return res.status(401).json({ success: false, message: 'Authentication fail' });
  }
}

function requirePro(req, res, next) {
  if (req.user.plan === 'free') {
    return res.status(403).json({ success: false, message: 'Pro plan chahiye', upgrade: true });
  }
  next();
}

function requireAgency(req, res, next) {
  if (req.user.plan !== 'agency') {
    return res.status(403).json({ success: false, message: 'Agency plan chahiye', upgrade: true });
  }
  next();
}

module.exports = { protect, requirePro, requireAgency };
