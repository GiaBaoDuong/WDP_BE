/**
 * Migration: Add avatar_url, bio, and social_links fields to User
 *
 * Run: node scripts/migrate-users-profile-fields.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const User = require("../models/User");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-users-profile] Connected to MongoDB");

    const collection = mongoose.connection.db.collection("users");

    // 1. Set default avatar_url = "" for users missing this field
    const resultAvatar = await collection.updateMany(
      { avatar_url: { $exists: false } },
      { $set: { avatar_url: "" } },
    );
    console.log(`[migrate-users-profile] avatar_url: set default "" for ${resultAvatar.modifiedCount} users`);

    // 2. Set default bio = "" for users missing this field
    const resultBio = await collection.updateMany(
      { bio: { $exists: false } },
      { $set: { bio: "" } },
    );
    console.log(`[migrate-users-profile] bio: set default "" for ${resultBio.modifiedCount} users`);

    // 3. Set default social_links for users missing this field
    const resultSocial = await collection.updateMany(
      { social_links: { $exists: false } },
      {
        $set: {
          social_links: {
            facebook: "",
            twitter: "",
            website: "",
          },
        },
      },
    );
    console.log(`[migrate-users-profile] social_links: set default {} for ${resultSocial.modifiedCount} users`);

    // Sanity check
    const total = await User.countDocuments();
    const withAvatar = await User.countDocuments({ avatar_url: { $exists: true } });
    const withBio = await User.countDocuments({ bio: { $exists: true } });
    const withSocial = await User.countDocuments({ social_links: { $exists: true } });

    console.log("\n[migrate-users-profile] Summary:");
    console.log(`  Total users: ${total}`);
    console.log(`  With avatar_url: ${withAvatar}`);
    console.log(`  With bio: ${withBio}`);
    console.log(`  With social_links: ${withSocial}`);

    await mongoose.disconnect();
    console.log("\n[migrate-users-profile] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-users-profile] Failed:", err);
    process.exit(1);
  }
})();
