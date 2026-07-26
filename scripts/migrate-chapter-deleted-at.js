/**
 * Migration: Add deleted_at field to Chapter
 *
 * Run: node scripts/migrate-chapter-deleted-at.js
 *
 * Steps:
 * 1. Add deleted_at = null for chapters missing this field (for new schema)
 * 2. Sync deleted_at for chapters whose series was soft-deleted before this field existed
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Chapter = require("../models/Chapter");
const Series = require("../models/Series");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-chapter-deleted-at] Connected to MongoDB");

    // Step 1: Backfill deleted_at = null for chapters missing this field
    const step1 = await Chapter.updateMany(
      { deleted_at: { $exists: false } },
      { $set: { deleted_at: null } },
    );
    console.log(
      `[Step 1] Added deleted_at field: matched=${step1.matchedCount}, modified=${step1.modifiedCount}`,
    );

    // Step 2: Sync chapters whose series was soft-deleted BEFORE this field existed.
    // Before this migration, admin could soft-delete a series but chapters had no deleted_at.
    // After this migration, chapters should be marked deleted too (soft delete).
    const deletedSeries = await Series.find({ deleted_at: { $ne: null } })
      .select("_id deleted_at")
      .lean();

    let totalSynced = 0;
    for (const series of deletedSeries) {
      const r = await Chapter.updateMany(
        { series_id: series._id, deleted_at: null },
        { $set: { deleted_at: series.deleted_at } },
      );
      if (r.modifiedCount > 0) {
        console.log(
          `  [Series ${series._id}] synced ${r.modifiedCount} chapters (series.deleted_at=${series.deleted_at})`,
        );
        totalSynced += r.modifiedCount;
      }
    }
    console.log(`[Step 2] Synced deleted_at for ${totalSynced} chapters across ${deletedSeries.length} deleted series`);

    // Sanity check
    const totalChapters = await Chapter.countDocuments();
    const withField = await Chapter.countDocuments({ deleted_at: { $exists: true } });
    const deletedChapters = await Chapter.countDocuments({ deleted_at: { $ne: null } });
    console.log(`[Check] Total chapters: ${totalChapters}, with deleted_at: ${withField}, soft-deleted: ${deletedChapters}`);

    await mongoose.disconnect();
    console.log("[migrate-chapter-deleted-at] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-chapter-deleted-at] Failed:", err);
    process.exit(1);
  }
})();
