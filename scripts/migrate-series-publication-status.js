/**
 * Migration: Backfill publication_status field cho Series
 *
 * Thêm field publication_status (String, null) cho tất cả Series.
 * Giá trị hợp lệ: "upcoming" | "ongoing" | "hiatus" | "completed" | "dropped" | null
 *
 * Logic:
 * 1. Backfill null cho tất cả Series chưa có field
 * 2. Series đã published (status="published" + is_public=true) → publication_status = "ongoing"
 *
 * Run: node scripts/migrate-series-publication-status.js
 *
 * Idempotent: chạy nhiều lần không sao — chỉ update documents thiếu field.
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Series = require("../models/Series");

const log = (msg) => console.log(`[migrate-series-publication-status] ${msg}`);

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    log("Connected to MongoDB");

    // ─── 1. Backfill null cho Series chưa có field ──────────────────────────
    log("--- Backfill null ---");
    const resultBackfill = await Series.updateMany(
      { publication_status: { $exists: false } },
      { $set: { publication_status: null } }
    );
    log(`publication_status=null: matched=${resultBackfill.matchedCount}, modified=${resultBackfill.modifiedCount}`);

    // ─── 2. Set ongoing cho Series đã published ────────────────────────────
    // Series có status="published" và is_public=true → đang xuất bản
    log("--- Set ongoing cho Series đã published ---");
    const resultOngoing = await Series.updateMany(
      {
        publication_status: { $exists: true, $eq: null },
        status: "published",
        is_public: true,
      },
      { $set: { publication_status: "ongoing" } }
    );
    log(`publication_status="ongoing" (published): matched=${resultOngoing.matchedCount}, modified=${resultOngoing.modifiedCount}`);

    // ─── 3. Set dropped cho Series bị cancelled ─────────────────────────────
    log("--- Set dropped cho Series cancelled ---");
    const resultDropped = await Series.updateMany(
      {
        publication_status: { $exists: true, $eq: null },
        status: "cancelled",
      },
      { $set: { publication_status: "dropped" } }
    );
    log(`publication_status="dropped" (cancelled): matched=${resultDropped.matchedCount}, modified=${resultDropped.modifiedCount}`);

    // ─── 4. Set completed cho Series đã hoàn thành ──────────────────────────
    // Các Series đang published nhưng không còn chapter mới → completed
    // (Logic này có thể tùy chỉnh theo nhu cầu. Tạm thời giữ null.)
    log("--- Done migration ---");

    // ─── 5. Sanity check ───────────────────────────────────────────────────
    log("--- Sanity check ---");
    const total = await Series.countDocuments();
    const withField = await Series.countDocuments({ publication_status: { $exists: true } });
    log(`Total series: ${total}, with publication_status field: ${withField}`);

    // ─── 6. Distribution ───────────────────────────────────────────────────
    log("--- Distribution by publication_status ---");
    const agg = await Series.aggregate([
      { $group: { _id: "$publication_status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    for (const row of agg) {
      log(`  ${row._id === null ? "(null)" : row._id}: ${row.count}`);
    }

    log("--- Distribution by status + publication_status ---");
    const crossAgg = await Series.aggregate([
      {
        $group: {
          _id: { status: "$status", pub: "$publication_status" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.status": 1, "_id.pub": 1 } },
    ]);
    for (const row of crossAgg) {
      log(
        `  status=${row._id.status || "(null)"}, publication_status=${row._id.pub || "(null)"}: ${row.count}`
      );
    }

    await mongoose.disconnect();
    log("Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-series-publication-status] Failed:", err);
    process.exit(1);
  }
})();
