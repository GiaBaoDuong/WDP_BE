const mongoose = require("mongoose");

/**
 * NotificationSubscription - đăng ký nhận thông báo cho MỘT series của reader.
 *
 * Tách bạch với Bookshelf (chỉ là "tủ truyện" lưu lại để đọc) —
 * một user có thể subscribe mà không cần add vào Bookshelf, hoặc ngược lại.
 *
 * Toggle theo từng loại sự kiện (notify_new_chapter, notify_series_update) để
 * có thể mở rộng thêm channel notify khác sau này mà không phá schema.
 */
const notificationSubscriptionSchema = new mongoose.Schema(
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
    notify_new_chapter: { type: Boolean, default: true },
    notify_series_update: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// 1 reader chỉ subscribe 1 series 1 lần
notificationSubscriptionSchema.index(
  { reader_id: 1, series_id: 1 },
  { unique: true }
);

// Query khi broadcast notify cho 1 series (kèm filter notify_new_chapter)
notificationSubscriptionSchema.index({
  series_id: 1,
  notify_new_chapter: 1,
});

module.exports = mongoose.model(
  "NotificationSubscription",
  notificationSubscriptionSchema
);
