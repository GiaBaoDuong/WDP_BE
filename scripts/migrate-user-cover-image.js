/**
 * Migration: Add cover_image_url field to User
 *
 * Run: node scripts/migrate-user-cover-image.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const User = require("../models/User");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-user-cover-image] Connected to MongoDB");

    // Backfill: set cover_image_url="" for users missing this field
    const result = await User.updateMany(
      { cover_image_url: { $exists: false } },
      { $set: { cover_image_url: "" } },
    );

    console.log(
      `[migrate-user-cover-image] Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`,
    );

    // Sanity check
    const countWithCover = await User.countDocuments({ cover_image_url: { $exists: true } });
    const totalUsers = await User.countDocuments();
    console.log(
      `[migrate-user-cover-image] Total users: ${totalUsers}, with cover_image_url: ${countWithCover}`,
    );

    await mongoose.disconnect();
    console.log("[migrate-user-cover-image] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-user-cover-image] Failed:", err);
    process.exit(1);
  }
})();
