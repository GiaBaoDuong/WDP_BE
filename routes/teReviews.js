const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireTE, requireMangaka, requireTEOrEB, requireMangakaOrTEOrEB } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const Series = require("../models/Series");
const Task = require("../models/Task");
const TEReview = require("../models/TEReview");
const Notification = require("../models/Notification");
const { notifyChapterToTE, notifyChapterToEB, notifyChapterTERevision } = require("../services/notificationService");

/**
 * @swagger
 * /te-reviews/pending:
 *   get:
 *     tags: [TEReviews]
 *     summary: Get pending chapters for TE review
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
 *         description: Forbidden - TE role required
 */
// ─── GET /te-reviews/pending ─────────────────────────────────────────────────
// TE xem danh sách chapter đang chờ duyệt
router.get("/pending", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const chapters = await Chapter.find({ status: "pending_TE" })
      .populate("submitted_by", "username full_name")
      .populate("series_id", "name")
      .sort({ updatedAt: 1 })
      .lean();

    return res.status(200).json({ success: true, data: chapters });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /te-reviews/chapter/{chapterId}/review:
 *   post:
 *     tags: [TEReviews]
 *     summary: Submit TE review for a chapter
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
 *             required:
 *               - decision
 *             properties:
 *               decision:
 *                 type: string
 *                 enum: [approved, revision]
 *               annotations:
 *                 type: array
 *                 items:
 *                   type: object
 *               feedback:
 *                 type: string
 *               revision_feedback:
 *                 type: string
 *     responses:
 *       200:
 *         description: Review submitted successfully
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
 *                     review:
 *                       $ref: '#/components/schemas/TEReview'
 *       400:
 *         description: Invalid decision value
 *       404:
 *         description: Chapter not found or not pending TE review
 */
// ─── POST /te-reviews/chapter/:chapterId/review ──────────────────────────────
// TE duyệt chapter (annotate + quyết định)
// Body: { decision: "approved"|"revision", annotations: [...], feedback, revision_feedback }
router.post("/chapter/:chapterId/review", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { decision, annotations, feedback, revision_feedback } = req.body;

    if (!["approved", "revision"].includes(decision)) {
      return next(new AppError("decision must be 'approved' or 'revision'", 400));
    }

    const chapter = await Chapter.findOne({ _id: req.params.chapterId, status: "pending_TE" });
    if (!chapter) return next(new AppError("Chapter not found or not pending TE review", 404));

    // Upsert TE review (1 chapter chỉ có 1 review)
    let review = await TEReview.findOne({ chapter_id: chapter._id });
    if (review) {
      review.decision = decision;
      review.annotations = annotations || [];
      review.feedback = feedback || "";
      review.revision_feedback = revision_feedback || "";
    } else {
      review = await TEReview.create({
        chapter_id: chapter._id,
        reviewed_by: req.user.nameid,
        decision,
        annotations: annotations || [],
        feedback: feedback || "",
        revision_feedback: revision_feedback || "",
      });
    }

    // Cập nhật chapter status
    if (decision === "approved") {
      chapter.status = "pending_EB";
      chapter.te_review_id = review._id;
      chapter.revision_notes = "";
      chapter.revision_annotations = [];
      chapter.revision_source = "";
    } else {
      chapter.status = "TE_revision";
      chapter.te_review_id = review._id;
      chapter.revision_notes = revision_feedback || "";
      chapter.revision_annotations = annotations || [];
      chapter.revision_source = "TE";
    }
    await chapter.save();

    // Notify Mangaka
    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";

    if (decision === "approved") {
      // Notify EB
      const ebUsers = await require("../models/User").find({ role: "EB" }).lean();
      for (const eb of ebUsers) {
        await notifyChapterToEB(Notification, eb._id, chapter, seriesName);
      }
    } else {
      // Notify Mangaka (kèm annotations để FE có thể render lại vùng khoanh đỏ)
      await notifyChapterTERevision(
        Notification,
        chapter.submitted_by,
        chapter,
        seriesName,
        annotations || []
      );
    }

    return res.status(200).json({
      success: true,
      data: { chapter, review },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /te-reviews/chapter/{chapterId}:
 *   get:
 *     tags: [TEReviews]
 *     summary: Get TE review for a chapter
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     responses:
 *       200:
 *         description: TE review data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TEReview'
 *       404:
 *         description: Review not found
 */
// ─── GET /te-reviews/chapter/:chapterId ─────────────────────────────────────
// Xem review của 1 chapter
router.get("/chapter/:chapterId", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const review = await TEReview.findOne({ chapter_id: req.params.chapterId })
      .populate("reviewed_by", "username full_name")
      .lean();

    if (!review) return next(new AppError("Review not found", 404));

    return res.status(200).json({ success: true, data: review });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /te-reviews/series/{seriesId}/profile:
 *   get:
 *     tags: [TEReviews]
 *     summary: Xem hồ sơ series từ góc nhìn TE (số liệu duyệt, annotation, ranking)
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
 *         description: Hồ sơ series + thống kê TE
 *       404:
 *         description: Series not found
 */
// ─── GET /te-reviews/series/:seriesId/profile ───────────────────────────────
// TE/EB xem hồ sơ series từ góc nhìn TE
function computeRanking(allPublished, targetSeries) {
  const sorted = [...allPublished].sort((a, b) => {
    if (b.average_score !== a.average_score) return b.average_score - a.average_score;
    return (b.total_votes || 0) - (a.total_votes || 0);
  });
  const idx = sorted.findIndex((s) => String(s._id) === String(targetSeries._id));
  return idx === -1 ? null : idx + 1;
}

router.get("/series/:seriesId/profile", authMiddleware, requireTEOrEB, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const series = await Series.findById(seriesId).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const chapterAgg = await Chapter.aggregate([
      { $match: { series_id: series._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const chapterBreakdown = chapterAgg.reduce((acc, cur) => {
      acc[cur._id] = cur.count;
      return acc;
    }, {});

    const myReviews = await TEReview.find({ reviewed_by: req.user.nameid })
      .populate({
        path: "chapter_id",
        match: { series_id: series._id },
        select: "_id chapter_number title",
      })
      .lean();
    const filteredMyReviews = myReviews.filter((r) => r.chapter_id);
    const approvedCount = filteredMyReviews.filter((r) => r.decision === "approved").length;
    const revisionCount = filteredMyReviews.filter((r) => r.decision === "revision").length;
    const myReviewCount = filteredMyReviews.length;

    const allSeriesReviews = await TEReview.find()
      .populate({
        path: "chapter_id",
        match: { series_id: series._id },
        select: "_id",
      })
      .lean();
    const annotations = allSeriesReviews
      .filter((r) => r.chapter_id)
      .flatMap((r) => r.annotations || []);
    const annotationsByErrorType = annotations.reduce((acc, a) => {
      const t = a.error_type || "other";
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {});

    const allPublished = await Series.find({ is_public: true, status: "published" })
      .select("_id average_score total_votes")
      .lean();
    const rankingPosition = computeRanking(allPublished, series);

    const chapters = await Chapter.find({ series_id: series._id })
      .select("_id chapter_number title status updatedAt")
      .sort({ chapter_number: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        series,
        chapter_status_breakdown: chapterBreakdown,
        my_review_stats: {
          total_reviews: myReviewCount,
          approved_count: approvedCount,
          revision_count: revisionCount,
          approval_rate: myReviewCount === 0 ? null : +(approvedCount / myReviewCount).toFixed(2),
        },
        annotation_stats: {
          total_annotations: annotations.length,
          by_error_type: annotationsByErrorType,
        },
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

/**
 * @swagger
 * /te-reviews/dashboard:
 *   get:
 *     tags: [TEReviews]
 *     summary: TE dashboard — tổng quan chapter đang chờ duyệt, group theo series, có deadline
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data
 */
// ─── GET /te-reviews/dashboard ───────────────────────────────────────────────
// TE xem tổng quan: bao nhiêu chapter đang chờ, bao nhiêu đang revision, group theo series
router.get("/dashboard", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    const pendingChapters = await Chapter.find({ status: "pending_TE" })
      .select("_id series_id chapter_number title submitted_by updatedAt")
      .populate("series_id", "name publication_schedule")
      .populate("submitted_by", "username full_name")
      .lean();

    const inRevisionChapters = await Chapter.find({ status: "TE_revision" })
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
      const oldest = all.reduce(
        (min, c) => (min === null || new Date(c.updatedAt) < new Date(min) ? c : min),
        null
      );
      const oldestAt = oldest ? new Date(oldest.updatedAt) : null;
      const ageHours = oldestAt ? Math.floor((now - oldestAt) / (1000 * 60 * 60)) : null;
      const isLate = oldestAt ? now - oldestAt > SEVEN_DAYS_MS : false;

      let estimatedDeadline = null;
      if (item.series && item.series.publication_schedule && item.series._id) {
        const lastPublished = await Chapter.findOne({
          series_id: item.series._id,
          is_published: true,
        })
          .sort({ published_at: -1 })
          .select("published_at")
          .lean();
        if (lastPublished && lastPublished.published_at) {
          const d = new Date(lastPublished.published_at);
          d.setDate(
            d.getDate() + (item.series.publication_schedule === "weekly" ? 7 : 30)
          );
          estimatedDeadline = d;
        }
      }

      bySeries.push({
        series: item.series,
        pending_count: item.pending_chapters.length,
        in_revision_count: item.in_revision_chapters.length,
        oldest_pending: oldest
          ? {
              _id: oldest._id,
              chapter_number: oldest.chapter_number,
              title: oldest.title,
              updatedAt: oldest.updatedAt,
              age_hours: ageHours,
            }
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

/**
 * @swagger
 * /te-reviews/studio-progress:
 *   get:
 *     tags: [TEReviews]
 *     summary: Realtime tiến độ studio (tổng hợp task + chapter theo từng series, phát hiện "at risk")
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: series_id
 *         required: false
 *         schema:
 *           type: string
 *         description: Lọc theo 1 series cụ thể
 *     responses:
 *       200:
 *         description: Tiến độ studio realtime
 */
// ─── GET /te-reviews/studio-progress ─────────────────────────────────────────
// Realtime tiến độ studio: tổng hợp task + chapter theo từng series
router.get("/studio-progress", authMiddleware, requireMangakaOrTEOrEB, async (req, res, next) => {
  try {
    const { series_id } = req.query;
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const ACTIVE_STATUSES = ["draft", "pending_assistant", "pending_TE", "TE_revision", "pending_EB", "EB_revision", "published"];

    const seriesFilter = { status: { $in: ["approved", "published"] } };
    if (series_id) seriesFilter._id = series_id;
    if (req.user.role === "Mangaka") seriesFilter.author_id = req.user.nameid;

    const seriesList = await Series.find(seriesFilter)
      .select("_id name status author_id")
      .populate("author_id", "username full_name")
      .lean();

    const result = [];
    let totalChaptersInProduction = 0;
    let chaptersAtRisk = 0;

    for (const s of seriesList) {
      const chapters = await Chapter.find({ series_id: s._id }).select("_id status updatedAt").lean();
      const chapterBreakdown = chapters.reduce((acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
      }, {});

      const chapterIds = chapters.map((c) => c._id);
      const tasks = await Task.aggregate([
        { $match: { chapter_id: { $in: chapterIds } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      const taskBreakdown = tasks.reduce((acc, t) => {
        acc[t._id] = t.count;
        return acc;
      }, {});
      const taskTotal = Object.values(taskBreakdown).reduce((a, b) => a + b, 0);
      const taskApproved = taskBreakdown.approved || 0;
      const completionRate = taskTotal === 0 ? null : +(taskApproved / taskTotal).toFixed(2);

      const atRisk = chapters.filter((c) => {
        if (!["pending_TE", "TE_revision", "pending_EB", "EB_revision"].includes(c.status)) return false;
        return now - new Date(c.updatedAt) > SEVEN_DAYS_MS;
      }).length;
      chaptersAtRisk += atRisk;
      totalChaptersInProduction += chapters.filter((c) => ACTIVE_STATUSES.includes(c.status)).length;

      result.push({
        series: s,
        task_stats: {
          total: taskTotal,
          by_status: taskBreakdown,
          approved: taskApproved,
          completion_rate: completionRate,
        },
        chapter_stats: {
          total: chapters.length,
          by_status: chapterBreakdown,
          in_production: chapters.filter((c) => ACTIVE_STATUSES.includes(c.status)).length,
          at_risk: atRisk,
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          total_active_series: seriesList.length,
          total_chapters_in_production: totalChaptersInProduction,
          chapters_at_risk: chaptersAtRisk,
          fetched_at: now,
        },
        series_progress: result,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
