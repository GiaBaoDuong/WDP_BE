const mongoose = require("mongoose");

const FEEDBACK_TYPES = ["error", "suggestion", "praise"];
const FEEDBACK_STATUSES = ["Pending", "Resolved"];

const editorFeedbackSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaSeries",
      required: [true, "Series ID is required"],
    },
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      default: null,
    },
    page_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaPage",
      default: null,
    },
    editor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Editor ID is required"],
    },
    markups: [
      {
        client_markup_id: { type: String, default: null },
        x_percent: {
          type: Number,
          required: true,
          min: 0,
          max: 100,
        },
        y_percent: {
          type: Number,
          required: true,
          min: 0,
          max: 100,
        },
        width_percent: {
          type: Number,
          required: true,
          min: 0.1,
          max: 100,
        },
        height_percent: {
          type: Number,
          required: true,
          min: 0.1,
          max: 100,
        },
        markup_type: {
          type: String,
          enum: {
            values: FEEDBACK_TYPES,
            message: `markup_type must be one of: ${FEEDBACK_TYPES.join(", ")}`,
          },
          default: "error",
        },
        comment: {
          type: String,
          default: "",
          maxlength: [2000, "Comment cannot exceed 2000 characters"],
        },
        _tempId: { type: String, default: null },
      },
    ],
    status: {
      type: String,
      enum: {
        values: FEEDBACK_STATUSES,
        message: `Status must be one of: ${FEEDBACK_STATUSES.join(", ")}`,
      },
      default: "Pending",
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
        ret.feedbackId = ret._id;
        delete ret._id;
        delete ret.__v;
        if (ret.markups) {
          ret.markups = ret.markups.map((m) => {
            const { _tempId, ...rest } = m;
            return rest;
          });
        }
        return ret;
      },
    },
  }
);

editorFeedbackSchema.index({ series_id: 1 });
editorFeedbackSchema.index({ chapter_id: 1 });
editorFeedbackSchema.index({ page_id: 1 });
editorFeedbackSchema.index({ editor_id: 1 });
editorFeedbackSchema.index({ status: 1 });

const EditorFeedback = mongoose.model("EditorFeedback", editorFeedbackSchema);

module.exports = {
  EditorFeedback,
  FEEDBACK_TYPES,
  FEEDBACK_STATUSES,
};
