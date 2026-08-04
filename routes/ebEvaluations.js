const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { requireEB, requireMangaka } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const EBEvaluation = require("../models/EBEvaluation");
const Notification = require("../models/Notification");
const Vote = require("../models/Vote");
const User = require("../models/User");
const {
  notifySeriesApproved,
  notifyRankingWarning,
  notifyChapterEBRevision,
  notifyChapterScheduledPublish,
  notifyChapterPublishConfirmed,
  notifySeriesPublished,
  notifySeriesEBRevision,
  notifySeriesRejected,
} = require("../services/notificationService");
const { isSeriesLockedForEBChapterReview, buildEBChapterLockError } = require("../services/debutGate");
const {
  EB_CRITERIA_KEYS,
  EB_RESULT_LABELS,
  EB_RESULT_LABEL_TEXT,
  EB_EVALUATION_STATUS,
  NOTIF_TYPES,
  SERIES_STATUS,
  CHAPTER_STATUS,
} = require("../utils/constants");
const {
  checkAgeSafety,
  validateContentLevels,
  getRubricById,
  getSuggestedRubricForSeries,
  listAllRubrics,
  listRubricsForFamily,
  computeWeightedCouncilAverage,
  computeMemberWeightedScore,
  buildRubricEntry,
  getAllFamilies,
  CORE_CRITERIA_KEYS,
  AGE_SAFETY_FIELDS,
  AGE_SAFETY_LEVELS,
  EXTENSION_CRITERIA,
  findFamilyForGenre,
  normalizeGenreKey,
  validateAgeRating,
  validateSeriesForRubric,
  WEIGHT_MATRIX,
} = require("../utils/ebScoringRubric");

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
          // Dùng weighted nếu có rubric, không thì equal weights
          let weights;
          if (ev.applied_rubric_weights && ev.applied_rubric_weights.size > 0) {
            weights = Object.fromEntries(ev.applied_rubric_weights);
          } else {
            weights = {};
            CORE_CRITERIA_KEYS.forEach((k) => { weights[k] = 20; });
          }
          councilAvg = computeWeightedCouncilAverage(ev.member_scores, weights);
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

      // Tính điểm trung bình hội đồng (weighted)
      let councilAvg = 0;
      if (ev.member_scores && ev.member_scores.length > 0) {
        let weights;
        if (ev.applied_rubric_weights && ev.applied_rubric_weights.size > 0) {
          weights = Object.fromEntries(ev.applied_rubric_weights);
        } else {
          weights = {};
          CORE_CRITERIA_KEYS.forEach((k) => { weights[k] = 20; });
        }
        councilAvg = computeWeightedCouncilAverage(ev.member_scores, weights);
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
 * /eb-evaluations/history:
 *   get:
 *     tags: [EBEvaluations]
 *     summary: Lịch sử chấm điểm của toàn hội đồng EB (xem lại + kiểm tra)
 *     description: |
 *       Trả về danh sách tất cả EBEvaluation mà hội đồng EB đã chấm, dùng để:
 *       - EB xem lại lịch sử chấm của mình
 *       - So sánh với các thành viên khác trong hội đồng
 *       - Kiểm tra điểm đã chấm trước đó
 *
 *       **Query params:**
 *       - `scope` : `series` (mặc định — duyệt toàn truyện, chapter_id = null) |
 *                   `chapter` (duyệt chapter mới, chapter_id != null) |
 *                   `all` (cả 2)
 *       - `result` : filter kết quả (`approved` | `revision` | `rejected`)
 *       - `status` : filter trạng thái evaluation (`scoring` | `saved` | `locked`)
 *       - `series_id` : filter theo series cụ thể
 *       - `q` : tìm kiếm theo tên series (case-insensitive)
 *       - `page`, `limit` : phân trang (limit tối đa 100, mặc định 20)
 *
 *       Mỗi item trả về:
 *       - evaluation_id, evaluation_type (series/chapter), result, status
 *       - series info (name, cover_image_url, status, author)
 *       - chapter info nếu là chapter review (chapter_number, title)
 *       - council_average, classification, classification_text
 *       - member_scores[] : điểm của từng thành viên hội đồng
 *       - evaluated_by, last_saved_by, last_saved_at, scheduled_publish_at
 *       - notes, quick_decision, quick_notes
 *     parameters:
 *       - in: query
 *         name: scope
 *         schema: { type: string, enum: [series, chapter, all] }
 *         default: series
 *       - in: query
 *         name: result
 *         schema: { type: string, enum: [approved, revision, rejected] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [scoring, saved, locked] }
 *       - in: query
 *         name: series_id
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Danh sách lịch sử chấm
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden - EB role required }
 */
// ─── GET /eb-evaluations/history ──────────────────────────────────────────────
// Lịch sử chấm điểm của toàn hội đồng EB, có filter + phân trang.
router.get("/history", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const { result, status, scope = "series", series_id: seriesIdFilter, q } = req.query;

    // ─── Build filter ───
    const filter = {};
    if (result && ["approved", "revision", "rejected"].includes(result)) {
      filter.result = result;
    }
    if (status && ["scoring", "saved", "locked"].includes(status)) {
      filter.status = status;
    }
    if (seriesIdFilter && mongoose.isValidObjectId(seriesIdFilter)) {
      filter.series_id = seriesIdFilter;
    }
    if (scope === "series") {
      filter.$or = [{ chapter_id: null }, { chapter_id: { $exists: false } }];
    } else if (scope === "chapter") {
      filter.chapter_id = { $ne: null, $exists: true };
    }
    // scope === "all" → không filter chapter_id

    // Tìm series theo tên trước (nếu có q), rồi gộp vào filter
    if (q && q.trim()) {
      const matchedSeries = await Series.find({
        name: { $regex: q.trim(), $options: "i" },
        deleted_at: null,
      })
        .select("_id")
        .lean();
      const matchedIds = matchedSeries.map((s) => s._id);
      if (matchedIds.length === 0) {
        return res.json({
          success: true,
          data: {
            items: [],
            page,
            limit,
            total: 0,
            has_more: false,
            stats: { total_series_reviewed: 0, total_chapter_reviewed: 0, total_council_average: 0 },
          },
        });
      }
      filter.series_id = filter.series_id
        ? { $in: matchedIds, _id: filter.series_id }
        : { $in: matchedIds };
    }

    const total = await EBEvaluation.countDocuments(filter);

    const evaluations = await EBEvaluation.find(filter)
      .populate("series_id", "name cover_image_url status publication_schedule author_id is_public")
      .populate("series_id.author_id", "username full_name phoneNumber")
      .populate("chapter_id", "chapter_number title status published_at scheduled_publish_at")
      .populate("evaluated_by", "username full_name phoneNumber avatar_url")
      .populate("last_saved_by", "username full_name phoneNumber avatar_url")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const items = evaluations.map((ev) => {
      const isSeriesReview = !ev.chapter_id;

      // Tính điểm hội đồng (weighted)
      let councilAvg = 0;
      if (ev.member_scores && ev.member_scores.length > 0) {
        let weights;
        if (ev.applied_rubric_weights && ev.applied_rubric_weights.size > 0) {
          weights = Object.fromEntries(ev.applied_rubric_weights);
        } else {
          weights = {};
          CORE_CRITERIA_KEYS.forEach((k) => { weights[k] = 20; });
        }
        councilAvg = computeWeightedCouncilAverage(ev.member_scores, weights);
      }

      return {
        evaluation_id: ev._id,
        evaluation_type: isSeriesReview ? "series" : "chapter",
        result: ev.result || null,
        quick_decision: ev.quick_decision || null,
        status: ev.status || null,
        first_review: ev.first_review || false,
        story_type: ev.story_type || "",
        series: ev.series_id
          ? {
              id: ev.series_id._id,
              name: ev.series_id.name,
              cover_image_url: ev.series_id.cover_image_url || "",
              status: ev.series_id.status,
              is_public: ev.series_id.is_public,
              publication_schedule: ev.series_id.publication_schedule || null,
              author: ev.series_id.author_id
                ? {
                    id: ev.series_id.author_id._id,
                    name: ev.series_id.author_id.full_name || ev.series_id.author_id.username,
                  }
                : null,
            }
          : null,
        chapter: ev.chapter_id
          ? {
              id: ev.chapter_id._id,
              chapter_number: ev.chapter_id.chapter_number,
              title: ev.chapter_id.title || "",
              status: ev.chapter_id.status,
              published_at: ev.chapter_id.published_at || null,
              scheduled_publish_at: ev.chapter_id.scheduled_publish_at || null,
            }
          : null,
        council_average: councilAvg,
        classification: classifyByScore(councilAvg),
        classification_text: classifyText(councilAvg),
        member_count: ev.member_scores ? ev.member_scores.length : 0,
        scheduled_publish_at: ev.scheduled_publish_at || null,
        evaluated_by: ev.evaluated_by
          ? {
              id: ev.evaluated_by._id,
              name: ev.evaluated_by.full_name || ev.evaluated_by.username,
              avatar_url: ev.evaluated_by.avatar_url || "",
            }
          : null,
        last_saved_by: ev.last_saved_by
          ? {
              id: ev.last_saved_by._id,
              name: ev.last_saved_by.full_name || ev.last_saved_by.username,
              avatar_url: ev.last_saved_by.avatar_url || "",
            }
          : null,
        last_saved_at: ev.last_saved_at || null,
        created_at: ev.createdAt,
        updated_at: ev.updatedAt,
      };
    });

    // Thống kê tổng quan (không phụ thuộc page/limit)
    const baseStats = {};
    if (seriesIdFilter && mongoose.isValidObjectId(seriesIdFilter)) {
      baseStats.series_id = seriesIdFilter;
    }
    const [
      totalSeriesReviewed,
      totalChapterReviewed,
      allCouncilAvgAgg,
    ] = await Promise.all([
      EBEvaluation.countDocuments({
        ...baseStats,
        $or: [{ chapter_id: null }, { chapter_id: { $exists: false } }],
      }),
      EBEvaluation.countDocuments({
        ...baseStats,
        chapter_id: { $ne: null, $exists: true },
      }),
      EBEvaluation.aggregate([
        {
          $match: {
            ...baseStats,
            $or: [{ chapter_id: null }, { chapter_id: { $exists: false } }],
            member_scores: { $exists: true, $ne: [] },
          },
        },
        { $unwind: "$member_scores" },
        {
          $group: {
            _id: null,
            avg: { $avg: "$member_scores.average" },
          },
        },
      ]),
    ]);
    const totalCouncilAvg =
      allCouncilAvgAgg && allCouncilAvgAgg.length > 0
        ? Math.round(allCouncilAvgAgg[0].avg * 100) / 100
        : 0;

    return res.json({
      success: true,
      data: {
        items,
        page,
        limit,
        total,
        has_more: skip + items.length < total,
        stats: {
          total_series_reviewed: totalSeriesReviewed,
          total_chapter_reviewed: totalChapterReviewed,
          total_council_average: totalCouncilAvg,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/{evaluationId}/history-detail:
 *   get:
 *     tags: [EBEvaluations]
 *     summary: Chi tiết 1 evaluation trong lịch sử chấm của hội đồng EB
 *     description: |
 *       Trả về toàn bộ thông tin chi tiết của 1 EBEvaluation, dùng khi EB click
 *       vào 1 card trong trang lịch sử `/eb-evaluations/history`.
 *
 *       Bao gồm:
 *       - Đầy đủ series info (name, cover, status, author, publication_schedule)
 *       - Chapter info nếu là chapter review
 *       - Điểm của từng thành viên hội đồng (member_scores) với 5 tiêu chí, comment từng tiêu chí, overall_comment
 *       - Council average, classification, classification_text
 *       - evaluated_by, last_saved_by, last_saved_at, scheduled_publish_at, notes, quick_decision, quick_notes
 *     parameters:
 *       - in: path
 *         name: evaluationId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Chi tiết evaluation }
 *       404: { description: Evaluation not found }
 */
// ─── GET /eb-evaluations/:evaluationId/history-detail ─────────────────────────
// Chi tiết 1 evaluation trong lịch sử — xem lại điểm, comment từng thành viên.
router.get("/:evaluationId/history-detail", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { evaluationId } = req.params;
    if (!mongoose.isValidObjectId(evaluationId)) {
      return next(new AppError("Invalid evaluationId", 400));
    }

    const ev = await EBEvaluation.findById(evaluationId)
      .populate("series_id", "name cover_image_url status publication_schedule author_id is_public description synopsis tags category average_score total_votes views_count")
      .populate("series_id.author_id", "username full_name phoneNumber avatar_url")
      .populate("chapter_id", "chapter_number title status published_at scheduled_publish_at createdAt")
      .populate("evaluated_by", "username full_name phoneNumber avatar_url")
      .populate("last_saved_by", "username full_name phoneNumber avatar_url")
      .populate("member_scores.member_id", "username full_name phoneNumber avatar_url is_eb_representative")
      .lean();

    if (!ev) return next(new AppError("Evaluation not found", 404));

    const isSeriesReview = !ev.chapter_id;

    // Tính council_average
    let councilAvg = 0;
    let councilBreakdown = {};
    if (ev.member_scores && ev.member_scores.length > 0) {
      const totals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        totals[k] = ev.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
      });
      const avgTotals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        avgTotals[k] =
          ev.member_scores.length > 0
            ? Math.round((totals[k] / ev.member_scores.length) * 100) / 100
            : 0;
      });
      // Weighted council average (dùng rubric weights nếu có)
      const weights = ev.applied_rubric_weights && ev.applied_rubric_weights.size > 0
        ? Object.fromEntries(ev.applied_rubric_weights)
        : Object.fromEntries(CORE_CRITERIA_KEYS.map((k) => [k, 20]));
      councilAvg = computeWeightedCouncilAverage(ev.member_scores, weights);
      councilBreakdown = avgTotals;
    }

    // Chuẩn hoá member_scores.
    // Đảm bảo FE history-detail luôn thấy tên người đọc được:
    //   - Ưu tiên 1: member_name đã lưu trong DB (do FE gửi lúc evaluate)
    //   - Ưu tiên 2: full_name / username từ populate user (nếu member_id là ObjectId)
    //   - Ưu tiên 3: "" — TUYỆT ĐỐI KHÔNG fallback sang external_member_id / member_id
    //                 vì đây chính là bug cũ (hiển thị "member-1785044498035-dbj18").
    //
    //   *Self-healing*: nếu record cũ bị bug đã copy external_member_id sang member_name
    //   (member_name khớp pattern "member-<digits>-<random>") → bỏ qua, dùng populate.
    const isStaleExternalId = (name) =>
      typeof name === "string" && /^member-\d+-[a-z0-9]+$/i.test(name.trim());

    const memberScores = (ev.member_scores || []).map((m) => {
      const user = m.member_id;
      const userFullName = user?.full_name || user?.username || "";
      const savedName = m.member_name && String(m.member_name).trim();
      const resolvedName =
        (savedName && !isStaleExternalId(savedName) ? savedName : "") ||
        userFullName ||
        "";
      return {
        member_id: user ? String(user._id) : null,
        external_member_id: m.external_member_id || null,
        member_name: resolvedName,
        member_avatar_url: user?.avatar_url || "",
        is_eb_representative: user?.is_eb_representative || false,
        scores: m.scores || {},
        average: m.average || 0,
        total_score: m.total_score || 0,
        comments: m.comments || {},
        overall_comment: m.overall_comment || "",
        notes: m.notes || "",
        saved_at: m.saved_at || null,
      };
    });

    // Tìm các evaluation khác cùng series (để EB đối chiếu)
    const otherEvaluations = await EBEvaluation.find({
      _id: { $ne: ev._id },
      series_id: ev.series_id?._id,
    })
      .select("_id chapter_id result status first_review createdAt last_saved_at")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return res.json({
      success: true,
      data: {
        evaluation_id: ev._id,
        evaluation_type: isSeriesReview ? "series" : "chapter",
        result: ev.result || null,
        quick_decision: ev.quick_decision || null,
        status: ev.status || null,
        first_review: ev.first_review || false,
        story_type: ev.story_type || "",
        series: ev.series_id
          ? {
              id: ev.series_id._id,
              name: ev.series_id.name,
              cover_image_url: ev.series_id.cover_image_url || "",
              status: ev.series_id.status,
              is_public: ev.series_id.is_public,
              publication_schedule: ev.series_id.publication_schedule || null,
              description: ev.series_id.description || ev.series_id.synopsis || "",
              synopsis: ev.series_id.synopsis || "",
              tags: ev.series_id.tags || [],
              category: ev.series_id.category || "",
              average_score: ev.series_id.average_score || 0,
              total_votes: ev.series_id.total_votes || 0,
              views_count: ev.series_id.views_count || 0,
              author: ev.series_id.author_id
                ? {
                    id: ev.series_id.author_id._id,
                    name: ev.series_id.author_id.full_name || ev.series_id.author_id.username,
                    avatar_url: ev.series_id.author_id.avatar_url || "",
                  }
                : null,
            }
          : null,
        chapter: ev.chapter_id
          ? {
              id: ev.chapter_id._id,
              chapter_number: ev.chapter_id.chapter_number,
              title: ev.chapter_id.title || "",
              status: ev.chapter_id.status,
              published_at: ev.chapter_id.published_at || null,
              scheduled_publish_at: ev.chapter_id.scheduled_publish_at || null,
              created_at: ev.chapter_id.createdAt,
            }
          : null,
        council_average: councilAvg,
        council_breakdown: councilBreakdown,
        classification: classifyByScore(councilAvg),
        classification_text: classifyText(councilAvg),
        member_count: ev.member_scores ? ev.member_scores.length : 0,
        member_scores: memberScores,
        scheduled_publish_at: ev.scheduled_publish_at || null,
        evaluated_by: ev.evaluated_by
          ? {
              id: ev.evaluated_by._id,
              name: ev.evaluated_by.full_name || ev.evaluated_by.username,
              avatar_url: ev.evaluated_by.avatar_url || "",
            }
          : null,
        last_saved_by: ev.last_saved_by
          ? {
              id: ev.last_saved_by._id,
              name: ev.last_saved_by.full_name || ev.last_saved_by.username,
              avatar_url: ev.last_saved_by.avatar_url || "",
            }
          : null,
        last_saved_at: ev.last_saved_at || null,
        notes: ev.notes || "",
        quick_notes: ev.quick_notes || "",
        created_at: ev.createdAt,
        updated_at: ev.updatedAt,
        related_evaluations: otherEvaluations.map((o) => ({
          evaluation_id: o._id,
          evaluation_type: !o.chapter_id ? "series" : "chapter",
          result: o.result || null,
          status: o.status,
          first_review: o.first_review,
          created_at: o.createdAt,
          last_saved_at: o.last_saved_at,
        })),
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

    // Tính council_average (weighted) + gắn my_member_score cho EB hiện tại
    let enrichedEvaluation = null;
    if (evaluation) {
      const weights = evaluation.applied_rubric_weights && evaluation.applied_rubric_weights.size > 0
        ? Object.fromEntries(evaluation.applied_rubric_weights)
        : Object.fromEntries(CORE_CRITERIA_KEYS.map((k) => [k, 20]));
      const councilAvg = evaluation.member_scores && evaluation.member_scores.length > 0
        ? computeWeightedCouncilAverage(evaluation.member_scores, weights)
        : 0;

      const userId = req.user.nameid;
      const myMemberScore = (evaluation.member_scores || []).find(
        (m) => m.member_id && String(m.member_id) === String(userId)
      ) || null;

      // Compute weighted council average for this evaluation
      const evalWeights = evaluation.applied_rubric_weights && evaluation.applied_rubric_weights.size > 0
        ? Object.fromEntries(evaluation.applied_rubric_weights)
        : Object.fromEntries(CORE_CRITERIA_KEYS.map((k) => [k, 20]));
      const evalCouncilAvg = evaluation.member_scores && evaluation.member_scores.length > 0
        ? computeWeightedCouncilAverage(evaluation.member_scores, evalWeights)
        : 0;

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
        // New rubric fields
        applied_rubric_id:           evaluation.applied_rubric_id || null,
        applied_rubric_total_weight: evaluation.applied_rubric_total_weight || 100,
        age_safety:                 evaluation.age_safety || null,
        content_levels:              evaluation.content_levels || null,
        // Weighted council average
        council_average: evalCouncilAvg,
        classification: classifyByScore(evalCouncilAvg),
        classification_text: classifyText(evalCouncilAvg),
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
 *                 description: |
 *                   Bắt buộc cho lần đầu. Mảng điểm từ các thành viên hội đồng.
 *
 *                   **Lưu ý:** FE PHẢI gửi kèm `member_name` (tên hiển thị thật).
 *                   `member_id` có thể là ObjectId user thật hoặc id local "member-..."
 *                   (BE sẽ tự lưu vào `external_member_id` cho id local).
 *                 items:
 *                   type: object
 *                   required: [member_name, scores]
 *                   properties:
 *                     member_id:
 *                       type: string
 *                       description: ID thành viên (ObjectId user thật HOẶC id local)
 *                     member_name:
 *                       type: string
 *                       description: Tên hiển thị thành viên hội đồng — BẮT BUỘC
 *                     scores:
 *                       type: object
 *                       properties:
 *                         content_script: { type: number }
 *                         art: { type: number }
 *                         characters: { type: number }
 *                         commercial_potential: { type: number }
 *                         publisher_fit: { type: number }
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
//
// First review body:
//   { member_scores, result, publication_schedule, notes, rubric_id,
//     content_levels: { violence, fear, profanity, nudity, danger_simulation },
//     extension_scores: [{ key, value, comment }] }
//
// Quick decision body (non-first):
//   { quick_decision, quick_notes, result }
router.post("/series/:seriesId/evaluate", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const {
      member_scores,
      result,
      publication_schedule,
      notes,
      quick_decision,
      quick_notes,
      scheduled_publish_at,
      rubric_id,
      content_levels,
      extension_scores,
    } = req.body;

    const series = await Series.findOne({ _id: req.params.seriesId });
    if (!series) return next(new AppError("Series not found", 404));

    // Kiểm tra lần đầu hay lần sau
    const isFirstReview = series.status === "draft" || series.status === "submitted";

    let evaluation;
    if (isFirstReview) {
      // ─── FIRST REVIEW ──────────────────────────────────────────────────────────

      // 1. Validate member_scores
      if (!member_scores || !Array.isArray(member_scores) || member_scores.length === 0) {
        return next(new AppError("member_scores is required for first review", 400));
      }
      if (member_scores.length < 3 || member_scores.length > 5) {
        return next(
          new AppError("Hội đồng cần tối thiểu 3 và tối đa 5 thành viên", 400)
        );
      }
      for (let idx = 0; idx < member_scores.length; idx += 1) {
        const m = member_scores[idx];
        if (!m.member_name || !String(m.member_name).trim()) {
          return next(
            new AppError(
              `member_scores[${idx}].member_name là bắt buộc. Vui lòng gửi kèm tên hiển thị của thành viên hội đồng (FE lấy từ roster).`,
              400
            )
          );
        }
      }
      if (!result) return next(new AppError("result is required", 400));

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

      // 2. Resolve rubric
      const rubric = rubric_id ? getRubricById(rubric_id) : getSuggestedRubricForSeries(series);
      if (!rubric) {
        return next(new AppError(`Rubric "${rubric_id}" không hợp lệ. Vui lòng chọn rubric khác.`, 400));
      }

      // 3. Age Safety Gate — FAIL → tạo evaluation rejected + notify Mangaka kèm chi tiết vi phạm
      const ageRating = series.age_rating || "All ages";
      if (content_levels !== undefined) {
        const safetyResult = checkAgeSafety(content_levels, ageRating);
        if (!safetyResult.passed) {
          // Build violation summary for notes
          const violationLabels = safetyResult.violations.map((v) => v.label).join(", ");
          const ageSafetyNotes = `Vi phạm độ tuổi (${ageRating}): ${violationLabels}`;

          const appliedRubricWeightsMap = rubric ? new Map(Object.entries(rubric.weights)) : new Map();

          // Tạo evaluation với result = "rejected"
          const ageSafetyEvaluation = await EBEvaluation.create({
            series_id:                   series._id,
            evaluated_by:                req.user.nameid,
            first_review:                true,
            applied_rubric_id:           rubric ? rubric.id : null,
            applied_rubric_weights:      appliedRubricWeightsMap,
            applied_rubric_total_weight: rubric ? rubric.total_weight : 100,
            age_safety: {
              passed:     safetyResult.passed,
              severity:  safetyResult.severity,
              rules_note: safetyResult.rules_note,
              violations: safetyResult.violations,
            },
            content_levels: {
              violence:           content_levels?.violence || 0,
              fear:              content_levels?.fear || 0,
              profanity:         content_levels?.profanity || 0,
              nudity:            content_levels?.nudity || 0,
              danger_simulation: content_levels?.danger_simulation || 0,
            },
            member_scores: [],
            result: "rejected",
            notes: ageSafetyNotes,
          });

          // Cập nhật series status = "rejected"
          series.status = "rejected";
          series.eb_evaluation_id = ageSafetyEvaluation._id;
          await series.save();

          // Gửi notification kèm chi tiết vi phạm
          await notifySeriesRejected(
            Notification,
            series.author_id,
            series,
            ageSafetyNotes,
            safetyResult
          );

          return res.status(201).json({
            success: true,
            data: {
              evaluation: ageSafetyEvaluation,
              age_safety: safetyResult,
              age_rating: ageRating,
              content_levels,
            },
          });
        }
      }

      // 4. Compute weighted council average
      const weights = rubric.weights;
      const councilAvg = computeWeightedCouncilAverage(member_scores, weights);
      const classification = classifyByScore(councilAvg);

      // 5. Transform member_scores
      const transformedMemberScores = member_scores.map((m) => {
        let normalizedMemberId = null;
        let externalMemberId = null;
        if (m.member_id) {
          if (mongoose.isValidObjectId(String(m.member_id))) {
            normalizedMemberId = m.member_id;
          } else {
            externalMemberId = String(m.member_id);
          }
        }

        // Compute weighted total_score từ rubric weights
        const weightedScore = computeMemberWeightedScore(m.scores || {}, weights);

        return {
          member_name:        String(m.member_name).trim(),
          member_id:          normalizedMemberId,
          external_member_id:  externalMemberId,
          scores:             m.scores || {},
          extension_scores:   m.extension_scores || [],
          comments:           m.comments || {},
          overall_comment:    m.overall_comment || "",
          total_score:        weightedScore,
          notes:              m.notes || "",
        };
      });

      // 6. Build age_safety data
      const ageSafetyResult = checkAgeSafety(content_levels || {}, ageRating);
      const appliedRubricWeightsMap = new Map(Object.entries(weights));

      evaluation = await EBEvaluation.create({
        series_id:                   series._id,
        evaluated_by:                req.user.nameid,
        first_review:                true,
        applied_rubric_id:           rubric.id,
        applied_rubric_weights:      appliedRubricWeightsMap,
        applied_rubric_total_weight: rubric.total_weight,
        age_safety: {
          passed:     ageSafetyResult.passed,
          severity:  ageSafetyResult.severity,
          rules_note: ageSafetyResult.rules_note,
          violations: ageSafetyResult.violations,
        },
        content_levels: {
          violence:           content_levels?.violence || 0,
          fear:              content_levels?.fear || 0,
          profanity:         content_levels?.profanity || 0,
          nudity:            content_levels?.nudity || 0,
          danger_simulation: content_levels?.danger_simulation || 0,
        },
        member_scores: transformedMemberScores,
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

      // Notify Mangaka — cho cả first review và second review
      if (result === "approved") {
        await notifySeriesApproved(
          Notification,
          series.author_id,
          series.name,
          publication_schedule || "weekly"
        );
      } else if (result === "revision") {
        await notifySeriesEBRevision(
          Notification,
          series.author_id,
          series,
          notes || ""
        );
      } else if (result === "rejected") {
        await notifySeriesRejected(
          Notification,
          series.author_id,
          series,
          notes || ""
        );
      }

      return res.status(201).json({
        success: true,
        data: {
          evaluation,
          rubric,
          classification,
          classification_text: classifyText(councilAvg),
          council_average: councilAvg,
          age_safety: evaluation.age_safety,
        },
      });
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

      // Notify Mangaka cho second review
      if (quick_decision === "approved") {
        await notifySeriesApproved(
          Notification,
          series.author_id,
          series.name,
          publication_schedule || "weekly"
        );
      } else if (quick_decision === "revision") {
        await notifySeriesEBRevision(
          Notification,
          series.author_id,
          series,
          quick_notes || ""
        );
      } else if (quick_decision === "rejected") {
        await notifySeriesRejected(
          Notification,
          series.author_id,
          series,
          quick_notes || ""
        );
      }
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
 *                 description: |
 *                   Bắt buộc cho lần đầu. Mảng điểm từ các thành viên hội đồng.
 *
 *                   **Lưu ý:** FE PHẢI gửi kèm `member_name` (tên hiển thị thật của thành viên HĐ,
 *                   lấy từ roster FE / localStorage). Nếu thiếu → BE trả 400.
 *
 *                   `member_id` có thể là:
 *                   - ObjectId user thật trong hệ thống → lưu `member_id`, populate được.
 *                   - String id local kiểu "member-1785044498035-dbj18" → BE tự lưu vào
 *                     `external_member_id` và KHÔNG copy sang `member_name`.
 *                 items:
 *                   type: object
 *                   required: [member_name, scores]
 *                   properties:
 *                     member_id:
 *                       type: string
 *                       description: ID thành viên (ObjectId user thật HOẶC id local "member-...")
 *                     member_name:
 *                       type: string
 *                       description: Tên hiển thị của thành viên hội đồng — BẮT BUỘC.
 *                     scores:
 *                       type: object
 *                       properties:
 *                         story_dialogue: { type: number }
 *                         art_design: { type: number }
 *                         panel_camera: { type: number }
 *                         pacing_climax: { type: number }
 *                         color: { type: number }
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
// Body: { result, notes, quick_decision, quick_notes, scheduled_publish_at,
//          rubric_id?, content_levels?, extension_scores? }
// ─── POST /eb-evaluations/chapter/:chapterId/evaluate ──────────────────────
// EB chấm điểm Series (dùng chapter làm context để lấy series)
// CHỈ lưu EBEvaluation, KHÔNG đổi chapter/series status
router.post("/chapter/:chapterId/evaluate", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const {
      result,
      notes,
      quick_decision,
      quick_notes,
      scheduled_publish_at,
      rubric_id,
      content_levels,
      extension_scores,
    } = req.body;

    const chapter = await Chapter.findOne({ _id: req.params.chapterId, status: "pending_EB" });
    if (!chapter) return next(new AppError("Chapter not found or not pending EB", 404));

    const series = await Series.findById(chapter.series_id).lean();
    if (!series) return next(new AppError("Series not found", 404));

    // ─── Debut Gate: chặn EB chấm chapter 2+ của series locked ───────────
    const gateCheck = await isSeriesLockedForEBChapterReview(chapter.series_id);
    if (gateCheck.locked) {
      const alreadyEvaluated = await EBEvaluation.find({
        series_id: chapter.series_id,
        chapter_id: { $exists: true, $ne: null },
        result: { $in: ["approved", "rejected", "revision"] },
      })
        .select("chapter_id result")
        .lean();

      const errPayload = buildEBChapterLockError({
        series: gateCheck.series,
        reason:
          "EB đã chấm 1 chapter của series này. Sau khi chấm, không được chấm chapter nào khác nữa cho đến khi series được confirm-publish.",
        extra: {
          already_evaluated_chapters: alreadyEvaluated.map((ev) => ({
            chapter_id: ev.chapter_id,
            result: ev.result,
          })),
          unlock_requirements: {
            eb_evaluated: true,
            publish_confirmed: false,
            missing_step:
              "EB must call POST /eb-evaluations/series/:seriesId/confirm-publish to unlock further chapter reviews.",
          },
        },
      });
      return next(new AppError(errPayload.message, 409, errPayload.data));
    }

    const isFirstReview = series.status === "draft" || series.status === "submitted";

    // ─── FIRST REVIEW: full scoring with weighted average + age safety ────────
    if (isFirstReview) {
      if (!result) return next(new AppError("result is required for first review", 400));

      const ms = req.body.member_scores;
      if (!ms || !Array.isArray(ms) || ms.length === 0) {
        return next(new AppError("member_scores is required for first review", 400));
      }
      if (ms.length < 3 || ms.length > 5) {
        return next(new AppError("Hội đồng cần tối thiểu 3 và tối đa 5 thành viên", 400));
      }
      for (let idx = 0; idx < ms.length; idx += 1) {
        const m = ms[idx];
        if (!m.member_name || !String(m.member_name).trim()) {
          return next(
            new AppError(
              `member_scores[${idx}].member_name là bắt buộc. Vui lòng gửi kèm tên hiển thị của thành viên hội đồng (FE lấy từ roster).`,
              400
            )
          );
        }
      }

      // Resolve rubric
      const rubric = rubric_id ? getRubricById(rubric_id) : getSuggestedRubricForSeries(series);
      if (!rubric) {
        return next(new AppError(`Rubric "${rubric_id}" không hợp lệ. Vui lòng chọn rubric khác.`, 400));
      }

      // Age Safety Gate — FAIL → tạo evaluation rejected + notify Mangaka kèm chi tiết vi phạm
      const ageRating = series.age_rating || "All ages";
      if (content_levels !== undefined) {
        const safetyResult = checkAgeSafety(content_levels, ageRating);
        if (!safetyResult.passed) {
          const violationLabels = safetyResult.violations.map((v) => v.label).join(", ");
          const ageSafetyNotes = `Vi phạm độ tuổi (${ageRating}): ${violationLabels}`;
          const appliedRubricWeightsMap = rubric ? new Map(Object.entries(rubric.weights)) : new Map();

          const ageSafetyEvaluation = await EBEvaluation.create({
            series_id:                   chapter.series_id,
            chapter_id:                  chapter._id,
            evaluated_by:                req.user.nameid,
            first_review:                true,
            applied_rubric_id:           rubric ? rubric.id : null,
            applied_rubric_weights:      appliedRubricWeightsMap,
            applied_rubric_total_weight: rubric ? rubric.total_weight : 100,
            age_safety: {
              passed:     safetyResult.passed,
              severity:  safetyResult.severity,
              rules_note: safetyResult.rules_note,
              violations: safetyResult.violations,
            },
            content_levels: {
              violence:           content_levels?.violence || 0,
              fear:              content_levels?.fear || 0,
              profanity:         content_levels?.profanity || 0,
              nudity:            content_levels?.nudity || 0,
              danger_simulation: content_levels?.danger_simulation || 0,
            },
            member_scores: [],
            result: "rejected",
            notes: ageSafetyNotes,
          });

          // Gửi notification cho Mangaka
          await notifySeriesRejected(
            Notification,
            series.author_id,
            series,
            ageSafetyNotes,
            safetyResult
          );

          return res.status(201).json({
            success: true,
            data: {
              evaluation: ageSafetyEvaluation,
              age_safety: safetyResult,
              age_rating: ageRating,
              content_levels,
            },
          });
        }
      }

      // Weighted scoring
      const weights = rubric.weights;
      const councilAvg = computeWeightedCouncilAverage(ms, weights);
      const classification = classifyByScore(councilAvg);
      const classificationText = classifyText(councilAvg);

      // Transform member_scores
      const transformedMemberScores = ms.map((m) => {
        let normalizedMemberId = null;
        let externalMemberId = null;
        if (m.member_id) {
          if (mongoose.isValidObjectId(String(m.member_id))) {
            normalizedMemberId = m.member_id;
          } else {
            externalMemberId = String(m.member_id);
          }
        }
        const weightedScore = computeMemberWeightedScore(m.scores || {}, weights);

        return {
          member_name:        String(m.member_name).trim(),
          member_id:          normalizedMemberId,
          external_member_id:  externalMemberId,
          scores:             m.scores || {},
          extension_scores:   m.extension_scores || [],
          comments:           m.comments || {},
          overall_comment:    m.overall_comment || "",
          total_score:        weightedScore,
          notes:              m.notes || "",
        };
      });

      // Age safety data
      const ageSafetyResult = checkAgeSafety(content_levels || {}, ageRating);
      const appliedRubricWeightsMap = new Map(Object.entries(weights));

      const newEvaluation = await EBEvaluation.create({
        series_id:                   chapter.series_id,
        chapter_id:                  chapter._id,
        evaluated_by:                req.user.nameid,
        first_review:                true,
        applied_rubric_id:           rubric.id,
        applied_rubric_weights:      appliedRubricWeightsMap,
        applied_rubric_total_weight: rubric.total_weight,
        age_safety: {
          passed:     ageSafetyResult.passed,
          severity:  ageSafetyResult.severity,
          rules_note: ageSafetyResult.rules_note,
          violations: ageSafetyResult.violations,
        },
        content_levels: {
          violence:           content_levels?.violence || 0,
          fear:              content_levels?.fear || 0,
          profanity:         content_levels?.profanity || 0,
          nudity:            content_levels?.nudity || 0,
          danger_simulation: content_levels?.danger_simulation || 0,
        },
        member_scores: transformedMemberScores,
        result,
        scheduled_publish_at: scheduled_publish_at || null,
        notes: notes || "",
        status: EB_EVALUATION_STATUS.LOCKED,
      });

      return res.status(201).json({
        success: true,
        data: {
          evaluation: newEvaluation,
          rubric,
          classification,
          classification_text: classificationText,
          council_average: councilAvg,
          age_safety: newEvaluation.age_safety,
          message: councilAvg >= 2.5 || result === "approved"
            ? "Điểm đã được lưu. Series đủ điều kiện xuất bản."
            : "Điểm thấp hơn 2.5. Series chưa đủ điều kiện xuất bản.",
        },
      });
    }

    // ─── NON-FIRST REVIEW: duyệt nhanh (giữ nguyên logic cũ) ───────────────
    if (!quick_decision) return next(new AppError("quick_decision is required", 400));

    if (quick_decision === "approved") {
      if (!result) return next(new AppError("result is required", 400));
    }

    // Lấy điểm từ evaluation gần nhất để tính council_average
    let councilAvg = 0;
    const latestEval = await EBEvaluation.findOne({ series_id: series._id })
      .sort({ createdAt: -1 })
      .lean();
    if (latestEval && latestEval.member_scores && latestEval.member_scores.length > 0) {
      // Dùng weighted nếu có rubric, không thì equal
      let weights;
      if (latestEval.applied_rubric_weights && latestEval.applied_rubric_weights.size > 0) {
        weights = Object.fromEntries(latestEval.applied_rubric_weights);
      } else {
        weights = {};
        CORE_CRITERIA_KEYS.forEach((k) => { weights[k] = 20; });
      }
      councilAvg = computeWeightedCouncilAverage(latestEval.member_scores, weights);
    }

    const classification = classifyByScore(councilAvg);
    const classificationText = classifyText(councilAvg);
    const finalResult = result || quick_decision || null;

    const newEvaluation = await EBEvaluation.create({
      series_id:   chapter.series_id,
      chapter_id:  chapter._id,
      evaluated_by: req.user.nameid,
      first_review: isFirstReview,
      // Giữ rubric từ evaluation gần nhất
      applied_rubric_id:           latestEval?.applied_rubric_id || null,
      applied_rubric_weights:      latestEval?.applied_rubric_weights || new Map(),
      applied_rubric_total_weight: latestEval?.applied_rubric_total_weight || 100,
      member_scores: [],
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
      series.publication_status = "dropped";
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

    // Tính council_average: dùng weighted nếu có rubric, không thì equal
    let councilAvg = 0;
    if (latestEval.member_scores && latestEval.member_scores.length > 0) {
      let weights;
      if (latestEval.applied_rubric_weights && latestEval.applied_rubric_weights.size > 0) {
        weights = Object.fromEntries(latestEval.applied_rubric_weights);
      } else {
        // Fallback: equal weights cho data cũ không có rubric
        weights = {};
        CORE_CRITERIA_KEYS.forEach((k) => { weights[k] = 20; });
      }
      councilAvg = computeWeightedCouncilAverage(latestEval.member_scores, weights);
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
    // publication_status = upcoming: chờ đến ngày publish → job tự chuyển sang ongoing
    series.publication_status = "upcoming";
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
      // Sau EB Confirm Publish → Chapter trả về cho Mangaka để giao task cho Assistant sửa tiếp.
      // Flow: pending_assistant → submitted_by_assistant → approved_by_mangaka → pending_TE → TE publish.
      // Giữ revision_notes/annotations để Mangaka + Assistant biết feedback từ EB.
      const firstChapter = orderedChapters[0];
      await Chapter.findByIdAndUpdate(firstChapter._id, {
        status: CHAPTER_STATUS.PENDING_ASSISTANT,
        is_scheduled: false,
        // Lưu publication_schedule để dùng khi TE publish chapter
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
          publication_status: series.publication_status,
          scheduled_publish_at: series.scheduled_publish_at,
        },
        chapters_scheduled: 0,
        chapter_ready_for_mangaka: orderedChapters.length > 0 ? orderedChapters[0]._id : null,
        chapter_status: CHAPTER_STATUS.PENDING_ASSISTANT,
        council_average: councilAvg,
        message: scheduled_publish_at
          ? `Series đã được duyệt. Series sẽ tự động chuyển sang "published" vào ${new Date(scheduled_publish_at).toLocaleString("vi-VN")}. Chapter đầu tiên sẽ được trả về cho Mangaka để giao task cho Assistant sửa, sau đó gửi TE review và TE sẽ publish.`
          : `Series đã được duyệt. Chapter đầu tiên sẽ được trả về cho Mangaka để giao task cho Assistant sửa, sau đó gửi TE review và TE sẽ publish.`,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /eb-evaluations/rubrics ──────────────────────────────────────────────
/**
 * Trả về danh sách tất cả rubric có sẵn để EB chọn.
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       rubrics: [
 *         { id, family, age_rating, weights, criteria, total_weight, has_extensions, extensions }
 *       ],
 *       families: [...],
 *       age_ratings: [...]
 *     }
 *   }
 */
router.get("/rubrics", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { family } = req.query;

    let rubrics;
    if (family && family !== "all") {
      rubrics = listRubricsForFamily(family);
    } else {
      rubrics = listAllRubrics();
    }

    return res.json({
      success: true,
      data: {
        rubrics,
        families: getAllFamilies(),
        age_ratings: ["All ages", "Teens 13+", "Mature 17+", "Adults Only 18+"],
        extension_criteria: Object.values(EXTENSION_CRITERIA).map((e) => ({
          key:         e.key,
          label:       e.label,
          description: e.description,
        })),
        age_safety_fields: AGE_SAFETY_FIELDS,
        age_safety_levels: AGE_SAFETY_LEVELS,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /eb-evaluations/suggest-rubric/:seriesId ─────────────────────────────
/**
 * Gợi ý rubric cho một series cụ thể dựa trên genre[] + age_rating.
 *
 * Hỗ trợ multi-genre: BE sẽ thử tất cả genre trong `series.genre`,
 * sau đó trả về rubric theo family[0] (theo thứ tự trong mảng) + alternatives.
 *
 * Hỗ trợ debug mode (?debug=true) — trả về raw DB values cho FE inspect.
 *
 * Query:
 *   debug    (optional, "true")  — include raw input + validation details
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       suggested_rubric: {
 *         id, family, age_rating, weights, criteria, total_weight,
 *         has_extensions, extensions,
 *         source_genres, source_family,
 *         same_family_alternatives,    // cùng family, age_rating khác
 *         cross_family_alternatives,   // family khác, cùng age_rating
 *         suggested: true | false,
 *         reason?: string,
 *       },
 *       validation: { valid, can_suggest, errors, warnings, normalized },
 *       series_info: { _id, name, genre, age_rating },
 *       alternatives: [...],          // gộp same + cross family
 *       debug?: { raw_input, lookup_trace }  // chỉ khi debug=true
 *     }
 *   }
 */
router.get("/suggest-rubric/:seriesId", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const series = await Series.findOne({ _id: req.params.seriesId }).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const suggested = getSuggestedRubricForSeries(series);
    const validation = suggested.validation;

    // Gộp same + cross family alternatives, loại bỏ primary
    const sameFamily = suggested.same_family_alternatives || [];
    const crossFamily = suggested.cross_family_alternatives || [];
    const allAlternatives = [...sameFamily, ...crossFamily].filter(
      (r) => r.id !== suggested.id
    );

    const responseData = {
      suggested_rubric: suggested,
      validation,
      series_info: {
        _id:        series._id,
        name:       series.name,
        genre:      series.genre,
        age_rating: series.age_rating,
      },
      alternatives: allAlternatives,
    };

    // Debug mode: trả raw values + lookup trace
    if (req.query.debug === "true") {
      const genreTrace = (series.genre || []).map((g) => {
        const result = findFamilyForGenre(g);
        return {
          input_genre:   g,
          normalized:    normalizeGenreKey(g),
          matched_genre: result.matched_genre,
          family:        result.family,
          match_type:    result.matched_genre === g ? "exact" : "normalized",
        };
      });

      const ageCheck = validateAgeRating(series.age_rating);
      responseData.debug = {
        raw_input: {
          genre:      series.genre,
          age_rating: series.age_rating,
        },
        lookup_trace: {
          genre_resolution: genreTrace,
          age_rating_check: ageCheck,
          matrix_lookup:    validation.normalized.matched_families.map((fam) => ({
            family:     fam,
            entry:      WEIGHT_MATRIX[fam]?.[validation.normalized.normalized_age_rating] || null,
            entry_keys: WEIGHT_MATRIX[fam] ? Object.keys(WEIGHT_MATRIX[fam]) : [],
          })),
        },
      };
    }

    return res.json({ success: true, data: responseData });
  } catch (error) {
    next(error);
  }
});

// ─── GET /eb-evaluations/age-safety-check ─────────────────────────────────────
/**
 * Kiểm tra nhanh age safety mà không cần lưu evaluation.
 *
 * Query params:
 *   age_rating   — độ tuổi mục tiêu (All ages | Teens 13+ | Mature 17+ | Adults Only 18+)
 *   violence     — 0–3
 *   fear         — 0–3
 *   profanity    — 0–3
 *   nudity       — 0–3
 *   danger_simulation — 0–3
 *
 * Response:
 *   { success: true, data: { passed, violations, severity, highest_level, rules_note } }
 */
router.get("/age-safety-check", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { age_rating, violence, fear, profanity, nudity, danger_simulation } = req.query;

    if (!age_rating) {
      return next(new AppError("age_rating là bắt buộc", 400));
    }

    const contentLevels = {
      violence:           violence ? parseInt(violence, 10) : 0,
      fear:              fear ? parseInt(fear, 10) : 0,
      profanity:         profanity ? parseInt(profanity, 10) : 0,
      nudity:            nudity ? parseInt(nudity, 10) : 0,
      danger_simulation: danger_simulation ? parseInt(danger_simulation, 10) : 0,
    };

    const result = checkAgeSafety(contentLevels, age_rating);

    return res.json({
      success: true,
      data: {
        ...result,
        content_levels: contentLevels,
        age_rating,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /eb-evaluations/preview-council-average ──────────────────────────────
/**
 * Preview weighted council average trước khi lưu (dùng trong FE form trước khi submit).
 *
 * Body:
 *   {
 *     rubric_id: "action-adventure|teens_13+",
 *     member_scores: [
 *       { member_name: "A", scores: { story_dialogue: 4, art_design: 4, ... } },
 *       { member_name: "B", scores: { story_dialogue: 3.5, art_design: 4, ... } },
 *       ...
 *     ]
 *   }
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       rubric: { id, weights, criteria },
 *       weighted_council_average: 3.85,
 *       per_criteria_averages: { story_dialogue: 3.83, art_design: 4.0, ... },
 *       classification: "GOOD",
 *       classification_text: "Tốt"
 *     }
 *   }
 */
router.post("/preview-council-average", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { rubric_id, member_scores } = req.body;

    if (!member_scores || !Array.isArray(member_scores)) {
      return next(new AppError("member_scores là bắt buộc", 400));
    }

    const rubric = rubric_id ? getRubricById(rubric_id) : null;
    if (rubric_id && !rubric) {
      return next(new AppError(`Rubric "${rubric_id}" không hợp lệ.`, 400));
    }

    // Default: equal weights nếu không có rubric
    const weights = rubric ? rubric.weights : null;
    const councilAvg = weights
      ? computeWeightedCouncilAverage(member_scores, weights)
      : 0;

    // Per-criteria averages
    const allKeys = rubric
      ? Object.keys(weights)
      : CORE_CRITERIA_KEYS;
    const perCriteriaAvg = {};
    for (const key of allKeys) {
      const avg = member_scores.reduce((acc, m) => acc + (m.scores?.[key] || 0), 0)
               / member_scores.length;
      perCriteriaAvg[key] = Math.round(avg * 100) / 100;
    }

    const classification = classifyByScore(councilAvg);
    const classificationText = classifyText(councilAvg);

    return res.json({
      success: true,
      data: {
        rubric: rubric || null,
        weighted_council_average: councilAvg,
        per_criteria_averages: perCriteriaAvg,
        classification,
        classification_text: classificationText,
        pass_threshold: 2.5,
        is_pass: councilAvg >= 2.5,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /eb-evaluations/publication-schedule ───────────────────────────────────
/**
 * EB xem lịch phát hành các Series — dạng calendar + list.
 *
 * - Series-level events: từ Series.scheduled_publish_at (lúc Series chuyển sang "published").
 * - Chapter-level events: từ Chapter.scheduled_publish_at (các chapter đã được TE lên lịch — flow cũ).
 * - Các mốc "phát hành định kỳ" được tính tương đối theo publication_schedule:
 *   weekly → +7 ngày, monthly → +30 ngày (kể từ scheduled_publish_at gốc).
 *
 * Query params:
 *   from, to      (ISO date, optional)  — Lọc event trong khoảng [from, to].
 *                                          Mặc định: from = hôm nay − 30 ngày, to = hôm nay + 90 ngày.
 *   publication_schedule (optional)      — Lọc theo "weekly" | "monthly".
 *   view          (optional)            — "calendar" (default) | "list"
 *                                          calendar: gom event theo ngày, kèm danh sách.
 *                                          list:    trả từng Series kèm mảng event.
 *   include_overdue (optional, "true")  — include Series đã quá hạn nhưng chưa published.
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       view: "calendar" | "list",
 *       range: { from, to },
 *       events: [...]   // calendar: phẳng theo ngày; list: 1 event / Series
 *     }
 *   }
 */
router.get("/publication-schedule", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setDate(defaultFrom.getDate() - 30);
    const defaultTo = new Date(now);
    defaultTo.setDate(defaultTo.getDate() + 90);

    const from = req.query.from ? new Date(req.query.from) : defaultFrom;
    const to = req.query.to ? new Date(req.query.to) : defaultTo;
    const view = req.query.view === "list" ? "list" : "calendar";
    const includeOverdue = req.query.include_overdue === "true";
    const scheduleFilter = ["weekly", "monthly"].includes(req.query.publication_schedule)
      ? req.query.publication_schedule
      : null;

    // ----- Series có lịch phát hành -----
    // Lấy Series có scheduled_publish_at (set lúc EB confirm-publish).
    const seriesFilter = {
      scheduled_publish_at: { $ne: null },
      status: { $in: [SERIES_STATUS.APPROVED_BY_EB, SERIES_STATUS.PUBLISHED] },
    };
    if (scheduleFilter) seriesFilter.publication_schedule = scheduleFilter;

    const seriesList = await Series.find(seriesFilter)
      .populate("author_id", "username full_name")
      .select(
        "name status publication_schedule scheduled_publish_at author_id cover_image_url"
      )
      .lean();

    // ----- Chapter có lịch phát hành (flow cũ, tương thích ngược) -----
    const chapterList = await Chapter.find({
      is_scheduled: true,
      scheduled_publish_at: { $ne: null, $gte: from, $lte: to },
    })
      .populate("series_id", "name cover_image_url publication_schedule")
      .select("chapter_number title scheduled_publish_at series_id status is_published published_at")
      .lean();

    // ----- Tính "next publish date" cho mỗi Series dựa trên publication_schedule -----
    // Nếu Series.published: next = last_published + 7 (weekly) | 30 (monthly) ngày
    // Nếu Series.approved_by_EB nhưng chưa published: next = scheduled_publish_at (nếu trong tương lai)
    const seriesSchedules = seriesList
      .map((series) => {
        const intervalDays =
          series.publication_schedule === "weekly"
            ? 7
            : series.publication_schedule === "monthly"
              ? 30
              : null;

        // Lấy chapter đã publish gần nhất của Series
        let lastPublishedChapter = null;
        // (Không query thêm DB để giữ response nhanh — chỉ dựa vào scheduled_publish_at)

        let nextPublishAt = null;

        if (series.status === SERIES_STATUS.APPROVED_BY_EB) {
          // Chưa publish → next = scheduled_publish_at gốc (nếu trong tương lai)
          nextPublishAt = new Date(series.scheduled_publish_at);
        } else if (series.status === SERIES_STATUS.PUBLISHED && intervalDays) {
          // Đã publish → next = scheduled_publish_at + N khoảng (7/30 ngày)
          const base = new Date(series.scheduled_publish_at);
          // Tính số khoảng đã qua để tìm next trong tương lai
          const ms = now.getTime() - base.getTime();
          const passed = Math.floor(ms / (intervalDays * 24 * 60 * 60 * 1000));
          nextPublishAt = new Date(
            base.getTime() + (passed + 1) * intervalDays * 24 * 60 * 60 * 1000
          );
        }

        if (!nextPublishAt) return null;

        // Lọc theo khoảng [from, to]
        const inRange = nextPublishAt >= from && nextPublishAt <= to;
        if (!inRange) {
          // Nếu overdue và include_overdue=true → include
          if (includeOverdue && nextPublishAt < now && series.status === SERIES_STATUS.APPROVED_BY_EB) {
            // vẫn trả event quá khứ
          } else {
            return null;
          }
        }

        return {
          type: "series",
          series_id: series._id,
          series_name: series.name,
          cover_image_url: series.cover_image_url || "",
          author: series.author_id
            ? { _id: series.author_id._id, name: series.author_id.full_name }
            : null,
          status: series.status,
          publication_schedule: series.publication_schedule,
          scheduled_publish_at: nextPublishAt,
          original_scheduled_publish_at: series.scheduled_publish_at,
          is_overdue: nextPublishAt < now && series.status === SERIES_STATUS.APPROVED_BY_EB,
        };
      })
      .filter(Boolean);

    // ----- Build chapter events -----
    const chapterEvents = chapterList.map((ch) => ({
      type: "chapter",
      chapter_id: ch._id,
      chapter_number: ch.chapter_number,
      chapter_title: ch.title,
      series_id: ch.series_id?._id,
      series_name: ch.series_id?.name,
      cover_image_url: ch.series_id?.cover_image_url || "",
      publication_schedule: ch.series_id?.publication_schedule || null,
      scheduled_publish_at: ch.scheduled_publish_at,
      published_at: ch.published_at || null,
      is_published: !!ch.is_published,
      status: ch.status,
    }));

    // ----- Gộp & sort -----
    const allEvents = [...seriesSchedules, ...chapterEvents].sort(
      (a, b) => new Date(a.scheduled_publish_at) - new Date(b.scheduled_publish_at)
    );

    // ----- Format theo view -----
    let formatted;
    if (view === "calendar") {
      // Gom theo YYYY-MM-DD
      const grouped = {};
      for (const ev of allEvents) {
        const d = new Date(ev.scheduled_publish_at);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (!grouped[key]) grouped[key] = { date: key, events: [] };
        grouped[key].events.push(ev);
      }
      formatted = Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date));
    } else {
      // List view: group theo series
      const seriesMap = {};
      for (const ev of allEvents) {
        const sid = ev.series_id?.toString() || "unknown";
        if (!seriesMap[sid]) {
          seriesMap[sid] = {
            series_id: ev.series_id,
            series_name: ev.series_name,
            cover_image_url: ev.cover_image_url,
            author: ev.author,
            publication_schedule: ev.publication_schedule,
            events: [],
          };
        }
        seriesMap[sid].events.push(ev);
      }
      formatted = Object.values(seriesMap).sort((a, b) =>
        (a.series_name || "").localeCompare(b.series_name || "")
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        view,
        range: {
          from: from.toISOString(),
          to: to.toISOString(),
        },
        total: allEvents.length,
        series_count: seriesSchedules.length,
        chapter_count: chapterEvents.length,
        events: formatted,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
