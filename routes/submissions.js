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
const { CHAPTER_STATUS } = require("../utils/constants");
const { ROLES } = require("../utils/constants");
const { notifyChapterToTE } = require("../services/notificationService");

// ─── GET /submissions/te-users ────────────────────────────────────────────────
/**
 * @swagger
 * /submissions/te-users:
 *   get:
 *     summary: Lấy danh sách TE (Editor) đang active
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách TE
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
 *                       username: { type: string }
 *                       full_name: { type: string }
 *                       email: { type: string }
 */
router.get("/te-users", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const teUsers = await User.find({ role: "Editor", status: "active" })
      .select("_id username full_name email")
      .lean();

    return res.status(200).json({ success: true, data: teUsers });
  } catch (error) {
    next(error);
  }
});

// ─── POST /submissions/chapters/:chapterId/assign-te ────────────────────────
/**
 * @swagger
 * /submissions/chapters/{chapterId}/assign-te:
 *   post:
 *     summary: Gán TE cụ thể cho chapter
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của chapter
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [te_id]
 *             properties:
 *               te_id:
 *                 type: string
 *                 description: ObjectId của TE được gán
 *     responses:
 *       200:
 *         description: Gán TE thành công
 *       400:
 *         description: te_id không hợp lệ hoặc chapter không ở trạng thái cho phép
 *       404:
 *         description: Chapter không tìm thấy
 */
router.post("/chapters/:chapterId/assign-te", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { te_id } = req.body;
    if (!te_id) return next(new AppError("te_id is required", 400));

    const te = await User.findOne({ _id: te_id, role: ROLES.EDITOR });
    if (!te) return next(new AppError("TE not found or invalid role", 400));

    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    // Chỉ assign được khi chưa gửi TE, hoặc đang ở trạng thái TE_revision hoặc review
    if (![CHAPTER_STATUS.DRAFT, CHAPTER_STATUS.PENDING_ASSISTANT, CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.REVIEW].includes(chapter.status)) {
      return next(new AppError(`Không thể gán TE ở trạng thái "${chapter.status}"`, 400));
    }

    const previousTeId = chapter.te_id;
    chapter.te_id = te_id;
    chapter.te_assigned_at = new Date();
    chapter.status = CHAPTER_STATUS.PENDING_TE;
    await chapter.save();

    // Notify TE được gán
    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";
    await notifyChapterToTE(Notification, te_id, chapter, seriesName);

    // Nếu có TE cũ bị thay, notify TE cũ
    if (previousTeId && String(previousTeId) !== String(te_id)) {
      await notifyChapterToTE(Notification, previousTeId, chapter, seriesName);
    }

    return res.status(200).json({
      success: true,
      message: `Đã gán TE "${te.full_name}" cho chapter.`,
      data: chapter,
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /submissions/chapters/:chapterId/remove-te ──────────────────────
/**
 * @swagger
 * /submissions/chapters/{chapterId}/remove-te:
 *   delete:
 *     summary: Gỡ TE khỏi chapter
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của chapter
 *     responses:
 *       200:
 *         description: Gỡ TE thành công
 *       400:
 *         description: Chapter chưa được gán TE
 *       404:
 *         description: Chapter không tìm thấy
 */
router.delete("/chapters/:chapterId/remove-te", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    if (!chapter.te_id) return next(new AppError("Chapter chưa được gán TE nào", 400));

    chapter.te_id = null;
    chapter.te_assigned_at = null;
    await chapter.save();

    return res.status(200).json({ success: true, message: "Đã gỡ TE khỏi chapter.", data: chapter });
  } catch (error) {
    next(error);
  }
});

// ─── POST /submissions/chapters/:chapterId/submit-to-te ───────────────────────
// Mangaka gửi chapter cho TE duyệt
// Điều kiện: tất cả tasks đã approved
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
 */
router.post("/chapters/:chapterId/submit-to-te", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { te_id } = req.body;

    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    if (![CHAPTER_STATUS.DRAFT, CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.PENDING_ASSISTANT, CHAPTER_STATUS.REVIEW].includes(chapter.status)) {
      return next(new AppError("Chapter cannot be submitted in current status", 400));
    }

    const unfinishedTasks = await Task.countDocuments({
      chapter_id: chapter._id,
      status: { $in: ["submitted", "revision"] },
    });
    if (unfinishedTasks > 0) {
      return next(new AppError(`${unfinishedTasks} task chưa hoàn thành. Vui lòng duyệt hết trước khi gửi cho TE.`, 400));
    }

    chapter.status = CHAPTER_STATUS.PENDING_TE;
    chapter.revision_notes = "";
    chapter.revision_annotations = [];
    chapter.revision_source = "";

    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";

    if (chapter.te_id) {
      await chapter.save();
      await Notification.create({
        user_id: chapter.te_id,
        type: "chapter_pending_te",
        chapter_id: chapter._id,
        title: `Chapter "${chapter.title}" cần duyệt`,
        message: `Chapter "${chapter.title}" (${chapter.chapter_number}) đã được gửi sang TE.`,
      });
    } else {
      await chapter.save();
      const teUsers = await User.find({ role: "Editor", status: "active" }).lean();
      await Notification.insertMany(
        teUsers.map((u) => ({
          user_id: u._id,
          type: "chapter_pending_te",
          chapter_id: chapter._id,
          title: `Chapter "${chapter.title}" cần duyệt`,
          message: `Chapter "${chapter.title}" (${chapter.chapter_number}) đã được gửi sang TE.`,
        }))
      );
    }

    return res.status(200).json({
      success: true,
      message: chapter.te_id ? "Chapter đã được gửi cho TE được gán." : "Chapter đã được gửi cho tất cả TE.",
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
    const chapters = await Chapter.find({
      status: CHAPTER_STATUS.PENDING_TE,
      $or: [{ te_id: req.user.nameid }, { te_id: null }],
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
    const chapters = await Chapter.find({ status: CHAPTER_STATUS.PENDING_EB })
      .populate("submitted_by", "username full_name phoneNumber")
      .populate("series_id", "name")
      .sort({ updatedAt: 1 })
      .lean();

    return res.status(200).json({ success: true, data: chapters });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /submissions/chapters/:id/approve ──────────────────────────────────
/**
 * @swagger
 * /submissions/chapters/{id}/approve:
 *   patch:
 *     summary: Mangaka approve chapter (chuyển sang trạng thái review)
 *     tags: [Submissions]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của chapter
 *     responses:
 *       200:
 *         description: Approve thành công
 *       400:
 *         description: Không thể approve ở trạng thái hiện tại
 *       404:
 *         description: Chapter không tìm thấy
 */
router.patch("/chapters/:id/approve", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.id,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    const VALID_APPROVE_STATUSES = [
      CHAPTER_STATUS.DRAFT,
      CHAPTER_STATUS.PENDING_ASSISTANT,
      CHAPTER_STATUS.SUBMITTED_BY_ASSISTANT,
      CHAPTER_STATUS.TE_REVISION,
      CHAPTER_STATUS.REVIEW,
    ];
    if (!VALID_APPROVE_STATUSES.includes(chapter.status)) {
      return next(new AppError(`Không thể approve ở trạng thái "${chapter.status}"`, 400));
    }

    chapter.status = CHAPTER_STATUS.REVIEW;
    await chapter.save();

    return res.status(200).json({ success: true, data: chapter });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
