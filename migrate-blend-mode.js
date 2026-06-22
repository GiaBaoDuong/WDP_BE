/**
 * Migration: Normalize PageLayer.blend_mode
 *
 * Why: Sharp không hỗ trợ "normal" / "source-over" — chỉ hỗ trợ "over" (hoặc null để dùng mặc định).
 * FE đã fix không gửi "normal" nữa, nhưng data cũ trong DB vẫn còn.
 *
 * Script này chuyển:
 *   - "normal" / "source-over" / ""  → null
 *
 * Run:  node migrate-blend-mode.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PageLayer = require("./models/PageLayer");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-blend-mode] Connected to MongoDB");

    const result = await PageLayer.updateMany(
      { blend_mode: { $in: ["normal", "source-over", ""] } },
      { $set: { blend_mode: null } }
    );

    console.log(`[migrate-blend-mode] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);

    // Sanity check: liệt kê các blend_mode hiện tại
    const distinct = await PageLayer.distinct("blend_mode");
    console.log(`[migrate-blend-mode] Distinct blend_mode after migration:`, distinct);

    await mongoose.disconnect();
    console.log("[migrate-blend-mode] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-blend-mode] Failed:", err);
    process.exit(1);
  }
})();
