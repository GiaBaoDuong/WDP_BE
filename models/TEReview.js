const mongoose = require("mongoose");

const TE_CRITERIA = {
  PACING_CONTENT: "pacing_content",               // 1. Nhịp độ & Nội dung
  VISUAL_ART_WRITING: "visual_art_writing",       // 2. Hình ảnh & Nghệ thuật / Phong cách viết
  LAYOUT_STORYBOARD: "layout_storyboard",        // 3. Bố cục & Áp phác
  LOCALIZATION_TECHNICAL: "localization_technical", // 4. Bản địa hoá & Kỹ thuật
};

const TE_CRITERIA_LABELS = {
  [TE_CRITERIA.PACING_CONTENT]:          "Nhịp độ & Nội dung",
  [TE_CRITERIA.VISUAL_ART_WRITING]:     "Hình ảnh & Nghệ thuật / Phong cách viết",
  [TE_CRITERIA.LAYOUT_STORYBOARD]:      "Bố cục & Áp phác",
  [TE_CRITERIA.LOCALIZATION_TECHNICAL]: "Bản địa hoá & Kỹ thuật",
};

const TE_CRITERIA_KEYS = [
  TE_CRITERIA.PACING_CONTENT,
  TE_CRITERIA.VISUAL_ART_WRITING,
  TE_CRITERIA.LAYOUT_STORYBOARD,
  TE_CRITERIA.LOCALIZATION_TECHNICAL,
];

const teAnnotationSchema = new mongoose.Schema(
  {
    page_id: { type: mongoose.Schema.Types.ObjectId, ref: "Page" },
    order: { type: Number, default: 0 },
    region: {
      x: { type: Number, required: true },
      y: { type: Number, required: true },
      width: { type: Number, required: true },
      height: { type: Number, required: true },
    },
    content: { type: String, required: true },
    error_type: {
      type: String,
      enum: ["content", "dialogue", "script", "art", "other"],
      default: "other",
    },
  },
  { _id: true }
);

const teReviewSchema = new mongoose.Schema(
  {
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      required: true,
      unique: true,
    },
    reviewed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    decision: {
      type: String,
      enum: ["draft", "revision", "approved", "rejected", "approved_publish"],
      required: true,
    },
    annotations: [teAnnotationSchema],

    // ── 4 tiêu chí đánh giá 0-5 sao ────────────────────────────────────────
    scores: {
      type: Map,
      of: {
        type: Number,
        min: 0,
        max: 5,
      },
      default: () => new Map(),
    },

    // ── Điểm trung bình (tự tính, không lưu cứng) ────────────────────────────
    // average_score sẽ được tính = tổng 4 tiêu chí / 4 ở response/aggregate

    // ── Ghi chú nhanh ────────────────────────────────────────────────────────
    feedback: { type: String, default: "" },
    revision_feedback: { type: String, default: "" },
    quick_notes: { type: String, default: "" }, // nhận xét nhanh cho mỗi tiêu chí
  },
  { timestamps: true }
);

// Virtual: average_score (tính từ scores map)
teReviewSchema.virtual("average_score").get(function () {
  const scores = this.scores;
  if (!scores || scores.size === 0) return null;
  const vals = Array.from(scores.values()).filter((v) => v !== null && v !== undefined);
  if (vals.length === 0) return null;
  return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
});

teReviewSchema.set("toJSON", { virtuals: true });
teReviewSchema.set("toObject", { virtuals: true });

const TEReview = mongoose.model("TEReview", teReviewSchema);

module.exports = {
  TEReview,
  TE_CRITERIA,
  TE_CRITERIA_LABELS,
  TE_CRITERIA_KEYS,
};
module.exports.TE_CRITERIA = TE_CRITERIA;
module.exports.TE_CRITERIA_LABELS = TE_CRITERIA_LABELS;
module.exports.TE_CRITERIA_KEYS = TE_CRITERIA_KEYS;
