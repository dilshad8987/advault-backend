const { verifyAccessToken } = require('../utils/jwt');
const { findUserById, isDeviceAllowed, registerDevice } = require('../store/db');
const { extractFingerprint } = require('./botDetection');

// ─── In-Memory Cache ───────────────────────────────────────────────────────────
const userCache   = new Map();
const deviceCache = new Map();
const USER_TTL    = 5  * 60 * 1000;
const DEVICE_TTL  = 10 * 60 * 1000;

function getCached(cache, key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { cache.delete(key); return null; }
  return entry.value;
}
function setCache(cache, key, value) {
  cache.set(key, { value, ts: Date.now() });
}
function invalidateUserCache(userId) {
  userCache.delete(userId);
  for (const key of deviceCache.keys()) {
    if (key.startsWith(`${userId}:`)) deviceCache.delete(key);
  }
}
async function getCachedUser(userId) {
  const cached = getCached(userCache, userId, USER_TTL);
  if (cached) return cached;
  const user = await findUserById(userId);
  if (user) setCache(userCache, userId, user);
  return user;
}

// ─── 1. Strong Password Validator ─────────────────────────────────────────────
// Rules: min 8 chars, uppercase, lowercase, number, special char
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{8,}$/;

function validateStrongPassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Password daalna zaroori hai.' };
  }
  if (password.length < 8) {
    return { valid: false, message: 'Password kam se kam 8 characters ka hona chahiye.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password mein kam se kam 1 uppercase letter hona chahiye (A-Z).' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password mein kam se kam 1 lowercase letter hona chahiye (a-z).' };
  }
  if (!/\d/.test(password)) {
    return { valid: false, message: 'Password mein kam se kam 1 number hona chahiye (0-9).' };
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    return { valid: false, message: 'Password mein kam se kam 1 special character hona chahiye (!@#$%^&* etc).' };
  }
  return { valid: true };
}

// ─── 2. Temporary / Disposable Email Blocker ──────────────────────────────────
// Common temp email domains ki list — aur bhi add karte raho
const TEMP_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwam.com',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'guerrillamail.info', 'guerrillamail.biz', 'guerrillamail.de', 'guerrillamail.net',
  'guerrillamail.org', 'spam4.me', 'trashmail.com', 'trashmail.me', 'trashmail.net',
  'trashmail.at', 'trashmail.io', 'trashmail.org', 'trashmail.xyz',
  'dispostable.com', 'mailnull.com', 'maildrop.cc', 'spamgourmet.com',
  'spamgourmet.net', 'spamgourmet.org', 'fakeinbox.com', 'mailnesia.com',
  'mailnull.com', 'spamcorpse.com', 'discard.email', 'spamspot.com',
  'spamthis.co.uk', 'throwam.com', 'tempr.email', 'discard.email',
  'discardmail.com', 'discardmail.de', 'spamgob.com', 'temp-mail.org',
  'temp-mail.io', 'tempinbox.com', 'tempinbox.co.uk', '10minutemail.com',
  '10minutemail.net', 'emailondeck.com', 'getairmail.com', 'getairmail.cf',
  'getairmail.ga', 'getairmail.gq', 'getairmail.ml', 'getairmail.tk',
  'mohmal.com', 'mt2015.com', 'mt2016.com', 'mt2017.com', 'mytempemail.com',
  'nowmymail.com', 'put2.net', 'spam.la', 'spam4.me', 'spamfree24.org',
  'spamfree24.de', 'spamfree24.eu', 'spamfree24.info', 'spamfree24.net',
  'spamhere.com', 'spamhole.com', 'spaml.de', 'spaml.com', 'spamoff.de',
  'spamtrap.ro', 'tempail.com', 'tempalias.com', 'tempinbox.com',
  'tempinbox.co.uk', 'tempsky.com', 'tempomail.fr', 'temporaryinbox.com',
  'tempthe.net', 'thanksnospam.info', 'throwam.com', 'trash-mail.com',
  'trashdevil.com', 'trashdevil.de', 'trashmail.me', 'trashmail.net',
  'trashmail.org', 'trashmail.xyz', 'uggsrock.com', 'venompen.com',
  'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'wh4f.org',
  'whyspam.me', 'willhackforfood.biz', 'willselfdestruct.com', 'winemaven.info',
  'wronghead.com', 'wuzupmail.net', 'xsecurity.org', 'xtend.biz', 'yep.it',
  'yogamaven.com', 'yopmail.fr', 'yopmail.pp.ua', 'yourspamgoesto.space',
  'yuurok.com', 'za.com', 'zerotohero.com', 'ziggo.nl', 'zoemail.com',
  'zoemail.net', 'zoemail.org', 'zomg.info', 'luxusmail.org', 'junkmail.gq',
]);

function isTempEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return true;
  return TEMP_EMAIL_DOMAINS.has(domain);
}

// ─── 3. VPN / Proxy / Tor Detection ───────────────────────────────────────────
// Ye headers proxy/VPN se aate hain. Genuine users ke paas ye nahi hote.
const VPN_HEADERS = [
  'x-forwarded-for',      // proxy/VPN ka indicator
  'via',                  // HTTP proxy
  'x-proxy-id',
  'x-real-ip',            // Nginx ke peeche agar apna server nahi hai
  'x-cluster-client-ip',
  'forwarded-for',
  'forwarded',
  'cf-connecting-ip',     // Cloudflare (allowed agar khud Cloudflare use kar rahe ho)
];

// Known VPN/Datacenter ASN ranges — ye optional hai, agar IP check karna ho
// Abhi header-based detection hi kaafi hai basic level ke liye
function detectVPN(req) {
  // Method 1: Proxy headers check
  const via      = req.headers['via'];
  const proxyId  = req.headers['x-proxy-id'];

  if (via)     return { detected: true, reason: 'HTTP Proxy header mila (Via)' };
  if (proxyId) return { detected: true, reason: 'Proxy ID header mila' };

  // Method 2: X-Forwarded-For mein multiple IPs = proxy chain
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',').map(ip => ip.trim());
    // Agar 2 se zyada IPs hain chain mein — VPN/proxy ka strong indicator
    if (ips.length > 2) {
      return { detected: true, reason: 'Multiple IP chain mili (VPN/proxy chain)' };
    }
  }

  // Method 3: User-Agent mein VPN client names
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const vpnAgents = ['nordvpn', 'expressvpn', 'surfshark', 'protonvpn', 'cyberghost', 'ipvanish', 'purevpn'];
  if (vpnAgents.some(v => ua.includes(v))) {
    return { detected: true, reason: 'VPN client user-agent detect hua' };
  }

  return { detected: false };
}

// ─── 4. Email Validation (proper format) ──────────────────────────────────────
function isValidEmail(email) {
  const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

// ─── Registration Validator Middleware ─────────────────────────────────────────
// Ye middleware /auth/register route pe lagao
async function validateRegistration(req, res, next) {
  const { email, password, name } = req.body;

  // Name check
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ success: false, message: 'Valid naam daalna zaroori hai.' });
  }

  // Email format check
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'Valid email daalna zaroori hai.' });
  }

  // Temp email check
  if (isTempEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Temporary ya disposable email allowed nahi hai. Real email use karo.'
    });
  }

  // Strong password check
  const pwCheck = validateStrongPassword(password);
  if (!pwCheck.valid) {
    return res.status(400).json({ success: false, message: pwCheck.message });
  }

  // VPN/Proxy check during registration
  const vpnCheck = detectVPN(req);
  if (vpnCheck.detected) {
    return res.status(403).json({
      success: false,
      message: 'VPN ya Proxy se registration allowed nahi hai. Direct connection use karo.'
    });
  }

  next();
}

// ─── Main Auth Middleware ──────────────────────────────────────────────────────
async function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Login karo pehle' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (!decoded?.id) {
      return res.status(401).json({ success: false, message: 'Token expire ho gaya. Dobara login karo.' });
    }

    const fingerprint = extractFingerprint(req);
    const user = await getCachedUser(decoded.id);

    if (!user) {
      return res.status(401).json({ success: false, message: 'User nahi mila' });
    }

    // ─── Device Check — 1 Device Per Account ─────────────────────────────────
    const cacheKey = `${user.id}:${fingerprint}`;
    const cachedDevice = getCached(deviceCache, cacheKey, DEVICE_TTL);

    if (!cachedDevice) {
      const allowed = isDeviceAllowed(user.id, fingerprint);
      if (!allowed) {
        // Pehle check karo: kya user ka koi device already registered hai?
        // Agar hai toh naya device block karo (1 device policy)
        const maxDevices = parseInt(process.env.MAX_DEVICES_PER_USER || '1', 10);
        const { getUserDeviceCount } = require('../store/db');
        const deviceCount = getUserDeviceCount ? getUserDeviceCount(user.id) : 0;

        if (deviceCount >= maxDevices) {
          return res.status(403).json({
            success: false,
            message: 'Ek account pe sirf ek device allowed hai. Pehle wale device se logout karo.',
            code: 'DEVICE_LIMIT_EXCEEDED'
          });
        }

        // Pehla device hai ya server restart — register karo
        registerDevice(user.id, fingerprint);
      }
      setCache(deviceCache, cacheKey, true);
    }

    req.user = user;
    req.fingerprint = fingerprint;
    next();

  } catch (err) {
    console.error('[Auth] protect error:', err.message);
    return res.status(401).json({ success: false, message: 'Authentication fail' });
  }
}

// ─── Login Validator Middleware ────────────────────────────────────────────────
// Ye middleware /auth/login route pe lagao (VPN block optional login pe)
async function validateLogin(req, res, next) {
  const { email, password } = req.body;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'Valid email daalo.' });
  }

  if (!password) {
    return res.status(400).json({ success: false, message: 'Password daalna zaroori hai.' });
  }

  // Optional: Login pe bhi VPN block karo
  if (process.env.BLOCK_VPN_ON_LOGIN === 'true') {
    const vpnCheck = detectVPN(req);
    if (vpnCheck.detected) {
      return res.status(403).json({
        success: false,
        message: 'VPN ya Proxy se login allowed nahi hai.'
      });
    }
  }

  next();
}

// ─── Plan Guards ───────────────────────────────────────────────────────────────
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

module.exports = {
  protect,
  requirePro,
  requireAgency,
  invalidateUserCache,
  validateRegistration,  // /auth/register pe lagao
  validateLogin,         // /auth/login pe lagao
  validateStrongPassword,
  isTempEmail,
  detectVPN,
};
