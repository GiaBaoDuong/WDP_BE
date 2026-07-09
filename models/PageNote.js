const mongoose = require("mongoose");

const pageNoteSchema = new mongoose.Schema(
  {
    page_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      required: true,
    },
    author_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    text: {
      type: String,
      required: true,
    },
    x: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    y: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    w: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    h: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    taskType: {
      type: String,
      enum: ["background", "shading", "fx", "other"],
      default: "other",
    },
    note_kind: {
      type: String,
      enum: ["brief", "revision"],
      default: "brief",
      index: true,
    },
    author_role: {
      type: String,
      enum: ["mangaka", "assistant"],
      default: "mangaka",
    },
    revision_round: {
      type: Number,
      default: 1,
    },
    status: {
      type: String,
      enum: ["active", "used_in_task"],
      default: "active",
    },
  },
  { timestamps: true }
);

pageNoteSchema.index({ page_id: 1, createdAt: -1 });
pageNoteSchema.index({ page_id: 1, note_kind: 1, revision_round: 1 });

const PageNote = mongoose.model("PageNote", pageNoteSchema);
module.exports = PageNote;
