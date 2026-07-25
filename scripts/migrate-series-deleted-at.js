/**
 * Migration: Backfill `deleted_at` field to Series
 *
 * Vì MongoDB không lưu field có giá trị `null` mặc định cho các document
 * cũ, series nào chưa có field `deleted_at` sẽ được set về `null`.
 * - `deleted_at = null` → series đang hoạt động
 * - `deleted_at = Date` → series đã bị ẩn (soft delete)
 *
 * Run: node scripts/migrate-series-deleted-at.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Series = require("../models/Series");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-series-deleted-at] Connected to MongoDB");

    // Create index on deleted_at if not exists
    const indexes = await mongoose.connection.db
      .collection("series")
      .indexes();
    const hasDeletedAtIndex = indexes.some(
      (idx) => idx.key && idx.key.deleted_at !== undefined,
    );

    if (hasDeletedAtIndex) {
      console.log("[migrate-series-deleted-at] Index on deleted_at already exists");
    } else {
      await mongoose.connection.db
        .collection("series")
        .createIndex({ deleted_at: 1 }, { background: true });
      console.log("[migrate-series-deleted-at] Created index on deleted_at");
    }

    // Backfill: set deleted_at=null for series missing this field
    const result = await Series.updateMany(
      { deleted_at: { $exists: false } },
      { $set: { deleted_at: null } },
    );

    console.log(
      `[migrate-series-deleted-at] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`,
    );

    // Sanity check
    const totalSeries = await Series.countDocuments();
    const activeSeries = await Series.countDocuments({ deleted_at: null });
    const hiddenSeries = await Series.countDocuments({
      deleted_at: { $ne: null },
    });

    console.log(
      `[migrate-series-deleted-at] Total: ${totalSeries}, Active: ${activeSeries}, Hidden: ${hiddenSeries}`,
    );

    await mongoose.disconnect();
    console.log("[migrate-series-deleted-at] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-series-deleted-at] Failed:", err);
    process.exit(1);
  }
})();
