/**
 * Migration: Backfill te_id and te_assigned_at fields to Chapter
 *
 * Vì MongoDB không lưu field có giá trị null vào document,
 * nên các chapter cũ không có trường te_id/te_assigned_at.
 * Script này set default null cho tất cả chapter thiếu field.
 *
 * Run: node scripts/migrate-chapters-te-id.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Chapter = require("../models/Chapter");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-chapters-te-id] Connected to MongoDB");

    // Create index te_id if not exists
    const indexes = await mongoose.connection.db
      .collection("chapters")
      .indexes();
    const hasTeIdIndex = indexes.some(
      (idx) => idx.key && idx.key.te_id !== undefined,
    );

    if (hasTeIdIndex) {
      console.log("[migrate-chapters-te-id] Index on te_id already exists");
    } else {
      await mongoose.connection.db
        .collection("chapters")
        .createIndex({ te_id: 1 }, { background: true });
      console.log("[migrate-chapters-te-id] Created index on te_id");
    }

    // Backfill: set te_id=null and te_assigned_at=null for chapters missing these fields
    const result = await Chapter.updateMany(
      {
        $or: [
          { te_id: { $exists: false } },
          { te_assigned_at: { $exists: false } },
        ],
      },
      {
        $set: {
          te_id: null,
          te_assigned_at: null,
        },
      },
    );

    console.log(
      `[migrate-chapters-te-id] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`,
    );

    // Sanity check
    const countWithTeId = await Chapter.countDocuments({ te_id: { $exists: true } });
    const countWithTeAssignedAt = await Chapter.countDocuments({ te_assigned_at: { $exists: true } });
    const totalChapters = await Chapter.countDocuments();
    console.log(
      `[migrate-chapters-te-id] Total chapters: ${totalChapters}, with te_id: ${countWithTeId}, with te_assigned_at: ${countWithTeAssignedAt}`,
    );

    await mongoose.disconnect();
    console.log("[migrate-chapters-te-id] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-chapters-te-id] Failed:", err);
    process.exit(1);
  }
})();
