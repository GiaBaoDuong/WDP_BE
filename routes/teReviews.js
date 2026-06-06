const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireTE, requireMangaka } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const Series = require("../models/Series");
const TEReview = require("../models/TEReview");
const Notification = require("../models/Notification");
const { notifyChapterToTE, notifyChapterToEB } = require("../services/notificationService");

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
    } else {
      chapter.status = "TE_revision";
      chapter.te_review_id = review._id;
      chapter.revision_notes = revision_feedback || "";
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
      // Notify Mangaka
      await Notification.create({
        user_id: chapter.submitted_by,
        type: "chapter_TE_revision",
        title: "TE yêu cầu chỉnh sửa",
        message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) cần chỉnh sửa theo góp ý của TE.`,
        meta: { chapter_id: chapter._id, series_id: chapter.series_id },
      });
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

module.exports = router;
