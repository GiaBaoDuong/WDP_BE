/**
 * Migration: Add "Mangaka" to valid enum values for revision_source
 *
 * Vì MongoDB không enforce enum, các document cũ vẫn hoạt động.
 * Script này đảm bảo:
 * 1. Các chapter có revision_source = "Mangaka" (đang hoạt động)
 * 2. Các chapter thiếu field revision_source được set giá trị mặc định ""
 *
 * Run: node scripts/migrate-chapters-revision-source.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Chapter = require("../models/Chapter");

const VALID_VALUES = ["TE", "EB", "Mangaka", ""];
const INVALID_VALUE = "Mangaka"; // Giá trị BE đang gán nhưng chưa có trong enum cũ

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-chapters-revision-source] Connected to MongoDB");

    // 1. Kiểm tra các document có revision_source không nằm trong enum mới
    // (Trường hợp này hiếm vì MongoDB không enforce enum)
    const invalidDocs = await Chapter.find({
      revision_source: { $nin: VALID_VALUES },
    });

    if (invalidDocs.length > 0) {
      console.log(`[migrate-chapters-revision-source] Found ${invalidDocs.length} docs with invalid revision_source`);
      for (const doc of invalidDocs) {
        console.log(`  - Chapter ${doc._id}: "${doc.revision_source}"`);
      }
    } else {
      console.log("[migrate-chapters-revision-source] No invalid revision_source found");
    }

    // 2. Đảm bảo tất cả chapters có field revision_source
    const missingField = await Chapter.countDocuments({
      revision_source: { $exists: false },
    });

    if (missingField > 0) {
      console.log(`[migrate-chapters-revision-source] ${missingField} chapters missing revision_source field`);
      const result = await Chapter.updateMany(
        { revision_source: { $exists: false } },
        { $set: { revision_source: "" } },
      );
      console.log(
        `[migrate-chapters-revision-source] Set default "" for ${result.modifiedCount} chapters`,
      );
    } else {
      console.log("[migrate-chapters-revision-source] All chapters have revision_source field");
    }

    // 3. Thống kê
    const stats = {};
    for (const val of VALID_VALUES) {
      stats[val || "(empty)"] = await Chapter.countDocuments({ revision_source: val });
    }
    console.log("[migrate-chapters-revision-source] Revision source distribution:");
    for (const [key, count] of Object.entries(stats)) {
      console.log(`  - "${key}": ${count}`);
    }

    const total = await Chapter.countDocuments();
    console.log(`[migrate-chapters-revision-source] Total chapters: ${total}`);

    await mongoose.disconnect();
    console.log("[migrate-chapters-revision-source] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-chapters-revision-source] Failed:", err);
    process.exit(1);
  }
})();
