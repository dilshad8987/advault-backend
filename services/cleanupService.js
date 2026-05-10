// services/cleanupService.js
//
// Roz raat 12 baje:
// 1. Cloudflare R2 se purani images/videos delete karo
// 2. R2 delete hone ke baad — usi ad ko MongoDB se bhi delete karo
//    (sirf wahi ad jiske R2 files successfully delete hui hain)
// 3. Popular ads (zyada views) 1 month tak rakho
// 4. Baaki weekly fresh
//
// INSTANT ADD: Scraper jab bhi naya ad save kare — seedha MongoDB mein
//              upsert hota hai, koi extra step nahi. Cache bhi nahi.

const mongoose = require('mongoose');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT   = process.env.R2_ENDPOINT;
const R2_BUCKET     = process.env.R2_BUCKET_NAME || 'advaultmedia';

// R2 client
let s3 = null;
if (R2_ENDPOINT && R2_ACCESS_KEY && R2_SECRET_KEY) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
    forcePathStyle: true,
  });
  console.log('R2 client ready');
}

// ─── View tracker — in-memory ─────────────────────────────────────────────────
const viewCounts = new Map();

function trackAdView(libraryId) {
  if (!libraryId) return;
  viewCounts.set(libraryId, (viewCounts.get(libraryId) || 0) + 1);
}

// ─── R2 URL se Key nikalo ─────────────────────────────────────────────────────
// https://pub-xxx.r2.dev/meta-ads/123.jpg → meta-ads/123.jpg
// https://xxx.r2.cloudflarestorage.com/bucket/meta-ads/123.jpg → meta-ads/123.jpg
function extractR2Key(url) {
  if (!url) return null;
  try {
    // Pattern 1: pub-xxx.r2.dev/key
    if (url.includes('.r2.dev/')) {
      const key = url.split('.r2.dev/')[1];
      return key || null;
    }
    // Pattern 2: endpoint/bucket/key (custom R2 endpoint)
    if (R2_ENDPOINT && url.startsWith(R2_ENDPOINT)) {
      const withoutEndpoint = url.slice(R2_ENDPOINT.length).replace(/^\//, '');
      // bucket name bhi ho sakta hai prefix mein
      const withoutBucket = withoutEndpoint.startsWith(R2_BUCKET + '/')
        ? withoutEndpoint.slice(R2_BUCKET.length + 1)
        : withoutEndpoint;
      return withoutBucket || null;
    }
    // Pattern 3: generic — last try URL parse
    const parsed = new URL(url);
    const key = parsed.pathname.replace(/^\//, '').replace(new RegExp(`^${R2_BUCKET}/`), '');
    return key || null;
  } catch (e) {
    return null;
  }
}

// ─── R2 file delete — returns true only on confirmed delete ──────────────────
async function deleteFromR2(url) {
  if (!s3 || !url) return false;

  const key = extractR2Key(url);
  if (!key) {
    console.warn('   ⚠ R2 key extract nahi hua:', url.slice(0, 60));
    return false;
  }

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e) {
    // NoSuchKey = file pehle se hi nahi thi — MongoDB se delete karna theek hai
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return true;
    console.error('   R2 delete error:', e.message, '| key:', key);
    return false;
  }
}

// ─── Main cleanup ─────────────────────────────────────────────────────────────
async function runCleanup() {
  console.log('\n🧹 CLEANUP SHURU: ' + new Date().toLocaleString());

  if (mongoose.connection.readyState !== 1) {
    console.log('MongoDB connected nahi — skip');
    return;
  }

  const MetaAd = require('../models/MetaAd');
  const now         = new Date();
  const oneMonthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const oneWeekAgo  = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const POPULAR_VIEWS = 5; // 5+ views = popular

  // Step 1: In-memory views MongoDB mein save karo
  let viewsSaved = 0;
  for (const [libId, count] of viewCounts.entries()) {
    try {
      await MetaAd.updateOne(
        { library_id: libId },
        { $inc: { view_count: count }, $set: { last_viewed: new Date() } }
      );
      viewsSaved++;
    } catch (e) {}
  }
  viewCounts.clear();
  console.log('Views saved: ' + viewsSaved);

  // Step 2: Delete candidates find karo
  const toDelete = await MetaAd.find({
    $or: [
      // Rule 1: 1 month se purana — hamesha delete
      { scraped_at: { $lt: oneMonthAgo } },
      // Rule 2: 1 week se purana + kam views
      {
        scraped_at: { $lt: oneWeekAgo },
        $or: [
          { view_count: { $lt: POPULAR_VIEWS } },
          { view_count: { $exists: false } },
          { view_count: null },
        ],
      },
    ],
  }).select('_id library_id r2_image_url r2_video_url view_count').lean();

  console.log('Delete candidates: ' + toDelete.length + ' ads');

  let r2ImgDel = 0, r2VidDel = 0, mongoDel = 0, r2FailSkip = 0;

  for (const ad of toDelete) {
    let imageDeleted = true; // agar R2 URL nahi hai to consider deleted
    let videoDeleted = true;

    // ── R2 Image delete ──────────────────────────────────────────────────────
    if (ad.r2_image_url && ad.r2_image_url.trim()) {
      imageDeleted = await deleteFromR2(ad.r2_image_url);
      if (imageDeleted) r2ImgDel++;
    }

    // ── R2 Video delete ──────────────────────────────────────────────────────
    if (ad.r2_video_url && ad.r2_video_url.trim()) {
      videoDeleted = await deleteFromR2(ad.r2_video_url);
      if (videoDeleted) r2VidDel++;
    }

    // ── MongoDB delete — SIRF tab jab R2 files successfully delete hui hain ─
    // Agar R2 delete fail hua to MongoDB record rakhte hain
    // (taki agli baar retry ho sake)
    if (imageDeleted && videoDeleted) {
      try {
        await MetaAd.deleteOne({ _id: ad._id });
        mongoDel++;
      } catch (e) {
        console.error('   MongoDB delete error:', e.message);
      }
    } else {
      r2FailSkip++;
      console.warn(`   ⚠ R2 delete fail — MongoDB mein rakha: ${ad.library_id}`);
    }
  }

  // Step 3: Popular ads ki R2 URLs reset karo
  // Taki fresh scrape pe naya data aaye
  const popularReset = await MetaAd.updateMany(
    {
      view_count: { $gte: POPULAR_VIEWS },
      scraped_at: { $lt: oneWeekAgo },
    },
    {
      $set: { r2_image_url: '', r2_video_url: '' },
    }
  );

  const remaining = await MetaAd.countDocuments();

  console.log('\n✅ CLEANUP COMPLETE:');
  console.log('   R2 images deleted:  ' + r2ImgDel);
  console.log('   R2 videos deleted:  ' + r2VidDel);
  console.log('   MongoDB deleted:    ' + mongoDel);
  console.log('   R2 fail (skipped):  ' + r2FailSkip);
  console.log('   Popular ads reset:  ' + popularReset.modifiedCount);
  console.log('   Remaining ads:      ' + remaining);
  console.log('🧹 ================================\n');
}

// ─── Schedule — roz raat 12 baje ─────────────────────────────────────────────
function msUntilMidnight() {
  const now  = new Date();
  const next = new Date();
  next.setHours(0, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function startCleanupScheduler() {
  const ms = msUntilMidnight();
  const hours = (ms / 1000 / 60 / 60).toFixed(1);
  console.log('🧹 Cleanup: ' + hours + ' ghante mein (raat 12 baje)');

  setTimeout(async function repeat() {
    await runCleanup().catch(e => console.error('Cleanup error:', e.message));
    setTimeout(repeat, 24 * 60 * 60 * 1000);
  }, ms);
}

module.exports = { startCleanupScheduler, trackAdView, runCleanup };
