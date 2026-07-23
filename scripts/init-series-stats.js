/**
 * Script khởi tạo SeriesStats từ data hiện có
 * Chạy: node scripts/init-series-stats.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Vote = require("../models/Vote");
const SeriesStats = require("../models/SeriesStats");

async function initSeriesStats() {
  try {
    console.log("[init-series-stats] Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[init-series-stats] Connected");

    // 1. Init tất cả series published
    console.log("\n[1/3] Init stats for published series...");
    const publishedSeries = await Series.find({
      status: "published",
      is_public: true,
    }).lean();

    console.log(`   Found ${publishedSeries.length} published series`);

    // 2. Init với aggregate views từ chapters
    console.log("\n[2/3] Aggregating views from chapters...");
    const viewsBySeries = await Chapter.aggregate([
      {
        $group: {
          _id: "$series_id",
          totalViews: { $sum: "$views_count" },
        },
      },
    ]);

    const viewsMap = {};
    viewsBySeries.forEach((v) => { viewsMap[String(v._id)] = v.totalViews; });

    // 3. Init với votes
    console.log("\n[3/3] Aggregating votes...");
    const votesBySeries = await Vote.aggregate([
      {
        $group: {
          _id: "$series_id",
          totalVotes: { $sum: 1 },
          totalScore: { $sum: "$score" },
        },
      },
    ]);

    const votesMap = {};
    votesBySeries.forEach((v) => {
      votesMap[String(v._id)] = {
        count: v.totalVotes,
        score: v.totalScore,
        avg: v.totalVotes > 0 ? Math.round((v.totalScore / v.totalVotes) * 10) / 10 : 0,
      };
    });

    // 4. Create stats cho tất cả period (daily, weekly, monthly)
    console.log("\n[4/4] Creating stats records...");
    const now = new Date();
    const periodTypes = ["daily", "weekly", "monthly"];

    let created = 0;
    for (const series of publishedSeries) {
      const seriesId = String(series._id);
      const views = viewsMap[seriesId] || 0;
      const voteData = votesMap[seriesId] || { count: 0, score: 0, avg: 0 };

      for (const periodType of periodTypes) {
        const periodKey = SeriesStats.getPeriodKey(periodType, now);

        await SeriesStats.findOneAndUpdate(
          { series_id: series._id, period_type: periodType, period_key: periodKey },
          {
            $setOnInsert: {
              series_id: series._id,
              period_type: periodType,
              period_key: periodKey,
              views_count: views,
              votes_count: voteData.count,
              total_score: voteData.score,
              average_score: voteData.avg,
            },
          },
          { upsert: true }
        );
        created++;
      }

      // Progress log
      if (publishedSeries.indexOf(series) % 10 === 0) {
        console.log(`   Processed ${publishedSeries.indexOf(series) + 1}/${publishedSeries.length}...`);
      }
    }

    console.log(`\n[init-series-stats] Done! Created ${created} stats records for ${publishedSeries.length} series`);

    // Show sample
    const sample = await SeriesStats.findOne({ period_type: "weekly" }).lean();
    if (sample) {
      console.log("\nSample record:", JSON.stringify(sample, null, 2));
    }

    await mongoose.disconnect();
    console.log("\n[init-series-stats] Disconnected");
    process.exit(0);
  } catch (err) {
    console.error("[init-series-stats] Error:", err);
    process.exit(1);
  }
}

initSeriesStats();
