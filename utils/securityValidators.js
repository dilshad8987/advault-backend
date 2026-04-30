// ─── Security Validators ──────────────────────────────────────────────────────
// 1. Strong Password Check
// 2. Disposable/Temporary Email Block
// 3. VPN / Proxy / Datacenter IP Detection

// ═══════════════════════════════════════════════════════════════
// 1. STRONG PASSWORD VALIDATOR
// Rules: min 8 chars, uppercase, lowercase, number, special char
// ═══════════════════════════════════════════════════════════════
function validateStrongPassword(password) {
  const errors = [];

  if (!password || password.length < 8) {
    errors.push('Password kam se kam 8 characters ka hona chahiye');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Ek uppercase letter zaroori hai (A-Z)');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Ek lowercase letter zaroori hai (a-z)');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Ek number zaroori hai (0-9)');
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    errors.push('Ek special character zaroori hai (!@#$%^&* etc.)');
  }
  if (password.length > 128) {
    errors.push('Password 128 characters se zyada nahi ho sakta');
  }

  return {
    valid: errors.length === 0,
    errors,
    message: errors.length > 0 ? errors[0] : null
  };
}

// ═══════════════════════════════════════════════════════════════
// 2. DISPOSABLE / TEMPORARY EMAIL BLOCKER
// Common temp email services blocked
// ═══════════════════════════════════════════════════════════════
const TEMP_EMAIL_DOMAINS = new Set([
  // Top disposable email providers
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamail.biz', 'guerrillamail.de',
  'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'guerrillamail.info', 'spam4.me', 'yopmail.com', 'yopmail.fr',
  'cool.fr.nf', 'jetable.fr.nf', 'nospam.ze.tc', 'nomail.xl.cx',
  'mega.zik.dj', 'speed.1s.fr', 'courriel.fr.nf', 'moncourrier.fr.nf',
  'monemail.fr.nf', 'monmail.fr.nf', 'trashmail.com', 'trashmail.me',
  'trashmail.at', 'trashmail.io', 'trashmail.net', 'throwam.com',
  'throwam.net', 'dispostable.com', 'mailnull.com', 'spamgourmet.com',
  'spamgourmet.net', 'spamgourmet.org', 'spamgourmet.com',
  'tempmail.com', 'temp-mail.org', 'temp-mail.ru', 'tempr.email',
  'tempinbox.com', 'tempinbox.co.uk', 'tempemail.net', 'fakeinbox.com',
  'mailnesia.com', 'mailnull.com', 'spamfree24.org', 'spamfree24.de',
  'spamfree24.eu', 'spamfree24.info', 'spamfree24.net', 'spamfree24.com',
  'spam.la', 'spam.su', 'spam.org.tr', 'spamgob.com',
  'throwaway.email', 'throwam.com', 'discard.email',
  'maildrop.cc', 'mailpoof.com', 'mailseal.de', 'mintemail.com',
  'mt2009.com', 'mt2014.com', 'mt2015.com', 'mt2016.com',
  'nwldx.com', 'objectmail.com', 'obobbo.com', 'odnorazovoe.ru',
  'oneoffmail.com', 'onewaymail.com', 'oopi.org', 'ordinaryamerican.net',
  'ovpn.to', 'pamexgo.net', 'pancakemail.com', 'paplease.com',
  'payspun.com', 'pearatly.com', 'pjjkp.com', 'plexolan.de',
  'poodog.com', 'postacı.com', 'pookmail.com', 'privacy.net',
  'proxymail.eu', 'prtnx.com', 'prtz.eu', 'punkass.com',
  'putthisinyourspamdatabase.com', 'qq.com.mx', 'quickinbox.com',
  'rcpt.at', 'reallymymail.com', 'recode.me', 'recursor.net',
  'reliable-mail.com', 'rematoka.com', 'rmqkr.net', 'rocketmail.com',
  'throwam.com', 'spamcannon.com', 'spamcannon.net', 'spamcon.org',
  'spamevader.net', 'spamfighter.cf', 'spamfighter.ga', 'spamfighter.gq',
  'spamfighter.ml', 'spamfighter.tk', 'spamgoes.in',
  // Indian temp mail
  'mailtemp.in', 'tempmail.in', '10minutemail.com', '10minutemail.net',
  '10minutemail.org', '10minutemail.de', '10minutemail.co.uk',
  '10minutemail.us', '10minutemail.info', '10minutemail.biz',
  '20minutemail.com', '20minutemail.it', '20minutemail.net',
  '20minutemail.org', 'minuteinbox.com', 'binkmail.com',
  'bobmail.info', 'chammy.info', 'devnullmail.com', 'delikkt.de',
  'discardmail.com', 'discardmail.de', 'disposableaddress.com',
  'disposableemailaddresses.com', 'disposableinbox.com',
  'dontreg.com', 'dontsendmespam.de', 'dump-email.info',
  'dumpandforfeit.com', 'dumpmail.de', 'dumpyemail.com',
  'e4ward.com', 'email60.com', 'emailinfive.com', 'emailisvalid.com',
  'emailtemporanea.com', 'emailtemporanea.net', 'emailtemporar.ro',
  'emailthe.net', 'emailtmp.com', 'emailwarden.com', 'emailx.at.hm',
  'emailxfer.com', 'emkei.cz', 'emkei.ga', 'emkei.gq', 'emkei.ml',
  'emkei.tk', 'evilcomputer.com', 'explodemail.com', 'express.net.ua',
  'extremail.ru', 'eyepaste.com', 'fakemailgenerator.com', 'fakemailgenerator.net',
  'fastacura.com', 'fastchevy.com', 'fastchrysler.com',
  // More popular ones
  'getnada.com', 'getonemail.com', 'gettempemail.com', 'girlsundertheinfluence.com',
  'gishpuppy.com', 'givmail.com', 'glix.it', 'glubex.com', 'glutglut.com',
  'goemailgo.com', 'gotmail.net', 'gotmail.org', 'grandmamail.com',
  'grandmasmail.com', 'great-host.in', 'greensloth.com', 'gsrv.co.uk',
  'guerillamail.biz', 'guerillamail.com', 'guerillamail.de', 'guerillamail.info',
  'guerillamail.net', 'guerillamail.org', 'guerillamailblock.com',
  'h.mintemail.com', 'h8s.org', 'haltospam.com', 'harakirimail.com',
  'hatespam.org', 'herp.in', 'hidemail.de', 'hidzz.com', 'hmamail.com',
  'hopemail.biz', 'hpc.tw', 'hulapla.de', 'ieatspam.eu', 'ieatspam.info',
  'ieh-mail.de', 'ihateyoualot.info', 'iheartspam.org', 'ikbenspamvrij.nl',
  'imails.info', 'inboxclean.com', 'inboxclean.org', 'incognitomail.com',
  'incognitomail.net', 'incognitomail.org', 'inoutmail.de', 'inoutmail.eu',
  'inoutmail.info', 'inoutmail.net', 'insorg-mail.info', 'instant-mail.de',
  'instantemailaddress.com', 'instantlyemail.com', 'ip6.li', 'irish2me.com',
  'jetable.com', 'jetable.fr.nf', 'jetable.net', 'jetable.org',
  'jnxjn.com', 'jolieil.com', 'jourrapide.com', 'jsrsolutions.com',
  'juicedmail.com', 'jumonji.tk', 'junk1.tk', 'kasmail.com',
  'kaspop.com', 'keepmymail.com', 'killmail.com', 'killmail.net',
  'klassmaster.com', 'klassmaster.net', 'klzlk.com', 'koszmail.pl',
  'kurzepost.de', 'lawlita.com', 'lazyinbox.com', 'letthemeatspam.com',
  'lhsdv.com', 'litedrop.com', 'lol.ovpn.to', 'lookugly.com',
  'lortemail.dk', 'lr78.com', 'lroid.com', 'lukop.dk',
  'm21.cc', 'mail-filter.com', 'mail-temporaire.fr', 'mail.by',
  'mail2rss.org', 'mail333.com', 'mailblocks.com', 'mailbucket.org',
  'mailcat.biz', 'mailcatch.com', 'mailde.de', 'mailde.info',
  'mailexpire.com', 'mailf5.com', 'mailfall.com', 'mailfree.ga',
  'mailfreeonline.com', 'mailguard.me', 'mailimate.com',
  'mailme.gq', 'mailme24.com', 'mailmetrash.com', 'mailmoat.com',
  'mailms.com', 'mailnew.com', 'mailnull.com', 'mailpick.biz',
  'mailrock.biz', 'mailscrap.com', 'mailshell.com', 'mailsiphon.com',
  'mailslapping.com', 'mailslite.com', 'mailtemp.info', 'mailtemporaire.com',
  'mailtemporaire.fr', 'mailthis.in', 'mailtome.de', 'mailtothis.com',
  'mailtrash.net', 'mailtv.net', 'mailtv.tv', 'mailzilla.com',
  'mailzilla.org', 'makemetheking.com', 'manifestgeo.com', 'mansiondev.com',
  'matapadang.com', 'mbx.cc', 'mega.zik.dj', 'meltmail.com',
  'messagebeamer.de', 'mezimages.net', 'mfsa.ru', 'mierdamail.com',
  'migumail.com', 'mindless.com', 'ministryofspam.com',
  'mmail.igg.biz', 'mnage.com', 'mohmal.com', 'moncourrier.fr.nf',
  'monemail.fr.nf', 'monmail.fr.nf', 'moza.pl', 'mozej.com',
  'msgos.com', 'mswork.ru', 'mt2009.com', 'mx0.wwwnew.eu',
  'my10minutemail.com', 'mypartyclip.de', 'myphantomemail.com',
  'mysamp.de', 'myspaceinc.com', 'myspaceinc.net', 'myspaceinc.org',
  'myspacepimpedup.com', 'myspamless.com', 'mytemp.email', 'mytempmail.com',
  'mytrashmail.com', 'nabuma.ru', 'neomailbox.com',
  'nepwk.com', 'nervmich.net', 'nervtmich.net', 'netmails.com',
  'netmails.net', 'nevermail.de', 'nnh.com', 'noblepioneer.com',
  'nogmailspam.info', 'nomail.pw', 'nomail.xl.cx', 'nomail2me.com',
  'nomorespamemails.com', 'nospam.ze.tc', 'nospam4.us', 'nospamfor.us',
  'nospammail.net', 'nospamthanks.info', 'notmailinator.com',
  'nowhere.org', 'nowmymail.net', 'nurfuerspam.de',
  'o2.co.uk', 'onewaymail.com', 'online.ms', 'oopi.org',
  'opentrash.com', 'ordinaryamerican.net', 'otherinbox.com',
  'ovpn.to', 'owlpic.com',
]);

function isDisposableEmail(email) {
  if (!email || !email.includes('@')) return false;
  
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) return false;
  
  // Direct match
  if (TEMP_EMAIL_DOMAINS.has(domain)) return true;
  
  // Subdomain check (e.g. user@sub.mailinator.com)
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parentDomain = parts.slice(i).join('.');
    if (TEMP_EMAIL_DOMAINS.has(parentDomain)) return true;
  }
  
  // Pattern-based detection for common temp mail patterns
  const tempPatterns = [
    /^(temp|throwaway|trash|spam|fake|disposable|junk|noreply|no-reply)/i,
    /\d{8,}@/,  // Very long number sequences before @
  ];
  
  // Domain-level pattern checks
  const domainPatterns = [
    /tempmail/i, /throwmail/i, /trashmail/i, /spammail/i,
    /fakemail/i, /disposable/i, /yopmail/i, /guerrilla/i,
    /mailinator/i, /tempemail/i, /tmpmail/i, /throwam/i,
    /discard/i, /maildrop/i, /sharklaser/i,
  ];
  
  return domainPatterns.some(p => p.test(domain));
}

// ═══════════════════════════════════════════════════════════════
// 3. VPN / PROXY / TOR DETECTION
// Uses ip-api.com (free, 45 req/min) to detect VPN/proxy IPs
// Falls back gracefully if API unavailable
// ═══════════════════════════════════════════════════════════════
const axios = require('axios');

// Cache to avoid repeated API calls for same IP
const ipCache = new Map();
const IP_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

async function detectVpnProxy(ip) {
  // Skip for localhost/private IPs during development
  if (!ip || ip === '::1' || ip === '127.0.0.1' || 
      ip.startsWith('192.168.') || ip.startsWith('10.') || 
      ip.startsWith('172.16.') || ip.startsWith('::ffff:127')) {
    return { isVpn: false, reason: null };
  }

  // Clean IPv6-mapped IPv4 (::ffff:1.2.3.4 → 1.2.3.4)
  const cleanIp = ip.replace(/^::ffff:/, '');

  // Check cache
  const cached = ipCache.get(cleanIp);
  if (cached && Date.now() - cached.ts < IP_CACHE_TTL) {
    return cached.result;
  }

  try {
    // ip-api.com free tier — fields: proxy, hosting, mobile
    const response = await axios.get(
      `http://ip-api.com/json/${cleanIp}?fields=status,proxy,hosting,mobile,isp,org,query`,
      { timeout: 3000 }
    );
    
    const data = response.data;
    
    if (data.status !== 'success') {
      return { isVpn: false, reason: null };
    }

    const isVpn = data.proxy === true;
    const isHosting = data.hosting === true; // Datacenter IP
    
    let reason = null;
    if (isVpn) reason = 'VPN ya proxy detected';
    else if (isHosting) reason = 'Datacenter IP detected (VPN servers commonly use these)';

    const result = { 
      isVpn: isVpn || isHosting, 
      reason,
      isp: data.isp 
    };
    
    // Cache result
    ipCache.set(cleanIp, { result, ts: Date.now() });
    
    return result;
    
  } catch (err) {
    // If IP check API fails, allow through (don't block users)
    console.warn('[VPN Check] IP API failed:', err.message);
    return { isVpn: false, reason: null };
  }
}

// Cleanup old cache entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipCache.entries()) {
    if (now - entry.ts > IP_CACHE_TTL) ipCache.delete(ip);
  }
}, 60 * 60 * 1000);

module.exports = {
  validateStrongPassword,
  isDisposableEmail,
  detectVpnProxy,
};
