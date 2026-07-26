const mongoose = require("mongoose");

const chapterSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
    },
    chapter_number: { type: Number, required: true },
    title: { type: String, default: "" },
    status: {
      type: String,
      enum: [
        "draft",
        "pending_assistant",
        "submitted_by_assistant",
        "approved_by_mangaka",
        "pending_TE",
        "TE_revision",
        "pending_EB",
        "EB_revision",
        "approved_by_EB",
        "published",
        "review",
        "revision_requested",
      ],
      default: "draft",
    },
    submitted_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    te_review_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TEReview",
      default: null,
    },
    eb_evaluation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EBEvaluation",
      default: null,
    },
    te_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    te_assigned_at: { type: Date, default: null },
    assistant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    revision_notes: { type: String, default: "" },
    revision_round: { type: Number, default: 1 },
    revision_annotations: {
      type: [
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
      ],
      default: [],
    },
    revision_source: {
      type: String,
      enum: ["TE", "EB", "Mangaka", ""],
      default: "",
    },
    is_published: { type: Boolean, default: false },
    published_at: { type: Date, default: null },
    views_count: { type: Number, default: 0 },
    cover_image_url: { type: String, default: "" },
    // Scheduling fields
    scheduled_publish_at: { type: Date, default: null },
    publication_duration_days: {
      type: Number,
      enum: [7, 30],
      default: null,
    },
    publication_schedule: {
      type: String,
      enum: ["weekly", "monthly"],
      default: null,
    },
    is_scheduled: { type: Boolean, default: false },
    revision_history: {
      type: [{
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        note: { type: String, default: "" },
      }],
      default: [],
    },
    deleted_at: { type: Date, default: null },
  },
  { timestamps: true }
);

chapterSchema.index({ series_id: 1, chapter_number: 1 });
chapterSchema.index({ status: 1 });
chapterSchema.index({ submitted_by: 1, status: 1 });
chapterSchema.index({ is_scheduled: 1, scheduled_publish_at: 1 });
chapterSchema.index({ series_id: 1, deleted_at: 1 });

const Chapter = mongoose.model("Chapter", chapterSchema);
module.exports = Chapter;
