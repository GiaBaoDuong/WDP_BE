const mongoose = require("mongoose");

/**
 * SeriesEndRequest - Mangaka gửi yêu cầu kết thúc (end) một series.
 *
 * Flow:
 *   1. Mangaka POST /manga/:seriesId/end-request  → status: "pending"
 *   2. Admin nhận notification → duyệt hoặc từ chối
 *   3a. Approved → chờ planned_final_chapter_number được publish
 *                   Khi chapter này published → Series.publication_status = "completed"
 *                   Fan-out notification cho reader subscribers & assistant
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
      required: [true, "planned_final_chapter_number is required"],
      min: [1, "planned_final_chapter_number must be >= 1"],
      validate: {
        validator: Number.isInteger,
        message: "planned_final_chapter_number must be an integer",
      },
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
