const mongoose = require("mongoose");

/**
 * SeriesEndRequest - Mangaka gửi yêu cầu kết thúc (end) một series.
 *
 * Flow:
 *   1. Mangaka POST /manga/:seriesId/end-request  → status: "pending"
 *   2. Admin nhận notification → duyệt hoặc từ chối
 *   3a. Approved → Series.publication_status = "completed"
 *                      Hủy tất cả Chapter.scheduled_publish_at trong tương lai
 *                      Fan-out notification cho reader subscribers & assistant
 *   3b. Rejected → giữ nguyên series, Mangaka nhận notification
 *   4. Auto-cancel: sau 7 ngày pending mà không ai duyệt → tự hủy (status: "cancelled")
 */
const seriesEndRequestSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
    },
    requested_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: {
      type: String,
      default: "",
      maxlength: 1000,
    },
    planned_final_chapter_number: {
      type: Number,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    decided_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decided_at: {
      type: Date,
      default: null,
    },
    admin_note: {
      type: String,
      default: "",
      maxlength: 1000,
    },
  },
  { timestamps: true }
);

// Mỗi series chỉ có tối đa 1 request đang pending tại một thời điểm
seriesEndRequestSchema.index(
  { series_id: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

// Index phục vụ query theo requested_by (lịch sử yêu cầu của mangaka)
seriesEndRequestSchema.index({ requested_by: 1, status: 1, createdAt: -1 });

const SeriesEndRequest = mongoose.model(
  "SeriesEndRequest",
  seriesEndRequestSchema
);
module.exports = SeriesEndRequest;
