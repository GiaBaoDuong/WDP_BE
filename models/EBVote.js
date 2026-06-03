const mongoose = require("mongoose");

const VOTE_STATUSES = ["Approved", "Rejected"];

const ebVoteSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaSeries",
      required: [true, "Series ID is required"],
    },
    eb_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "EB user ID is required"],
    },
    vote_status: {
      type: String,
      enum: {
        values: VOTE_STATUSES,
        message: `Vote status must be one of: ${VOTE_STATUSES.join(", ")}`,
      },
      required: [true, "Vote status is required"],
    },
    comment: {
      type: String,
      default: "",
      maxlength: [2000, "Comment cannot exceed 2000 characters"],
    },
  },
  {
    timestamps: {
      createdAt: "voted_at",
      updatedAt: "updated_at",
    },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret.voteId = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

ebVoteSchema.index({ series_id: 1, eb_user_id: 1 }, { unique: true });
ebVoteSchema.index({ series_id: 1 });
ebVoteSchema.index({ eb_user_id: 1 });

const EBVote = mongoose.model("EBVote", ebVoteSchema);

module.exports = {
  EBVote,
  VOTE_STATUSES,
};
