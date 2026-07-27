/**
 * Series End Request Auto-Cancel Job
 *
 * Chạy mỗi 10 phút:
 *   Tìm các SeriesEndRequest đang ở status = "pending" và đã quá 7 ngày kể từ
 *   khi tạo (createdAt + 7 ngày < now) → tự động set status = "cancelled",
 *   gửi notification cho Mangaka.
 *
 * Start: gọi startAutoCancelJob() trong bin/www
 * Stop:  gọi stopAutoCancelJob() khi server shutdown
 */
const SeriesEndRequest = require("../models/SeriesEndRequest");
const Notification = require("../models/Notification");
const { NOTIF_TYPES } = require("../utils/constants");

// ─── Config ────────────────────────────────────────────────────────────────────
const AUTO_CANCEL_DAYS = 7;
const INTERVAL_MS = 10 * 60 * 1000; // 10 phút

let intervalHandle = null;

function startAutoCancelJob() {
  if (intervalHandle) return; // tránh start 2 lần
  console.log(`[SeriesEndRequest] Auto-cancel job started (every ${INTERVAL_MS / 60000} min, TTL: ${AUTO_CANCEL_DAYS} days)`);
  intervalHandle = setInterval(processAutoCancel, INTERVAL_MS);
  // Chạy ngay lần đầu (không đợi 10 phút)
  processAutoCancel().catch((err) => console.error("[SeriesEndRequest] initial run error:", err.message));
}

function stopAutoCancelJob() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[SeriesEndRequest] Auto-cancel job stopped");
  }
}

async function processAutoCancel() {
  const cutoff = new Date(Date.now() - AUTO_CANCEL_DAYS * 24 * 60 * 60 * 1000);

  try {
    const expired = await SeriesEndRequest.find({
      status: "pending",
      createdAt: { $lt: cutoff },
    }).populate("series_id", "name requested_by");

    if (!expired || expired.length === 0) return;

    console.log(`[SeriesEndRequest] Auto-cancelling ${expired.length} expired request(s)`);

    for (const request of expired) {
      const seriesName = request.series_id?.name || "(đã xóa)";

      // 1. Update status → cancelled
      request.status = "cancelled";
      request.decided_by = null; // system auto-cancelled, không ai duyệt
      request.decided_at = new Date();
      request.admin_note = `Tự động hủy sau ${AUTO_CANCEL_DAYS} ngày không được duyệt.`;
      await request.save();

      // 2. Notify Mangaka
      await Notification.create({
        user_id: request.requested_by,
        type: NOTIF_TYPES.SERIES_END_AUTO_CANCELLED,
        title: "Yêu cầu kết thúc truyện đã tự hủy",
        message: `Yêu cầu kết thúc truyện "${seriesName}" đã tự động bị hủy sau ${AUTO_CANCEL_DAYS} ngày không được duyệt. Bạn có thể gửi lại yêu cầu mới nếu cần.`,
        is_read: false,
        related_entity_type: "series_end_request",
        related_entity_id: request._id,
      });
    }

    console.log(`[SeriesEndRequest] Auto-cancelled ${expired.length} request(s)`);
  } catch (err) {
    console.error("[SeriesEndRequest] Auto-cancel error:", err.message);
  }
}

module.exports = { startAutoCancelJob, stopAutoCancelJob };
