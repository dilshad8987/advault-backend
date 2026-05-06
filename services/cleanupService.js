// services/cleanupService.js
//
// Roz raat 12 baje:
// 1. Cloudflare R2 se purani images/videos delete karo
// 2. Popular ads (zyada views) 1 month tak rakho
// 3. Baaki weekly fresh

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

// ─── R2 file delete ───────────────────────────────────────────────────────────
async function deleteFromR2(url) {
  try {
    if (!s3 || !url || !url.includes('r2.dev')) return false;
    // URL se key nikalo
    // https://pub-xxx.r2.dev/meta-ads/123.jpg → meta-ads/123.jpg
    const parts = url.split('.r2.dev/');
    const key = parts[1];
    if (!key) return false;

    await s3.send(new DeleteObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }));
    return true;
  } catch(e) {
    console.error('R2 delete error:', e.message);
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
  const now = new Date();
  const oneMonthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const oneWeekAgo  = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const POPULAR_VIEWS = 5; // 5+ views = popular

  // Step 1: In-memory views save karo MongoDB mein
  let viewsSaved = 0;
  for (const [libId, count] of viewCounts.entries()) {
    try {
      await MetaAd.updateOne(
        { library_id: libId },
        {
          $inc: { view_count: count },
          $set: { last_viewed: new Date() }
        }
      );
      viewsSaved++;
    } catch(e) {}
  }
  viewCounts.clear();
  console.log('Views saved: ' + viewsSaved);

  // Step 2: Delete karne wale ads find karo
  // Rule 1: 1 month se purana — hamesha delete
  // Rule 2: 1 week se purana + views < POPULAR_VIEWS — delete
  const toDelete = await MetaAd.find({
    $or: [
      { scraped_at: { $lt: oneMonthAgo } },
      {
        scraped_at: { $lt: oneWeekAgo },
        $or: [
          { view_count: { $lt: POPULAR_VIEWS } },
          { view_count: { $exists: false } },
          { view_count: null },
        ]
      }
    ]
  }).select('_id library_id r2_image_url r2_video_url view_count').lean();

  console.log('Delete honge: ' + toDelete.length + ' ads');

  let r2ImgDel = 0, r2VidDel = 0, mongoDel = 0;

  for (const ad of toDelete) {
    // Cloudflare R2 se image delete
    if (ad.r2_image_url) {
      const ok = await deleteFromR2(ad.r2_image_url);
      if (ok) r2ImgDel++;
    }

    // Cloudflare R2 se video delete
    if (ad.r2_video_url) {
      const ok = await deleteFromR2(ad.r2_video_url);
      if (ok) r2VidDel++;
    }

    // MongoDB se delete
    try {
      await MetaAd.deleteOne({ _id: ad._id });
      mongoDel++;
    } catch(e) {}
  }

  // Step 3: Popular ads ki R2 URLs reset karo
  // Taki fresh scrape pe naya data save ho
  const popularReset = await MetaAd.updateMany(
    {
      view_count: { $gte: POPULAR_VIEWS },
      scraped_at: { $lt: oneWeekAgo }
    },
    {
      $set: {
        r2_image_url: '',
        r2_video_url: '',
      }
    }
  );

  const remaining = await MetaAd.countDocuments();

  console.log('\n✅ CLEANUP COMPLETE:');
  console.log('   R2 images deleted: ' + r2ImgDel);
  console.log('   R2 videos deleted: ' + r2VidDel);
  console.log('   MongoDB deleted:   ' + mongoDel);
  console.log('   Popular ads reset: ' + popularReset.modifiedCount);
  console.log('   Remaining ads:     ' + remaining);
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
