const mongoose = require("mongoose");

const ASSISTANT_TASK_TYPES = ["Background", "Shading", "Effects", "Other"];
const TASK_STATUSES = ["pending_assistant", "Assigned", "Submitted", "Approved", "Rejected"];

const assistantTaskSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaSeries",
      required: [true, "Series ID is required"],
    },
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      required: [true, "Chapter ID is required"],
    },
    page_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaPage",
      required: [true, "Page ID is required"],
    },
    page_index: {
      type: Number,
      default: 0,
    },
    page_image_url: {
      type: String,
      default: "",
    },
    image_width: {
      type: Number,
      default: null,
    },
    image_height: {
      type: Number,
      default: null,
    },
    mangaka_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Mangaka ID is required"],
    },
    notes: [
      {
        client_note_id: { type: String, default: null },
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
        task_type: {
          type: String,
          enum: {
            values: ASSISTANT_TASK_TYPES,
            message: `Task type must be one of: ${ASSISTANT_TASK_TYPES.join(", ")}`,
          },
          default: "Other",
        },
        assignee: { type: String, default: null, maxlength: 100 },
        message: { type: String, default: "", maxlength: 2000 },
        sort_order: { type: Number, default: 0 },
        _tempId: { type: String, default: null },
      },
    ],
    status: {
      type: String,
      enum: {
        values: TASK_STATUSES,
        message: `Status must be one of: ${TASK_STATUSES.join(", ")}`,
      },
      default: "pending_assistant",
    },
  },
  {
    timestamps: {
      createdAt: "sent_at",
      updatedAt: "updated_at",
    },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret.taskId = ret._id;
        delete ret._id;
        delete ret.__v;
        if (ret.notes) {
          ret.notes = ret.notes.map((n) => {
            const { _tempId, ...rest } = n;
            return rest;
          });
        }
        return ret;
      },
    },
  }
);

assistantTaskSchema.index({ series_id: 1 });
assistantTaskSchema.index({ chapter_id: 1 });
assistantTaskSchema.index({ page_id: 1 });
assistantTaskSchema.index({ mangaka_id: 1, status: 1 });
assistantTaskSchema.index({ status: 1 });

const AssistantTask = mongoose.model("AssistantTask", assistantTaskSchema);

module.exports = {
  AssistantTask,
  ASSISTANT_TASK_TYPES,
  TASK_STATUSES,
};
