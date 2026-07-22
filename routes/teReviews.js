const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireTE, requireMangaka, requireTEOrEB, requireMangakaOrTEOrEB } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const Series = require("../models/Series");
const Task = require("../models/Task");
const TEReview = require("../models/TEReview");
const SeriesReview = require("../models/SeriesReview");
const Notification = require("../models/Notification");
const { CHAPTER_STATUS, TE_DECISION, SERIES_STATUS } = require("../utils/constants");
const { ROLES } = require("../utils/constants");
const {
  notifyChapterToTE,
  notifyChapterToEB,
  notifyChapterTERevision,
  notifyChapterTERejected,
  notifyChapterTEPublished,
  notifySeriesRevision,
} = require("../services/notificationService");

// ─── GET /te-reviews/pending ─────────────────────────────────────────────────
/**
 * @swagger
 * /te-reviews/pending:
 *   get:
 *     tags: [TEReviews]
 *     summary: Lấy danh sách chapter chờ TE duyệt (nhóm theo Series)
 *     description: |
 *       TE chỉ thấy chapter:
 *       - Được gán cho mình (te_id = req.user.nameid)
 *       - HOẶC chưa ai gán (te_id = null)
 *       Ở trạng thái `pending_TE` hoặc `approved_by_EB`
 *
 *       Response chia thành 2 nhóm:
 *       - `series_level`: Series chưa EB-approved (status ∈ {draft, submitted, rejected, cancelled})
 *         → TE cần review CẢ Series + Chapter (gửi EB / yêu cầu revision).
 *       - `chapter_level`: Series đã EB-approved (status ∈ {approved_by_EB, approved, published})
 *         → TE chỉ cần publish Chapter thủ công.
 *
 *       FE có thể dùng 2 nhóm này để hiển thị tabs riêng biệt.
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách chapter nhóm theo Series, chia 2 mục series_level và chapter_level
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     series_level:
 *                       type: object
 *                       properties:
 *                         label: { type: string }
 *                         description: { type: string }
 *                         count: { type: number }
 *                         series:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               _id: { type: string }
 *                               name: { type: string }
 *                               status: { type: string }
 *                               cover_image_url: { type: string }
 *                               genre: { type: array, items: { type: string } }
 *                               tags: { type: array, items: { type: string } }
 *                               synopsis: { type: string }
 *                               author: { type: object }
 *                               publication_schedule: { type: string }
 *                               chapter_count: { type: number }
 *                               chapters:
 *                                 type: array
 *                                 items:
 *                                   type: object
 *                                   properties:
 *                                     _id: { type: string }
 *                                     chapter_number: { type: number }
 *                                     title: { type: string }
 *                                     status: { type: string }
 *                                     te_assigned_at: { type: string }
 *                                     updatedAt: { type: string }
 *                                     submitted_by: { type: object }
 *                                     te_review_id: { type: string }
 *                     chapter_level:
 *                       type: object
 *                       properties:
 *                         label: { type: string }
 *                         description: { type: string }
 *                         count: { type: number }
 *                         series:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               (giống series_level)
 *                      
 */
router.get("/pending", authMiddleware, requireTE, async (req, res, next) => {
  try {
    // Lấy tất cả chapters ở trạng thái chờ TE
    const chapters = await Chapter.find({
      status: { $in: [CHAPTER_STATUS.PENDING_TE, CHAPTER_STATUS.APPROVED_BY_EB] },
      $or: [
        { te_id: req.user.nameid },
        { te_id: null },
      ],
    })
      .populate("submitted_by", "username full_name phoneNumber")
      .populate("series_id", "name status publication_schedule author_id cover_image_url genre tags synopsis")
      .sort({ te_assigned_at: 1, updatedAt: 1 })
      .lean();

    // Định nghĩa Series status nào thuộc giai đoạn nào
    const CHAPTER_LEVEL_STATUSES = [
      SERIES_STATUS.APPROVED_BY_EB,
      SERIES_STATUS.APPROVED,
      SERIES_STATUS.PUBLISHED,
    ];

    // Tách chapters vào 2 nhóm
    const seriesLevelChapters = [];
    const chapterLevelChapters = [];

    chapters.forEach((c) => {
      const seriesStatus = c.series_id && c.series_id.status;
      const isChapterLevel = CHAPTER_LEVEL_STATUSES.includes(seriesStatus);
      const enriched = {
        _id: c._id,
        chapter_number: c.chapter_number,
        title: c.title,
        status: c.status,
        te_assigned_at: c.te_assigned_at,
        updatedAt: c.updatedAt,
        submitted_by: c.submitted_by,
        te_review_id: c.te_review_id,
        // QUAN TRỌNG: giữ lại series_id để groupBySeries phía dưới có thể nhóm đúng
        series_id: c.series_id,
      };
      if (isChapterLevel) {
        chapterLevelChapters.push(enriched);
      } else {
        seriesLevelChapters.push(enriched);
      }
    });

    // Helper: nhóm chapters theo series_id
    const groupBySeries = (chaptersList) => {
      const seriesMap = {};
      chaptersList.forEach((chapter) => {
        const seriesId = chapter.series_id?._id?.toString() || chapter.series_id?.toString();
        if (!seriesId) return;
        if (!seriesMap[seriesId]) {
          seriesMap[seriesId] = {
            _id: seriesId,
            name: chapter.series_id?.name || "Unknown Series",
            status: chapter.series_id?.status || "unknown",
            cover_image_url: chapter.series_id?.cover_image_url || "",
            genre: chapter.series_id?.genre || [],
            tags: chapter.series_id?.tags || [],
            synopsis: chapter.series_id?.synopsis || "",
            author: chapter.series_id?.author_id || null,
            publication_schedule: chapter.series_id?.publication_schedule || null,
            chapters: [],
          };
        }
        seriesMap[seriesId].chapters.push(chapter);
      });
      // Sắp xếp series theo updatedAt của chapter mới nhất
      const seriesList = Object.values(seriesMap);
      seriesList.sort((a, b) => {
        const aUpdated = a.chapters[0]?.updatedAt || new Date(0);
        const bUpdated = b.chapters[0]?.updatedAt || new Date(0);
        return new Date(bUpdated) - new Date(aUpdated);
      });
      // Thêm chapter_count
      seriesList.forEach((s) => {
        s.chapter_count = s.chapters.length;
        // Xóa series_id trong từng chapter (đã có ở level ngoài)
        s.chapters.forEach((ch) => {
          delete ch.series_id;
        });
      });
      return seriesList;
    };

    const seriesLevelSeries = groupBySeries(seriesLevelChapters);
    const chapterLevelSeries = groupBySeries(chapterLevelChapters);

    // Đếm tổng chapters
    const seriesLevelCount = seriesLevelChapters.length;
    const chapterLevelCount = chapterLevelChapters.length;

    return res.status(200).json({
      success: true,
      data: {
        series_level: {
          label: "Series chưa được duyệt",
          description: "TE cần review toàn Series + Chapter trước khi gửi EB",
          count: seriesLevelCount,
          series: seriesLevelSeries,
        },
        chapter_level: {
          label: "Series đã được duyệt",
          description: "TE chỉ cần review và publish Chapter",
          count: chapterLevelCount,
          series: chapterLevelSeries,
        },
        // Metadata tổng
        meta: {
          total_chapters: chapters.length,
          total_series: seriesLevelSeries.length + chapterLevelSeries.length,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/history ─────────────────────────────────────────────────
/**
 * @swagger
 * /te-reviews/history:
 *   get:
 *     tags: [TEReviews]
 *     summary: Lịch sử các review của TE hiện tại
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: decision
 *         schema:
 *           type: string
 *           enum: [approved, rejected]
 *         description: Lọc theo quyết định
 *       - in: query
 *         name: from_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Từ ngày (inclusive)
 *       - in: query
 *         name: to_date
 *         schema:
 *           type: string
 *           format: date
 *         description: Đến ngày (inclusive)
 *     responses:
 *       200:
 *         description: Danh sách review đã hoàn thành
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id: { type: string }
 *                       decision: { type: string }
 *                       createdAt: { type: string, format: date-time }
 *                       chapter_id:
 *                         type: object
 *                         properties:
 *                           _id: { type: string }
 *                           chapter_number: { type: number }
 *                           title: { type: string }
 *                           series_id:
 *                             type: object
 *                             properties:
 *                               name: { type: string }
 *                           submitted_by:
 *                             type: object
 *                             properties:
 *                               username: { type: string }
 *                               full_name: { type: string }
 */
router.get("/history", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { decision, from_date, to_date } = req.query;
    const filter = { reviewed_by: req.user.nameid };

    if (decision) filter.decision = decision;
    if (from_date || to_date) {
      filter.createdAt = {};
      if (from_date) filter.createdAt.$gte = new Date(from_date);
      if (to_date)   filter.createdAt.$lte = new Date(to_date);
    }

    const reviews = await TEReview.find(filter)
      .populate({
        path: "chapter_id",
        populate: [
          { path: "series_id", select: "name" },
          { path: "submitted_by", select: "username full_name" },
        ],
      })
      .sort({ createdAt: -1 })
      .lean();

    const enriched = reviews.map((r) => {
      return { ...r };
    });

    return res.status(200).json({ success: true, data: enriched });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/chapter/:chapterId ─────────────────────────────────────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}:
 *   get:
 *     tags: [TEReviews]
 *     summary: Lấy TEReview của một chapter
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Review của chapter
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     _id: { type: string }
 *                     chapter_id: { type: string }
 *                     decision:
 *                       type: string
 *                       enum: [approved, rejected]
 *                     notes: { type: string }
 *                     annotations:
 *                       type: array
 *                       items: { type: object }
 *                     reviewed_by:
 *                       type: object
 *                       properties:
 *                         username: { type: string }
 *                         full_name: { type: string }
 *                         phoneNumber: { type: string }
 *                     createdAt: { type: string, format: date-time }
 *       404:
 *         description: Review not found
 */
router.get("/chapter/:chapterId", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const review = await TEReview.findOne({ chapter_id: req.params.chapterId })
      .populate("reviewed_by", "username full_name phoneNumber")
      .lean();

    if (!review) return next(new AppError("Review not found", 404));

    return res.status(200).json({
      success: true,
      data: review,
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/dashboard ───────────────────────────────────────────────
/**
 * @swagger
 * /te-reviews/dashboard:
 *   get:
 *     tags: [TEReviews]
 *     summary: Dashboard TE - gom chapter theo series + cảnh báo trễ hạn
 *     description: |
 *       Trả về:
 *       - summary: tổng số chapter pending / in-revision / late
 *       - by_series: danh sách series với chapter pending/in-revision, oldest_pending, is_late (>7 ngày), estimated_deadline
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_pending: { type: integer }
 *                         total_in_revision: { type: integer }
 *                         total_chapters: { type: integer }
 *                         series_count: { type: integer }
 *                         late_count: { type: integer }
 *                     by_series:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           series:
 *                             type: object
 *                             properties:
 *                               _id: { type: string }
 *                               name: { type: string }
 *                               publication_schedule:
 *                                 type: string
 *                                 enum: [weekly, monthly]
 *                           pending_count: { type: integer }
 *                           in_revision_count: { type: integer }
 *                           oldest_pending:
 *                             type: object
 *                             nullable: true
 *                             properties:
 *                               _id: { type: string }
 *                               chapter_number: { type: number }
 *                               title: { type: string }
 *                               updatedAt: { type: string, format: date-time }
 *                               age_hours: { type: integer }
 *                           is_late: { type: boolean }
 *                           estimated_deadline:
 *                             type: string
 *                             format: date-time
 *                             nullable: true
 *                           pending_chapters:
 *                             type: array
 *                             items: { type: object }
 *                           in_revision_chapters:
 *                             type: array
 *                             items: { type: object }
 */
router.get("/dashboard", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    const pendingChapters = await Chapter.find({
      status: { $in: [CHAPTER_STATUS.PENDING_TE, CHAPTER_STATUS.APPROVED_BY_EB] },
      $or: [{ te_id: req.user.nameid }, { te_id: null }],
    })
      .select("_id series_id chapter_number title submitted_by updatedAt te_assigned_at status")
      .populate("series_id", "name publication_schedule")
      .populate("submitted_by", "username full_name phoneNumber")
      .lean();

    const inRevisionChapters = await Chapter.find({
      status: CHAPTER_STATUS.TE_REVISION,
      $or: [{ te_id: req.user.nameid }, { te_id: null }],
    })
      .select("_id series_id chapter_number title updatedAt")
      .populate("series_id", "name publication_schedule")
      .lean();

    const bySeriesMap = new Map();
    const ensure = (series, fallbackId) => ({
      series: series || { _id: fallbackId, name: "(unknown)", publication_schedule: null },
      pending_chapters: [],
      in_revision_chapters: [],
    });
    for (const ch of pendingChapters) {
      const sid = ch.series_id ? String(ch.series_id._id) : "unknown";
      if (!bySeriesMap.has(sid)) bySeriesMap.set(sid, ensure(ch.series_id, sid));
      bySeriesMap.get(sid).pending_chapters.push(ch);
    }
    for (const ch of inRevisionChapters) {
      const sid = ch.series_id ? String(ch.series_id._id) : "unknown";
      if (!bySeriesMap.has(sid)) bySeriesMap.set(sid, ensure(ch.series_id, sid));
      bySeriesMap.get(sid).in_revision_chapters.push(ch);
    }

    const bySeries = [];
    for (const [, item] of bySeriesMap) {
      const all = [...item.pending_chapters, ...item.in_revision_chapters];
      const oldest = all.reduce((min, c) => (min === null || new Date(c.updatedAt) < new Date(min) ? c : min), null);
      const oldestAt = oldest ? new Date(oldest.updatedAt) : null;
      const ageHours = oldestAt ? Math.floor((now - oldestAt) / (1000 * 60 * 60)) : null;
      const isLate = oldestAt ? now - oldestAt > SEVEN_DAYS_MS : false;

      let estimatedDeadline = null;
      if (item.series && item.series.publication_schedule && item.series._id) {
        const lastPublished = await Chapter.findOne({ series_id: item.series._id, is_published: true })
          .sort({ published_at: -1 })
          .select("published_at")
          .lean();
        if (lastPublished && lastPublished.published_at) {
          const d = new Date(lastPublished.published_at);
          d.setDate(d.getDate() + (item.series.publication_schedule === "weekly" ? 7 : 30));
          estimatedDeadline = d;
        }
      }

      bySeries.push({
        series: item.series,
        pending_count: item.pending_chapters.length,
        in_revision_count: item.in_revision_chapters.length,
        oldest_pending: oldest
          ? { _id: oldest._id, chapter_number: oldest.chapter_number, title: oldest.title, updatedAt: oldest.updatedAt, age_hours: ageHours }
          : null,
        is_late: isLate,
        estimated_deadline: estimatedDeadline,
        pending_chapters: item.pending_chapters,
        in_revision_chapters: item.in_revision_chapters,
      });
    }

    bySeries.sort((a, b) => {
      if (a.is_late !== b.is_late) return a.is_late ? -1 : 1;
      const aT = a.oldest_pending ? new Date(a.oldest_pending.updatedAt).getTime() : Infinity;
      const bT = b.oldest_pending ? new Date(b.oldest_pending.updatedAt).getTime() : Infinity;
      return aT - bT;
    });

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          total_pending: pendingChapters.length,
          total_in_revision: inRevisionChapters.length,
          total_chapters: pendingChapters.length + inRevisionChapters.length,
          series_count: bySeries.length,
          late_count: bySeries.filter((s) => s.is_late).length,
        },
        by_series: bySeries,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/studio-progress ─────────────────────────────────────────
/**
 * @swagger
 * /te-reviews/studio-progress:
 *   get:
 *     tags: [TEReviews]
 *     summary: Tiến độ studio - thống kê chapter/task theo series
 *     description: |
 *       Trả về tiến độ của các series (đang approved/published).
 *       - Mangaka: chỉ xem series của mình
 *       - TE/EB: xem tất cả
 *       Filter thêm bằng `series_id` query.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: series_id
 *         schema:
 *           type: string
 *         description: Filter theo series ID (optional)
 *     responses:
 *       200:
 *         description: Studio progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_active_series: { type: integer }
 *                         total_chapters_in_production: { type: integer }
 *                         chapters_at_risk: { type: integer }
 *                         fetched_at: { type: string, format: date-time }
 *                     series_progress:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           series:
 *                             type: object
 *                             properties:
 *                               _id: { type: string }
 *                               name: { type: string }
 *                               status: { type: string }
 *                               author_id:
 *                                 type: object
 *                                 properties:
 *                                   username: { type: string }
 *                                   full_name: { type: string }
 *                                   phoneNumber: { type: string }
 *                           task_stats:
 *                             type: object
 *                             properties:
 *                               total: { type: integer }
 *                               by_status:
 *                                 type: object
 *                                 additionalProperties: { type: integer }
 *                               approved: { type: integer }
 *                               completion_rate:
 *                                 type: number
 *                                 nullable: true
 *                           chapter_stats:
 *                             type: object
 *                             properties:
 *                               total: { type: integer }
 *                               by_status:
 *                                 type: object
 *                                 additionalProperties: { type: integer }
 *                               in_production: { type: integer }
 *                               at_risk: { type: integer }
 */
router.get("/studio-progress", authMiddleware, requireMangakaOrTEOrEB, async (req, res, next) => {
  try {
    const { series_id } = req.query;
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const ACTIVE_STATUSES = [
      CHAPTER_STATUS.DRAFT, CHAPTER_STATUS.PENDING_ASSISTANT, CHAPTER_STATUS.PENDING_TE,
      CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.PENDING_EB, CHAPTER_STATUS.EB_REVISION,
      CHAPTER_STATUS.APPROVED_BY_EB,
      CHAPTER_STATUS.PUBLISHED,
    ];

    const seriesFilter = { status: { $in: [SERIES_STATUS.APPROVED_BY_EB, SERIES_STATUS.APPROVED, SERIES_STATUS.PUBLISHED] } };
    if (series_id) seriesFilter._id = series_id;
    if (req.user.role === "Mangaka") seriesFilter.author_id = req.user.nameid;

    const seriesList = await Series.find(seriesFilter)
      .select("_id name status author_id")
      .populate("author_id", "username full_name phoneNumber")
      .lean();

    const result = [];
    let totalChaptersInProduction = 0;
    let chaptersAtRisk = 0;

    for (const s of seriesList) {
      const chapters = await Chapter.find({ series_id: s._id }).select("_id status updatedAt").lean();
      const chapterBreakdown = chapters.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});

      const chapterIds = chapters.map((c) => c._id);
      const tasks = await Task.aggregate([
        { $match: { chapter_id: { $in: chapterIds } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      const taskBreakdown = tasks.reduce((acc, t) => { acc[t._id] = t.count; return acc; }, {});
      const taskTotal = Object.values(taskBreakdown).reduce((a, b) => a + b, 0);
      const taskApproved = taskBreakdown.approved || 0;
      const completionRate = taskTotal === 0 ? null : +(taskApproved / taskTotal).toFixed(2);

      const atRisk = chapters.filter((c) => {
        if (![CHAPTER_STATUS.PENDING_TE, CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.PENDING_EB, CHAPTER_STATUS.EB_REVISION, CHAPTER_STATUS.APPROVED_BY_EB].includes(c.status)) return false;
        return now - new Date(c.updatedAt) > SEVEN_DAYS_MS;
      }).length;
      chaptersAtRisk += atRisk;
      totalChaptersInProduction += chapters.filter((c) => ACTIVE_STATUSES.includes(c.status)).length;

      result.push({
        series: s,
        task_stats: { total: taskTotal, by_status: taskBreakdown, approved: taskApproved, completion_rate: completionRate },
        chapter_stats: {
          total: chapters.length, by_status: chapterBreakdown,
          in_production: chapters.filter((c) => ACTIVE_STATUSES.includes(c.status)).length, at_risk: atRisk,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        summary: { total_active_series: seriesList.length, total_chapters_in_production: totalChaptersInProduction, chapters_at_risk: chaptersAtRisk, fetched_at: now },
        series_progress: result,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  SERIES REVIEW — đánh giá 4 tiêu chí + feedback CHO SERIES
// ════════════════════════════════════════════════════════════════════════════

// ─── GET /series-review/:seriesId ────────────────────────────────────────────
/**
 * @swagger
 * /te-reviews/series-review/{seriesId}:
 *   get:
 *     tags: [TEReviews]
 *     summary: Lấy series review hiện tại của TE cho series
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Series review (null nếu chưa có)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     review:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         _id: { type: string }
 *                         series_id: { type: string }
 *                         decision:
 *                           type: string
 *                           enum: [draft, approved, revision]
 *                         feedback: { type: string }
 *                         quick_notes: { type: string }
 *                         revision_feedback: { type: string }
 *                         createdAt: { type: string, format: date-time }
 *                         updatedAt: { type: string, format: date-time }
 *       404:
 *         description: Series not found
 */
router.get("/series-review/:seriesId", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { seriesId } = req.params;

    const series = await Series.findById(seriesId).lean();
    if (!series) return next(new AppError("Series not found", 404));

    let review = await SeriesReview.findOne({ series_id: seriesId, reviewed_by: req.user.nameid }).lean();

    return res.status(200).json({
      success: true,
      data: {
        review: review
          ? {
              _id: review._id,
              series_id: review.series_id,
              decision: review.decision,
              feedback: review.feedback,
              quick_notes: review.quick_notes,
              revision_feedback: review.revision_feedback,
              createdAt: review.createdAt,
              updatedAt: review.updatedAt,
            }
          : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /series-review/:seriesId ───────────────────────────────────────────
/**
 * @swagger
 * /te-reviews/series-review/{seriesId}:
 *   post:
 *     tags: [TEReviews]
 *     summary: Save draft Series review (không gửi đi)
 *     description: |
 *       [Nút: Save Review] — Lưu nháp đánh giá series, KHÔNG gửi đi.
 *       Tạo mới nếu chưa có, cập nhật nếu đã có.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               feedback:
 *                 type: string
 *               quick_notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Draft saved
 *       404:
 *         description: Series not found
 */
router.post("/series-review/:seriesId", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const { feedback, quick_notes } = req.body;

    const series = await Series.findById(seriesId).lean();
    if (!series) return next(new AppError("Series not found", 404));

    let review = await SeriesReview.findOne({ series_id: seriesId, reviewed_by: req.user.nameid });
    if (review) {
      if (feedback !== undefined) review.feedback = feedback;
      if (quick_notes !== undefined) review.quick_notes = quick_notes;
    } else {
      review = await SeriesReview.create({
        series_id: seriesId,
        reviewed_by: req.user.nameid,
        decision: "draft",
        feedback: feedback || "",
        quick_notes: quick_notes || "",
      });
    }
    await review.save();

    return res.status(200).json({
      success: true,
      data: {
        _id: review._id,
        series_id: review.series_id,
        decision: review.decision,
        feedback: review.feedback,
        quick_notes: review.quick_notes,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /series-review/:seriesId/submit ────────────────────────────────────
/**
 * @swagger
 * /te-reviews/series-review/{seriesId}/submit:
 *   post:
 *     tags: [TEReviews]
 *     summary: TE submit Series review (approve → EB / reject → Mangaka)
 *     description: |
 *       [Nút: Approve & Publish / Reject & Request Edit]
 *
 *       - action = "approve":
 *         - Tất cả chapter `pending_TE` của series (được assign cho TE này) → `pending_EB`
 *         - Gửi notification cho tất cả EB
 *         - SeriesReview.decision = "approved"
 *       - action = "reject":
 *         - Series → revision (revision_source = "TE", revision_notes = revision_feedback)
 *         - Gửi notification cho Mangaka
 *         - SeriesReview.decision = "revision"
 *
 *       Chapter chỉ là nội dung TE review để đưa ra quyết định cho Series.
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
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [approve, reject]
 *                 description: Hành động của TE
 *               feedback:
 *                 type: string
 *                 description: Feedback tổng hợp cho series
 *               quick_notes:
 *                 type: string
 *                 description: Ghi chú nhanh
 *               revision_feedback:
 *                 type: string
 *                 description: Feedback yêu cầu sửa (chỉ dùng khi action=reject)
 *     responses:
 *       200:
 *         description: Series review submitted
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
 *                     action:
 *                       type: string
 *                       enum: [approve, reject]
 *                     message:
 *                       type: string
 *                     chapters_to_eb:
 *                       type: array
 *                       description: Chỉ trả về khi action=approve
 *                       items:
 *                         type: object
 *                         properties:
 *                           _id: { type: string }
 *                           chapter_number: { type: number }
 *                           title: { type: string }
 *                     review:
 *                       type: object
 *                       properties:
 *                         _id: { type: string }
 *                         decision:
 *                           type: string
 *                           enum: [approved, revision]
 *                         feedback: { type: string }
 *                         quick_notes: { type: string }
 *                         revision_feedback: { type: string }
 *       400:
 *         description: Invalid action
 *       404:
 *         description: Series not found
 */
router.post("/series-review/:seriesId/submit", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const { action, feedback, quick_notes, revision_feedback } = req.body;

    if (!action || !["approve", "reject"].includes(action)) {
      return next(new AppError("action is required and must be 'approve' or 'reject'", 400));
    }

    const series = await Series.findById(seriesId).lean();
    if (!series) return next(new AppError("Series not found", 404));

    let review = await SeriesReview.findOne({ series_id: seriesId, reviewed_by: req.user.nameid });
    if (review) {
      if (feedback !== undefined) review.feedback = feedback;
      if (quick_notes !== undefined) review.quick_notes = quick_notes;
      if (revision_feedback !== undefined) review.revision_feedback = revision_feedback;
    } else {
      review = await SeriesReview.create({
        series_id: seriesId,
        reviewed_by: req.user.nameid,
        feedback: feedback || "",
        quick_notes: quick_notes || "",
        revision_feedback: revision_feedback || "",
      });
    }
    await review.save();

    if (action === "approve") {
      review.decision = "approved";
      await review.save();

      const chaptersToEB = await Chapter.find({
        series_id: seriesId,
        status: CHAPTER_STATUS.PENDING_TE,
        te_id: req.user.nameid,
      }).lean();

      await Chapter.updateMany(
        {
          series_id: seriesId,
          status: CHAPTER_STATUS.PENDING_TE,
          te_id: req.user.nameid,
        },
        {
          status: CHAPTER_STATUS.PENDING_EB,
          revision_notes: "",
          revision_annotations: [],
          revision_source: "",
          is_published: false,
        }
      );

      const ebUsers = await require("../models/User").find({ role: ROLES.EB }).lean();
      for (const eb of ebUsers) {
        for (const ch of chaptersToEB) {
          await notifyChapterToEB(Notification, eb._id, ch, series.name);
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          action: "approve",
          message: `${chaptersToEB.length} chapter(s) chuyển sang pending_EB.`,
          chapters_to_eb: chaptersToEB.map((c) => ({ _id: c._id, chapter_number: c.chapter_number, title: c.title })),
          review: {
            _id: review._id,
            decision: review.decision,
            feedback: review.feedback,
            quick_notes: review.quick_notes,
          },
        },
      });
    } else {
      review.decision = "revision";
      review.revision_feedback = revision_feedback || review.revision_feedback || "";
      await review.save();

      await Series.findByIdAndUpdate(seriesId, {
        revision_notes: review.revision_feedback,
        revision_source: "TE",
      });

      await notifySeriesRevision(Notification, series.author_id, series, review.revision_feedback);

      return res.status(200).json({
        success: true,
        data: {
          action: "reject",
          message: "Series chuyển sang revision.",
          review: {
            _id: review._id,
            decision: review.decision,
            feedback: review.feedback,
            quick_notes: review.quick_notes,
            revision_feedback: review.revision_feedback,
          },
        },
      });
    }
  } catch (error) {
    next(error);
  }
});

// ─── POST /te-reviews/series-review/:seriesId/review-chapter ─────────────────
/**
 * @swagger
 * /te-reviews/series-review/{seriesId}/review-chapter:
 *   post:
 *     tags: [TEReviews]
 *     summary: TE review Chapter + Series trong cùng 1 lần (gộp 2 API thành 1)
 *     description: |
 *       API này gộp chức năng của 2 API cũ:
 *       - `POST /te-reviews/chapter/:chapterId/te-action`
 *       - `POST /te-reviews/series-review/:seriesId/submit`
 *
 *       TE chỉ cần gọi 1 lần duy nhất thay vì 2 lần tuần tự. Tránh notify EB trùng lặp,
 *       tránh inconsistent state khi 1 trong 2 API bị fail giữa chừng.
 *
 *       **Flow xử lý:**
 *       - `action = "approve"`:
 *         - Lưu SeriesReview.feedback
 *         - Nếu Series chưa EB-approved → Chapter → "pending_EB" + notify EB (1 LẦN)
 *         - Nếu Series đã EB-approved (chapter_level) → Chapter → "published" + notify Mangaka
 *       - `action = "reject"`:
 *         - Chapter → "TE_revision" + lưu revision_notes
 *         - Series có revision_notes (lưu revision_feedback)
 *         - notifySeriesRevision + notifyChapterTERevision (notify Mangaka)
 *
 *       **Lợi ích so với 2 API cũ:**
 *       - 1 HTTP call thay vì 2
 *       - 1 transaction logic, không sợ 1 bên fail
 *       - Notify EB chỉ 1 lần (không bị duplicate)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [chapter_id, action]
 *             properties:
 *               chapter_id: { type: string }
 *               action: { type: string, enum: [approve, reject] }
 *               notes:
 *                 type: array
 *                 items: { type: string }
 *                 description: 'Ghi chú nội bộ (dùng cho cả approve/reject)'
 *               feedback:
 *                 type: string
 *                 description: 'Feedback cho Series (vd: Series concept rất tốt)'
 *               revision_notes:
 *                 type: string
 *                 description: 'Ghi chú yêu cầu sửa (chỉ cần khi reject)'
 *     responses:
 *       200:
 *         description: Thành công
 *       400: { description: Thiếu trường hoặc action không hợp lệ }
 *       403: { description: TE không được gán chapter }
 *       404: { description: Series hoặc Chapter không tồn tại }
 */
router.post("/series-review/:seriesId/review-chapter", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const { chapter_id, action, notes, feedback, revision_notes } = req.body;

    // Validate input
    if (!chapter_id) {
      return next(new AppError("chapter_id is required", 400));
    }
    if (!action || !["approve", "reject"].includes(action)) {
      return next(new AppError("action is required and must be 'approve' or 'reject'", 400));
    }

    // Lấy Series + Chapter
    const series = await Series.findById(seriesId);
    if (!series) return next(new AppError("Series not found", 404));

    const chapter = await Chapter.findById(chapter_id);
    if (!chapter) return next(new AppError("Chapter not found", 404));

    // Check chapter thuộc series
    if (String(chapter.series_id) !== String(seriesId)) {
      return next(new AppError("Chapter does not belong to this series", 400));
    }

    // Check TE có được gán chapter không
    // Logic: Nếu chapter chưa được gán (te_id = null), TE hiện tại sẽ tự nhận.
    //       Nếu đã được gán → chỉ TE đó mới được review.
    if (chapter.te_id && String(chapter.te_id) !== String(req.user.nameid)) {
      return next(new AppError("Chapter này đã được gán cho TE khác", 403));
    }
    if (!chapter.te_id) {
      // Auto-claim chapter
      chapter.te_id = req.user.nameid;
      chapter.te_assigned_at = new Date();
    }

    // Lưu SeriesReview (dùng chung cho cả approve/reject)
    let seriesReview = await SeriesReview.findOne({
      series_id: seriesId,
      reviewed_by: req.user.nameid,
    });

    const notesJoined = Array.isArray(notes) ? notes.join("\n") : (notes || "");

    if (!seriesReview) {
      seriesReview = new SeriesReview({
        series_id: seriesId,
        reviewed_by: req.user.nameid,
        feedback: feedback || "",
        quick_notes: notesJoined,
        revision_feedback: revision_notes || "",
      });
    } else {
      if (feedback !== undefined) seriesReview.feedback = feedback;
      if (notes !== undefined) seriesReview.quick_notes = notesJoined;
      if (revision_notes !== undefined) seriesReview.revision_feedback = revision_notes;
    }

    // ─── XỬ LÝ ACTION APPROVE ─────────────────────────────────────
    if (action === "approve") {
      // Lưu SeriesReview.decision = "approved"
      seriesReview.decision = "approved";
      await seriesReview.save();

      // Kiểm tra Series đã EB duyệt chưa
      const seriesApproved = [
        SERIES_STATUS.APPROVED_BY_EB,
        SERIES_STATUS.APPROVED,
        SERIES_STATUS.PUBLISHED,
      ].includes(series.status);

      if (seriesApproved) {
        // Series đã EB-approved → Publish chapter (chapter_level)
        chapter.status = CHAPTER_STATUS.PUBLISHED;
        chapter.is_published = true;
        chapter.published_at = new Date();
        chapter.revision_notes = "";
        chapter.revision_annotations = [];
        chapter.revision_source = "";
        await chapter.save();

        const teReview = await TEReview.findOne({ chapter_id: chapter_id });
        if (teReview) {
          teReview.decision = TE_DECISION.APPROVED_PUBLISH;
          await teReview.save();
        }

        await notifyChapterTEPublished(
          Notification,
          chapter.submitted_by,
          chapter,
          series.name
        );

        return res.status(200).json({
          success: true,
          message: "Chapter đã được publish.",
          data: {
            chapter,
            series_review: {
              _id: seriesReview._id,
              decision: seriesReview.decision,
              feedback: seriesReview.feedback,
              quick_notes: seriesReview.quick_notes,
            },
          },
        });
      } else {
        // Series chưa EB-approved → Chapter → pending_EB (gửi EB duyệt)
        chapter.status = CHAPTER_STATUS.PENDING_EB;
        chapter.revision_notes = "";
        chapter.revision_annotations = [];
        chapter.revision_source = "";
        await chapter.save();

        const teReview = await TEReview.findOne({ chapter_id: chapter_id });
        if (teReview) {
          teReview.decision = TE_DECISION.APPROVED;
          await teReview.save();
        }

        // Notify EB (CHỈ 1 LẦN)
        const ebUsers = await require("../models/User").find({ role: ROLES.EB }).lean();
        for (const eb of ebUsers) {
          await notifyChapterToEB(Notification, eb._id, chapter, series.name);
        }

        return res.status(200).json({
          success: true,
          message: "Chapter đã được gửi lên EB để duyệt Series.",
          data: {
            chapter,
            series_review: {
              _id: seriesReview._id,
              decision: seriesReview.decision,
              feedback: seriesReview.feedback,
              quick_notes: seriesReview.quick_notes,
            },
          },
        });
      }
    }

    // ─── XỬ LÝ ACTION REJECT ─────────────────────────────────────
    // (action === "reject")
    seriesReview.decision = "revision";
    seriesReview.revision_feedback = revision_notes || seriesReview.revision_feedback || "";
    await seriesReview.save();

    // Chapter → TE_revision
    chapter.status = CHAPTER_STATUS.TE_REVISION;
    chapter.revision_notes = seriesReview.revision_feedback;
    chapter.revision_source = "TE";

    // Copy TEReview.annotations → chapter.revision_annotations
    const teReview = await TEReview.findOne({ chapter_id: chapter_id });
    if (teReview && teReview.annotations.length > 0) {
      chapter.revision_annotations = teReview.annotations.map((a) => ({
        page_id: a.page_id,
        region: {
          x: a.region.x,
          y: a.region.y,
          width: a.region.width,
          height: a.region.height,
        },
        content: a.content,
        error_type: a.error_type || "other",
      }));
    } else {
      chapter.revision_annotations = [];
    }
    await chapter.save();

    if (teReview) {
      teReview.decision = TE_DECISION.REVISION;
      teReview.revision_feedback = seriesReview.revision_feedback;
      await teReview.save();
    }

    // Gắn revision_notes vào Series (để Mangaka thấy feedback toàn Series)
    series.revision_notes = seriesReview.revision_feedback;
    series.revision_source = "TE";
    await series.save();

    // Notify Mangaka
    await notifySeriesRevision(Notification, series.author_id, series, seriesReview.revision_feedback);
    await notifyChapterTERevision(Notification, chapter.submitted_by, chapter, chapter.revision_notes);

    return res.status(200).json({
      success: true,
      message: "Đã yêu cầu Mangaka chỉnh sửa chapter + series.",
      data: {
        chapter,
        series_review: {
          _id: seriesReview._id,
          decision: seriesReview.decision,
          feedback: seriesReview.feedback,
          quick_notes: seriesReview.quick_notes,
          revision_feedback: seriesReview.revision_feedback,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /series-review/:seriesId/next-chapter ───────────────────────────────
/**
 * @swagger
 * /te-reviews/series-review/{seriesId}/next-chapter:
 *   get:
 *     tags: [TEReviews]
 *     summary: Lấy chapter pending_TE tiếp theo của series (cho nút Next Chapter)
 *     description: |
 *       Tìm chapter `pending_TE` được assign cho TE hiện tại,
 *       sắp xếp theo chapter_number tăng dần (ưu tiên chapter nhỏ nhất).
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Next chapter (null nếu hết)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     next_chapter:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         _id: { type: string }
 *                         chapter_number: { type: number }
 *                         title: { type: string }
 *                         status: { type: string }
 *                         submitted_by:
 *                           type: object
 *                           properties:
 *                             username: { type: string }
 *                             full_name: { type: string }
 *                         series:
 *                           type: object
 *                           properties:
 *                             _id: { type: string }
 *                             name: { type: string }
 *                         updatedAt: { type: string, format: date-time }
 *                     message:
 *                       type: string
 *       404:
 *         description: Series not found
 */
router.get("/series-review/:seriesId/next-chapter", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { seriesId } = req.params;

    const series = await Series.findById(seriesId).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const nextChapter = await Chapter.findOne({
      series_id: seriesId,
      status: CHAPTER_STATUS.PENDING_TE,
      te_id: req.user.nameid,
    })
      .sort({ chapter_number: 1 })
      .populate("submitted_by", "username full_name phoneNumber")
      .lean();

    if (!nextChapter) {
      return res.status(200).json({
        success: true,
        data: { next_chapter: null, message: "Không còn chapter nào đang chờ TE trong series này." },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        next_chapter: {
          _id: nextChapter._id,
          chapter_number: nextChapter.chapter_number,
          title: nextChapter.title,
          status: nextChapter.status,
          submitted_by: nextChapter.submitted_by,
          series: { _id: series._id, name: series.name },
          updatedAt: nextChapter.updatedAt,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/series/:seriesId/profile ───────────────────────────────
/**
 * @swagger
 * /te-reviews/series/{seriesId}/profile:
 *   get:
 *     tags: [TEReviews]
 *     summary: Profile tổng hợp của series cho TE/EB
 *     description: |
 *       Trả về:
 *       - Series info
 *       - chapter_status_breakdown: số chapter theo từng status
 *       - my_series_review: SeriesReview của TE/EB hiện tại cho series này
 *       - my_approved_count: số chapter mà TE hiện tại đã approved
 *       - ranking: vị trí xếp hạng theo average_score trong tất cả series published
 *       - recent_chapters: 10 chapter gần nhất
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Series profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     series:
 *                       $ref: '#/components/schemas/Series'
 *                     chapter_status_breakdown:
 *                       type: object
 *                       additionalProperties: { type: integer }
 *                     my_series_review:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         _id: { type: string }
 *                         decision:
 *                           type: string
 *                           enum: [draft, approved, revision]
 *                         feedback: { type: string }
 *                         quick_notes: { type: string }
 *                         revision_feedback: { type: string }
 *                     my_approved_count: { type: integer }
 *                     ranking:
 *                       type: object
 *                       properties:
 *                         position: { type: integer, nullable: true }
 *                         score: { type: number }
 *                         total_votes: { type: integer }
 *                     recent_chapters:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           _id: { type: string }
 *                           chapter_number: { type: number }
 *                           title: { type: string }
 *                           status: { type: string }
 *                           updatedAt: { type: string, format: date-time }
 *       404:
 *         description: Series not found
 */
router.get("/series/:seriesId/profile", authMiddleware, requireTEOrEB, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const series = await Series.findById(seriesId).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const chapterAgg = await Chapter.aggregate([
      { $match: { series_id: series._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const chapterBreakdown = chapterAgg.reduce((acc, cur) => { acc[cur._id] = cur.count; return acc; }, {});

    const allPublished = await Series.find({ is_public: true, status: "published" })
      .select("_id average_score total_votes").lean();
    const sorted = [...allPublished].sort((a, b) => {
      if (b.average_score !== a.average_score) return b.average_score - a.average_score;
      return (b.total_votes || 0) - (a.total_votes || 0);
    });
    const rankingPosition = sorted.findIndex((s) => String(s._id) === String(series._id)) + 1 || null;

    const chapters = await Chapter.find({ series_id: series._id })
      .select("_id chapter_number title status updatedAt")
      .sort({ chapter_number: -1 }).lean();

    // Lấy series review của TE đang login
    const seriesReview = await SeriesReview.findOne({ series_id: seriesId, reviewed_by: req.user.nameid }).lean();

    const myApprovedCount = await TEReview.countDocuments({
      reviewed_by: req.user.nameid,
      decision: { $in: [TE_DECISION.APPROVED, TE_DECISION.APPROVED_PUBLISH] },
    });

    return res.status(200).json({
      success: true,
      data: {
        series,
        chapter_status_breakdown: chapterBreakdown,
        my_series_review: seriesReview
          ? {
              _id: seriesReview._id,
              decision: seriesReview.decision,
              feedback: seriesReview.feedback,
              quick_notes: seriesReview.quick_notes,
              revision_feedback: seriesReview.revision_feedback,
            }
          : null,
        my_approved_count: myApprovedCount,
        ranking: {
          position: rankingPosition,
          score: series.average_score,
          total_votes: series.total_votes,
          in_top_50: rankingPosition !== null && rankingPosition <= 50,
        },
        chapters,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  CHAPTER ANNOTATION — vẽ ô khoanh trên trang của chapter
// ════════════════════════════════════════════════════════════════════════════

// ─── GET /te-reviews/chapter/:chapterId/pages ────────────────────────────────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/pages:
 *   get:
 *     tags: [TEReviews]
 *     summary: Lấy pages của chapter (kèm annotations) để TE review
 *     description: |
 *       - `page=N`: lấy 1 page (mặc định page=1), trả về pagination
 *       - `all=true`: lấy tất cả pages cùng lúc
 *       Mỗi page có format URL normalize (final_image_url, result_image_url, original_image_url, url, image_url, imageUrl)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *           default: false
 *     responses:
 *       200:
 *         description: Pages + annotations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: object
 *                       nullable: true
 *                     pages:
 *                       type: array
 *                       items: { type: object }
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page: { type: integer }
 *                         limit: { type: integer }
 *                         total: { type: integer }
 *                         has_prev: { type: boolean }
 *                         has_next: { type: boolean }
 *                         prev_page: { type: integer, nullable: true }
 *                         next_page: { type: integer, nullable: true }
 *                     annotations:
 *                       type: array
 *                       items: { type: object }
 *       404:
 *         description: Chapter not found
 */
// Query params:
//   page=N      - Lấy 1 page (mặc định)
//   all=true    - Lấy tất cả pages cùng lúc
router.get("/chapter/:chapterId/pages", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId } = req.params;
    const pageNum = parseInt(req.query.page) || 1;
    const getAll = req.query.all === "true";

    const chapter = await Chapter.findById(chapterId).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const review = await TEReview.findOne({ chapter_id: chapterId }).lean();

    // Lấy tất cả pages
    const allPages = await Page.find({ chapter_id: chapterId }).sort({ page_number: 1 }).lean();

    if (allPages.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          page: null,
          pages: [],
          pagination: { page: 1, limit: 1, total: 0, has_prev: false, has_next: false },
          annotations: [],
        },
      });
    }

    // Helper normalize URL - fallback cho nhiều format FE có thể gửi
    const normalizeUrl = (p) => {
      return p.final_image_url || p.result_image_url || p.original_image_url ||
             p.url || p.image_url || p.imageUrl || "";
    };

    // Helper format page object
    const formatPage = (p) => ({
      _id: p._id,
      id: p._id,
      page_number: p.page_number,
      pageIndex: p.page_number - 1,
      // URL fields - normalize tất cả các format
      final_image_url: p.final_image_url || "",
      result_image_url: p.result_image_url || "",
      original_image_url: p.original_image_url || "",
      url: p.url || p.final_image_url || p.result_image_url || p.original_image_url || "",
      image_url: p.image_url || p.final_image_url || p.result_image_url || p.original_image_url || "",
      imageUrl: p.imageUrl || p.final_image_url || p.result_image_url || p.original_image_url || "",
      width: p.width || 0,
      height: p.height || 0,
      status: p.status || "raw",
    });

    // Đếm annotations per page
    const pageAnnotationCounts = {};
    for (const p of allPages) {
      pageAnnotationCounts[String(p._id)] = review
        ? review.annotations.filter((a) => String(a.page_id) === String(p._id)).length
        : 0;
    }

    // Lấy tất cả pages
    if (getAll) {
      const totalPages = allPages.length;
      return res.status(200).json({
        success: true,
        data: {
          page: null,
          pages: allPages.map((p) => ({
            ...formatPage(p),
            annotation_count: pageAnnotationCounts[String(p._id)] || 0,
          })),
          pagination: { page: 1, limit: totalPages, total: totalPages, has_prev: false, has_next: false },
          annotations: review ? review.annotations : [],
        },
      });
    }

    // Lấy 1 page
    const totalPages = allPages.length;
    const safePage = Math.max(1, Math.min(pageNum, totalPages));
    const currentPage = allPages[safePage - 1];

    const pageAnnotations = review
      ? review.annotations.filter((a) => String(a.page_id) === String(currentPage._id))
          .sort((a, b) => (a.order || 0) - (b.order || 0))
      : [];

    return res.status(200).json({
      success: true,
      data: {
        page: {
          ...formatPage(currentPage),
          annotations: pageAnnotations,
        },
        pages: allPages.map((p) => ({
          _id: p._id,
          id: p._id,
          page_number: p.page_number,
          annotation_count: pageAnnotationCounts[String(p._id)] || 0,
        })),
        pagination: {
          page: safePage,
          limit: 1,
          total: totalPages,
          has_prev: safePage > 1,
          has_next: safePage < totalPages,
          prev_page: safePage > 1 ? safePage - 1 : null,
          next_page: safePage < totalPages ? safePage + 1 : null,
        },
        annotations: pageAnnotations,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/chapter/:chapterId/page/:pageId/annotations ───────────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/page/{pageId}/annotations:
 *   get:
 *     tags: [TEReviews]
 *     summary: Lấy annotations của 1 page trong chapter
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: pageId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Annotations của page
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id: { type: string }
 *                       page_id: { type: string }
 *                       order: { type: integer }
 *                       region:
 *                         type: object
 *                         properties:
 *                           x: { type: number }
 *                           y: { type: number }
 *                           width: { type: number }
 *                           height: { type: number }
 *                       content: { type: string }
 *                       error_type: { type: string }
 *       404:
 *         description: Page not found in chapter
 */
router.get("/chapter/:chapterId/page/:pageId/annotations", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId, pageId } = req.params;
    const page = await Page.findOne({ _id: pageId, chapter_id: chapterId }).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const review = await TEReview.findOne({ chapter_id: chapterId }).lean();
    const annotations = review
      ? review.annotations.filter((a) => String(a.page_id) === String(pageId)).sort((a, b) => (a.order || 0) - (b.order || 0))
      : [];

    return res.status(200).json({ success: true, data: annotations });
  } catch (error) {
    next(error);
  }
});

// ─── POST /te-reviews/chapter/:chapterId/annotations ───────────────────────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/annotations:
 *   post:
 *     tags: [TEReviews]
 *     summary: Tạo annotation mới cho 1 page của chapter
 *     description: |
 *       TE vẽ ô khoanh trên page + nhập nội dung.
 *       Hỗ trợ 2 format region:
 *       - `region: {x,y,width,height}` (object)
 *       - Hoặc flat: `x, y, w, h, width, height, region_x, region_y, region_width, region_height`
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [page_id, content]
 *             properties:
 *               page_id:
 *                 type: string
 *                 description: Cũng có thể gửi là `id`
 *               id:
 *                 type: string
 *                 description: Alias của page_id
 *               region:
 *                 type: object
 *                 properties:
 *                   x: { type: number }
 *                   y: { type: number }
 *                   width: { type: number }
 *                   height: { type: number }
 *               x: { type: number }
 *               y: { type: number }
 *               w: { type: number }
 *               h: { type: number }
 *               content:
 *                 type: string
 *                 description: Nội dung ghi chú
 *               error_type:
 *                 type: string
 *                 enum: [content, dialogue, script, art, other]
 *                 default: other
 *     responses:
 *       201:
 *         description: Annotation created
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Page not found in chapter
 */
router.post("/chapter/:chapterId/annotations", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId } = req.params;
    const body = req.body;

    // Handle both formats: region object OR flat x/y/w/h fields
    const pageId = body.page_id || body.id;
    let region = body.region;

    if (!region) {
      // Try flat fields: x, y, w/h, width/height
      const x = Number(body.x ?? body.region_x);
      const y = Number(body.y ?? body.region_y);
      const width = Number(body.w ?? body.width ?? body.region_width);
      const height = Number(body.h ?? body.height ?? body.region_height);

      if (!pageId || isNaN(x) || isNaN(y) || isNaN(width) || isNaN(height) || !body.content) {
        return next(new AppError("page_id (or id), x, y, w/h, and content are required", 400));
      }

      region = { x, y, width, height };
    }

    if (!pageId || !body.content) {
      return next(new AppError("page_id (or id) and content are required", 400));
    }

    const page = await Page.findOne({ _id: pageId, chapter_id: chapterId }).lean();
    if (!page) return next(new AppError("Page not found in this chapter", 404));

    // Dùng findOneAndUpdate với upsert để tránh race condition duplicate key
    let review = await TEReview.findOneAndUpdate(
      { chapter_id: chapterId },
      {
        $setOnInsert: {
          chapter_id: chapterId,
          reviewed_by: req.user.nameid,
          decision: TE_DECISION.DRAFT,
          feedback: "",
          revision_feedback: "",
          quick_notes: "",
        },
      },
      { returnDocument: 'after', upsert: true, runValidators: true }
    );

    const pageAnns = review.annotations.filter((a) => String(a.page_id) === String(pageId));
    const newOrder = pageAnns.length + 1;

    const newAnnotation = {
      _id: new mongoose.Types.ObjectId(),
      page_id: pageId,
      order: newOrder,
      region,
      content: body.content,
      error_type: body.error_type || "other",
    };

    review.annotations.push(newAnnotation);
    await review.save();

    return res.status(201).json({ success: true, data: newAnnotation });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /te-reviews/chapter/:chapterId/annotations/:annotationId ────────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/annotations/{annotationId}:
 *   patch:
 *     tags: [TEReviews]
 *     summary: Cập nhật annotation
 *     description: |
 *       Cập nhật region/content/error_type/order. Có thể truyền `region` object HOẶC flat fields.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: annotationId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               region:
 *                 type: object
 *                 properties:
 *                   x: { type: number }
 *                   y: { type: number }
 *                   width: { type: number }
 *                   height: { type: number }
 *               x: { type: number }
 *               y: { type: number }
 *               w: { type: number }
 *               h: { type: number }
 *               content: { type: string }
 *               error_type:
 *                 type: string
 *                 enum: [content, dialogue, script, art, other]
 *               order: { type: integer, minimum: 0 }
 *     responses:
 *       200:
 *         description: Annotation updated
 *       400:
 *         description: Invalid input
 *       404:
 *         description: Review or annotation not found
 */
router.patch("/chapter/:chapterId/annotations/:annotationId", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId, annotationId } = req.params;
    const body = req.body;
    const { region, content, error_type, order } = body;

    const review = await TEReview.findOne({ chapter_id: chapterId });
    if (!review) return next(new AppError("Review not found", 404));

    const annotation = review.annotations.id(annotationId);
    if (!annotation) return next(new AppError("Annotation not found", 404));

    if (region !== undefined) {
      if (typeof region !== "object" || typeof region.x !== "number" || typeof region.y !== "number" ||
          typeof region.width !== "number" || typeof region.height !== "number") {
        return next(new AppError("region must have numeric x, y, width, height", 400));
      }
      annotation.region = region;
    } else if (body.x !== undefined || body.y !== undefined || body.w !== undefined || body.h !== undefined) {
      // Handle flat fields: x, y, w/h
      annotation.region = {
        x: Number(body.x ?? body.region_x ?? annotation.region.x),
        y: Number(body.y ?? body.region_y ?? annotation.region.y),
        width: Number(body.w ?? body.width ?? body.region_width ?? annotation.region.width),
        height: Number(body.h ?? body.height ?? body.region_height ?? annotation.region.height),
      };
    }
    if (content !== undefined) annotation.content = content;
    if (error_type !== undefined) {
      if (!["content", "dialogue", "script", "art", "other"].includes(error_type)) return next(new AppError("Invalid error_type", 400));
      annotation.error_type = error_type;
    }
    if (order !== undefined) {
      if (typeof order !== "number" || order < 0) return next(new AppError("order must be a non-negative number", 400));
      annotation.order = order;
    }

    await review.save();
    return res.status(200).json({ success: true, data: annotation });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /te-reviews/chapter/:chapterId/annotations/:annotationId ───────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/annotations/{annotationId}:
 *   delete:
 *     tags: [TEReviews]
 *     summary: Xóa annotation
 *     description: |
 *       Xóa annotation khỏi TEReview. Sau khi xóa, các annotation còn lại trên cùng page sẽ được reorder.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: annotationId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Annotation deleted
 *       404:
 *         description: Review or annotation not found
 */
router.delete("/chapter/:chapterId/annotations/:annotationId", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId, annotationId } = req.params;

    const review = await TEReview.findOne({ chapter_id: chapterId });
    if (!review) return next(new AppError("Review not found", 404));

    const annotation = review.annotations.id(annotationId);
    if (!annotation) return next(new AppError("Annotation not found", 404));

    const deletedPageId = annotation.page_id;
    annotation.deleteOne();

    const remainingOnPage = review.annotations
      .filter((a) => String(a.page_id) === String(deletedPageId))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    remainingOnPage.forEach((a, idx) => { a.order = idx + 1; });

    await review.save();
    return res.status(200).json({ success: true, message: "Annotation deleted" });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/chapter/:chapterId/annotations ─────────────────────────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/annotations:
 *   get:
 *     summary: Lấy tất cả annotations của chapter
 *     tags: [TEReviews]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Danh sách annotations
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
 *                     type: object
 *                     properties:
 *                       _id: { type: string }
 *                       page_id: { type: string }
 *                       x: { type: number }
 *                       y: { type: number }
 *                       w: { type: number }
 *                       h: { type: number }
 *                       content: { type: string }
 *                       annotation_type: { type: string }
 *                       createdAt: { type: string }
 */
router.get("/chapter/:chapterId/annotations", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId } = req.params;

    const chapter = await Chapter.findById(chapterId).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const review = await TEReview.findOne({ chapter_id: chapterId }).lean();
    if (!review || review.annotations.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const annotations = review.annotations
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((a) => ({
        _id: a._id,
        page_id: a.page_id,
        x: a.region.x,
        y: a.region.y,
        w: a.region.width,
        h: a.region.height,
        content: a.content,
        annotation_type: a.error_type,
        createdAt: a._id ? review.createdAt : null,
      }));

    return res.status(200).json({ success: true, data: annotations });
  } catch (error) {
    next(error);
  }
});
// ─── POST /te-reviews/chapter/:chapterId/te-action ──────────────────────────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/te-action:
 *   post:
 *     summary: TE thực hiện hành động với chapter (approve = gửi EB, reject = yêu cầu Mangaka sửa)
 *     tags: [TEReviews]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [approve, reject]
 *                 description: "approve = gửi EB duyệt, reject = yêu cầu Mangaka sửa"
 *               notes:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Ghi chú revision (khi action = reject)
 *     responses:
 *       200:
 *         description: Hành động thực hiện thành công
 *       400:
 *         description: action không hợp lệ
 *       403:
 *         description: Không có quyền
 */
router.post("/chapter/:chapterId/te-action", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId } = req.params;
    const { action, notes } = req.body;

    if (!action || !["approve", "reject"].includes(action)) {
      return next(new AppError("action is required and must be 'approve' or 'reject'", 400));
    }

    const chapter = await Chapter.findById(chapterId);
    if (!chapter) return next(new AppError("Chapter not found", 404));

    if (!chapter.te_id || String(chapter.te_id) !== String(req.user.nameid)) {
      return next(new AppError("Bạn không được gán cho chapter này", 403));
    }

    if (action === "approve") {
      // Kiểm tra series đã được EB duyệt chưa (approved_by_EB / approved / published)
      const series = await Series.findById(chapter.series_id).lean();
      const seriesApproved = series && [SERIES_STATUS.APPROVED_BY_EB, SERIES_STATUS.APPROVED, SERIES_STATUS.PUBLISHED].includes(series.status);

      if (seriesApproved) {
        // Series đã được EB duyệt → TE duyệt xong → Publish trực tiếp
        chapter.status = CHAPTER_STATUS.PUBLISHED;
        chapter.is_published = true;
        chapter.published_at = new Date();
        chapter.revision_notes = "";
        chapter.revision_annotations = [];
        chapter.revision_source = "";
        await chapter.save();

        const review = await TEReview.findOne({ chapter_id: chapterId });
        if (review) {
          review.decision = TE_DECISION.APPROVED_PUBLISH;
          await review.save();
        }

        await notifyChapterTEPublished(
          Notification,
          chapter.submitted_by,
          chapter,
          series.name
        );

        return res.status(200).json({
          success: true,
          message: "Chapter đã được publish.",
          data: chapter,
        });
      } else {
        // Series chưa approved → gửi EB duyệt (chờ EB approve Series)
        chapter.status = CHAPTER_STATUS.PENDING_EB;
        chapter.revision_notes = "";
        chapter.revision_annotations = [];
        chapter.revision_source = "";
        await chapter.save();

        const review = await TEReview.findOne({ chapter_id: chapterId });
        if (review) {
          review.decision = TE_DECISION.APPROVED;
          await review.save();
        }

        const ebUsers = await require("../models/User").find({ role: ROLES.EB }).lean();
        for (const eb of ebUsers) {
          await notifyChapterToEB(Notification, eb._id, chapter, series ? series.name : "");
        }

        return res.status(200).json({
          success: true,
          message: "Chapter đã được gửi lên EB để duyệt Series.",
          data: chapter,
        });
      }
    } else {
      chapter.status = CHAPTER_STATUS.TE_REVISION;
      chapter.revision_notes = Array.isArray(notes) ? notes.join("\n") : (notes || "");
      chapter.revision_source = "TE";

      // Copy annotations from TEReview to chapter for Mangaka to view
      const review = await TEReview.findOne({ chapter_id: chapterId });
      if (review && review.annotations.length > 0) {
        chapter.revision_annotations = review.annotations.map((a) => ({
          page_id: a.page_id,
          region: {
            x: a.region.x,
            y: a.region.y,
            width: a.region.width,
            height: a.region.height,
          },
          content: a.content,
          error_type: a.error_type || "other",
        }));
      } else {
        chapter.revision_annotations = [];
      }

      await chapter.save();

      if (review) {
        review.decision = TE_DECISION.REVISION;
        review.revision_feedback = Array.isArray(notes) ? notes.join("\n") : (notes || "");
        await review.save();
      }

      await notifyChapterTERevision(Notification, chapter.submitted_by, chapter, chapter.revision_notes);

      return res.status(200).json({
        success: true,
        message: "Đã yêu cầu Mangaka chỉnh sửa chapter.",
        data: chapter,
      });
    }
  } catch (error) {
    next(error);
  }
});

// ─── POST /te-reviews/chapter/:chapterId/publish ─────────────────────────────
/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/publish:
 *   post:
 *     tags: [TEReviews]
 *     summary: TE publish chapter (chapter đã được EB duyệt)
 *     description: |
 *       TE publish chapter sau khi đã review sửa xong.
 *
 *       **Điều kiện**:
 *       - Chapter.status = "approved_by_EB"
 *       - Series.status ∈ ["approved_by_EB", "approved", "published"]
 *
 *       **Hành động**:
 *       - Chapter → "published", is_published = true, published_at = now
 *       - TEReview.decision = "approved_publish"
 *       - Nếu Series đang ở "approved_by_EB" → set Series = "published"
 *       - Notification cho Mangaka
 *
 *       **Lưu ý flow 2 giai đoạn**:
 *       - Giai đoạn 1 (Series chưa EB-approved): TE approve → chapter → "pending_EB", không publish.
 *       - Giai đoạn 2 (Series đã EB-approved): chapter sau khi EB confirm → "approved_by_EB",
 *         TE publish thủ công qua endpoint này.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Chapter published
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   $ref: '#/components/schemas/Chapter'
 *       400:
 *         description: Chapter chưa approved_by_EB hoặc Series chưa được EB duyệt
 *       404:
 *         description: Chapter not found
 */
router.post("/chapter/:chapterId/publish", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId } = req.params;

    const chapter = await Chapter.findById(chapterId);
    if (!chapter) return next(new AppError("Chapter not found", 404));

    // Chỉ cho phép publish chapter ở trạng thái approved_by_EB
    if (chapter.status !== CHAPTER_STATUS.APPROVED_BY_EB) {
      return next(new AppError("Chapter không ở trạng thái sẵn sàng publish. Vui lòng duyệt chapter trước.", 400));
    }

    // Kiểm tra series đã được EB duyệt chưa (approved_by_EB / approved / published)
    const series = await Series.findById(chapter.series_id).lean();
    if (!series || ![SERIES_STATUS.APPROVED_BY_EB, SERIES_STATUS.APPROVED, SERIES_STATUS.PUBLISHED].includes(series.status)) {
      return next(new AppError("Series chưa được EB duyệt", 400));
    }

    // Publish chapter
    chapter.status = CHAPTER_STATUS.PUBLISHED;
    chapter.is_published = true;
    chapter.published_at = new Date();
    chapter.revision_notes = "";
    chapter.revision_annotations = [];
    chapter.revision_source = "";
    await chapter.save();

    // Snapshot ảnh cuối cho Reader (set final_image_url lúc publish để freeze giá trị)
    // Ưu tiên result_image_url (ảnh assistant render), fallback original_image_url (ảnh gốc)
    // Không ảnh hưởng luồng nội bộ - chỉ set sau khi đã publish thành công
    // Bỏ qua nếu lỗi (chapter đã published, không làm fail cả request)
    await Page.updateMany(
      { chapter_id: chapter._id },
      [
        {
          $set: {
            final_image_url: {
              $ifNull: ["$result_image_url", "$original_image_url"],
            },
          },
        },
      ],
      { updatePipeline: true },
    ).catch((err) =>
      console.warn(
        `[publish] Failed to snapshot final_image_url for chapter ${chapter._id}:`,
        err.message
      )
    );

    const review = await TEReview.findOne({ chapter_id: chapterId });
    if (review) {
      review.decision = TE_DECISION.APPROVED_PUBLISH;
      await review.save();
    }

    // Nếu đây là chapter đầu tiên của Series được publish → set Series.status = "published"
    // (áp dụng khi Series đang ở "approved_by_EB" - chuyển sang "published")
    if (series.status === SERIES_STATUS.APPROVED_BY_EB) {
      await Series.findByIdAndUpdate(series._id, { status: SERIES_STATUS.PUBLISHED });
    }

    await notifyChapterTEPublished(
      Notification,
      chapter.submitted_by,
      chapter,
      series.name
    );

    return res.status(200).json({
      success: true,
      message: "Chapter đã được publish thành công.",
      data: chapter,
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  SERIES PUBLICATION STATUS — TE chuyển trạng thái phát hành
// ════════════════════════════════════════════════════════════════════════════

const VALID_TRANSITIONS = {
  ongoing: ["hiatus", "completed", "dropped"],
  hiatus: ["ongoing"],
  dropped: ["ongoing"],
  upcoming: [],
  completed: [],
};

const PUBLICATION_STATUS_VALUES = ["upcoming", "ongoing", "hiatus", "completed", "dropped"];

/**
 * @swagger
 * /te-reviews/series/:seriesId/publication-status:
 *   patch:
 *     tags: [TEReviews]
 *     summary: TE chuyển publication_status của series
 *     description: |
 *       TE chuyển trạng thái phát hành của series.
 *
 *       **Transition rules:**
 *       - ongoing → hiatus, completed, dropped ✅
 *       - hiatus → ongoing ✅
 *       - dropped → ongoing ✅
 *       - completed → * ❌ (read-only)
 *       - upcoming → * ❌ (auto từ job)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publication_status]
 *             properties:
 *               publication_status:
 *                 type: string
 *                 enum: [ongoing, hiatus, completed, dropped]
 *     responses:
 *       200:
 *         description: Publication status updated
 *       400:
 *         description: Invalid transition
 *       403:
 *         description: Not authorized
 */
router.patch("/series/:seriesId/publication-status", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const { publication_status } = req.body;

    if (!publication_status || !PUBLICATION_STATUS_VALUES.includes(publication_status)) {
      return next(new AppError("publication_status is required and must be one of: ongoing, hiatus, completed, dropped", 400));
    }

    const series = await Series.findById(seriesId).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const currentStatus = series.publication_status || null;

    // completed is read-only
    if (currentStatus === "completed") {
      return next(new AppError("Không thể thay đổi trạng thái của series đã completed", 400));
    }

    // upcoming is auto-set by job, not manually changeable
    if (currentStatus === "upcoming") {
      return next(new AppError("Series đang ở trạng thái upcoming. Trạng thái sẽ tự chuyển sang ongoing khi đến ngày publish.", 400));
    }

    // Validate transition
    const allowed = currentStatus ? (VALID_TRANSITIONS[currentStatus] || []) : ["ongoing"];
    if (!allowed.includes(publication_status)) {
      return next(
        new AppError(
          `Không thể chuyển từ "${currentStatus || 'null'}" sang "${publication_status}". ` +
          `Các transition hợp lệ: ${allowed.join(", ") || "không có"}.`,
          400
        )
      );
    }

    await Series.findByIdAndUpdate(seriesId, { publication_status });

    return res.status(200).json({
      success: true,
      message: `Publication status đã chuyển từ "${currentStatus || 'null'}" sang "${publication_status}".`,
      data: {
        _id: seriesId,
        previous_status: currentStatus,
        publication_status,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
