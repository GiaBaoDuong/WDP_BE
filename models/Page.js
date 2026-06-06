const mongoose = require("mongoose");

const pageSchema = new mongoose.Schema(
  {
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      required: true,
    },
    page_number: { type: Number, required: true },
    original_image_url: { type: String, default: "" },
    result_image_url: { type: String, default: "" },
    status: {
      type: String,
      enum: ["raw", "has_task", "submitted", "approved", "revision"],
      default: "raw",
    },
    uploaded_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

pageSchema.index({ chapter_id: 1, page_number: 1 });
pageSchema.index({ status: 1 });

const Page = mongoose.model("Page", pageSchema);
module.exports = Page;
