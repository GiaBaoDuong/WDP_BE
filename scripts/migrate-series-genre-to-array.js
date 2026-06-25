/**
 * Migration: Convert Series.genre from String to [String]
 *
 * Một số document Series cũ đang lưu genre là String.
 * Script này convert sang mảng 1 phần tử để khớp schema mới.
 *
 * Run: node scripts/migrate-series-genre-to-array.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Series = require("../models/Series");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-series-genre] Connected to MongoDB");

    // Đếm số document đang lưu genre là String (không phải mảng)
    const countStringGenre = await Series.countDocuments({
      genre: { $type: "string" },
    });

    console.log(
      `[migrate-series-genre] Found ${countStringGenre} series with genre as String`,
    );

    if (countStringGenre === 0) {
      console.log("[migrate-series-genre] Nothing to migrate");
      await mongoose.disconnect();
      process.exit(0);
    }

    // Convert genre từ String -> [String] bằng aggregation pipeline
    const result = await Series.updateMany(
      { genre: { $type: "string" } },
      [
        {
          $set: {
            genre: ["$genre"],
          },
        },
      ],
      { updatePipeline: true },
    );

    console.log(
      `[migrate-series-genre] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`,
    );

    // Sanity check
    const totalSeries = await Series.countDocuments();
    const countArrayGenre = await Series.countDocuments({
      genre: { $type: "array" },
    });
    const countStringAfter = await Series.countDocuments({
      genre: { $type: "string" },
    });

    console.log(
      `[migrate-series-genre] Total: ${totalSeries}, Array: ${countArrayGenre}, String: ${countStringAfter}`,
    );

    await mongoose.disconnect();
    console.log("[migrate-series-genre] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-series-genre] Failed:", err);
    process.exit(1);
  }
})();
