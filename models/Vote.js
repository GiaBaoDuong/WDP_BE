const mongoose = require("mongoose");

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
    score: { type: Number, required: true, min: 1, max: 10 },
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
