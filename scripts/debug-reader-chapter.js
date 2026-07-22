/**
 * Debug: Check chapter và pages của Reader
 *
 * Giúp xác định tại sao Reader không load được chapter.
 *
 * Run: node scripts/debug-reader-chapter.js <chapter_id>
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");

const log = (msg) => console.log(msg);

const chapterId = process.argv[2];
if (!chapterId) {
  console.error("Usage: node scripts/debug-reader-chapter.js <chapter_id>");
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    log("Connected to MongoDB\n");

    // ─── 1. Check Chapter ─────────────────────────────────────────────────
    const chapter = await Chapter.findById(chapterId).lean();
    if (!chapter) {
      log("❌ Chapter not found");
      process.exit(1);
    }

    log("=== CHAPTER ===");
    log(`  _id: ${chapter._id}`);
    log(`  chapter_number: ${chapter.chapter_number}`);
    log(`  title: ${chapter.title}`);
    log(`  status: ${chapter.status}`);
    log(`  is_published: ${chapter.is_published}`);
    log(`  published_at: ${chapter.published_at}`);
    log(`  series_id: ${chapter.series_id}`);

    // ─── 2. Check Series ─────────────────────────────────────────────────
    const series = await Series.findById(chapter.series_id).lean();
    if (!series) {
      log("\n❌ Series not found");
    } else {
      log("\n=== SERIES ===");
      log(`  _id: ${series._id}`);
      log(`  name: ${series.name}`);
      log(`  status: ${series.status}`);
      log(`  is_public: ${series.is_public}`);
      log(`  publication_status: ${series.publication_status}`);
    }

    // ─── 3. Check Pages ─────────────────────────────────────────────────
    const pages = await Page.find({ chapter_id: chapterId }).lean();
    log(`\n=== PAGES (${pages.length} pages) ===`);
    if (pages.length === 0) {
      log("  ⚠️  Không có pages nào cho chapter này!");
    } else {
      pages.forEach((p, i) => {
        log(`  Page ${i + 1}:`);
        log(`    _id: ${p._id}`);
        log(`    page_number: ${p.page_number}`);
        log(`    final_image_url: "${p.final_image_url || ""}"`);
        log(`    result_image_url: "${p.result_image_url || ""}"`);
        log(`    original_image_url: "${p.original_image_url || ""}"`);
      });
    }

    // ─── 4. Simulate Reader access ─────────────────────────────────────
    log("\n=== SIMULATE READER ACCESS ===");

    // Check 1: Chapter is_published
    if (chapter.is_published !== true) {
      log(`❌ FAIL: chapter.is_published = ${chapter.is_published} (cần true)`);
    } else {
      log("✅ PASS: chapter.is_published = true");
    }

    // Check 2: Series is_public
    if (!series) {
      log("❌ FAIL: Series not found");
    } else if (series.is_public !== true) {
      log(`❌ FAIL: series.is_public = ${series.is_public} (cần true)`);
    } else {
      log("✅ PASS: series.is_public = true");
    }

    // Check 3: Series status
    if (!series) {
      log("❌ FAIL: Series not found");
    } else if (series.status !== "published") {
      log(`❌ FAIL: series.status = "${series.status}" (cần "published")`);
    } else {
      log('✅ PASS: series.status = "published"');
    }

    // Check 4: Pages có final_image_url
    const pagesWithImage = pages.filter((p) => p.final_image_url && p.final_image_url.trim() !== "");
    if (pages.length === 0) {
      log("❌ FAIL: Không có pages nào");
    } else if (pagesWithImage.length === 0) {
      log("❌ FAIL: Tất cả pages đều không có final_image_url");
      log("   → FE sẽ không hiển thị ảnh được");
    } else {
      log(`✅ PASS: ${pagesWithImage.length}/${pages.length} pages có final_image_url`);
    }

    // ─── 5. Recommendations ─────────────────────────────────────────────
    log("\n=== RECOMMENDATIONS ===");
    if (chapter.is_published !== true) {
      log("→ Cần set chapter.is_published = true");
    }
    if (series && series.is_public !== true) {
      log("→ Cần set series.is_public = true");
    }
    if (series && series.status !== "published") {
      log('→ Cần set series.status = "published"');
    }
    if (series && !series.publication_status) {
      log('→ Nên set series.publication_status = "ongoing"');
    }
    if (pagesWithImage.length === 0 && pages.length > 0) {
      log("→ Cần snapshot final_image_url cho các pages");
      log("  → Chạy: node scripts/fix-final-image-url.js " + chapterId);
    }

    await mongoose.disconnect();
    log("\nDone");
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
})();
