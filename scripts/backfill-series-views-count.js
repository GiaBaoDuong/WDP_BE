/**
 * Backfill: Tính lại Series.views_count từ tổng Chapter.views_count
 * Run: node scripts/backfill-series-views-count.js
 */

require("dotenv").config();
const mongoose = require("mongoose");

const Series = require("../models/Series");
const Chapter = require("../models/Chapter");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  // Aggregate: tổng views theo series_id từ Chapter
  const stats = await Chapter.aggregate([
    { $match: { is_published: true } },
    { $group: { _id: "$series_id", totalViews: { $sum: "$views_count" } } },
  ]);

  console.log(`Found ${stats.length} series with chapters`);

  let updated = 0;
  let skipped = 0;

  for (const stat of stats) {
    const series = await Series.findById(stat._id);
    if (!series) {
      skipped++;
      continue;
    }

    if (series.views_count !== stat.totalViews) {
      series.views_count = stat.totalViews;
      await series.save();
      updated++;
      console.log(`  ${series.name}: ${stat.totalViews} views`);
    } else {
      skipped++;
    }
  }

  // Series không có chapter nào → views_count = 0 (đã default)
  const zeroCount = await Series.countDocuments({
    views_count: { $ne: 0 },
    _id: { $nin: stats.map((s) => s._id) },
  });
  if (zeroCount > 0) {
    await Series.updateMany(
      { _id: { $nin: stats.map((s) => s._id) } },
      { $set: { views_count: 0 } }
    );
    console.log(`Set ${zeroCount} series without chapters to 0 views`);
  }

  console.log(`\nDone. Updated: ${updated}, Skipped (already correct): ${skipped}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
