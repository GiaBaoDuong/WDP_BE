const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireEB, requireMangaka } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const EBEvaluation = require("../models/EBEvaluation");
const Notification = require("../models/Notification");
const Vote = require("../models/Vote");
const {
  notifySeriesApproved,
  notifyRankingWarning,
  notifyChapterEBRevision,
  notifyChapterScheduledPublish,
  notifyChapterPublishConfirmed,
  notifySeriesPublished,
} = require("../services/notificationService");
const {
  EB_CRITERIA_KEYS,
  EB_RESULT_LABELS,
  EB_RESULT_LABEL_TEXT,
  EB_EVALUATION_STATUS,
  NOTIF_TYPES,
  SERIES_STATUS,
  CHAPTER_STATUS,
} = require("../utils/constants");

// ─── Helper: phân loại kết quả theo phổ điểm ────────────────────────────────
const classifyByScore = (councilAvg) => {
  if (councilAvg < 2.5) return EB_RESULT_LABELS.NOT_PASS;
  if (councilAvg < 3.5) return EB_RESULT_LABELS.PASS;
  if (councilAvg < 4.25) return EB_RESULT_LABELS.GOOD;
  return EB_RESULT_LABELS.EXCELLENT;
};

const classifyText = (councilAvg) => {
  const label = classifyByScore(councilAvg);
  return EB_RESULT_LABEL_TEXT[label] || "";
};

// ─── Helper: xác định lịch xuất bản theo phỏng điểm ──────────────────────
const defaultScheduleByScore = (councilAvg) => {
  const classification = classifyByScore(councilAvg);
  if (classification === EB_RESULT_LABELS.PASS) return "monthly";
  if (classification === EB_RESULT_LABELS.GOOD || classification === EB_RESULT_LABELS.EXCELLENT) return "weekly";
  return null;
};

const durationDaysBySchedule = (schedule) => {
  if (schedule === "weekly") return 7;
  if (schedule === "monthly") return 30;
  return null;
};

/**
 * @swaggerap
 * /eb-evaluations/pending:
 *   get:
 *     tags: [EBEvaluations]
 *     summary: Get pending chapters for EB evaluation
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of pending chapters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Chapter'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - EB role required
 */
// ─── GET /eb-evaluations/pending ─────────────────────────────────────────────
// EB xem danh sách SERIES đang chờ duyệt (lấy series có ít nhất 1 chapter ở pending_EB)
// Mỗi series chỉ xuất hiện 1 lần trong danh sách (dù có nhiều chapter pending)
router.get("/pending", authMiddleware, requireEB, async (req, res, next) => {
  try {
    // 1. Tìm tất cả series có chapter đang ở pending_EB
    //    → lấy distinct series_id từ chapters pending_EB
    const pendingChapterSeriesIds = await Chapter.distinct("series_id", {
      status: "pending_EB",
    });

    if (pendingChapterSeriesIds.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    // 2. Lấy thông tin series đầy đủ
    const seriesList = await Series.find({ _id: { $in: pendingChapterSeriesIds } })
      .populate("author_id", "username full_name phoneNumber")
      .lean();

    // 3. Với mỗi series, gắn thông tin EB evaluation mới nhất + chapter đầu tiên (pending_EB)
    const result = await Promise.all(
      seriesList.map(async (s) => {
        // Tìm chapter đầu tiên đang pending_EB (để hiển thị trong danh sách)
        const firstPendingChapter = await Chapter.findOne({
          series_id: s._id,
          status: "pending_EB",
        })
          .sort({ chapter_number: 1 })
          .select("_id chapter_number title updatedAt")
          .lean();

        // Tìm EBEvaluation mới nhất liên quan đến series này
        const ev = await EBEvaluation.findOne({ series_id: s._id })
          .sort({ createdAt: -1 })
          .lean();

        let councilAvg = 0;
        let classification = null;
        let classificationText = "";
        if (ev && ev.member_scores && ev.member_scores.length > 0) {
          const totals = {};
          EB_CRITERIA_KEYS.forEach((k) => {
            totals[k] = ev.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
          });
          const avgTotals = {};
          EB_CRITERIA_KEYS.forEach((k) => {
            avgTotals[k] = Math.round((totals[k] / ev.member_scores.length) * 100) / 100;
          });
          councilAvg =
            Math.round(
              (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
            ) / 100;
          classification = classifyByScore(councilAvg);
          classificationText = classifyText(councilAvg);
        }

        return {
          _id: s._id,
          name: s.name,
          cover_image_url: s.cover_image_url,
          synopsis: s.synopsis,
          genre: s.genre,
          tags: s.tags,
          status: s.status,
          publication_schedule: s.publication_schedule,
          author_id: s.author_id,
          average_score: s.average_score,
          total_votes: s.total_votes,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          // Chapter đầu tiên đang pending_EB
          first_pending_chapter: firstPendingChapter
            ? {
                _id: firstPendingChapter._id,
                chapter_number: firstPendingChapter.chapter_number,
                title: firstPendingChapter.title,
                updatedAt: firstPendingChapter.updatedAt,
              }
            : null,
          // Điểm EB đã có
          council_average: councilAvg,
          classification,
          classification_text: classificationText,
          evaluation_id: ev?._id || null,
          evaluation_status: ev?.status || null,
          evaluation_locked: ev?.status === EB_EVALUATION_STATUS.LOCKED,
        };
      })
    );

    // Sort theo updatedAt của series (cũ nhất lên đầu)
    result.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/my-history:
 *   get:
 *     tags: [EBEvaluations]
 *     summary: Lịch sử chấm điểm của EB hiện tại
 *     description: |
 *       Trả về danh sách series mà EB hiện tại đã từng chấm điểm (qua `member_scores.member_id`),
 *       kèm điểm trung bình hội đồng và điểm của riêng EB này cho từng series.
 *
 *       Mỗi item gồm:
 *       - Thông tin series (name, cover_image_url, status, author, ...)
 *       - Điểm của user EB hiện tại (5 tiêu chí + average + tổng)
 *       - Điểm trung bình cả hội đồng (council_average)
 *       - Số thành viên đã chấm
 *       - Kết quả cuối cùng (approved/rejected/revision) + ngày chấm gần nhất
 *
 *       Query params:
 *       - `page` (default 1), `limit` (default 20)
 *       - `result` (optional): lọc theo kết quả `approved` | `rejected` | `revision`
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: result
 *         schema:
 *           type: string
 *           enum: [approved, rejected, revision]
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           series: { $ref: '#/components/schemas/Series' }
 *                           evaluation_id: { type: string }
 *                           chapter_id: { type: string }
 *                           my_score:
 *                             type: object
 *                             properties:
 *                               scores:
 *                                 type: object
 *                                 description: 5 tiêu chí điểm của EB hiện tại
 *                               average: { type: number }
 *                               total_score: { type: number }
 *                               overall_comment: { type: string }
 *                               saved_at: { type: string, format: date-time }
 *                               member_name: { type: string }
 *                           council_average: { type: number }
 *                           member_count: { type: integer }
 *                           result: { type: string, enum: [approved, rejected, revision, null] }
 *                           evaluated_at: { type: string, format: date-time }
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     has_more: { type: boolean }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - EB role required
 */
// ─── GET /eb-evaluations/my-history ──────────────────────────────────────────
// Trả về lịch sử series mà EB hiện tại đã chấm + điểm của riêng họ + điểm hội đồng
router.get("/my-history", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const userId = req.user.nameid;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const { result } = req.query;

    // Filter theo result nếu có
    const evalFilter = {};
    if (result && ["approved", "rejected", "revision"].includes(result)) {
      evalFilter.result = result;
    }

    // Tìm tất cả EBEvaluation có chứa lượt chấm của user hiện tại
    const evaluations = await EBEvaluation.find({
      ...evalFilter,
      "member_scores.member_id": userId,
    })
      .populate("series_id", "name cover_image_url status publication_schedule genre synopsis author_id tags")
      .populate("series_id.author_id", "username full_name phoneNumber")
      .sort({ updatedAt: -1 })
      .lean();

    // Tính tổng trước khi paginate
    const total = evaluations.length;

    const items = evaluations.slice(skip, skip + limit).map((ev) => {
      // Tìm lượt chấm của user hiện tại trong member_scores
      const myMemberScore =
        (ev.member_scores || []).find(
          (m) => m.member_id && String(m.member_id) === String(userId)
        ) || null;

      // Tính điểm trung bình hội đồng
      let councilAvg = 0;
      if (ev.member_scores && ev.member_scores.length > 0) {
        const totals = {};
        EB_CRITERIA_KEYS.forEach((k) => {
          totals[k] = ev.member_scores.reduce(
            (acc, m) => acc + (m.scores?.[k] || 0),
            0
          );
        });
        const avgTotals = {};
        EB_CRITERIA_KEYS.forEach((k) => {
          avgTotals[k] =
            Math.round((totals[k] / ev.member_scores.length) * 100) / 100;
        });
        councilAvg =
          Math.round(
            (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) /
              EB_CRITERIA_KEYS.length) * 100
          ) / 100;
      }

      return {
        series: ev.series_id,
        evaluation_id: ev._id,
        chapter_id: ev.chapter_id || null,
        story_type: ev.story_type || "",
        my_score: myMemberScore
          ? {
              member_name: myMemberScore.member_name || "",
              scores: myMemberScore.scores || {},
              average: myMemberScore.average || 0,
              total_score: myMemberScore.total_score || 0,
              overall_comment: myMemberScore.overall_comment || "",
              comments: myMemberScore.comments || {},
              saved_at: myMemberScore.saved_at || null,
            }
          : null,
        council_average: councilAvg,
        classification: classifyByScore(councilAvg),
        classification_text: classifyText(councilAvg),
        member_count: ev.member_scores ? ev.member_scores.length : 0,
        result: ev.result || null,
        quick_decision: ev.quick_decision || null,
        evaluated_at: ev.last_saved_at || ev.updatedAt,
        evaluation_status: ev.status,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        items,
        page,
        limit,
        total,
        has_more: skip + items.length < total,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/series/{seriesId}/detail:
 *   get:
 *     tags: [EBEvaluations]
 *     summary: Chi tiết series + chapter 1 để EB xem trước khi chấm
 *     description: |
 *       Khi EB click vào 1 series trong danh sách `/eb-evaluations/pending`,
 *       endpoint này trả về:
 *
 *       - **series**: thông tin đầy đủ của series (name, cover_image_url, description, genre, tags,
 *         synopsis, author, publication_schedule, status, average_score, total_votes, ...)
 *       - **first_chapter**: chapter 1 (chapter_number nhỏ nhất) của series kèm:
 *         - Tất cả pages (page_number, image_url, status)
 *         - preview_images URL để EB xem trước
 *       - **evaluation**: EBEvaluation hiện tại của series (nếu có) kèm:
 *         - member_scores của cả hội đồng
 *         - draft_scores/draft_comments nếu EB này đang nhập dở
 *         - result, quick_decision, council_average
 *
 *       Dùng để EB quyết định trước khi chấm điểm series (xem cover, đọc mô tả, xem chapter 1).
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: OK
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     series: { $ref: '#/components/schemas/Series' }
 *                     first_chapter:
 *                       type: object
 *                       nullable: true
 *                       description: chapter 1 của series (preview)
 *                       properties:
 *                         _id: { type: string }
 *                         chapter_number: { type: number }
 *                         title: { type: string }
 *                         status: { type: string }
 *                         pages:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               _id: { type: string }
 *                               page_number: { type: number }
 *                               image_url: { type: string }
 *                               status: { type: string }
 *                     pending_chapters:
 *                       type: array
 *                       description: Tất cả chapter đang pending_EB của series này
 *                     evaluation:
 *                       type: object
 *                       nullable: true
 *                       description: EBEvaluation hiện tại của series
 *       404:
 *         description: Series not found
 */
// ─── GET /eb-evaluations/series/:seriesId/detail ────────────────────────────
// EB click vào 1 series trong danh sách /pending → trả về đầy đủ series + chapter 1 để preview
router.get("/series/:seriesId/detail", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const Page = require("../models/Page");
    const { seriesId } = req.params;

    // 1. Lấy series đầy đủ thông tin
    const series = await Series.findById(seriesId)
      .populate("author_id", "username full_name phoneNumber avatar_url")
      .lean();
    if (!series) return next(new AppError("Series not found", 404));

    // 2. Tìm chapter 1 (chapter_number nhỏ nhất) của series để EB preview
    const firstChapter = await Chapter.findOne({ series_id: series._id })
      .sort({ chapter_number: 1 })
      .select("_id chapter_number title status")
      .lean();

    let firstChapterWithPages = null;
    if (firstChapter) {
      const pages = await Page.find({ chapter_id: firstChapter._id })
        .select("_id page_number original_image_url result_image_url final_image_url status")
        .sort({ page_number: 1 })
        .lean();
      firstChapterWithPages = {
        _id: firstChapter._id,
        chapter_number: firstChapter.chapter_number,
        title: firstChapter.title,
        status: firstChapter.status,
        pages: (pages || []).map((p) => ({
          _id: p._id,
          page_number: p.page_number,
          image_url: p.final_image_url || p.result_image_url || p.original_image_url || "",
          status: p.status,
        })),
      };
    }

    // 3. Lấy tất cả chapter đang pending_EB của series này
    const pendingChapters = await Chapter.find({
      series_id: series._id,
      status: "pending_EB",
    })
      .sort({ chapter_number: 1 })
      .lean();

    // 4. Lấy EBEvaluation hiện tại của series
    const evaluation = await EBEvaluation.findOne({ series_id: seriesId })
      .populate("evaluated_by", "username full_name phoneNumber")
      .sort({ createdAt: -1 })
      .lean();

    // Tính council_average + gắn my_member_score cho EB hiện tại
    let enrichedEvaluation = null;
    if (evaluation) {
      let councilAvg = 0;
      if (evaluation.member_scores && evaluation.member_scores.length > 0) {
        const totals = {};
        EB_CRITERIA_KEYS.forEach((k) => {
          totals[k] = evaluation.member_scores.reduce(
            (acc, m) => acc + (m.scores?.[k] || 0),
            0
          );
        });
        const avgTotals = {};
        EB_CRITERIA_KEYS.forEach((k) => {
          avgTotals[k] =
            Math.round((totals[k] / evaluation.member_scores.length) * 100) / 100;
        });
        councilAvg =
          Math.round(
            (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) /
              EB_CRITERIA_KEYS.length) * 100
          ) / 100;
      }

      const userId = req.user.nameid;
      const myMemberScore = (evaluation.member_scores || []).find(
        (m) => m.member_id && String(m.member_id) === String(userId)
      ) || null;

      enrichedEvaluation = {
        _id: evaluation._id,
        series_id: evaluation.series_id,
        chapter_id: evaluation.chapter_id,
        evaluated_by: evaluation.evaluated_by,
        last_saved_by: evaluation.last_saved_by,
        last_saved_at: evaluation.last_saved_at,
        story_type: evaluation.story_type,
        preview_images: evaluation.preview_images || [],
        current_member_name: evaluation.current_member_name,
        draft_scores: evaluation.draft_scores || {},
        draft_comments: evaluation.draft_comments || {},
        draft_overall_comment: evaluation.draft_overall_comment || "",
        status: evaluation.status,
        first_review: evaluation.first_review,
        member_scores: evaluation.member_scores || [],
        quick_decision: evaluation.quick_decision,
        quick_notes: evaluation.quick_notes,
        result: evaluation.result,
        publication_schedule: evaluation.publication_schedule,
        scheduled_publish_at: evaluation.scheduled_publish_at,
        notes: evaluation.notes,
        council_average: councilAvg,
        classification: classifyByScore(councilAvg),
        classification_text: classifyText(councilAvg),
        my_member_score: myMemberScore,
        can_edit: evaluation.status !== EB_EVALUATION_STATUS.LOCKED,
        created_at: evaluation.createdAt,
        updated_at: evaluation.updatedAt,
      };
    }

    return res.status(200).json({
      success: true,
      data: {
        series,
        first_chapter: firstChapterWithPages,
        pending_chapters: pendingChapters.map((ch) => ({
          _id: ch._id,
          chapter_number: ch.chapter_number,
          title: ch.title,
          status: ch.status,
          submitted_by: ch.submitted_by,
          createdAt: ch.createdAt,
          updatedAt: ch.updatedAt,
        })),
        evaluation: enrichedEvaluation,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/series/{seriesId}/evaluate:
 *   post:
 *     tags: [EBEvaluations]
 *     summary: EB evaluates a series (Series-level, only once)
 *     description: |
 *       EB chấm điểm Series 1 lần duy nhất. Chapter chỉ là nội dung EB đọc để đưa ra quyết định cho Series.
 *       - Lần đầu: truyền `member_scores` + `result` (approved/revision/rejected) → tạo EBEvaluation với `council_average`
 *       - Lần sau: truyền `quick_decision` + `quick_notes` → cập nhật nhanh
 *       - Nếu `result = approved` và `council_average >= 2.5` → series.status chuyển "approved"
 *       - Nếu `result = rejected` → series.status chuyển "rejected"
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               member_scores:
 *                 type: array
 *                 description: Bắt buộc cho lần đầu. Mảng điểm từ các thành viên hội đồng
 *                 items:
 *                   type: object
 *                   properties:
 *                     member_id:
 *                       type: string
 *                       description: ID thành viên EB (optional)
 *                     scores:
 *                       type: object
 *                       properties:
 *                         content_script:
 *                           type: number
 *                         art:
 *                           type: number
 *                         characters:
 *                           type: number
 *                         commercial_potential:
 *                           type: number
 *                         publisher_fit:
 *                           type: number
 *               result:
 *                 type: string
 *                 enum: [approved, revision, rejected]
 *                 description: Kết quả chấm (bắt buộc lần đầu)
 *               publication_schedule:
 *                 type: string
 *                 enum: [weekly, monthly]
 *                 description: Tần suất xuất bản (cho lần đầu approved)
 *               notes:
 *                 type: string
 *                 description: Ghi chú tổng hợp
 *               quick_decision:
 *                 type: string
 *                 enum: [approved, revision, rejected]
 *                 description: Quyết định nhanh (lần sau)
 *               quick_notes:
 *                 type: string
 *                 description: Ghi chú nhanh (lần sau)
 *               scheduled_publish_at:
 *                 type: string
 *                 format: date-time
 *                 description: Ngày giờ cụ thể để chapter đầu tiên publish (optional)
 *     responses:
 *       201:
 *         description: Evaluation submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     series:
 *                       $ref: '#/components/schemas/Series'
 *                     evaluation:
 *                       $ref: '#/components/schemas/EBEvaluation'
 *       400:
 *         description: Validation error (member_scores required for first review, etc.)
 *       404:
 *         description: Series not found
 */
// ─── POST /eb-evaluations/series/:seriesId/evaluate ─────────────────────────
// EB đánh giá series (lần đầu: chấm điểm chi tiết; lần sau: duyệt nhanh)
// Body: { member_scores: [...], result, publication_schedule, notes }
// Hoặc: { quick_decision, quick_notes, result }
router.post("/series/:seriesId/evaluate", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { member_scores, result, publication_schedule, notes, quick_decision, quick_notes, scheduled_publish_at } = req.body;

    const series = await Series.findOne({ _id: req.params.seriesId });
    if (!series) return next(new AppError("Series not found", 404));

    // Kiểm tra lần đầu hay lần sau
    const isFirstReview = series.status === "draft" || series.status === "submitted";

    let evaluation;
    if (isFirstReview) {
      // Lần đầu: bắt buộc có member_scores
      if (!member_scores || !Array.isArray(member_scores) || member_scores.length === 0) {
        return next(new AppError("member_scores is required for first review", 400));
      }
      if (!result) return next(new AppError("result is required", 400));

      // Nếu approve → BẮT BUỘC chọn publication_schedule (weekly/monthly) trước
      if (result === "approved") {
        if (!publication_schedule || !["weekly", "monthly"].includes(publication_schedule)) {
          return next(
            new AppError(
              "publication_schedule (weekly/monthly) là bắt buộc khi result = 'approved'",
              400
            )
          );
        }
      }

      // Tính council_average từ member_scores
      const totals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        totals[k] = member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
      });
      const avgTotals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        avgTotals[k] = member_scores.length > 0
          ? Math.round((totals[k] / member_scores.length) * 100) / 100
          : 0;
      });
      const councilAvg =
        Math.round(
          (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
        ) / 100;
      const classification = classifyByScore(councilAvg);

      evaluation = await EBEvaluation.create({
        series_id: series._id,
        evaluated_by: req.user.nameid,
        first_review: true,
        member_scores: member_scores.map((m) => ({
          ...m,
          total_score:
            (m.content_script || 0) +
            (m.art || 0) +
            (m.characters || 0) +
            (m.commercial_potential || 0) +
            (m.publisher_fit || 0),
        })),
        result,
        publication_schedule: result === "approved" ? publication_schedule : null,
        scheduled_publish_at: scheduled_publish_at || null,
        notes: notes || "",
      });

      // Cập nhật series
      series.status = result;
      series.eb_evaluation_id = evaluation._id;
      if (result === "approved") {
        series.is_public = true;
        series.publication_schedule = publication_schedule;
      }
      await series.save();
    } else {
      // Lần sau: duyệt nhanh
      if (!quick_decision) return next(new AppError("quick_decision is required", 400));

      // Nếu quick_decision = approved → BẮT BUỘC chọn publication_schedule
      if (quick_decision === "approved") {
        if (!publication_schedule || !["weekly", "monthly"].includes(publication_schedule)) {
          return next(
            new AppError(
              "publication_schedule (weekly/monthly) là bắt buộc khi quick_decision = 'approved'",
              400
            )
          );
        }
      }

      evaluation = await EBEvaluation.create({
        series_id: series._id,
        evaluated_by: req.user.nameid,
        first_review: false,
        quick_decision,
        quick_notes: quick_notes || "",
        result: quick_decision,
        publication_schedule: quick_decision === "approved" ? publication_schedule : null,
        scheduled_publish_at: scheduled_publish_at || null,
        notes: notes || "",
      });

      series.status = quick_decision;
      series.eb_evaluation_id = evaluation._id;
      if (quick_decision === "approved") {
        series.is_public = true;
        series.publication_schedule = publication_schedule;
      }
      await series.save();
    }

    // Notify Mangaka
    if (result === "approved" || quick_decision === "approved") {
      await notifySeriesApproved(
        Notification,
        series.author_id,
        series.name,
        publication_schedule || "weekly"
      );
    }

    return res.status(201).json({ success: true, data: { series, evaluation } });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/chapter/{chapterId}/evaluate:
 *   post:
 *     tags: [EBEvaluations]
 *     summary: EB evaluates a chapter
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               member_scores:
 *                 type: array
 *                 items:
 *                   type: object
 *               result:
 *                 type: string
 *                 enum: [approved, revision, rejected]
 *               notes:
 *                 type: string
 *               quick_decision:
 *                 type: string
 *                 enum: [approved, revision, rejected]
 *               quick_notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Chapter evaluation submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     chapter:
 *                       $ref: '#/components/schemas/Chapter'
 *                     evaluation:
 *                       $ref: '#/components/schemas/EBEvaluation'
 *       404:
 *         description: Chapter not found or not pending EB
 */
// ─── POST /eb-evaluations/chapter/:chapterId/evaluate ─────────────────────────
// EB đánh giá chapter với logic:
// - < 2.5 → Không duyệt (EB_revision), ẩn nút xuất bản
// - 2.5 – < 3.5 → Duyệt, xuất bản theo tháng (30 ngày)
// - 3.5 – < 4.25 → Duyệt, xuất bản theo tuần (7 ngày)
// - 4.25 – 5     → Duyệt, xuất bản theo tuần (7 ngày)
// Body: { result: "approved"|"rejected"|"revision", scheduled_publish_at?, notes? }
//       hoặc { quick_decision, quick_notes?, scheduled_publish_at? }
// ─── POST /eb-evaluations/chapter/:chapterId/evaluate ──────────────────────
// EB chấm điểm Series (dùng chapter làm context để lấy series)
// CHỈ lưu EBEvaluation, KHÔNG đổi chapter/series status
router.post("/chapter/:chapterId/evaluate", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { result, notes, quick_decision, quick_notes, scheduled_publish_at } = req.body;

    const chapter = await Chapter.findOne({ _id: req.params.chapterId, status: "pending_EB" });
    if (!chapter) return next(new AppError("Chapter not found or not pending EB", 404));

    const series = await Series.findById(chapter.series_id).lean();
    if (!series) return next(new AppError("Series not found", 404));

    // Tính điểm từ member_scores (nếu có)
    let councilAvg = 0;
    const isFirstReview = series.status === "draft" || series.status === "submitted";
    
    if (isFirstReview && req.body.member_scores) {
      const totals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        totals[k] = req.body.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
      });
      const avgTotals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        avgTotals[k] = req.body.member_scores.length > 0
          ? Math.round((totals[k] / req.body.member_scores.length) * 100) / 100
          : 0;
      });
      councilAvg =
        Math.round(
          (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
        ) / 100;
    } else {
      // Lấy điểm từ evaluation gần nhất
      const latestEval = await EBEvaluation.findOne({ series_id: series._id })
        .sort({ createdAt: -1 })
        .lean();
      if (latestEval && latestEval.member_scores && latestEval.member_scores.length > 0) {
        const totals = {};
        EB_CRITERIA_KEYS.forEach((k) => {
          totals[k] = latestEval.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
        });
        const avgTotals = {};
        EB_CRITERIA_KEYS.forEach((k) => {
          avgTotals[k] = Math.round((totals[k] / latestEval.member_scores.length) * 100) / 100;
        });
        councilAvg =
          Math.round(
            (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
          ) / 100;
      }
    }

    const classification = classifyByScore(councilAvg);
    const classificationText = classifyText(councilAvg);
    const finalResult = result || quick_decision || null;

    // Transform member_scores từ format FE sang format model
    let transformedMemberScores = [];
    if (req.body.member_scores && Array.isArray(req.body.member_scores)) {
      transformedMemberScores = req.body.member_scores.map((m) => {
        // Tính total_score từ 5 tiêu chí nếu có scores
        let totalScore = m.total_score || 0;
        if (m.scores && Object.keys(m.scores).length > 0 && totalScore === 0) {
          totalScore = EB_CRITERIA_KEYS.reduce((acc, k) => acc + (m.scores[k] || 0), 0);
        }
        return {
          member_name: m.member_name || m.member_id || "Member",
          member_id: null, // FE gửi string, không phải ObjectId
          scores: m.scores || {},
          comments: m.comments || {},
          overall_comment: m.overall_comment || "",
          total_score: totalScore,
          notes: m.notes || "",
        };
      });
    }

    // Lưu evaluation mới - CHỈ lưu điểm, không đổi status
    const newEvaluation = await EBEvaluation.create({
      series_id: chapter.series_id,
      chapter_id: chapter._id,
      evaluated_by: req.user.nameid,
      first_review: isFirstReview,
      member_scores: transformedMemberScores,
      quick_decision: quick_decision || null,
      quick_notes: quick_notes || "",
      result: finalResult,
      scheduled_publish_at: scheduled_publish_at || null,
      notes: notes || "",
      status: EB_EVALUATION_STATUS.LOCKED,
    });

    return res.status(201).json({
      success: true,
      data: {
        evaluation: newEvaluation,
        classification,
        classification_text: classificationText,
        council_average: councilAvg,
        message: councilAvg >= 2.5 || finalResult === "approved" 
          ? "Điểm đã được lưu. Series đủ điều kiện xuất bản." 
          : "Điểm thấp hơn 2.5. Series chưa đủ điều kiện xuất bản.",
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/series/{seriesId}:
 *   get:
 *     tags: [EBEvaluations]
 *     summary: Get evaluation history for a series
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     responses:
 *       200:
 *         description: Evaluation history
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/EBEvaluation'
 */
// ─── GET /eb-evaluations/series/:seriesId ─────────────────────────────────────
// Xem lịch sử đánh giá của 1 series
router.get("/series/:seriesId", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const evaluations = await EBEvaluation.find({ series_id: req.params.seriesId })
      .populate("evaluated_by", "username full_name phoneNumber")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: evaluations });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/series/{seriesId}/decision:
 *   patch:
 *     tags: [EBEvaluations]
 *     summary: EB makes decision on an approved series
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - decision
 *             properties:
 *               decision:
 *                 type: string
 *                 enum: [continue, cancelled, change_schedule]
 *               schedule:
 *                 type: string
 *                 description: Required when decision is change_schedule
 *     responses:
 *       200:
 *         description: Decision updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Series'
 *       400:
 *         description: decision is required
 *       404:
 *         description: Series not found or not approved
 */
// ─── PATCH /eb-evaluations/series/:seriesId/decision ─────────────────────────
// EB ra quyết định với series đang xuất bản
// Body: { decision: "continue"|"cancelled"|"change_schedule", schedule }
router.patch("/series/:seriesId/decision", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { decision, schedule } = req.body;
    if (!decision) return next(new AppError("decision is required", 400));

    const series = await Series.findOne({ _id: req.params.seriesId, status: "approved" });
    if (!series) return next(new AppError("Series not found or not approved", 404));

    if (decision === "cancelled") {
      series.status = "cancelled";
      series.is_public = false;
      await series.save();

      await notifyRankingWarning(
        Notification,
        series.author_id,
        series.name,
        "N/A"
      );
    } else if (decision === "change_schedule" && schedule) {
      series.publication_schedule = schedule;
      await series.save();
    }

    return res.status(200).json({ success: true, data: series });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/votes/confirm:
 *   post:
 *     tags: [EBEvaluations]
 *     summary: EB confirms/updates reader votes for a series
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - series_id
 *               - release_period
 *               - votes
 *             properties:
 *               series_id:
 *                 type: string
 *               release_period:
 *                 type: string
 *               votes:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     reader_id:
 *                       type: string
 *                     score:
 *                       type: number
 *                     comment:
 *                       type: string
 *     responses:
 *       200:
 *         description: Votes confirmed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *       400:
 *         description: series_id, release_period, votes are required
 */
// ─── POST /eb-evaluations/votes/confirm ───────────────────────────────────────
// EB xác nhận/cập nhật dữ liệu vote từ Reader
// Body: { series_id, release_period, votes: [{reader_id, score, comment}] }
router.post("/votes/confirm", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { series_id, release_period, votes } = req.body;
    if (!series_id || !release_period || !votes) {
      return next(new AppError("series_id, release_period, votes are required", 400));
    }

    const results = await Promise.all(
      votes.map((v) =>
        Vote.findOneAndUpdate(
          { series_id, reader_id: v.reader_id, release_period },
          { score: v.score, comment: v.comment || "" },
          { upsert: true, returnDocument: "after" }
        )
      )
    );

    // Tính lại average_score và total_votes
    const seriesVotes = await Vote.find({ series_id, release_period });
    const avg =
      seriesVotes.reduce((s, v) => s + v.score, 0) / (seriesVotes.length || 1);
    await Series.findByIdAndUpdate(series_id, {
      average_score: Math.round(avg * 10) / 10,
      total_votes: seriesVotes.length,
    });

    return res.status(200).json({ success: true, data: results });
  } catch (error) {
    next(error);
  }
});

// ─── POST /eb-evaluations/series/:seriesId/confirm-publish ───────────────────
/**
 * @swagger
 * /eb-evaluations/series/{seriesId}/confirm-publish:
 *   post:
 *     tags: [EBEvaluations]
 *     summary: EB confirm publish for a series (Series-level)
 *     description: |
 *       Sau khi EB chấm điểm Series (council_average >= 2.5),
 *       EB gọi endpoint này để xác nhận xuất bản Series.
 *       - Series → status = "approved_by_EB", is_public = true
 *       - **KHÔNG tự động publish chapter**: chapter đầu tiên (nếu có) chuyển sang "approved_by_EB"
 *         nhưng chờ TE publish thủ công sau khi Mangaka sửa xong.
 *       - Job scheduledPublish sẽ tự động set Series.status = "published" theo scheduled_publish_at
 *         (kể cả khi Series chưa có chapter nào publish → Reader vẫn thấy được Series).
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               publication_schedule:
 *                 type: string
 *                 enum: [weekly, monthly]
 *                 description: Tần suất xuất bản
 *               scheduled_publish_at:
 *                 type: string
 *                 format: date-time
 *                 description: Ngày giờ cụ thể để chapter đầu tiên được publish
 *     responses:
 *       200:
 *         description: Series confirmed for publishing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     series:
 *                       type: object
 *                       properties:
 *                         _id:
 *                           type: string
 *                         name:
 *                           type: string
 *                         status:
 *                           type: string
 *                           example: approved_by_EB
 *                         is_public:
 *                           type: boolean
 *                         publication_schedule:
 *                           type: string
 *                           enum: [weekly, monthly]
 *                         scheduled_publish_at:
 *                           type: string
 *                           format: date-time
 *                     chapters_scheduled:
 *                       type: integer
 *                       description: Số chapter được scheduled tự động (luôn là 0 — chapter chờ TE publish thủ công)
 *                     chapter_ready_for_te:
 *                       type: string
 *                       nullable: true
 *                       description: ID của chapter đầu tiên ở trạng thái "approved_by_EB" chờ TE publish
 *                     council_average:
 *                       type: number
 *                       description: Điểm trung bình hội đồng
 *                     message:
 *                       type: string
 *       400:
 *         description: Score below 2.5 or missing evaluation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *       404:
 *         description: Series not found
 */
router.post("/series/:seriesId/confirm-publish", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { scheduled_publish_at, publication_schedule } = req.body;

    const series = await Series.findById(req.params.seriesId);
    if (!series) return next(new AppError("Series not found", 404));

    // Xác định publication_schedule sẽ dùng:
    //  - Ưu tiên giá trị truyền vào body (nếu hợp lệ)
    //  - Nếu không truyền → lấy từ series.publication_schedule (đã set lúc evaluate)
    //  - Nếu vẫn rỗng → BẮT BUỘC chọn weekly/monthly trước khi confirm-publish
    let finalSchedule = null;
    if (publication_schedule && ["weekly", "monthly"].includes(publication_schedule)) {
      finalSchedule = publication_schedule;
    } else if (series.publication_schedule && ["weekly", "monthly"].includes(series.publication_schedule)) {
      finalSchedule = series.publication_schedule;
    }
    if (!finalSchedule) {
      return next(
        new AppError(
          "publication_schedule (weekly/monthly) là bắt buộc. Vui lòng chọn weekly hoặc monthly trước khi confirm-publish.",
          400
        )
      );
    }

    // Lấy evaluation mới nhất để kiểm tra điểm
    const latestEval = await EBEvaluation.findOne({ series_id: series._id })
      .sort({ createdAt: -1 })
      .lean();

    if (!latestEval) {
      return next(new AppError("Chưa có đánh giá nào. Vui lòng chấm điểm trước.", 400));
    }

    // Tính council_average từ member_scores
    let councilAvg = 0;
    if (latestEval.member_scores && latestEval.member_scores.length > 0) {
      const totals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        totals[k] = latestEval.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
      });
      const avgTotals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        avgTotals[k] = Math.round((totals[k] / latestEval.member_scores.length) * 100) / 100;
      });
      councilAvg =
        Math.round(
          (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
        ) / 100;
    }

    // Kiểm tra điểm >= 2.5 mới cho publish
    if (councilAvg < 2.5) {
      return next(new AppError(`Điểm ${councilAvg} thấp hơn 2.5. Series chưa đủ điều kiện xuất bản.`, 400));
    }

    // Cập nhật Series thành approved_by_EB (CHƯA published - chờ đến ngày)
    // Series.status = "published" sẽ do job scheduledPublish set theo scheduled_publish_at
    // (không phụ thuộc vào chapter - kể cả khi Series chưa có chapter nào được publish)
    series.status = SERIES_STATUS.APPROVED_BY_EB;
    series.is_public = true;
    // publication_schedule: dùng finalSchedule đã validate ở trên
    series.publication_schedule = finalSchedule;
    // scheduled_publish_at là ngày cụ thể - lưu vào Series
    if (scheduled_publish_at) {
      series.scheduled_publish_at = new Date(scheduled_publish_at);
    }
    await series.save();

    // Lưu ý: KHÔNG schedule chapter tự động.
    // Chapter sẽ được TE publish thủ công sau khi Mangaka sửa xong và TE review lại.
    // Job scheduledPublish sẽ tự động set Series.status = "published" theo scheduled_publish_at.
    // Cập nhật chapter 1 (nếu có) sang trạng thái sẵn sàng cho TE review/publish sau:
    //   - chapter 1 status = "approved_by_EB" (chờ TE publish)
    //   - KHÔNG set is_scheduled = true (chờ TE publish thủ công)
    //   - Giữ revision_notes/annotations để TE xem lịch sử feedback từ EB
    const pendingEBChapters = await Chapter.find({
      series_id: series._id,
      status: "pending_EB",
    });
    // Chapter 1 (đầu tiên) sẽ là chapter đầu tiên sau khi sắp xếp theo chapter_number
    const orderedChapters = pendingEBChapters.sort((a, b) => (a.chapter_number || 0) - (b.chapter_number || 0));
    if (orderedChapters.length > 0) {
      // Chỉ chuyển chapter đầu tiên sang approved_by_EB để TE publish thủ công
      // Các chapter còn lại (nếu có) vẫn ở pending_EB chờ EB duyệt từng chapter
      const firstChapter = orderedChapters[0];
      await Chapter.findByIdAndUpdate(firstChapter._id, {
        status: CHAPTER_STATUS.APPROVED_BY_EB,
        is_scheduled: false,
        // Lưu publication_schedule để TE dùng khi publish chapter
        publication_schedule: finalSchedule,
      });
    }

    // Gửi thông báo cho Mangaka
    await notifySeriesPublished(Notification, series.author_id, series, scheduled_publish_at);

    return res.status(200).json({
      success: true,
      data: {
        series: {
          _id: series._id,
          name: series.name,
          status: series.status,
          is_public: series.is_public,
          publication_schedule: series.publication_schedule,
          scheduled_publish_at: series.scheduled_publish_at,
        },
        chapters_scheduled: 0,
        chapter_ready_for_te: orderedChapters.length > 0 ? orderedChapters[0]._id : null,
        council_average: councilAvg,
        message: scheduled_publish_at
          ? `Series đã được duyệt. Series sẽ tự động chuyển sang "published" vào ${new Date(scheduled_publish_at).toLocaleString("vi-VN")}. Chapter đầu tiên sẽ chờ TE publish thủ công sau khi Mangaka sửa xong.`
          : `Series đã được duyệt. Chapter đầu tiên sẽ chờ TE publish thủ công sau khi Mangaka sửa xong.`,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
