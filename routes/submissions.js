const express = require("express");
const router = express.Router();
const multer = require("multer");
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { requireMangaka, requireTE, requireEB } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const Page = require("../models/Page");
const Task = require("../models/Task");
const Notification = require("../models/Notification");
const User = require("../models/User");
const cloudinary = require("../config/cloudinary");
const { CHAPTER_STATUS, ROLES, SERIES_STATUS } = require("../utils/constants");
const { notifyChapterToTE } = require("../services/notificationService");
const { canSubmitChapterToTE } = require("../services/debutGate");
const path = require("path");

// Multer memory storage for quick-revision uploads
const uploadRevisionPages = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error("Only image files (jpeg, jpg, png, webp) are allowed"));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Upload single file lên Cloudinary (stream from memory buffer)
async function uploadSingleToCloudinary(file, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", allowed_formats: ["jpg", "jpeg", "png", "webp"] },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(file.buffer);
  });
}

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

    // Chỉ assign được khi đã duyệt bởi Mangaka HOẶC đang revision
    // KHÔNG đổi status ở đây - status sẽ đổi ở submit-to-te
    if (![CHAPTER_STATUS.APPROVED_BY_MANGAKA, CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.REVIEW].includes(chapter.status)) {
      return next(new AppError(`Không thể gán TE ở trạng thái "${chapter.status}". Vui lòng duyệt chapter trước.`, 400));
    }

    const previousTeId = chapter.te_id;
    chapter.te_id = te_id;
    chapter.te_assigned_at = new Date();
    // KHÔNG đổi status ở đây - chỉ lưu te_id để submit-to-te dùng
    const series = await Series.findById(chapter.series_id).lean();
    await chapter.save();

    // Notify TE được gán
    const seriesName = series ? series.name : "";
    await notifyChapterToTE(Notification, te_id, chapter, seriesName);

    // Nếu có TE cũ bị thay, notify TE cũ
    if (previousTeId && String(previousTeId) !== String(te_id)) {
      await notifyChapterToTE(Notification, previousTeId, chapter, seriesName);
    }

    return res.status(200).json({
      success: true,
      message: `Đã gán TE "${te.full_name}" cho chapter. Có thể gửi cho TE.`,
      data: chapter,
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /submissions/chapters/:chapterId/approve-by-mangaka ────────────────
// Mangaka duyệt chapter từ Assistant trước khi gửi TE
// Điều kiện: tất cả tasks đã approved
/**
 * @swagger
 * /submissions/chapters/{chapterId}/approve-by-mangaka:
 *   post:
 *     summary: Mangaka duyệt chapter từ Assistant
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
 *         description: Chapter đã được duyệt
 *       400:
 *         description: Chapter không ở trạng thái chờ duyệt
 *       404:
 *         description: Chapter không tìm thấy
 */
router.post("/chapters/:chapterId/approve-by-mangaka", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    // Chỉ duyệt được khi đang ở trạng thái submitted_by_assistant
    if (chapter.status !== CHAPTER_STATUS.SUBMITTED_BY_ASSISTANT) {
      return next(new AppError(`Không thể duyệt chapter ở trạng thái "${chapter.status}"`, 400));
    }

    // Kiểm tra tất cả tasks đã approved chưa (chỉ check vòng hiện tại).
    // Dedupe theo page_id: 1 page = 1 task đại diện (ưu tiên status "cao nhất") để tránh
    // fail vì task trùng/ẩn do flow POST /chapters + submit tạo 2 lần hoặc task cũ chưa archive.
    const unfinishedRaw = await Task.find({
      chapter_id: chapter._id,
      is_current_round: true,
      status: { $ne: "approved" },
    })
      .populate("page_id", "page_number")
      .select("_id page_id status revision_round assigned_to")
      .lean();

    const STATUS_PRIORITY = { revision: 4, in_progress: 3, submitted: 2, in_review: 2, pending: 1 };
    const dedupeByPage = new Map();
    for (const t of unfinishedRaw) {
      const key = t.page_id?._id?.toString() ?? "orphan";
      const existing = dedupeByPage.get(key);
      const tPri = STATUS_PRIORITY[t.status] ?? 0;
      const ePri = STATUS_PRIORITY[existing?.status] ?? -1;
      if (!existing || tPri > ePri) dedupeByPage.set(key, t);
    }
    const unfinished = Array.from(dedupeByPage.values());

    if (unfinished.length > 0) {
      return next(new AppError(
        `${unfinished.length} trang còn task chưa được duyệt. Vui lòng duyệt hết trước.`,
        400,
        {
          total_unfinished: unfinishedRaw.length,
          affected_pages: unfinished.length,
          missing_tasks: unfinished.map((t) => ({
            task_id: t._id,
            page_id: t.page_id?._id ?? null,
            page_number: t.page_id?.page_number ?? null,
            status: t.status,
            revision_round: t.revision_round ?? null,
          })),
        }
      ));
    }

    // Cập nhật status
    chapter.status = CHAPTER_STATUS.APPROVED_BY_MANGAKA;
    await chapter.save();

    return res.status(200).json({
      success: true,
      message: "Chapter đã được duyệt. Có thể gửi cho TE.",
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
// Hỗ trợ 2 giai đoạn (xem `phase` trong response):
//   - "series_level": Series chưa EB-approved (status ∈ draft/submitted/rejected/cancelled)
//     → Gửi Series + chapter cho TE. TE duyệt cả Series (gửi EB / yêu cầu revision).
//   - "chapter_level": Series đã EB-approved (status ∈ approved/published)
//     → Chỉ gửi chapter cho TE. TE duyệt chapter để publish.
/**
 * @swagger
 * /submissions/chapters/{chapterId}/submit-to-te:
 *   post:
 *     summary: Submit chapter to TE for review
 *     description: |
 *       Mangaka gửi chapter cho TE duyệt.
 *       Điều kiện:
 *       - Chapter đang ở trạng thái `approved_by_mangaka`, `te_revision`, hoặc `review`
 *       - Tất cả tasks của chapter phải ở trạng thái `approved` (không còn `submitted`/`revision`)
 *       Nếu đã gán TE (chapter.te_id) → chỉ gửi cho TE đó.
 *       Nếu chưa gán → gửi cho TẤT CẢ TE active.
 *       Chapter → status = "pending_TE"
 *
 *       **Hỗ trợ 2 giai đoạn** (phân biệt theo `Series.status`):
 *       - Giai đoạn 1 (`series_level`): Series chưa EB-approved (status ∈ {draft, submitted, rejected, cancelled}).
 *         Gửi cả Series + chapter. TE review chapter và quyết định cả Series (gửi EB hoặc yêu cầu revision).
 *         Notification type: `series_pending_te`, `related_entity_type = "series"`.
 *       - Giai đoạn 2 (`chapter_level`): Series đã EB-approved (status ∈ {approved, published}).
 *         Chỉ gửi chapter cho TE. TE duyệt chapter để EB confirm publish.
 *         Notification type: `chapter_pending_te`, `related_entity_type = "chapter"`.
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
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               te_id:
 *                 type: string
 *                 description: Override TE (optional, dùng nếu chưa assign trước đó)
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
 *                 message:
 *                   type: string
 *                 phase:
 *                   type: string
 *                   enum: [series_level, chapter_level]
 *                   description: |
 *                     Giai đoạn review:
 *                     - `series_level`: TE duyệt cả Series (giai đoạn 1).
 *                     - `chapter_level`: TE duyệt chapter (giai đoạn 2).
 *                 data:
 *                   $ref: '#/components/schemas/Chapter'
 *                 seriesInfo:
 *                   type: object
 *                   properties:
 *                     _id: { type: string }
 *                     name: { type: string }
 *                     cover_image_url: { type: string }
 *                     genre:
 *                       type: array
 *                       items: { type: string }
 *                     tags:
 *                       type: array
 *                       items: { type: string }
 *                     synopsis: { type: string }
 *                     author_id: { type: string }
 *                     status: { type: string }
 *       400:
 *         description: Invalid status or unfinished tasks
 *       404:
 *         description: Chapter not found or unauthorized
 */
router.post("/chapters/:chapterId/submit-to-te", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { te_id } = req.body;

    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    // Chỉ submit được khi đã duyệt bởi Mangaka HOẶC đang revision
    if (![CHAPTER_STATUS.APPROVED_BY_MANGAKA, CHAPTER_STATUS.TE_REVISION, CHAPTER_STATUS.REVIEW].includes(chapter.status)) {
      return next(new AppError(`Không thể gửi chapter ở trạng thái "${chapter.status}". Vui lòng duyệt chapter trước.`, 400));
    }

    const unfinishedTasks = await Task.countDocuments({
      chapter_id: chapter._id,
      is_current_round: true,
      status: { $in: ["submitted", "revision"] },
    });
    if (unfinishedTasks > 0) {
      return next(new AppError(`${unfinishedTasks} task chưa hoàn thành. Vui lòng duyệt hết trước khi gửi cho TE.`, 400));
    }

    const series = await Series.findById(chapter.series_id).lean();
    if (!series) return next(new AppError("Series not found", 404));

    // ─── Debut Gate (luồng 1): chỉ cho submit 1 chapter (chapter đầu) khi series locked ───────────
    // Gate này chặn việc Mangaka submit nhiều chapter lên TE khi series chưa qua debut pipeline.
    // Sau khi EB confirm-publish → gate mở → cho submit chapter 2+.
    const submitGate = await canSubmitChapterToTE({ series, chapterNumber: chapter.chapter_number });
    if (!submitGate.allowed) {
      return next(new AppError(submitGate.message, 409, submitGate.data));
    }

    chapter.status = CHAPTER_STATUS.PENDING_TE;
    chapter.revision_notes = "";
    chapter.revision_annotations = [];
    chapter.revision_source = "";

    // Phân biệt 2 giai đoạn theo Series.status:
    //   - Giai đoạn 1: Series chưa EB-approved (draft/submitted/rejected/cancelled)
    //     → Gửi Series + chapter cho TE. TE quyết định cả Series (gửi EB / yêu cầu revision).
    //   - Giai đoạn 2: Series đã EB-approved (approved_by_EB/approved/published)
    //     → Chỉ gửi chapter cho TE. TE publish chapter thủ công qua /te-reviews/chapter/:id/publish.
    const isSeriesLevel = ![SERIES_STATUS.APPROVED_BY_EB, SERIES_STATUS.APPROVED, SERIES_STATUS.PUBLISHED].includes(series.status);

    const chapterPayload = chapter.toObject ? chapter.toObject() : chapter;

    const baseMeta = {
      chapter_id: chapter._id,
      chapter_number: chapter.chapter_number,
      chapter_title: chapter.title,
      series_id: series._id,
      series_name: series.name,
      series_genre: series.genre || [],
      series_tags: series.tags || [],
      series_synopsis: series.synopsis || "",
      series_cover_image_url: series.cover_image_url || "",
      series_author_id: series.author_id || null,
      series_status: series.status,
      is_series_level: isSeriesLevel,
      submitted_by: chapter.submitted_by,
    };

    // Giai đoạn 1: notification trỏ vào Series (related_entity_type = "series")
    // Giai đoạn 2: notification trỏ vào Chapter (giữ nguyên flow cũ)
    const baseNotification = isSeriesLevel
      ? {
          related_entity_type: "series",
          related_entity_id: series._id,
          meta: baseMeta,
        }
      : {
          related_entity_type: "chapter",
          related_entity_id: chapter._id,
          meta: baseMeta,
        };

    const notificationType = isSeriesLevel ? "series_pending_te" : "chapter_pending_te";
    const notificationTitle = isSeriesLevel
      ? `Series "${series.name}" cần TE duyệt`
      : `Chapter "${chapter.title}" cần duyệt`;
    const notificationMessage = isSeriesLevel
      ? `Series "${series.name}" (kèm chapter ${chapter.chapter_number}) đã được gửi sang TE để duyệt.`
      : `Chapter "${chapter.title}" (${chapter.chapter_number}) của series "${series.name}" đã được gửi sang TE.`;

    if (chapter.te_id) {
      await chapter.save();
      await Notification.create({
        ...baseNotification,
        user_id: chapter.te_id,
        type: notificationType,
        title: notificationTitle,
        message: notificationMessage,
      });
    } else {
      await chapter.save();
      const teUsers = await User.find({ role: "Editor", status: "active" }).lean();
      await Notification.insertMany(
        teUsers.map((u) => ({
          ...baseNotification,
          user_id: u._id,
          type: notificationType,
          title: notificationTitle,
          message: notificationMessage,
        }))
      );
    }

    return res.status(200).json({
      success: true,
      message: chapter.te_id ? "Đã gửi cho TE được gán." : "Đã gửi cho tất cả TE.",
      data: chapterPayload,
      // Trả về phase để FE biết đang ở giai đoạn nào
      phase: isSeriesLevel ? "series_level" : "chapter_level",
      seriesInfo: {
        _id: series._id,
        name: series.name,
        cover_image_url: series.cover_image_url || "",
        genre: series.genre || [],
        tags: series.tags || [],
        synopsis: series.synopsis || "",
        author_id: series.author_id,
        status: series.status,
      },
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

// ─── POST /submissions/chapters/:id/quick-revision ───────────────────────────
// Mangaka sửa nhanh 1-2 pages rồi gửi thẳng cho TE (bỏ qua bước Assistant).
// Chỉ áp dụng khi EB hoặc TE yêu cầu chỉnh sửa nội dung nhỏ.
// Luồng: EB/TE bảo sửa → Mangaka sửa 1-2 page → gọi API này → gửi thẳng cho TE
/**
 * @swagger
 * /submissions/chapters/{id}/quick-revision:
 *   post:
 *     summary: Mangaka sửa nhanh pages rồi gửi thẳng cho TE (bỏ qua Assistant)
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
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               pages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     page_id:
 *                       type: string
 *                       description: ID của page cần sửa
 *                     image:
 *                       type: string
 *                       format: binary
 *                       description: Ảnh đã sửa (file)
 *     responses:
 *       200:
 *         description: Gửi lại cho TE thành công
 *       400:
 *         description: Chapter không ở trạng thái revision hoặc không có quyền
 *       404:
 *         description: Chapter không tìm thấy
 */
router.post(
  "/chapters/:id/quick-revision",
  authMiddleware,
  requireMangaka,
  uploadRevisionPages.array("pages", 5),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { page_ids } = req.body;
      const uploadedFiles = req.files || [];

      const chapter = await Chapter.findOne({
        _id: id,
        submitted_by: req.user.nameid,
      }).populate("series_id", "name status");
      if (!chapter) {
        return next(new AppError("Chapter not found or unauthorized", 404));
      }

      // Chỉ cho phép quick-revision khi:
      // - chapter đang ở trạng thái revision (TE_revision, EB_revision, revision_requested), HOẶC
      // - series bị EB reject (series.status = "rejected"), HOẶC
      // - series đang revision (series.status = "revision")
      const revisionStatuses = [CHAPTER_STATUS.EB_REVISION, CHAPTER_STATUS.TE_REVISION, "revision_requested"];
      const isSeriesRejectedOrRevision = chapter.series_id && 
        (chapter.series_id.status === "rejected" || chapter.series_id.status === "revision");
      if (!revisionStatuses.includes(chapter.status) && !isSeriesRejectedOrRevision) {
        return next(
          new AppError(
            `Chỉ cho phép quick-revision khi chapter đang ở trạng thái revision hoặc series bị EB reject/revision (hiện tại: chapter="${chapter.status}", series="${chapter.series_id?.status || 'unknown'}")`,
            400
          )
        );
      }

      // Parse page_ids: có thể là JSON array string hoặc array
      let parsedPageIds = [];
      if (page_ids) {
        try {
          parsedPageIds = typeof page_ids === "string" ? JSON.parse(page_ids) : page_ids;
        } catch {
          return next(new AppError("page_ids không hợp lệ", 400));
        }
      }

      if (parsedPageIds.length === 0 && uploadedFiles.length === 0) {
        return next(new AppError("Cần truyền ít nhất 1 page_id và 1 ảnh đã sửa", 400));
      }

      if (parsedPageIds.length !== uploadedFiles.length) {
        return next(new AppError("Số lượng page_ids và số ảnh upload phải bằng nhau", 400));
      }

      // Giới hạn số page được quick-revision (tối đa 5 pages)
      if (uploadedFiles.length > 5) {
        return next(new AppError("Quick revision chỉ cho phép tối đa 5 pages mỗi lần", 400));
      }

      // Validate page_ids tồn tại và thuộc về chapter này
      const pages = await Page.find({
        _id: { $in: parsedPageIds },
        chapter_id: chapter._id,
      });
      if (pages.length !== parsedPageIds.length) {
        return next(new AppError("Một hoặc nhiều page_id không hợp lệ hoặc không thuộc chapter này", 400));
      }

      const series = await Series.findById(chapter.series_id).lean();
      if (!series) return next(new AppError("Series not found", 404));

      // Upload images lên Cloudinary
      const folder = `wdp/chapters/${chapter.series_id}/${Date.now()}`;
      const uploadPromises = uploadedFiles.map((file) =>
        uploadSingleToCloudinary(file, folder)
      );
      const uploadResults = await Promise.all(uploadPromises);

      // Cập nhật từng page với ảnh đã sửa
      const pageUpdates = pages.map((page, index) => {
        const imageUrl = uploadResults[index];
        return Page.findByIdAndUpdate(page._id, {
          result_image_url: imageUrl,
          final_image_url: imageUrl,
          current_version: page.current_version + 1,
          status: "approved",
        });
      });
      await Promise.all(pageUpdates);

      // Reset revision fields và chuyển chapter sang pending_TE
      chapter.status = CHAPTER_STATUS.PENDING_TE;
      chapter.revision_notes = "";
      chapter.revision_annotations = [];
      chapter.revision_source = "";
      chapter.revision_round = (chapter.revision_round || 1) + 1;
      chapter.revision_history.push({
        at: new Date(),
        by: req.user.nameid,
        note: `Quick revision: ${uploadedFiles.length} page(s) đã sửa và gửi thẳng cho TE`,
      });
      await chapter.save();

      // Notify TE
      const seriesName = series.name || "";
      if (chapter.te_id) {
        await Notification.create({
          user_id: chapter.te_id,
          type: "chapter_pending_te",
          title: `Chapter "${chapter.title}" cần duyệt lại`,
          message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) của series "${seriesName}" đã được Mangaka sửa nhanh và gửi lại. Có ${uploadedFiles.length} page(s) đã được cập nhật.`,
          meta: {
            chapter_id: chapter._id,
            series_id: chapter.series_id,
            revision_type: "quick_revision",
            page_count: uploadedFiles.length,
          },
        });
      } else {
        const teUsers = await User.find({ role: "Editor", status: "active" }).lean();
        await Notification.insertMany(
          teUsers.map((u) => ({
            user_id: u._id,
            type: "chapter_pending_te",
            title: `Chapter "${chapter.title}" cần duyệt lại`,
            message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) của series "${seriesName}" đã được Mangaka sửa nhanh và gửi lại. Có ${uploadedFiles.length} page(s) đã được cập nhật.`,
            meta: {
              chapter_id: chapter._id,
              series_id: chapter.series_id,
              revision_type: "quick_revision",
              page_count: uploadedFiles.length,
            },
          }))
        );
      }

      return res.status(200).json({
        success: true,
        message: `Đã sửa ${uploadedFiles.length} page(s) và gửi lại cho TE.`,
        data: {
          chapter_id: chapter._id,
          chapter_number: chapter.chapter_number,
          chapter_title: chapter.title,
          series_id: chapter.series_id,
          series_name: seriesName,
          status: chapter.status,
          revision_round: chapter.revision_round,
          updated_pages: parsedPageIds.map((pid, i) => ({
            page_id: pid,
            page_number: pages.find((p) => p._id.toString() === pid).page_number,
            new_image_url: uploadResults[i],
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

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
