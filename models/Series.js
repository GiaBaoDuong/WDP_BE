const mongoose = require("mongoose");

const seriesSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Series name is required"],
      trim: true,
      maxlength: 200,
    },
    description: { type: String, default: "" },
    genre: { type: String, default: "" },
    target_audience: { type: String, default: "" },
    synopsis: { type: String, default: "" },
    author_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["draft", "submitted", "approved", "rejected", "published", "cancelled"],
      default: "draft",
    },
    publication_schedule: {
      type: String,
      enum: ["weekly", "monthly", null],
      default: null,
    },
    is_public: { type: Boolean, default: false },
    average_score: { type: Number, default: 0, min: 0, max: 10 },
    total_votes: { type: Number, default: 0 },
    cover_image_url: { type: String, default: "" },
    eb_evaluation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EBEvaluation",
      default: null,
    },
  },
  { timestamps: true }
);

seriesSchema.index({ author_id: 1, status: 1 });
seriesSchema.index({ is_public: 1, status: 1 });
seriesSchema.index({ average_score: -1 });

const Series = mongoose.model("Series", seriesSchema);
module.exports = Series;
