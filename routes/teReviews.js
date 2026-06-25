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
const { TEReview } = require("../models/TEReview");
const { SeriesReview } = require("../models/SeriesReview");
const Notification = require("../models/Notification");
const { CHAPTER_STATUS } = require("../utils/constants");
const { TE_DECISION } = require("../utils/constants");
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
// TE chỉ thấy chapter được gán cho mình HOẶC chưa ai gán
router.get("/pending", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const chapters = await Chapter.find({
      status: CHAPTER_STATUS.PENDING_TE,
      $or: [
        { te_id: req.user.nameid },
        { te_id: null },
      ],
    })
      .populate("submitted_by", "username full_name phoneNumber")
      .populate("series_id", "name")
      .sort({ te_assigned_at: 1, updatedAt: 1 })
      .lean();

    return res.status(200).json({ success: true, data: chapters });
  } catch (error) {
    next(error);
  }
});

// ─── GET /te-reviews/history ─────────────────────────────────────────────────
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
router.get("/dashboard", authMiddleware, requireTE, async (req, res, next) => {
  try {
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    const pendingChapters = await Chapter.find({
      status: CHAPTER_STATUS.PENDING_TE,
      $or: [{ te_id: req.user.nameid }, { te_id: null }],
    })
      .select("_id series_id chapter_number title submitted_by updatedAt te_assigned_at")
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
router.get("/studio-progress", authMiddleware, requireMangakaOrTEOrEB, async (req, res, next) => {
  try {
    const { series_id } = req.query;
    const now = new Date();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const ACTIVE_STATUSES = [
      CHAPTER_STATUS.DRAFT, CHAPTER_STATUS.PENDING_ASSISTANT, CHAPTER_STATUS.PENDING_TE,
      CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.PENDING_EB, CHAPTER_STATUS.EB_REVISION,
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
        if (![CHAPTER_STATUS.PENDING_TE, CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.PENDING_EB, CHAPTER_STATUS.EB_REVISION].includes(c.status)) return false;
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
// Lấy series review hiện tại của TE cho series này
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
// [Nút: Save Review] — Lưu nháp đánh giá series, KHÔNG gửi đi
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
// [Nút: Approve & Publish / Reject & Request Edit]
//   action = "approve" → gửi EB (chapters → pending_EB)
//   action = "reject"  → gửi Mangaka (series → revision)
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

      for (const ch of chaptersToEB) {
        ch.status = CHAPTER_STATUS.PENDING_EB;
        ch.revision_notes = "";
        ch.revision_annotations = [];
        ch.revision_source = "";
        ch.is_published = false;
        await ch.save();
      }

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

// ─── GET /series-review/:seriesId/next-chapter ───────────────────────────────
// [Nút: Next Chapter] — Tìm chapter pending_TE tiếp theo của series
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
      { new: true, upsert: true, runValidators: true }
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
 *     tags: [TE Reviews]
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
 *     tags: [TE Reviews]
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
      const series = await Series.findById(chapter.series_id).lean();
      for (const eb of ebUsers) {
        await notifyChapterToEB(Notification, eb._id, chapter, series ? series.name : "");
      }

      return res.status(200).json({
        success: true,
        message: "Chapter đã được gửi lên EB.",
        data: chapter,
      });
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

module.exports = router;
