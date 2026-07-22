/**
 * Fix: Snapshot final_image_url cho Pages
 *
 * Khi TE publish chapter, final_image_url có thể bị rỗng do:
 * - result_image_url ban đầu rỗng nên không snapshot được
 * - Lỗi khi chạy $cond trong MongoDB aggregation
 *
 * Script này fix bằng cách:
 * 1. Ưu tiên result_image_url
 * 2. Fallback original_image_url
 *
 * Run: node scripts/fix-final-image-url.js [chapter_id]
 * - Có chapter_id → chỉ fix chapter đó
 * - Không có → fix TẤT CẢ pages có result_image_url nhưng final_image_url rỗng
 *
 * Idempotent: chạy nhiều lần không sao
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Page = require("../models/Page");

const log = (msg) => console.log(`[fix-final-image-url] ${msg}`);

const chapterId = process.argv[2];

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    log("Connected to MongoDB");

    const filter = {
      final_image_url: { $in: ["", null] },
      result_image_url: { $nin: ["", null] },
    };

    if (chapterId) {
      filter.chapter_id = chapterId;
      log(`Fixing chapter: ${chapterId}`);
    } else {
      log("Fixing ALL chapters...");
    }

    // Đếm trước
    const count = await Page.countDocuments(filter);
    log(`Found ${count} pages cần fix`);

    if (count === 0) {
      log("Không có page nào cần fix");
      await mongoose.disconnect();
      process.exit(0);
    }

    // Fix: ưu tiên result_image_url, fallback original_image_url
    const result = await Page.updateMany(
      filter,
      [
        {
          $set: {
            final_image_url: {
              $ifNull: ["$result_image_url", "$original_image_url"],
            },
          },
        },
      ],
      { updatePipeline: true }
    );

    log(`Fixed: matched=${result.matchedCount}, modified=${result.modifiedCount}`);

    // Verify
    if (chapterId) {
      const pages = await Page.find({ chapter_id: chapterId }).lean();
      log(`\nVerification (chapter ${chapterId}):`);
      pages.forEach((p, i) => {
        log(`  Page ${i + 1}: final_image_url = "${p.final_image_url || "(empty)"}"`);
      });
    } else {
      const remaining = await Page.countDocuments({
        final_image_url: { $in: ["", null] },
        result_image_url: { $nin: ["", null] },
      });
      log(`\nRemaining: ${remaining} pages`);
    }

    await mongoose.disconnect();
    log("Done");
    process.exit(0);
  } catch (err) {
    console.error("[fix-final-image-url] Failed:", err);
    process.exit(1);
  }
})();
