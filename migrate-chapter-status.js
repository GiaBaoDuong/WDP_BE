/**
 * Migration: Normalize Chapter.status
 *
 * Why: BE vừa thêm 2 status mới ("submitted_by_assistant", "review") vào enum của
 *      Chapter model + constants + swagger. Data cũ trong DB không có, nhưng nếu
 *      có documents nào trước đó được set những giá trị không nằm trong enum mới
 *      (ví dụ typo, hoặc giá trị từ flow cũ) thì sẽ bị Mongoose strict validation
 *      reject khi save.
 *
 * Script này:
 *   - Quét tất cả Chapter trong DB
 *   - Lấy về các status hiện tại
 *   - Map lại các giá trị không hợp lệ về status hợp lệ gần nhất
 *   - In báo cáo trước, hỏi confirm (hoặc dry-run) trước khi ghi
 *
 * Mapping mặc định:
 *   - undefined / null / "" / unknown → "draft"
 *   - "in_progress"                    → "pending_assistant"  (flow cũ)
 *   - "submitted"                      → "submitted_by_assistant"  (flow cũ assistant nộp)
 *   - "in_review"                      → "review"
 *   - các giá trị khác ngoài enum hiện tại → "draft" (an toàn nhất)
 *
 * Run:  node migrate-chapter-status.js
 * Run:  node migrate-chapter-status.js --dry-run   (chỉ in báo cáo, không ghi)
 * Run:  node migrate-chapter-status.js --force      (ghi mà không hỏi confirm)
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const Chapter = require("./models/Chapter");
const { CHAPTER_STATUS } = require("./utils/constants");

const VALID_STATUSES = Object.values(CHAPTER_STATUS);

const STATUS_REMAP = {
  "in_progress": CHAPTER_STATUS.PENDING_ASSISTANT,
  "submitted": CHAPTER_STATUS.SUBMITTED_BY_ASSISTANT,
  "in_review": CHAPTER_STATUS.REVIEW,
};

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-chapter-status] Connected to MongoDB");
    console.log(`[migrate-chapter-status] Valid statuses: ${VALID_STATUSES.join(", ")}`);

    const allChapters = await Chapter.find(
      {},
      { _id: 1, status: 1, series_id: 1, chapter_number: 1, title: 1 }
    ).lean();

    console.log(`[migrate-chapter-status] Total chapters scanned: ${allChapters.length}`);

    const breakdown = await Chapter.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    console.log("[migrate-chapter-status] Current status breakdown:");
    breakdown.forEach((b) => console.log(`   - "${b._id}": ${b.count}`));

    const toMigrate = [];
    for (const ch of allChapters) {
      const current = ch.status;
      if (current && VALID_STATUSES.includes(current)) continue;

      let newStatus;
      if (current == null || current === "" || current === undefined) {
        newStatus = CHAPTER_STATUS.DRAFT;
      } else if (STATUS_REMAP[current]) {
        newStatus = STATUS_REMAP[current];
      } else {
        newStatus = CHAPTER_STATUS.DRAFT;
      }
      toMigrate.push({ _id: ch._id, from: current, to: newStatus, ref: ch });
    }

    if (toMigrate.length === 0) {
      console.log("[migrate-chapter-status] No chapters need migration. ✓");
      await mongoose.disconnect();
      process.exit(0);
    }

    console.log(`\n[migrate-chapter-status] Chapters to migrate: ${toMigrate.length}`);
    const byFrom = {};
    toMigrate.forEach((m) => {
      const key = `${m.from ?? "(null)"} → ${m.to}`;
      byFrom[key] = (byFrom[key] || 0) + 1;
    });
    console.log("[migrate-chapter-status] Migration plan:");
    Object.entries(byFrom).forEach(([k, v]) => console.log(`   - ${k}: ${v}`));

    if (dryRun) {
      console.log("\n[migrate-chapter-status] --dry-run mode, no changes written.");
      console.log("[migrate-chapter-status] Sample (first 10):");
      toMigrate.slice(0, 10).forEach((m) => {
        console.log(`   - ${m._id} (series=${m.ref.series_id}, ch#${m.ref.chapter_number}): "${m.from ?? "(null)"}" → "${m.to}"`);
      });
      await mongoose.disconnect();
      process.exit(0);
    }

    if (!force) {
      console.log("\n[migrate-chapter-status] Press Ctrl+C within 5s to abort, or wait to continue...");
      await new Promise((r) => setTimeout(r, 5000));
    }

    let totalModified = 0;
    for (const m of toMigrate) {
      const r = await Chapter.updateOne({ _id: m._id }, { $set: { status: m.to } });
      totalModified += r.modifiedCount || 0;
    }

    console.log(`[migrate-chapter-status] Migration done. Modified: ${totalModified}/${toMigrate.length}`);

    const afterBreakdown = await Chapter.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    console.log("[migrate-chapter-status] Status breakdown AFTER migration:");
    afterBreakdown.forEach((b) => console.log(`   - "${b._id}": ${b.count}`));

    await mongoose.disconnect();
    console.log("[migrate-chapter-status] Done ✓");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-chapter-status] Failed:", err);
    process.exit(1);
  }
})();
