const mongoose = require("mongoose");

const PAGE_STATUSES = ["Processing", "Approved"];

const mangaPageSchema = new mongoose.Schema(
  {
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      required: [true, "Chapter ID is required"],
    },
    page_number: {
      type: Number,
      required: [true, "Page number is required"],
      min: [1, "Page number must be at least 1"],
    },
    image_url: {
      type: String,
      default: "",
    },
    width: {
      type: Number,
      default: null,
    },
    height: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: PAGE_STATUSES,
        message: `Status must be one of: ${PAGE_STATUSES.join(", ")}`,
      },
      default: "Processing",
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
        ret.pageId = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

mangaPageSchema.index({ chapter_id: 1, page_number: 1 }, { unique: true });
mangaPageSchema.index({ chapter_id: 1 });

const MangaPage = mongoose.model("MangaPage", mangaPageSchema);

module.exports = {
  MangaPage,
  PAGE_STATUSES,
};
