const mongoose = require("mongoose");

const ebMemberScoreSchema = new mongoose.Schema({
  member_name: { type: String, required: true },
  content_script: { type: Number, default: 0, min: 0, max: 10 },
  art: { type: Number, default: 0, min: 0, max: 10 },
  characters: { type: Number, default: 0, min: 0, max: 10 },
  commercial_potential: { type: Number, default: 0, min: 0, max: 10 },
  publisher_fit: { type: Number, default: 0, min: 0, max: 10 },
  total_score: { type: Number, default: 0 },
  notes: { type: String, default: "" },
});

const ebEvaluationSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
    },
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      default: null,
    },
    evaluated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    first_review: { type: Boolean, default: false },
    // Lần đầu: chấm điểm chi tiết từng thành viên hội đồng
    member_scores: [ebMemberScoreSchema],
    // Lần sau: duyệt nhanh
    quick_decision: {
      type: String,
      enum: ["approved", "rejected", "revision", null],
      default: null,
    },
    quick_notes: { type: String, default: "" },
    result: {
      type: String,
      enum: ["approved", "rejected", "revision", null],
      default: null,
    },
    publication_schedule: {
      type: String,
      enum: ["weekly", "monthly", null],
      default: null,
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

ebEvaluationSchema.index({ series_id: 1 });
ebEvaluationSchema.index({ chapter_id: 1 });

const EBEvaluation = mongoose.model("EBEvaluation", ebEvaluationSchema);
module.exports = EBEvaluation;
