const mongoose = require("mongoose");

const NOTE_TASK_TYPES = ["background", "shading", "effects", "flat_color", "bubble", "lettering", "other"];

const pageNoteSchema = new mongoose.Schema(
  {
    client_note_id: {
      type: String,
      default: null,
    },
    page_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaPage",
      required: [true, "Page ID is required"],
    },
    x_percent: {
      type: Number,
      required: [true, "x_percent is required"],
      min: [0, "x_percent must be at least 0"],
      max: [100, "x_percent must not exceed 100"],
    },
    y_percent: {
      type: Number,
      required: [true, "y_percent is required"],
      min: [0, "y_percent must be at least 0"],
      max: [100, "y_percent must not exceed 100"],
    },
    width_percent: {
      type: Number,
      required: [true, "width_percent is required"],
      min: [0.1, "width_percent must be at least 0.1"],
      max: [100, "width_percent must not exceed 100"],
    },
    height_percent: {
      type: Number,
      required: [true, "height_percent is required"],
      min: [0.1, "height_percent must be at least 0.1"],
      max: [100, "height_percent must not exceed 100"],
    },
    task_type: {
      type: String,
      enum: {
        values: NOTE_TASK_TYPES,
        message: `task_type must be one of: ${NOTE_TASK_TYPES.join(", ")}`,
      },
      default: "other",
    },
    assignee: {
      type: String,
      default: null,
      maxlength: [100, "Assignee name cannot exceed 100 characters"],
    },
    message: {
      type: String,
      default: "",
      maxlength: [2000, "Message cannot exceed 2000 characters"],
    },
    sort_order: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["pending", "in_progress", "done"],
      default: "pending",
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
        ret.noteId = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

pageNoteSchema.index({ page_id: 1, sort_order: 1 });
pageNoteSchema.index({ page_id: 1, assignee: 1 });

const PageNote = mongoose.model("PageNote", pageNoteSchema);

module.exports = {
  PageNote,
  NOTE_TASK_TYPES,
};
