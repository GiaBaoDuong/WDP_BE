/**
 * Migration: Create compound index { type: 1, related_entity_id: 1 } on Notification
 *
 * Index phục vụ:
 * 1. Dedup notification khi series publish (job scheduledPublish check notification
 *    đã gửi cho series chưa — dùng query { type, related_entity_id }).
 * 2. Query dashboard "tất cả notification liên quan entity này" nhanh.
 *
 * Run: node scripts/migrate-notifications-type-entity-index.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Notification = require("../models/Notification");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-notifications-type-entity-index] Connected to MongoDB");

    const indexes = await mongoose.connection.db
      .collection("notifications")
      .indexes();

    const indexName = indexes.find(
      (idx) =>
        idx.key &&
        idx.key.type === 1 &&
        idx.key.related_entity_id === 1,
    );

    if (indexName) {
      console.log(
        `[migrate-notifications-type-entity-index] Index { type: 1, related_entity_id: 1 } already exists (name: "${indexName.name}")`,
      );
    } else {
      await mongoose.connection.db
        .collection("notifications")
        .createIndex({ type: 1, related_entity_id: 1 }, { background: true });
      console.log(
        "[migrate-notifications-type-entity-index] Created index { type: 1, related_entity_id: 1 }",
      );
    }

    // Sanity check
    const allIndexes = await mongoose.connection.db
      .collection("notifications")
      .indexes();
    console.log(
      `[migrate-notifications-type-entity-index] All indexes on notifications:`,
    );
    for (const idx of allIndexes) {
      console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`);
    }

    await mongoose.disconnect();
    console.log("[migrate-notifications-type-entity-index] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-notifications-type-entity-index] Failed:", err);
    process.exit(1);
  }
})();
