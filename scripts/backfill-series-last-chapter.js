/**
 * Script: Backfill Series.last_chapter_published_at
 * - Tính lại từ Chapter collection: lấy published_at mới nhất của các chapter đã publish.
 * - Series chưa có chapter publish nào sẽ được set null.
 *
 * Chạy: node scripts/backfill-series-last-chapter.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");

async function backfill() {
  try {
    console.log("[backfill] Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[backfill] Connected");

    console.log("[backfill] Aggregating latest published chapter per series...");
    const latest = await Chapter.aggregate([
      { $match: { is_published: true, published_at: { $ne: null } } },
      {
        $group: {
          _id: "$series_id",
          last_published_at: { $max: "$published_at" },
        },
      },
    ]);

    const map = new Map(latest.map((x) => [String(x._id), x.last_published_at]));
    console.log(`[backfill] Found ${latest.length} series có chapter publish.`);

    const allSeries = await Series.find({}).select("_id").lean();
    let updated = 0;
    let nulled = 0;

    for (const s of allSeries) {
      const val = map.get(String(s._id)) || null;
      await Series.findByIdAndUpdate(s._id, {
        $set: { last_chapter_published_at: val },
      });
      if (val) updated++;
      else nulled++;
    }

    console.log(`[backfill] Done. updated=${updated}, null=${nulled}, total=${allSeries.length}`);
    process.exit(0);
  } catch (err) {
    console.error("[backfill] Error:", err);
    process.exit(1);
  }
}

backfill();