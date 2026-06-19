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
const { TEReview, TE_CRITERIA_KEYS } = require("../models/TEReview");
const Notification = require("../models/Notification");
const { CHAPTER_STATUS } = require("../utils/constants");
const { TE_DECISION } = require("../utils/constants");
const { ROLES } = require("../utils/constants");
const { notifyChapterToTE, notifyChapterToEB, notifyChapterTERevision, notifyChapterTERejected, notifyChapterTEPublished } = require("../services/notificationService");

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
<<<<<<< HEAD
    const chapters = await Chapter.find({ status: CHAPTER_STATUS.PENDING_TE })
      .populate("submitted_by", "username full_name phoneNumber")
      .populate("series_id", "name")
      .sort({ updatedAt: 1 })
      .lean();

    return res.status(200).json({ success: true, data: chapters });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/history ─────────────────────────────────────────────────
// Lịch sử toàn bộ review của TE đang login
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

    // Attach average_score (virtual)
    const enriched = reviews.map((r) => {
      const scores = r.scores instanceof Map ? Object.fromEntries(r.scores) : r.scores || {};
      const vals = Object.values(scores).filter((v) => v != null);
      const avg = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
      return { ...r, scores, average_score: avg };
    });

    return res.status(200).json({ success: true, data: enriched });
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
// Body: { decision, annotations, feedback, revision_feedback, quick_notes, scores: { pacing_content, visual_art_writing, layout_storyboard, localization_technical } }
router.post("/chapter/:chapterId/review", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { decision, annotations, feedback, revision_feedback, quick_notes, scores } = req.body;
    const validDecisions = ["draft", "revision", "approved", "rejected", "approved_publish"];

    if (!validDecisions.includes(decision)) {
      return next(new AppError(`decision must be one of: ${validDecisions.join(", ")}`, 400));
    }

    const chapter = await Chapter.findOne({ _id: req.params.chapterId, status: CHAPTER_STATUS.PENDING_TE });
    if (!chapter) return next(new AppError("Chapter not found or not pending TE review", 404));

    // Validate scores: mỗi tiêu chí phải là số nguyên 0-5
    if (scores) {
      for (const key of Object.keys(scores)) {
        const val = scores[key];
        if (!TE_CRITERIA_KEYS.includes(key)) {
          return next(new AppError(`Invalid score key: "${key}". Valid keys: ${TE_CRITERIA_KEYS.join(", ")}`, 400));
        }
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 5) {
          return next(new AppError(`Score "${key}" must be an integer from 0 to 5`, 400));
        }
      }
    }

    // Upsert TE review
    let review = await TEReview.findOne({ chapter_id: chapter._id });
    if (review) {
      review.decision = decision;
      review.annotations = annotations || [];
      review.feedback = feedback || "";
      review.revision_feedback = revision_feedback || "";
      review.quick_notes = quick_notes || "";
      if (scores) {
        for (const [key, val] of Object.entries(scores)) {
          review.scores.set(key, val);
        }
      }
    } else {
      const scoreMap = new Map();
      if (scores) {
        for (const [key, val] of Object.entries(scores)) {
          scoreMap.set(key, val);
        }
      }
      review = await TEReview.create({
        chapter_id: chapter._id,
        reviewed_by: req.user.nameid,
        decision,
        annotations: annotations || [],
        feedback: feedback || "",
        revision_feedback: revision_feedback || "",
        quick_notes: quick_notes || "",
        scores: scoreMap,
      });
    }
    await review.save();

    // ── Xử lý theo từng decision ────────────────────────────────────────────
    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";

    if (decision === TE_DECISION.DRAFT) {
      // Lưu nháp, giữ nguyên trạng thái pending_TE, không notify
      return res.status(200).json({
        success: true,
        data: { chapter, review },
      });
    }

    if (decision === TE_DECISION.REVISION) {
      chapter.status = CHAPTER_STATUS.TE_REVISION;
      chapter.revision_notes = revision_feedback || "";
      chapter.revision_annotations = annotations || [];
      chapter.revision_source = "TE";
      await chapter.save();
      await notifyChapterTERevision(Notification, chapter.submitted_by, chapter, seriesName, annotations || []);
      return res.status(200).json({ success: true, data: { chapter, review } });
    }

    if (decision === TE_DECISION.REJECTED) {
      chapter.status = CHAPTER_STATUS.DRAFT;
      chapter.revision_notes = revision_feedback || "";
      chapter.revision_annotations = [];
      chapter.revision_source = "TE";
      await chapter.save();
      await notifyChapterTERejected(Notification, chapter.submitted_by, chapter, seriesName);
      return res.status(200).json({ success: true, data: { chapter, review } });
    }

    if (decision === TE_DECISION.APPROVED) {
      chapter.status = CHAPTER_STATUS.PENDING_EB;
      chapter.revision_notes = "";
      chapter.revision_annotations = [];
      chapter.revision_source = "";
      await chapter.save();
      const ebUsers = await require("../models/User").find({ role: ROLES.EB }).lean();
      for (const eb of ebUsers) {
        await notifyChapterToEB(Notification, eb._id, chapter, seriesName);
      }
      return res.status(200).json({ success: true, data: { chapter, review } });
    }

    if (decision === TE_DECISION.APPROVED_PUBLISH) {
      chapter.status = CHAPTER_STATUS.PUBLISHED;
      chapter.is_published = true;
      chapter.published_at = new Date();
      chapter.revision_notes = "";
      chapter.revision_annotations = [];
      chapter.revision_source = "";
      await chapter.save();
      await notifyChapterTEPublished(Notification, chapter.submitted_by, chapter, seriesName);
      return res.status(200).json({ success: true, data: { chapter, review } });
    }

    return res.status(200).json({ success: true, data: { chapter, review } });
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
      .populate("reviewed_by", "username full_name phoneNumber")
      .lean();

    if (!review) return next(new AppError("Review not found", 404));

    const scores = review.scores instanceof Map ? Object.fromEntries(review.scores) : review.scores || {};
    const vals = Object.values(scores).filter((v) => v != null);
    const average_score = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;

    return res.status(200).json({
      success: true,
      data: { ...review, scores, average_score },
    });
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

    // Compute per-decision stats and average scores
    const approvedCount = filteredMyReviews.filter((r) => r.decision === TE_DECISION.APPROVED).length;
    const revisionCount = filteredMyReviews.filter((r) => r.decision === TE_DECISION.REVISION).length;
    const rejectedCount = filteredMyReviews.filter((r) => r.decision === TE_DECISION.REJECTED).length;
    const publishedCount = filteredMyReviews.filter((r) => r.decision === TE_DECISION.APPROVED_PUBLISH).length;
    const myReviewCount = filteredMyReviews.length;

    const allScores = filteredMyReviews.flatMap((r) =>
      Object.values(r.scores instanceof Map ? Object.fromEntries(r.scores) : r.scores || {})
    );
    const avgOverall = allScores.length
      ? +(allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(2)
      : null;

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
          rejected_count: rejectedCount,
          published_count: publishedCount,
          approval_rate: myReviewCount === 0 ? null : +((approvedCount + publishedCount) / myReviewCount).toFixed(2),
          average_score: avgOverall,
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

    const pendingChapters = await Chapter.find({ status: CHAPTER_STATUS.PENDING_TE })
      .select("_id series_id chapter_number title submitted_by updatedAt")
      .populate("series_id", "name publication_schedule")
      .populate("submitted_by", "username full_name phoneNumber")
      .lean();

    const inRevisionChapters = await Chapter.find({ status: CHAPTER_STATUS.TE_REVISION })
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
    const ACTIVE_STATUSES = [
      CHAPTER_STATUS.DRAFT,
      CHAPTER_STATUS.PENDING_ASSISTANT,
      CHAPTER_STATUS.PENDING_TE,
      CHAPTER_STATUS.TE_REVISION,
      CHAPTER_STATUS.PENDING_EB,
      CHAPTER_STATUS.EB_REVISION,
      CHAPTER_STATUS.PUBLISHED,
    ];

    const seriesFilter = { status: { $in: ["approved", "published"] } };
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
        if (![CHAPTER_STATUS.PENDING_TE, CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.PENDING_EB, CHAPTER_STATUS.EB_REVISION].includes(c.status)) return false;
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

// ─── GET /te-reviews/chapter/:chapterId/pages ────────────────────────────────
// Lấy danh sách pages của chapter, kèm annotation count & annotation đầu tiên (để preview)
// Hỗ trợ phân trang prev/next: ?page=1 (1-based), default page=1
router.get("/chapter/:chapterId/pages", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId } = req.params;
    const pageNum = parseInt(req.query.page) || 1;
    const limit = 1; // mỗi lần xem 1 trang

    const chapter = await Chapter.findById(chapterId).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const totalPages = await Page.countDocuments({ chapter_id: chapterId });
    if (totalPages === 0) {
      return res.status(200).json({
        success: true,
        data: {
          pages: [],
          pagination: { page: 1, limit: 1, total: 0, has_prev: false, has_next: false },
          annotations: [],
        },
      });
    }

    // Clamp page
    const safePage = Math.max(1, Math.min(pageNum, totalPages));
    const skip = (safePage - 1) * limit;

    const page = await Page.findOne({ chapter_id: chapterId })
      .sort({ page_number: 1 })
      .skip(skip)
      .lean();

    // Annotations của trang hiện tại (sắp xếp theo order)
    const review = await TEReview.findOne({ chapter_id: chapterId }).lean();
    const pageAnnotations = review
      ? review.annotations
          .filter((a) => String(a.page_id) === String(page._id))
          .sort((a, b) => (a.order || 0) - (b.order || 0))
      : [];

    // Tổng annotation count cho mỗi page (để render page indicators)
    const allPages = await Page.find({ chapter_id: chapterId })
      .select("_id page_number")
      .sort({ page_number: 1 })
      .lean();

    const pageAnnotationCounts = {};
    if (review) {
      for (const p of allPages) {
        pageAnnotationCounts[String(p._id)] = review.annotations.filter(
          (a) => String(a.page_id) === String(p._id)
        ).length;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        page: {
          _id: page._id,
          page_number: page.page_number,
          original_image_url: page.original_image_url,
          result_image_url: page.result_image_url,
          status: page.status,
        },
        pages: allPages.map((p) => ({
          _id: p._id,
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
// Lấy annotations của 1 page cụ thể (sắp xếp theo order)
router.get("/chapter/:chapterId/page/:pageId/annotations", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId, pageId } = req.params;

    const page = await Page.findOne({ _id: pageId, chapter_id: chapterId }).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const review = await TEReview.findOne({ chapter_id: chapterId }).lean();
    const annotations = review
      ? review.annotations
          .filter((a) => String(a.page_id) === String(pageId))
          .sort((a, b) => (a.order || 0) - (b.order || 0))
      : [];

    return res.status(200).json({ success: true, data: annotations });
  } catch (error) {
    next(error);
  }
});

// ─── POST /te-reviews/chapter/:chapterId/annotations ───────────────────────
// Thêm 1 annotation mới (tạo ô khoanh)
router.post("/chapter/:chapterId/annotations", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId } = req.params;
    const { page_id, region, content, error_type } = req.body;

    if (!page_id || !region || !content) {
      return next(new AppError("page_id, region, and content are required", 400));
    }
    if (typeof region.x !== "number" || typeof region.y !== "number" ||
        typeof region.width !== "number" || typeof region.height !== "number") {
      return next(new AppError("region must have numeric x, y, width, height", 400));
    }

    const page = await Page.findOne({ _id: page_id, chapter_id: chapterId }).lean();
    if (!page) return next(new AppError("Page not found in this chapter", 404));

    // Lấy review hiện tại hoặc tạo mới (decision = draft)
    let review = await TEReview.findOne({ chapter_id: chapterId });
    if (!review) {
      review = await TEReview.create({
        chapter_id: chapterId,
        reviewed_by: req.user.nameid,
        decision: TE_DECISION.DRAFT,
        annotations: [],
        feedback: "",
        revision_feedback: "",
        quick_notes: "",
        scores: new Map(),
      });
    }

    // Tính order = số annotation hiện tại của page + 1
    const pageAnns = review.annotations.filter(
      (a) => String(a.page_id) === String(page_id)
    );
    const newOrder = pageAnns.length + 1;

    const newAnnotation = {
      _id: new mongoose.Types.ObjectId(),
      page_id,
      order: newOrder,
      region,
      content,
      error_type: error_type || "other",
    };

    review.annotations.push(newAnnotation);
    await review.save();

    return res.status(201).json({
      success: true,
      data: newAnnotation,
    });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /te-reviews/chapter/:chapterId/annotations/:annotationId ────────
// Cập nhật nội dung / toạ độ 1 annotation (sửa nhận xét)
router.patch("/chapter/:chapterId/annotations/:annotationId", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { chapterId, annotationId } = req.params;
    const { region, content, error_type, order } = req.body;

    const review = await TEReview.findOne({ chapter_id: chapterId });
    if (!review) return next(new AppError("Review not found", 404));

    const annotation = review.annotations.id(annotationId);
    if (!annotation) return next(new AppError("Annotation not found", 404));

    if (region !== undefined) {
      if (typeof region !== "object" ||
          typeof region.x !== "number" || typeof region.y !== "number" ||
          typeof region.width !== "number" || typeof region.height !== "number") {
        return next(new AppError("region must have numeric x, y, width, height", 400));
      }
      annotation.region = region;
    }
    if (content !== undefined) annotation.content = content;
    if (error_type !== undefined) {
      if (!["content", "dialogue", "script", "art", "other"].includes(error_type)) {
        return next(new AppError("Invalid error_type", 400));
      }
      annotation.error_type = error_type;
    }
    if (order !== undefined) {
      if (typeof order !== "number" || order < 0) {
        return next(new AppError("order must be a non-negative number", 400));
      }
      annotation.order = order;
    }

    await review.save();

    return res.status(200).json({ success: true, data: annotation });
  } catch (error) {
    next(error);
  }
});

// ─── POST /te-reviews/chapter/:chapterId/submit ────────────────────────────────
// Submit review cuối cùng, với tuỳ chọn save & next chapter
// Body: { decision, feedback, revision_feedback, quick_notes, scores, next_action: "stay" | "next_chapter" }
router.post("/chapter/:chapterId/submit", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const { decision, feedback, revision_feedback, quick_notes, scores, next_action } = req.body;
    const validDecisions = [TE_DECISION.DRAFT, TE_DECISION.REVISION, TE_DECISION.APPROVED, TE_DECISION.REJECTED, TE_DECISION.APPROVED_PUBLISH];

    if (!validDecisions.includes(decision)) {
      return next(new AppError(`decision must be one of: ${validDecisions.join(", ")}`, 400));
    }

    const chapter = await Chapter.findOne({ _id: req.params.chapterId, status: CHAPTER_STATUS.PENDING_TE });
    if (!chapter) return next(new AppError("Chapter not found or not pending TE review", 404));

    // Validate scores
    if (scores) {
      for (const [key, val] of Object.entries(scores)) {
        if (!TE_CRITERIA_KEYS.includes(key)) {
          return next(new AppError(`Invalid score key: "${key}"`, 400));
        }
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 5) {
          return next(new AppError(`Score "${key}" must be integer 0-5`, 400));
        }
      }
    }

    // Upsert review với decision cuối cùng
    let review = await TEReview.findOne({ chapter_id: chapter._id });
    if (review) {
      review.decision = decision;
      review.feedback = feedback || review.feedback || "";
      review.revision_feedback = revision_feedback || review.revision_feedback || "";
      review.quick_notes = quick_notes || review.quick_notes || "";
      if (scores) {
        for (const [key, val] of Object.entries(scores)) {
          review.scores.set(key, val);
        }
      }
    } else {
      const scoreMap = new Map();
      if (scores) {
        for (const [key, val] of Object.entries(scores)) scoreMap.set(key, val);
      }
      review = await TEReview.create({
        chapter_id: chapter._id,
        reviewed_by: req.user.nameid,
        decision,
        annotations: [],
        feedback: feedback || "",
        revision_feedback: revision_feedback || "",
        quick_notes: quick_notes || "",
        scores: scores ? new Map(Object.entries(scores)) : new Map(),
      });
    }
    await review.save();

    // ── Xử lý chapter status theo decision ────────────────────────────────
    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";

    if (decision === TE_DECISION.REVISION) {
      chapter.status = CHAPTER_STATUS.TE_REVISION;
      chapter.revision_notes = revision_feedback || "";
      chapter.revision_annotations = review.annotations || [];
      chapter.revision_source = "TE";
      await chapter.save();
      await notifyChapterTERevision(Notification, chapter.submitted_by, chapter, seriesName, review.annotations || []);
    } else if (decision === TE_DECISION.REJECTED) {
      chapter.status = CHAPTER_STATUS.DRAFT;
      chapter.revision_notes = revision_feedback || "";
      chapter.revision_annotations = [];
      chapter.revision_source = "TE";
      await chapter.save();
      await notifyChapterTERejected(Notification, chapter.submitted_by, chapter, seriesName);
    } else if (decision === TE_DECISION.APPROVED) {
      chapter.status = CHAPTER_STATUS.PENDING_EB;
      chapter.revision_notes = "";
      chapter.revision_annotations = [];
      chapter.revision_source = "";
      await chapter.save();
      const ebUsers = await require("../models/User").find({ role: ROLES.EB }).lean();
      for (const eb of ebUsers) {
        await notifyChapterToEB(Notification, eb._id, chapter, seriesName);
      }
    } else if (decision === TE_DECISION.APPROVED_PUBLISH) {
      chapter.status = CHAPTER_STATUS.PUBLISHED;
      chapter.is_published = true;
      chapter.published_at = new Date();
      chapter.revision_notes = "";
      chapter.revision_annotations = [];
      chapter.revision_source = "";
      await chapter.save();
      await notifyChapterTEPublished(Notification, chapter.submitted_by, chapter, seriesName);
    }
    // DRAFT: giữ nguyên pending_TE, không thay đổi

    // ── Tìm next chapter nếu user chọn "next_chapter" ─────────────────────
    let nextChapter = null;
    if (next_action === "next_chapter" && decision !== TE_DECISION.DRAFT) {
      const sameSeries = await Chapter.findOne({
        _id: { $ne: chapter._id },
        series_id: chapter.series_id,
        status: CHAPTER_STATUS.PENDING_TE,
      })
        .sort({ chapter_number: 1 })
        .lean();

      if (!sameSeries) {
        // Thử tìm chapter pending TE khác (series khác)
        nextChapter = await Chapter.findOne({
          _id: { $ne: chapter._id },
          status: CHAPTER_STATUS.PENDING_TE,
        })
          .sort({ updatedAt: 1 })
          .populate("submitted_by", "username full_name")
          .populate("series_id", "name")
          .lean();
      } else {
        nextChapter = sameSeries;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        submitted_chapter: {
          _id: chapter._id,
          chapter_number: chapter.chapter_number,
          title: chapter.title,
          status: chapter.status,
          decision,
        },
        review: {
          _id: review._id,
          scores: Object.fromEntries(review.scores),
          average_score: review.average_score,
          annotation_count: review.annotations.length,
          feedback: review.feedback,
          quick_notes: review.quick_notes,
        },
        next_chapter: nextChapter
          ? {
              _id: nextChapter._id,
              chapter_number: nextChapter.chapter_number,
              title: nextChapter.title,
              series: nextChapter.series_id,
              submitted_by: nextChapter.submitted_by,
            }
          : null,
          next_action,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /te-reviews/chapter/:chapterId/annotations/:annotationId ───────
// Xoá 1 annotation (gỡ ô)
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

module.exports = router;