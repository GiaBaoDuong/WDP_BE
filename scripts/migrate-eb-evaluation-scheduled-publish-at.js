/**
 * Migration: Add scheduled_publish_at field to EBEvaluation
 *
 * Run: node scripts/migrate-eb-evaluation-scheduled-publish-at.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const EBEvaluation = require("../models/EBEvaluation");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-eb-eval] Connected to MongoDB");

    // Check documents without scheduled_publish_at field
    const countMissing = await EBEvaluation.countDocuments({
      scheduled_publish_at: { $exists: false },
    });

    console.log(
      `[migrate-eb-eval] Found ${countMissing} evaluations without scheduled_publish_at field`,
    );

    if (countMissing === 0) {
      // Force update all documents anyway to ensure field exists
      const total = await EBEvaluation.countDocuments();
      console.log(`[migrate-eb-eval] All ${total} evaluations already have scheduled_publish_at`);
      await mongoose.disconnect();
      process.exit(0);
    }

    // Add scheduled_publish_at field with default null to all documents missing it
    const result = await EBEvaluation.updateMany(
      { scheduled_publish_at: { $exists: false } },
      { $set: { scheduled_publish_at: null } },
    );

    console.log(
      `[migrate-eb-eval] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`,
    );

    // Sanity check
    const total = await EBEvaluation.countDocuments();
    const countWithField = await EBEvaluation.countDocuments({
      scheduled_publish_at: { $exists: true },
    });

    console.log(
      `[migrate-eb-eval] Total: ${total}, With field: ${countWithField}`,
    );

    await mongoose.disconnect();
    console.log("[migrate-eb-eval] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-eb-eval] Failed:", err);
    process.exit(1);
  }
})();
