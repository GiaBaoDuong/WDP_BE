const mongoose = require("mongoose");

const seriesReviewSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
      unique: true,
    },
    reviewed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ── Nhận xét tổng hợp cho toàn series ───────────────────────────────
    feedback: { type: String, default: "" },
    quick_notes: { type: String, default: "" },

    // ── Decision: draft | revision | approved ───────────────────────────
    decision: {
      type: String,
      enum: ["draft", "revision", "approved"],
      default: "draft",
    },

    // ── Revision feedback gửi cho Mangaka khi decision = revision ────────
    revision_feedback: { type: String, default: "" },
  },
  { timestamps: true }
);

seriesReviewSchema.set("toJSON", { virtuals: true });
seriesReviewSchema.set("toObject", { virtuals: true });

const SeriesReview = mongoose.model("SeriesReview", seriesReviewSchema);

module.exports = {
  SeriesReview,
};
module.exports.SERIES_TE_CRITERIA = null;
module.exports.SERIES_TE_CRITERIA_LABELS = null;
module.exports.SERIES_TE_CRITERIA_KEYS = null;
