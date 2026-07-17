const mongoose = require("mongoose");

const SCORE_LABELS = {
  5: "Xuất sắc",
  4: "Hay",
  3: "Bình thường",
  2: "Dở",
  1: "Rất dở",
};

const voteSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
    },
    reader_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    score: { type: Number, required: true, min: 1, max: 5 },
    score_label: {
      type: String,
      enum: Object.values(SCORE_LABELS),
      default: function() {
        return SCORE_LABELS[this.score] || "Bình thường";
      },
    },
    comment: { type: String, default: "" },
    release_period: { type: String, required: true },
  },
  { timestamps: true }
);

voteSchema.index({ series_id: 1, release_period: 1 });
voteSchema.index({ reader_id: 1, series_id: 1 }, { unique: true });
voteSchema.index({ score: -1 });

const Vote = mongoose.model("Vote", voteSchema);
module.exports = Vote;
module.exports.SCORE_LABELS = SCORE_LABELS;
