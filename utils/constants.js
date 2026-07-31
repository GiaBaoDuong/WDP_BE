// ─── Roles ───────────────────────────────────────────────────────────────────
const ROLES = {
  ADMIN: "Admin",
  MANGAKA: "Mangaka",
  ASSISTANT: "Assistant",
  EDITOR: "Editor",       // Tantou Editor
  EB: "EB",               // Editorial Board
  READER: "Reader",
};

// ─── Series Status ──────────────────────────────────────────────────────────
const SERIES_STATUS = {
  DRAFT: "draft",                    // Đang soạn thảo (chỉ Mangaka thấy)
  SUBMITTED: "submitted",            // Đã gửi lên EB
  APPROVED: "approved",              // EB duyệt → đang xuất bản
  APPROVED_BY_EB: "approved_by_EB",  // EB duyệt, chờ publish theo lịch (Job scheduledPublish sẽ set → published)
  REJECTED: "rejected",             // EB từ chối
  PUBLISHED: "published",            // Đã xuất bản công khai
  CANCELLED: "cancelled",            // Bị huỷ
};

// ─── Chapter Status ──────────────────────────────────────────────────────────
const CHAPTER_STATUS = {
  DRAFT: "draft",                    // Đang soạn, Mangaka đang làm
  PENDING_ASSISTANT: "pending_assistant", // Mangaka đang chờ Assistant làm
  SUBMITTED_BY_ASSISTANT: "submitted_by_assistant", // Assistant đã nộp chapter, chờ Mangaka duyệt
  APPROVED_BY_MANGAKA: "approved_by_mangaka", // Mangaka đã duyệt chapter, chờ gửi TE
  PENDING_TE: "pending_TE",          // Đã gửi lên TE
  TE_REVISION: "TE_revision",        // TE yêu cầu chỉnh sửa
  PENDING_EB: "pending_EB",         // TE duyệt, chờ EB
  EB_REVISION: "EB_revision",       // EB yêu cầu chỉnh sửa
  APPROVED_BY_EB: "approved_by_EB", // EB duyệt Series, chờ TE publish
  PUBLISHED: "published",            // Đã xuất bản
  REVIEW: "review",                  // Mangaka đang duyệt
};

// ─── Page Status ─────────────────────────────────────────────────────────────
const PAGE_STATUS = {
  RAW: "raw",                        // Trang gốc chưa xử lý
  HAS_TASK: "has_task",             // Đã giao việc cho Assistant
  SUBMITTED: "submitted",            // Assistant đã nộp ảnh kết quả
  APPROVED: "approved",              // Mangaka duyệt
  REVISION: "revision",              // Mangaka yêu cầu sửa lại
};

// ─── Task / Work Type ────────────────────────────────────────────────────────
const TASK_WORK_TYPES = {
  BACKGROUND: "background",          // Vẽ nền
  SHADING: "shading",                // Tô bóng
  EFFECTS: "effects",                // Hiệu ứng
  DETAILS: "details",                // Chỉnh chi tiết
  OTHER: "other",                    // Khác
};

// ─── Task Status ─────────────────────────────────────────────────────────────
const TASK_STATUS = {
  PENDING: "pending",                // Mới giao, chưa làm
  IN_PROGRESS: "in_progress",       // Đang làm
  SUBMITTED: "submitted",            // Đã nộp kết quả
  APPROVED: "approved",               // Mangaka duyệt
  REVISION: "revision",              // Mangaka yêu sửa
  ARCHIVED: "archived",              // Task cũ đã hoàn thành từ vòng trước (ẩn khỏi submit)
};

// ─── Cooperation Request Status ───────────────────────────────────────────────
const COOP_STATUS = {
  PENDING: "pending",                // Mangaka gửi yêu cầu, chờ Assistant trả lời
  ACCEPTED_MEET: "accepted_meet",    // Assistant đồng ý gặp mặt
  REJECTED: "rejected",              // Assistant từ chối
  MEETING: "meeting",                // Hai bên đang gặp mặt (chờ quyết định)
  ACCEPTED: "accepted",              // Assistant đồng ý hợp tác
  DECLINED: "declined",              // Không hợp tác sau gặp mặt
};

// ─── TE Review Decision ──────────────────────────────────────────────────────
const TE_DECISION = {
  DRAFT: "draft",               // Lưu nháp, chưa quyết định
  REVISION: "revision",          // Yêu cầu chỉnh sửa
  APPROVED: "approved",          // Duyệt, gửi lên EB
  REJECTED: "rejected",          // Từ chối
  APPROVED_PUBLISH: "approved_publish", // Duyệt & xuất bản trực tiếp
};

// ─── EB Evaluation Result ────────────────────────────────────────────────────
const EB_RESULT = {
  APPROVED: "approved",
  REJECTED: "rejected",
  REVISION: "revision",
};

// ─── Publication Schedule ─────────────────────────────────────────────────────
const PUBLICATION_SCHEDULE = {
  WEEKLY: "weekly",
  MONTHLY: "monthly",
};

// ─── Notification Types ───────────────────────────────────────────────────────
const NOTIF_TYPES = {
  COOP_INVITE: "coop_invite",             // Mangaka gửi lời mời hợp tác
  COOP_ACCEPTED_MEET: "coop_accepted_meet", // Assistant đồng ý gặp
  COOP_REJECTED: "coop_rejected",         // Assistant từ chối
  COOP_MEETING: "coop_meeting",           // Cần quyết định sau gặp
  COOP_ACCEPTED: "coop_accepted",         // Hợp tác thành công
  COOP_DECLINED: "coop_declined",         // Không hợp tác
  TASK_ASSIGNED: "task_assigned",         // Mangaka giao việc
  TASK_SUBMITTED: "task_submitted",       // Assistant nộp việc
  TASK_APPROVED: "task_approved",         // Mangaka duyệt việc
  TASK_REVISION: "task_revision",         // Mangaka yêu sửa
  CHAPTER_ASSISTANT_WORK_COMPLETE: "chapter_assistant_work_complete", // Assistant hoàn thành chapter
  CHAPTER_ALL_TASKS_APPROVED: "chapter_all_tasks_approved",         // Tất cả tasks đã duyệt
  CHAPTER_TO_TE: "chapter_to_TE",             // Mangaka gửi chapter cho TE
  CHAPTER_TE_APPROVED: "chapter_TE_approved",    // TE duyệt, gửi lên EB
  CHAPTER_TE_REVISION: "chapter_TE_revision",   // TE yêu cửa chỉnh sửa
  CHAPTER_TE_REJECTED: "chapter_TE_rejected",    // TE từ chối
  CHAPTER_TE_PUBLISHED: "chapter_TE_published", // TE duyệt & xuất bản
  CHAPTER_TO_EB: "chapter_to_EB",         // TE gửi lên EB
  CHAPTER_EB_APPROVED: "chapter_EB_approved", // EB duyệt
  CHAPTER_EB_REVISION: "chapter_EB_revision", // EB yêu sửa
  EB_SCORE_SAVED: "eb_score_saved",       // EB lưu điểm chấm cho chapter
  SERIES_APPROVED: "series_approved",     // Series được xuất bản
  SERIES_TE_REVISION: "series_TE_revision", // Series cần chỉnh sửa theo TE
  SERIES_CANCELLED: "series_cancelled",   // Series bị huỷ
  RANKING_WARNING: "ranking_warning",     // Series nguy cơ bị huỷ
  VOTES_UPDATED: "votes_updated",         // Dữ liệu vote được cập nhật
  CHAPTER_SCHEDULED_PUBLISH: "chapter_scheduled_publish", // Chapter được hẹn giờ xuất bản
  CHAPTER_PUBLISH_CONFIRMED: "chapter_publish_confirmed", // Chapter xuất bản thành công
  ADMIN_USER_BANNED: "admin_user_banned",       // Admin ban user
  ADMIN_CONTENT_REMOVED: "admin_content_removed", // Admin xoá nội dung
  ADMIN_ROLE_CHANGED: "admin_role_changed",     // Admin đổi vai trò user
  // ─── Series End Request ───────────────────────────────────────────────
  SERIES_END_REQUEST_SUBMITTED: "series_end_request_submitted", // Mangaka gửi yêu cầu end truyện → Admin nhận
  SERIES_END_APPROVED: "series_end_approved", // Admin duyệt → Mangaka nhận
  SERIES_END_REJECTED: "series_end_rejected", // Admin từ chối → Mangaka nhận
  SERIES_END_AUTO_CANCELLED: "series_end_auto_cancelled", // Tự hủy sau 7 ngày → Mangaka nhận
  SERIES_END_NOTIFY_READERS: "series_end_notify_readers", // Series đã end → Reader subscribers nhận
  SERIES_END_NOTIFY_ASSISTANT: "series_end_notify_assistant", // Series đã end → Assistant đang hợp tác nhận
};

// ─── EB Scoring ───────────────────────────────────────────────────────────────
// 5 tiêu chí chấm điểm (key dùng trong DB / API)
const EB_CRITERIA = {
  STORY_DIALOGUE: "story_dialogue",   // 1. cốt truyện & lời thoại
  ART_DESIGN: "art_design",           // 2. nét vẽ & tạo hình nhân vật
  PANEL_CAMERA: "panel_camera",       // 3. phân khung & góc máy
  PACING_CLIMAX: "pacing_climax",     // 4. nhịp độ & cao trào
  COLOR: "color",                     // 5. đổ màu & phối màu
};

const EB_CRITERIA_LABELS = {
  story_dialogue: "Cốt truyện & lời thoại",
  art_design: "Nét vẽ & tạo hình nhân vật",
  panel_camera: "Phân khung & góc máy",
  pacing_climax: "Nhịp độ & cao trào",
  color: "Đổ màu & phối màu",
};

const EB_CRITERIA_KEYS = [
  EB_CRITERIA.STORY_DIALOGUE,
  EB_CRITERIA.ART_DESIGN,
  EB_CRITERIA.PANEL_CAMERA,
  EB_CRITERIA.PACING_CLIMAX,
  EB_CRITERIA.COLOR,
];

const EB_SCORE_MIN = 0;
const EB_SCORE_MAX = 5;
const EB_SCORE_STEP = 0.5;

// Phân loại điểm tổng hợp hội đồng (0–5)
//  < 2.5        : không đạt
//  2.5 – < 3.5  : đạt
//  3.5 – < 4.25 : tốt
//  4.25 – 5     : xuất sắc
const EB_RESULT_LABELS = {
  NOT_PASS: "khong_dat",
  PASS: "dat",
  GOOD: "tot",
  EXCELLENT: "xuat_sac",
};

const EB_RESULT_LABEL_TEXT = {
  khong_dat: "Không đạt",
  dat: "Đạt",
  tot: "Tốt",
  xuat_sac: "Xuất sắc",
};

const EB_EVALUATION_STATUS = {
  SCORING: "scoring",
  SAVED: "saved",
  LOCKED: "locked",
};

// Thời gian cho phép chỉnh sửa sau khi lưu (giờ)
const EB_EDIT_WINDOW_HOURS = 24;

// ─── Monetization ─────────────────────────────────────────────────────────────
const CHAPTER_ACCESS_TYPE = {
  FREE: "FREE",
  PAID: "PAID",
};

// Chỉ chapter 1 mặc định FREE (luôn luôn FREE, không thể set PAID).
// Từ chapter 2 trở đi Mangaka tự quyết định, mặc định PAID (phải nhập coin_price).
const FREE_CHAPTER_AUTO_LIMIT = 1;

module.exports = {
  ROLES,
  SERIES_STATUS,
  CHAPTER_STATUS,
  PAGE_STATUS,
  TASK_WORK_TYPES,
  TASK_STATUS,
  COOP_STATUS,
  TE_DECISION,
  EB_RESULT,
  PUBLICATION_SCHEDULE,
  NOTIF_TYPES,
  EB_CRITERIA,
  EB_CRITERIA_LABELS,
  EB_CRITERIA_KEYS,
  EB_SCORE_MIN,
  EB_SCORE_MAX,
  EB_SCORE_STEP,
  EB_RESULT_LABELS,
  EB_RESULT_LABEL_TEXT,
  EB_EVALUATION_STATUS,
  EB_EDIT_WINDOW_HOURS,
  CHAPTER_ACCESS_TYPE,
  FREE_CHAPTER_AUTO_LIMIT,
};
