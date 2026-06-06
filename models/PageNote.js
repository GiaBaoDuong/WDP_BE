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
    content: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

pageNoteSchema.index({ page_id: 1, createdAt: -1 });

const PageNote = mongoose.model("PageNote", pageNoteSchema);
module.exports = PageNote;
