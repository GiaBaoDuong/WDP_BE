/**
 * Migration: Backfill các field mới cho Series và Chapter
 *
 * 1. Series:
 *    - `scheduled_publish_at` (Date, null) — đã có thể đã được migrate bởi
 *      scripts/migrate-series-scheduled-publish-at.js nhưng chạy lại để đảm bảo.
 *    - `publication_schedule` (String|null) — enum: "weekly" | "monthly" | null.
 *
 * 2. Chapter:
 *    - `is_scheduled` (Boolean, false)
 *    - `scheduled_publish_at` (Date, null)
 *    - `publication_schedule` (String|null)
 *    - `publication_duration_days` (Number|null) — enum: 7 | 30 | null.
 *
 * 3. Status enum mới ("approved_by_EB" cho Series và Chapter) KHÔNG cần migrate ở DB
 *    vì MongoDB không validate enum ở DB level (chỉ validate qua Mongoose driver).
 *
 * Run: node scripts/migrate-series-chapter-scheduled-fields.js
 *
 * Idempotent: chạy nhiều lần không sao — chỉ update documents thiếu field.
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Series = require("../models/Series");
const Chapter = require("../models/Chapter");

const log = (msg) => console.log(`[migrate-scheduled-fields] ${msg}`);

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    log("Connected to MongoDB");

    // ─── 1. Series: backfill scheduled_publish_at + publication_schedule ─────
    log("--- Series ---");
    const seriesFields = ["scheduled_publish_at", "publication_schedule"];
    for (const field of seriesFields) {
      const result = await Series.updateMany(
        { [field]: { $exists: false } },
        { $set: { [field]: null } }
      );
      log(`Series.${field}: matched=${result.matchedCount}, modified=${result.modifiedCount}`);
    }

    // ─── 2. Chapter: backfill các field scheduling ───────────────────────────
    log("--- Chapter ---");
    const chapterFieldUpdates = [
      { field: "is_scheduled", value: false },
      { field: "scheduled_publish_at", value: null },
      { field: "publication_schedule", value: null },
      { field: "publication_duration_days", value: null },
    ];
    for (const { field, value } of chapterFieldUpdates) {
      const result = await Chapter.updateMany(
        { [field]: { $exists: false } },
        { $set: { [field]: value } }
      );
      log(`Chapter.${field}: matched=${result.matchedCount}, modified=${result.modifiedCount}`);
    }

    // ─── 3. Sanity check ─────────────────────────────────────────────────────
    log("--- Sanity check ---");
    const totalSeries = await Series.countDocuments();
    const seriesWithScheduledAt = await Series.countDocuments({
      scheduled_publish_at: { $exists: true },
    });
    const seriesWithPubSchedule = await Series.countDocuments({
      publication_schedule: { $exists: true },
    });
    log(`Series: total=${totalSeries}, with scheduled_publish_at=${seriesWithScheduledAt}, with publication_schedule=${seriesWithPubSchedule}`);

    const totalChapters = await Chapter.countDocuments();
    const chWithIsScheduled = await Chapter.countDocuments({
      is_scheduled: { $exists: true },
    });
    const chWithScheduledAt = await Chapter.countDocuments({
      scheduled_publish_at: { $exists: true },
    });
    const chWithPubSchedule = await Chapter.countDocuments({
      publication_schedule: { $exists: true },
    });
    const chWithDuration = await Chapter.countDocuments({
      publication_duration_days: { $exists: true },
    });
    log(
      `Chapter: total=${totalChapters}, with is_scheduled=${chWithIsScheduled}, with scheduled_publish_at=${chWithScheduledAt}, with publication_schedule=${chWithPubSchedule}, with publication_duration_days=${chWithDuration}`
    );

    // ─── 4. Stats theo status ─────────────────────────────────────────────────
    log("--- Status distribution ---");
    const seriesStatusAgg = await Series.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    log("Series.status:");
    for (const row of seriesStatusAgg) log(`  ${row._id || "(null)"}: ${row.count}`);

    const chapterStatusAgg = await Chapter.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    log("Chapter.status:");
    for (const row of chapterStatusAgg) log(`  ${row._id || "(null)"}: ${row.count}`);

    // ─── 5. Indexes ──────────────────────────────────────────────────────────
    log("--- Indexes ---");
    const chapterIndexes = await mongoose.connection.db
      .collection("chapters")
      .indexes();
    const hasIsScheduledIdx = chapterIndexes.some(
      (idx) => idx.key && idx.key.is_scheduled !== undefined && idx.key.scheduled_publish_at !== undefined
    );
    if (hasIsScheduledIdx) {
      log("Chapter compound index (is_scheduled, scheduled_publish_at) already exists");
    } else {
      await mongoose.connection.db
        .collection("chapters")
        .createIndex({ is_scheduled: 1, scheduled_publish_at: 1 }, { background: true });
      log("Created Chapter compound index (is_scheduled, scheduled_publish_at)");
    }

    await mongoose.disconnect();
    log("Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-scheduled-fields] Failed:", err);
    process.exit(1);
  }
})();