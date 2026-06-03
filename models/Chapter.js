const mongoose = require("mongoose");

const CHAPTER_STATUSES = ["In_Progress", "Editor_Review", "Completed"];

const chapterSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaSeries",
      required: [true, "Series ID is required"],
    },
    chapter_number: {
      type: Number,
      required: [true, "Chapter number is required"],
      min: [1, "Chapter number must be at least 1"],
    },
    title: {
      type: String,
      default: "",
      maxlength: [150, "Title cannot exceed 150 characters"],
    },
    deadline: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: CHAPTER_STATUSES,
        message: `Status must be one of: ${CHAPTER_STATUSES.join(", ")}`,
      },
      default: "In_Progress",
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
        ret.chapterId = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

chapterSchema.index({ series_id: 1, chapter_number: 1 }, { unique: true });
chapterSchema.index({ series_id: 1 });

const Chapter = mongoose.model("Chapter", chapterSchema);

module.exports = {
  Chapter,
  CHAPTER_STATUSES,
};
