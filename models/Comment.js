const mongoose = require("mongoose");

const commentSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: [true, "Series ID is required"],
    },
    reader_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Reader ID is required"],
    },
    content: {
      type: String,
      required: [true, "Content is required"],
      trim: true,
      maxlength: [500, "Content cannot exceed 500 characters"],
    },
    parent_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Comment",
      default: null,
    },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

commentSchema.index({ series_id: 1, created_at: -1 });
commentSchema.index({ parent_id: 1 });

const Comment = mongoose.model("Comment", commentSchema);
module.exports = Comment;
