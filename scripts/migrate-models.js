/**
 * Script migrate-models.js
 * Chạy: node scripts/migrate-models.js
 *
 * Tạo các collections mới trên MongoDB Atlas:
 * - SeriesStats
 * - FollowAuthor
 * - ReadingHistory
 */

const mongoose = require("mongoose");
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

async function migrate() {
  console.log("🔄 Starting model migration...\n");

  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    const db = mongoose.connection.db;
    const results = [];

    // ═══════════════════════════════════════════════════════════════════
    // 1. SeriesStats
    // ═══════════════════════════════════════════════════════════════════
    console.log("📊 Creating SeriesStats collection...");
    const seriesStatsSchema = new mongoose.Schema(
      {
        series_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Series",
          required: true,
        },
        period_type: {
          type: String,
          enum: ["daily", "weekly", "monthly"],
          required: true,
        },
        period_key: { type: String, required: true },
        views_count: { type: Number, default: 0 },
        votes_count: { type: Number, default: 0 },
        total_score: { type: Number, default: 0 },
        average_score: { type: Number, default: 0 },
      },
      { timestamps: true }
    );

    seriesStatsSchema.index({ series_id: 1, period_type: 1, period_key: 1 }, { unique: true });
    seriesStatsSchema.index({ period_type: 1, period_key: 1, views_count: -1 });
    seriesStatsSchema.index({ period_type: 1, period_key: 1, votes_count: -1 });
    seriesStatsSchema.index({ period_type: 1, period_key: 1, average_score: -1 });

    const SeriesStats = mongoose.model("SeriesStats", seriesStatsSchema);

    // Create indexes
    await db.collection("seriesstats").createIndex(
      { series_id: 1, period_type: 1, period_key: 1 },
      { unique: true, background: true }
    );
    await db.collection("seriesstats").createIndex(
      { period_type: 1, period_key: 1, views_count: -1 },
      { background: true }
    );
    await db.collection("seriesstats").createIndex(
      { period_type: 1, period_key: 1, votes_count: -1 },
      { background: true }
    );
    await db.collection("seriesstats").createIndex(
      { period_type: 1, period_key: 1, average_score: -1 },
      { background: true }
    );

    results.push({ collection: "seriesstats", status: "created", indexes: 4 });
    console.log("   ✅ SeriesStats indexes created\n");

    // ═══════════════════════════════════════════════════════════════════
    // 2. FollowAuthor
    // ═══════════════════════════════════════════════════════════════════
    console.log("👥 Creating FollowAuthor collection...");
    const followAuthorSchema = new mongoose.Schema(
      {
        reader_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        author_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        created_at: { type: Date, default: Date.now },
      },
      { timestamps: true }
    );

    followAuthorSchema.index({ reader_id: 1, author_id: 1 }, { unique: true });
    followAuthorSchema.index({ author_id: 1 });

    const FollowAuthor = mongoose.model("FollowAuthor", followAuthorSchema);

    await db.collection("followauthors").createIndex(
      { reader_id: 1, author_id: 1 },
      { unique: true, background: true }
    );
    await db.collection("followauthors").createIndex(
      { author_id: 1 },
      { background: true }
    );

    results.push({ collection: "followauthors", status: "created", indexes: 2 });
    console.log("   ✅ FollowAuthor indexes created\n");

    // ═══════════════════════════════════════════════════════════════════
    // 3. ReadingHistory
    // ═══════════════════════════════════════════════════════════════════
    console.log("📖 Creating ReadingHistory collection...");
    const readingHistorySchema = new mongoose.Schema(
      {
        reader_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        series_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Series",
          required: true,
        },
        last_read_chapter: { type: Number, default: 0 },
        read_at: { type: Date, default: Date.now },
      },
      { timestamps: true }
    );

    readingHistorySchema.index({ reader_id: 1, series_id: 1 }, { unique: true });
    readingHistorySchema.index({ reader_id: 1, read_at: -1 });

    const ReadingHistory = mongoose.model("ReadingHistory", readingHistorySchema);

    await db.collection("readinghistories").createIndex(
      { reader_id: 1, series_id: 1 },
      { unique: true, background: true }
    );
    await db.collection("readinghistories").createIndex(
      { reader_id: 1, read_at: -1 },
      { background: true }
    );

    results.push({ collection: "readinghistories", status: "created", indexes: 2 });
    console.log("   ✅ ReadingHistory indexes created\n");

    // ═══════════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════════
    console.log("═══════════════════════════════════════════");
    console.log("🎉 Migration completed successfully!");
    console.log("═══════════════════════════════════════════\n");

    console.log("Created collections:");
    results.forEach((r) => {
      console.log(`  • ${r.collection}: ${r.indexes} indexes`);
    });

    console.log("\nCollections are now available in MongoDB Atlas.");
    console.log("App will automatically use them when running.\n");

  } catch (error) {
    console.error("❌ Migration failed:", error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

migrate();
