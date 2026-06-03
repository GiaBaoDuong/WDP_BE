const mongoose = require("mongoose");

const seriesDraftFileSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MangaSeries",
      required: [true, "Series ID is required"],
    },
    page_number: {
      type: Number,
      required: [true, "Page number is required"],
      min: [1, "Page number must be at least 1"],
    },
    file_url: {
      type: String,
      required: [true, "File URL is required"],
    },
    original_filename: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: {
      createdAt: "uploaded_at",
      updatedAt: "updated_at",
    },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret.draftId = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

seriesDraftFileSchema.index({ series_id: 1 });
seriesDraftFileSchema.index({ series_id: 1, page_number: 1 });

const SeriesDraftFile = mongoose.model("SeriesDraftFile", seriesDraftFileSchema);

module.exports = SeriesDraftFile;
