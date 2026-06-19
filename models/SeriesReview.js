const mongoose = require("mongoose");

// ─── 4 tiêu chí đánh giá series (TE) ─────────────────────────────────────
const SERIES_TE_CRITERIA = {
  PACING_CONTENT: "pacing_content",
  VISUAL_ART_WRITING: "visual_art_writing",
  LAYOUT_STORYBOARD: "layout_storyboard",
  LOCALIZATION_TECHNICAL: "localization_technical",
};

const SERIES_TE_CRITERIA_LABELS = {
  [SERIES_TE_CRITERIA.PACING_CONTENT]: "Nhịp độ & Nội dung",
  [SERIES_TE_CRITERIA.VISUAL_ART_WRITING]: "Hình ảnh & Nghệ thuật / Phong cách viết",
  [SERIES_TE_CRITERIA.LAYOUT_STORYBOARD]: "Bố cục & Áp phác",
  [SERIES_TE_CRITERIA.LOCALIZATION_TECHNICAL]: "Bản địa hoá & Kỹ thuật",
};

const SERIES_TE_CRITERIA_KEYS = [
  SERIES_TE_CRITERIA.PACING_CONTENT,
  SERIES_TE_CRITERIA.VISUAL_ART_WRITING,
  SERIES_TE_CRITERIA.LAYOUT_STORYBOARD,
  SERIES_TE_CRITERIA.LOCALIZATION_TECHNICAL,
];

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

    // ── 4 tiêu chí đánh giá series 0-5 sao ─────────────────────────────
    scores: {
      type: Map,
      of: {
        type: Number,
        min: 0,
        max: 5,
      },
      default: () => new Map(),
    },

    // ── Điểm trung bình (virtual, không lưu cứng) ────────────────────────
    // average_score = tổng 4 tiêu chí / 4

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

// Virtual: average_score
seriesReviewSchema.virtual("average_score").get(function () {
  if (!this.scores || this.scores.size === 0) return null;
  const vals = Array.from(this.scores.values()).filter(
    (v) => v !== null && v !== undefined
  );
  if (vals.length === 0) return null;
  return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
});

seriesReviewSchema.set("toJSON", { virtuals: true });
seriesReviewSchema.set("toObject", { virtuals: true });

const SeriesReview = mongoose.model("SeriesReview", seriesReviewSchema);

module.exports = {
  SeriesReview,
  SERIES_TE_CRITERIA,
  SERIES_TE_CRITERIA_LABELS,
  SERIES_TE_CRITERIA_KEYS,
};
