/**
 * Migration: Backfill scheduled_publish_at field to Series
 *
 * Thêm field scheduled_publish_at (Date) cho tất cả Series.
 * Vì MongoDB không lưu field default null vào document,
 * các series cũ không có trường này.
 *
 * Run: node scripts/migrate-series-scheduled-publish-at.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Series = require("../models/Series");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-series-scheduled-publish-at] Connected to MongoDB");

    // Backfill: set scheduled_publish_at=null for series missing this field
    const result = await Series.updateMany(
      { scheduled_publish_at: { $exists: false } },
      { $set: { scheduled_publish_at: null } }
    );

    console.log(
      `[migrate-series-scheduled-publish-at] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`
    );

    // Sanity check
    const total = await Series.countDocuments();
    const withField = await Series.countDocuments({
      scheduled_publish_at: { $exists: true },
    });
    console.log(
      `[migrate-series-scheduled-publish-at] Total series: ${total}, with scheduled_publish_at: ${withField}`
    );

    await mongoose.disconnect();
    console.log("[migrate-series-scheduled-publish-at] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-series-scheduled-publish-at] Failed:", err);
    process.exit(1);
  }
})();
