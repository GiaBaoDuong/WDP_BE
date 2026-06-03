const mongoose = require("mongoose");

const SERIES_STATUSES = [
  "Draft",
  "Pending_TE",
  "TE_Rejected",
  "Pending_EB",
  "Published_Weekly",
  "Published_Monthly",
  "Dropped",
];

const PUBLISH_SCHEDULES = ["Weekly", "Monthly"];

const mangaSeriesSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
      maxlength: [150, "Title cannot exceed 150 characters"],
    },
    description: {
      type: String,
      default: "",
      maxlength: [5000, "Description cannot exceed 5000 characters"],
    },
    mangaka_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Mangaka ID is required"],
    },
    editor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: SERIES_STATUSES,
        message: `Status must be one of: ${SERIES_STATUSES.join(", ")}`,
      },
      default: "Draft",
    },
    publish_schedule: {
      type: String,
      enum: {
        values: PUBLISH_SCHEDULES,
        message: `Publish schedule must be one of: ${PUBLISH_SCHEDULES.join(", ")}`,
      },
      default: null,
    },
    te_comment: {
      type: String,
      default: null,
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
        ret.seriesId = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

mangaSeriesSchema.index({ mangaka_id: 1, status: 1 });
mangaSeriesSchema.index({ status: 1 });
mangaSeriesSchema.index({ editor_id: 1, status: 1 });

const MangaSeries = mongoose.model("MangaSeries", mangaSeriesSchema);

module.exports = {
  MangaSeries,
  SERIES_STATUSES,
  PUBLISH_SCHEDULES,
};
