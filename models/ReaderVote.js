const mongoose = require("mongoose");

const readerVoteSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaSeries",
      required: [true, "Series ID is required"],
    },
    issue_period: {
      type: String,
      required: [true, "Issue period is required"],
      maxlength: [50, "Issue period cannot exceed 50 characters"],
    },
    vote_count: {
      type: Number,
      required: [true, "Vote count is required"],
      min: [0, "Vote count cannot be negative"],
      default: 0,
    },
    imported_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Imported by user ID is required"],
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret.voteDataId = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

readerVoteSchema.index({ series_id: 1, issue_period: 1 }, { unique: true });
readerVoteSchema.index({ issue_period: 1 });
readerVoteSchema.index({ series_id: 1 });

const ReaderVote = mongoose.model("ReaderVote", readerVoteSchema);

module.exports = ReaderVote;
