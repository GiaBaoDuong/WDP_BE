/**
 * Migration: Create Bookshelf collection and indexes
 *
 * Bookshelf - truyện mà reader đã lưu vào "tủ sách"
 * Mỗi cặp (reader_id, series_id) là duy nhất -> tránh lưu trùng.
 *
 * Run: node scripts/migrate-bookshelf.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Bookshelf = require("../models/Bookshelf");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-bookshelf] Connected to MongoDB");

    const collectionName = "bookshelves";

    // Create indexes as defined in schema
    const indexes = [
      { key: { reader_id: 1, series_id: 1 }, options: { unique: true, background: true } },
      { key: { reader_id: 1, added_at: -1 }, options: { background: true } },
    ];

    for (const idx of indexes) {
      const existingIndexes = await mongoose.connection.db
        .collection(collectionName)
        .indexes();
      const exists = existingIndexes.some(
        (existing) =>
          JSON.stringify(existing.key) === JSON.stringify(idx.key),
      );

      if (exists) {
        console.log(`[migrate-bookshelf] Index ${JSON.stringify(idx.key)} already exists, skipping`);
      } else {
        await mongoose.connection.db
          .collection(collectionName)
          .createIndex(idx.key, idx.options);
        console.log(`[migrate-bookshelf] Created index ${JSON.stringify(idx.key)}`);
      }
    }

    // Sanity check
    const totalDocs = await Bookshelf.countDocuments();
    const allIndexes = await mongoose.connection.db
      .collection(collectionName)
      .indexes();
    console.log(
      `[migrate-bookshelf] Collection: ${collectionName}, Total docs: ${totalDocs}, Indexes: ${allIndexes.length}`,
    );

    await mongoose.disconnect();
    console.log("[migrate-bookshelf] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-bookshelf] Failed:", err);
    process.exit(1);
  }
})();
