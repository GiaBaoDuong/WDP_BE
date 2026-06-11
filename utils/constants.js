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
  REJECTED: "rejected",             // EB từ chối
  PUBLISHED: "published",            // Đã xuất bản công khai
  CANCELLED: "cancelled",            // Bị huỷ
};

// ─── Chapter Status ──────────────────────────────────────────────────────────
const CHAPTER_STATUS = {
  DRAFT: "draft",                    // Đang soạn, Mangaka đang làm
  PENDING_ASSISTANT: "pending_assistant", // Mangaka đang chờ Assistant làm
  PENDING_TE: "pending_TE",          // Đã gửi lên TE
  TE_REVISION: "TE_revision",        // TE yêu cầu chỉnh sửa
  PENDING_EB: "pending_EB",         // TE duyệt, chờ EB
  EB_REVISION: "EB_revision",       // EB yêu cầu chỉnh sửa
  PUBLISHED: "published",            // Đã xuất bản
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
  APPROVED: "approved",
  REVISION: "revision",
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
  TASK_APPROVED: "task_approved",         // Mangaka duyệt việc
  CHAPTER_ASSISTANT_WORK_COMPLETE: "chapter_assistant_work_complete", // Assistant hoàn thành chapter
  CHAPTER_ALL_TASKS_APPROVED: "chapter_all_tasks_approved",         // Tất cả tasks đã duyệt
  CHAPTER_TO_TE: "chapter_to_TE",         // Mangaka gửi chapter cho TE
  CHAPTER_TE_APPROVED: "chapter_TE_approved", // TE duyệt
  CHAPTER_TE_REVISION: "chapter_TE_revision", // TE yêu sửa
  CHAPTER_TO_EB: "chapter_to_EB",         // TE gửi lên EB
  CHAPTER_EB_APPROVED: "chapter_EB_approved", // EB duyệt
  CHAPTER_EB_REVISION: "chapter_EB_revision", // EB yêu sửa
  SERIES_APPROVED: "series_approved",     // Series được xuất bản
  SERIES_CANCELLED: "series_cancelled",   // Series bị huỷ
  RANKING_WARNING: "ranking_warning",     // Series nguy cơ bị huỷ
  VOTES_UPDATED: "votes_updated",         // Dữ liệu vote được cập nhật
  ADMIN_USER_BANNED: "admin_user_banned",       // Admin ban user
  ADMIN_CONTENT_REMOVED: "admin_content_removed", // Admin xoá nội dung
  ADMIN_ROLE_CHANGED: "admin_role_changed",     // Admin đổi vai trò user
};

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
};
