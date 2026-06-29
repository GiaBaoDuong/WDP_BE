const mongoose = require("mongoose");

/**
 * Bookshelf - truyện mà reader đã lưu vào "tủ sách"
 * Mỗi cặp (reader_id, series_id) là duy nhất -> tránh lưu trùng.
 */
const bookshelfSchema = new mongoose.Schema(
  {
    reader_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
    },
    added_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// 1 reader chỉ lưu 1 series 1 lần
bookshelfSchema.index({ reader_id: 1, series_id: 1 }, { unique: true });
bookshelfSchema.index({ reader_id: 1, added_at: -1 });

const Bookshelf = mongoose.model("Bookshelf", bookshelfSchema);
module.exports = Bookshelf;