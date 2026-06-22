const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    page_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      required: true,
    },
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      required: true,
    },
    assigned_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    work_type: {
      type: String,
      enum: ["background", "shading", "effects", "details", "other"],
      required: true,
    },
    region: {
      x: { type: Number, required: true },
      y: { type: Number, required: true },
      width: { type: Number, required: true },
      height: { type: Number, required: true },
    },
    description: { type: String, default: "" },
    revision_note: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "in_progress", "submitted", "in_review", "approved", "revision"],
      default: "pending",
    },
    result_image_url: { type: String, default: "" },
    note_ids: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "PageNote",
    }],
  },
  { timestamps: true }
);

taskSchema.index({ assigned_to: 1, status: 1 });
taskSchema.index({ chapter_id: 1, status: 1 });
taskSchema.index({ page_id: 1 });
taskSchema.index({ assigned_by: 1 });

const Task = mongoose.model("Task", taskSchema);
module.exports = Task;
