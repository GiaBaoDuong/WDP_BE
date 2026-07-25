/**
 * Migration: Backfill cover_image_url field to Chapter
 *
 * Vì MongoDB không lưu field có giá trị mặc định vào document,
 * nên các chapter cũ không có trường cover_image_url.
 * Script này set default "" cho tất cả chapter thiếu field.
 *
 * Run: node scripts/migrate-chapters-cover-image.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Chapter = require("../models/Chapter");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-chapters-cover-image] Connected to MongoDB");

    // Backfill: set cover_image_url="" for chapters missing this field
    const result = await Chapter.updateMany(
      { cover_image_url: { $exists: false } },
      { $set: { cover_image_url: "" } }
    );

    console.log(
      `[migrate-chapters-cover-image] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`
    );

    // Sanity check
    const countWithCover = await Chapter.countDocuments({
      cover_image_url: { $exists: true },
    });
    const totalChapters = await Chapter.countDocuments();
    console.log(
      `[migrate-chapters-cover-image] Total chapters: ${totalChapters}, with cover_image_url: ${countWithCover}`
    );

    await mongoose.disconnect();
    console.log("[migrate-chapters-cover-image] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-chapters-cover-image] Failed:", err);
    process.exit(1);
  }
})();
