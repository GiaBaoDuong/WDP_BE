const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireMangaka, requireTE, requireEB } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const Task = require("../models/Task");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { notifyChapterToTE } = require("../services/notificationService");

// ─── POST /submissions/chapters/:chapterId/submit-to-te ───────────────────────
// Mangaka gửi chapter cho TE duyệt
// Điều kiện: tất cả pages đã approved
/**
 * @swagger
 * /submissions/chapters/{chapterId}/submit-to-te:
 *   post:
 *     summary: Submit chapter to TE for review
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *         description: The chapter ID
 *     responses:
 *       200:
 *         description: Chapter submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Chapter đã được gửi cho TE duyệt
 *                 data:
 *                   type: object
 *                   description: The updated chapter object
 *                 seriesName:
 *                   type: string
 *                   description: Name of the series
 *       400:
 *         description: Chapter cannot be submitted in current status or unfinished tasks
 *       404:
 *         description: Chapter not found or unauthorized
 */
router.post("/chapters/:chapterId/submit-to-te", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    // Kiểm tra chapter đang ở trạng thái draft hoặc TE_revision
    if (!["draft", "TE_revision", "pending_assistant"].includes(chapter.status)) {
      return next(new AppError("Chapter cannot be submitted in current status", 400));
    }

    // Kiểm tra tất cả tasks đã approved hoặc không có task
    const pendingTasks = await Task.countDocuments({
      chapter_id: chapter._id,
      status: { $nin: ["approved", "pending", "in_progress"] },
    });

    // Tasks đang submitted hoặc revision = chưa xong
    const unfinishedTasks = await Task.countDocuments({
      chapter_id: chapter._id,
      status: { $in: ["submitted", "revision"] },
    });

    if (unfinishedTasks > 0) {
      return next(
        new AppError(`Còn ${unfinishedTasks} task chưa hoàn thành. Vui lòng kiểm duyệt hết trước khi gửi cho TE.`, 400)
      );
    }

    chapter.status = "pending_TE";
    chapter.revision_notes = "";
    await chapter.save();

    // Lấy series name
    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";

    // Notify TE
    const teUsers = await User.find({ role: "Editor" }).lean();
    for (const te of teUsers) {
      await notifyChapterToTE(Notification, te._id, chapter, seriesName);
    }

    return res.status(200).json({
      success: true,
      message: "Chapter đã được gửi cho TE duyệt",
      data: chapter,
      seriesName,
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /submissions/mangaka ────────────────────────────────────────────────
// Mangaka xem tất cả chapters của mình theo trạng thái
/**
 * @swagger
 * /submissions/mangaka:
 *   get:
 *     summary: Get all chapters submitted by mangaka
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         required: false
 *         schema:
 *           type: string
 *         description: Filter by chapter status (optional)
 *     responses:
 *       200:
 *         description: List of chapters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       series_id:
 *                         type: object
 *                         properties:
 *                           name:
 *                             type: string
 *                           status:
 *                             type: string
 *                       status:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 */
router.get("/mangaka", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { submitted_by: req.user.nameid };
    if (status) filter.status = status;

    const chapters = await Chapter.find(filter)
      .populate("series_id", "name status")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: chapters });
  } catch (error) {
    next(error);
  }
});

// ─── GET /submissions/te ─────────────────────────────────────────────────────
// TE xem danh sách chapter đang chờ duyệt (route phụ, chính ở teReviews)
/**
 * @swagger
 * /submissions/te:
 *   get:
 *     summary: Get all chapters pending TE review
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of chapters pending TE review
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       submitted_by:
 *                         type: object
 *                         properties:
 *                           username:
 *                             type: string
 *                           full_name:
 *                             type: string
 *                       series_id:
 *                         type: object
 *                         properties:
 *                           name:
 *                             type: string
 *                       status:
 *                         type: string
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 */
router.get("/te", authMiddleware, requireTE, async (req, res, next) => {
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

// ─── GET /submissions/eb ─────────────────────────────────────────────────────
// EB xem danh sách chờ duyệt
/**
 * @swagger
 * /submissions/eb:
 *   get:
 *     summary: Get all chapters pending EB review
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of chapters pending EB review
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       submitted_by:
 *                         type: object
 *                         properties:
 *                           username:
 *                             type: string
 *                           full_name:
 *                             type: string
 *                       series_id:
 *                         type: object
 *                         properties:
 *                           name:
 *                             type: string
 *                       status:
 *                         type: string
 *                       updatedAt:
 *                         type: string
 *                         format: date-time
 */
router.get("/eb", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const chapters = await Chapter.find({ status: "pending_EB" })
      .populate("submitted_by", "username full_name")
      .populate("series_id", "name")
      .sort({ updatedAt: 1 })
      .lean();

    return res.status(200).json({ success: true, data: chapters });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
