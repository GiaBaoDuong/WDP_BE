const mongoose = require("mongoose");

/**
 * ReadingHistory - lịch sử đọc truyện của reader.
 * Mỗi cặp (reader_id, series_id) là duy nhất -> lưu 1 lần, cập nhật khi đọc lại.
 * - `last_read_chapter` là số chapter user đang đọc (0 nếu chỉ mở truyện).
 * - `read_at` là thời điểm cuối cùng user mở/đọc truyện (sort theo field này desc).
 */
const readingHistorySchema = new mongoose.Schema(
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
    last_read_chapter: { type: Number, default: 0 },
    read_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// 1 reader chỉ có 1 entry cho mỗi series
readingHistorySchema.index(
  { reader_id: 1, series_id: 1 },
  { unique: true }
);
// Sort theo lịch sử đọc gần nhất
readingHistorySchema.index({ reader_id: 1, read_at: -1 });

const ReadingHistory = mongoose.model("ReadingHistory", readingHistorySchema);
module.exports = ReadingHistory;
