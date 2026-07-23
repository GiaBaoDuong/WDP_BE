const mongoose = require("mongoose");

const seriesStatsSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
    },
    // daily | weekly | monthly
    period_type: {
      type: String,
      enum: ["daily", "weekly", "monthly"],
      required: true,
    },
    // Key format:
    // - daily: "2026-07-23"
    // - weekly: "2026-W29"
    // - monthly: "2026-07"
    period_key: {
      type: String,
      required: true,
    },
    views_count: {
      type: Number,
      default: 0,
    },
    votes_count: {
      type: Number,
      default: 0,
    },
    total_score: {
      type: Number,
      default: 0,
    },
    average_score: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Unique index: mỗi series + period_type + period_key là duy nhất
seriesStatsSchema.index(
  { series_id: 1, period_type: 1, period_key: 1 },
  { unique: true }
);

// Index để query rankings nhanh
seriesStatsSchema.index({ period_type: 1, period_key: 1, views_count: -1 });
seriesStatsSchema.index({ period_type: 1, period_key: 1, votes_count: -1 });
seriesStatsSchema.index({ period_type: 1, period_key: 1, average_score: -1 });

// Virtual for computed average_score
seriesStatsSchema.virtual("computed_average_score").get(function () {
  return this.votes_count > 0
    ? Math.round((this.total_score / this.votes_count) * 10) / 10
    : 0;
});

// Ensure virtuals are included in JSON
seriesStatsSchema.set("toJSON", { virtuals: true });
seriesStatsSchema.set("toObject", { virtuals: true });

// Static: tạo hoặc cập nhật stats
seriesStatsSchema.statics.upsertStats = async function (
  seriesId,
  periodType,
  periodKey,
  updates
) {
  const result = await this.findOneAndUpdate(
    { series_id: seriesId, period_type: periodType, period_key: periodKey },
    {
      $inc: {
        views_count: updates.views_count || 0,
        votes_count: updates.votes_count || 0,
        total_score: updates.total_score || 0,
      },
      $setOnInsert: { series_id: seriesId, period_type: periodType, period_key: periodKey },
    },
    { upsert: true, returnDocument: "after" }
  );

  // Recalculate average_score
  if (result.votes_count > 0) {
    result.average_score = Math.round((result.total_score / result.votes_count) * 10) / 10;
    await result.save();
  }

  return result;
};

// Static: lấy period_key theo type
seriesStatsSchema.statics.getPeriodKey = function (periodType, date = new Date()) {
  const d = new Date(date);
  switch (periodType) {
    case "daily":
      return d.toISOString().split("T")[0];
    case "weekly": {
      // ISO week: W + week number
      const firstDayOfYear = new Date(d.getFullYear(), 0, 1);
      const pastDaysOfYear = (d - firstDayOfYear) / 86400000;
      const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "monthly":
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    default:
      return d.toISOString().split("T")[0];
  }
};

const SeriesStats = mongoose.model("SeriesStats", seriesStatsSchema);

module.exports = SeriesStats;
