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

const ebMemberScoreSchema = new mongoose.Schema({
  member_name: { type: String, required: true },
  member_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  // 5 tiêu chí (0–5 step 0.5)
  scores: { type: ebScoreDetailSchema, default: () => ({}) },
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
    // Danh sách điểm chi tiết từng thành viên hội đồng (mỗi member = 1 lượt chấm)
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
