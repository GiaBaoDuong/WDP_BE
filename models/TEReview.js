const mongoose = require("mongoose");

const teAnnotationSchema = new mongoose.Schema(
  {
    page_id: { type: mongoose.Schema.Types.ObjectId, ref: "Page" },
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
      enum: ["approved", "revision"],
      required: true,
    },
    annotations: [teAnnotationSchema],
    feedback: { type: String, default: "" },
    revision_feedback: { type: String, default: "" },
  },
  { timestamps: true }
);

const TEReview = mongoose.model("TEReview", teReviewSchema);
module.exports = TEReview;
