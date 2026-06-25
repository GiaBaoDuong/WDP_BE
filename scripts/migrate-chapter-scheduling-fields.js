/**
 * Migration: Add scheduling fields to Chapter
 *
 * Fields:
 * - scheduled_publish_at: Date
 * - publication_duration_days: enum [7, 30]
 * - publication_schedule: enum ["weekly", "monthly"]
 * - is_scheduled: Boolean
 *
 * Run: node scripts/migrate-chapter-scheduling-fields.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Chapter = require("../models/Chapter");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-chapter-sched] Connected to MongoDB");

    const fields = [
      "scheduled_publish_at",
      "publication_duration_days",
      "publication_schedule",
      "is_scheduled",
    ];

    const countMissing = await Chapter.countDocuments({
      $or: fields.map((f) => ({ [f]: { $exists: false } })),
    });

    console.log(
      `[migrate-chapter-sched] Found ${countMissing} chapters missing scheduling fields`,
    );

    if (countMissing === 0) {
      const total = await Chapter.countDocuments();
      console.log(`[migrate-chapter-sched] All ${total} chapters already have scheduling fields`);
      await mongoose.disconnect();
      process.exit(0);
    }

    const result = await Chapter.updateMany(
      { scheduled_publish_at: { $exists: false } },
      {
        $set: {
          scheduled_publish_at: null,
          publication_duration_days: null,
          publication_schedule: null,
          is_scheduled: false,
        },
      },
    );

    console.log(
      `[migrate-chapter-sched] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`,
    );

    const total = await Chapter.countDocuments();
    const counts = await Promise.all(
      fields.map((f) =>
        Chapter.countDocuments({ [f]: { $exists: true } })
      )
    );

    console.log(
      `[migrate-chapter-sched] Total: ${total}, scheduled_publish_at: ${counts[0]}, publication_duration_days: ${counts[1]}, publication_schedule: ${counts[2]}, is_scheduled: ${counts[3]}`,
    );

    await mongoose.disconnect();
    console.log("[migrate-chapter-sched] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-chapter-sched] Failed:", err);
    process.exit(1);
  }
})();
