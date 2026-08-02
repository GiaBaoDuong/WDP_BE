const mongoose = require("mongoose");

/**
 * PurchasedChapter - Reader đã mua chapter trả phí.
 * `price` is an integer CoinUnit purchase snapshot.
 *
 * Unique (reader_id, chapter_id) để chỉ mua 1 lần duy nhất.
 * `price` là số Coin đã trừ tại thời điểm mua (snapshot).
 */
const purchasedChapterSchema = new mongoose.Schema(
  {
    reader_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      required: true,
      index: true,
    },
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "price must be integer CoinUnit" },
    },
    purchased_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Mỗi reader chỉ mua 1 chapter đúng 1 lần
purchasedChapterSchema.index({ reader_id: 1, chapter_id: 1 }, { unique: true });
purchasedChapterSchema.index({ chapter_id: 1, purchased_at: -1 });

const PurchasedChapter = mongoose.model("PurchasedChapter", purchasedChapterSchema);
module.exports = PurchasedChapter;
