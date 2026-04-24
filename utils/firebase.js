const admin = require('firebase-admin');

if (!admin.apps.length) {
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!rawKey) {
    console.error('❌ FIREBASE_PRIVATE_KEY missing in environment variables!');
    process.exit(1);
  }

  // Railway pe private key alag formats mein aa sakti hai — sab handle karo
  let privateKey = rawKey;

  // Agar escaped newlines hain toh replace karo
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  // Agar quotes hain toh hatao
  if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
    privateKey = privateKey.slice(1, -1);
  }
  if (privateKey.startsWith("'") && privateKey.endsWith("'")) {
    privateKey = privateKey.slice(1, -1);
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey
      })
    });
    console.log('✅ Firebase initialized successfully');
  } catch (err) {
    console.error('❌ Firebase init error:', err.message);
    process.exit(1);
  }
}

module.exports = admin;
