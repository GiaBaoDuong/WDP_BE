const mongoose = require("mongoose");

// ─── 5 tiêu chí chấm điểm EB (mỗi tiêu chí 0–5 step 0.5) ────────────────────
// 1. story_dialogue   : cốt truyện & lời thoại
// 2. art_design       : nét vẽ & tạo hình nhân vật
// 3. panel_camera     : phân khung & góc máy
// 4. pacing_climax    : nhịp độ & cao trào
// 5. color            : đổ màu & phối màu
const ebScoreDetailSchema = new mongoose.Schema(
  {
    story_dialogue: { type: Number, default: 0, min: 0, max: 5 },
    art_design: { type: Number, default: 0, min: 0, max: 5 },
    panel_camera: { type: Number, default: 0, min: 0, max: 5 },
    pacing_climax: { type: Number, default: 0, min: 0, max: 5 },
    color: { type: Number, default: 0, min: 0, max: 5 },
  },
  { _id: false }
);

const ebCriteriaCommentSchema = new mongoose.Schema(
  {
    story_dialogue: { type: String, default: "" },
    art_design: { type: String, default: "" },
    panel_camera: { type: String, default: "" },
    pacing_climax: { type: String, default: "" },
    color: { type: String, default: "" },
  },
  { _id: false }
);

// ─── Extension Score Schema (dynamic criteria beyond the 5 core) ───────────────
// Cho phép lưu scores của extension criteria (character_development, atmosphere, ...)
// Nested trong mỗi member_scores entry
const ebExtensionScoreSchema = new mongoose.Schema(
  {
    key:    { type: String, required: true },
    value:  { type: Number, default: 0, min: 0, max: 5 },
    comment: { type: String, default: "" },
  },
  { _id: false }
);

const ebMemberScoreSchema = new mongoose.Schema({
  // Tên hiển thị của thành viên hội đồng (BẮT BUỘC khi evaluate).
  // Nếu member_id là ObjectId user thật → BE vẫn ưu tiên lưu tên người dùng
  // tại thời điểm chấm (full_name / username) để chống "di sản" khi user đổi tên.
  member_name: { type: String, required: true, trim: true },
  // ObjectId trỏ sang User (nếu thành viên HĐ là user thật trong hệ thống).
  // Null khi thành viên chỉ tồn tại ở roster FE (id local).
  member_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  // ID local do FE tạo khi thêm thành viên HĐ (vd "member-1785044498035-dbj18").
  // Lưu song song với member_id để giữ reference cho FE,
  // đồng thời giúp BE biết đây là user "ngoài hệ thống" (không populate được).
  external_member_id: { type: String, default: null, trim: true },
  // 5 tiêu chí (0–5 step 0.5)
  scores: { type: ebScoreDetailSchema, default: () => ({}) },
  // Extension scores cho criteria mở rộng (character_development, atmosphere, ...)
  extension_scores: { type: [ebExtensionScoreSchema], default: [] },
  // điểm trung bình 5 tiêu chí (0–5)
  average: { type: Number, default: 0, min: 0, max: 5 },
  // nhận xét riêng cho từng tiêu chí
  comments: { type: ebCriteriaCommentSchema, default: () => ({}) },
  // nhận xét tổng thể của thành viên
  overall_comment: { type: String, default: "" },
  total_score: { type: Number, default: 0 },
  notes: { type: String, default: "" },
  saved_at: { type: Date, default: null },
});

const ebEvaluationSchema = new mongoose.Schema(
  {
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
    },
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      default: null,
    },
    evaluated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // ID tài khoản đại diện EB lưu điểm gần nhất (chỉ user có is_eb_representative=true mới có quyền này)
    last_saved_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Thời điểm lưu điểm gần nhất — dùng để tính 24h edit window
    last_saved_at: {
      type: Date,
      default: null,
    },
    // Loại truyện (vd: "Hành động", "Lãng mạn", "Horror"...)
    story_type: { type: String, default: "" },
    // Lưu lại URL ảnh preview từ TE submit để EB xem khi chấm
    preview_images: { type: [String], default: [] },
    // Thành viên hội đồng đang nhập điểm (frontend chọn qua dropdown)
    current_member_name: { type: String, default: "" },
    // Bộ 5 tiêu chí (đang chấm) - dùng tạm trước khi lưu thành member_scores
    draft_scores: { type: ebScoreDetailSchema, default: () => ({}) },
    draft_comments: { type: ebCriteriaCommentSchema, default: () => ({}) },
    draft_overall_comment: { type: String, default: "" },
    // Trạng thái evaluation
    // - "scoring"  : đang trong quá trình chấm
    // - "saved"    : đã lưu, có thể chỉnh
    // - "locked"   : đã khóa, không cho sửa
    status: {
      type: String,
      enum: ["scoring", "saved", "locked"],
      default: "scoring",
    },
    first_review: { type: Boolean, default: false },

    // ─── NEW: Dynamic Rubric Fields ────────────────────────────────────────────

    // ID rubric mà EB chọn tại thời điểm chấm
    // Format: "genre_family|age_rating" e.g. "action-adventure|teens_13+"
    applied_rubric_id: { type: String, default: null },

    // Snapshot trọng số tại thời điểm chấm
    // { story_dialogue: 20, art_design: 20, panel_camera: 20, pacing_climax: 20, color: 20 }
    // Có thể thêm extension keys nếu rubric có extension criteria
    applied_rubric_weights: {
      type: Map,
      of: Number,
      default: () => new Map(),
    },

    // Tổng trọng số (nên = 100)
    applied_rubric_total_weight: { type: Number, default: 100 },

    // ─── NEW: Age Safety Gate ─────────────────────────────────────────────────

    // Kết quả age safety check (PASS/FAIL)
    age_safety: {
      passed:        { type: Boolean, default: true },
      severity:      { type: String,  default: "Không vi phạm" },
      rules_note:    { type: String,  default: "" },
      // Violations chi tiết
      violations: [{
        field:         { type: String, default: "" },
        label:         { type: String, default: "" },
        actual_level:  { type: Number, default: 0 },
        max_allowed:   { type: Number, default: 0 },
        age_rating:    { type: String, default: "" },
        message:       { type: String, default: "" },
      }],
    },

    // Điểm content levels do EB đánh giá (0–3)
    // Dùng cho age safety check trước khi lưu
    content_levels: {
      violence:           { type: Number, default: 0, min: 0, max: 3 },
      fear:              { type: Number, default: 0, min: 0, max: 3 },
      profanity:         { type: Number, default: 0, min: 0, max: 3 },
      nudity:            { type: Number, default: 0, min: 0, max: 3 },
      danger_simulation:  { type: Number, default: 0, min: 0, max: 3 },
    },

    // ─── END NEW FIELDS ───────────────────────────────────────────────────────

    // Danh sách điểm chi tiết từng thành viên hội đồng (mỗi member = 1 lượt chấm)
    // Mỗi member có extension_scores[] cho criteria mở rộng
    member_scores: { type: [ebMemberScoreSchema], default: [] },
    // Duyệt nhanh
    quick_decision: {
      type: String,
      enum: ["approved", "rejected", "revision", null],
      default: null,
    },
    quick_notes: { type: String, default: "" },
    result: {
      type: String,
      enum: ["approved", "rejected", "revision", null],
      default: null,
    },
    publication_schedule: {
      type: String,
      enum: ["weekly", "monthly", null],
      default: null,
    },
    // Ngày giờ EB hẹn xuất bản chapter
    scheduled_publish_at: { type: Date, default: null },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

ebEvaluationSchema.index({ series_id: 1 });
ebEvaluationSchema.index({ chapter_id: 1 });
ebEvaluationSchema.index({ chapter_id: 1, status: 1 });

const EBEvaluation = mongoose.model("EBEvaluation", ebEvaluationSchema);
module.exports = EBEvaluation;
module.exports.ebScoreDetailSchema = ebScoreDetailSchema;
module.exports.ebCriteriaCommentSchema = ebCriteriaCommentSchema;
module.exports.ebMemberScoreSchema = ebMemberScoreSchema;
