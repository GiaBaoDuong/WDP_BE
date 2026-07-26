const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    is_read: { type: Boolean, default: false },
    related_entity_type: {
      type: String,
      enum: [
        "series",
        "chapter",
        "page",
        "task",
        "cooperation_request",
        "cooperation",
        "te_review",
        "eb_evaluation",
        "vote",
        null,
      ],
      default: null,
    },
    related_entity_id: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

notificationSchema.index({ user_id: 1, is_read: 1, createdAt: -1 });

// Index phục vụ dedup notification "new_series_from_author" (và các type
// fan-out khác): truy vấn "đã từng gửi notification type X cho entity Y chưa?"
// được job scheduledPublish gọi mỗi tick. Index này cũng giúp query dashboard
// "tất cả notification liên quan entity này" nhanh.
notificationSchema.index({ type: 1, related_entity_id: 1 });

const Notification = mongoose.model("Notification", notificationSchema);
module.exports = Notification;
