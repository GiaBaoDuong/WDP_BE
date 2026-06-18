const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const authMiddleware = require("../middleware/auth");
const { requireMangaka, requireMangakaOrAssistant, requireAssistant, requireMangakaOrTEOrEB } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const PageLayer = require("../models/PageLayer");
const Series = require("../models/Series");
const Task = require("../models/Task");
const User = require("../models/User");
const Cooperation = require("../models/Cooperation");
const PageNote = require("../models/PageNote");
const Notification = require("../models/Notification");
const upload = require("../middleware/upload");
const { notifyChapterAssigned } = require("../services/notificationService");
const {
  notifyChapterAssistantWorkComplete,
} = require("../services/notificationService");

// ─── POST /chapters ──────────────────────────────────────────────────────────
// Mangaka tạo chapter thuộc series
/**
 * @swagger
 * /chapters:
 *   post:
 *     summary: Tạo chapter mới
 *     tags: [Chapters]
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
 *               - chapter_number
 *             properties:
 *               series_id:
 *                 type: string
 *                 description: ID của series
 *               chapter_number:
 *                 type: integer
 *                 description: Số thứ tự chapter
 *               title:
 *                 type: string
 *                 description: Tiêu đề chapter (optional)
 *     responses:
 *       201:
 *         description: Chapter được tạo thành công
 *       400:
 *         description: Thiếu series_id hoặc chapter_number
 *       404:
 *         description: Series not found hoặc unauthorized
 *       409:
 *         description: Chapter number đã tồn tại trong series
 */
router.post("/", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { series_id, chapter_number, title } = req.body;

    if (!series_id || chapter_number === undefined) {
      return next(new AppError("series_id and chapter_number are required", 400));
    }

    const series = await Series.findOne({
      _id: series_id,
      author_id: req.user.nameid,
    });
    if (!series) {
      return next(new AppError("Series not found or unauthorized", 404));
    }

    const existing = await Chapter.findOne({ series_id, chapter_number });
    if (existing) {
      return next(new AppError("Chapter number already exists in this series", 409));
    }

    const chapter = await Chapter.create({
      series_id,
      chapter_number,
      title: title || "",
      submitted_by: req.user.nameid,
      status: "draft",
    });

    return res.status(201).json({ success: true, data: chapter });
  } catch (error) {
    next(error);
  }
});

// ─── GET /chapters/:id ───────────────────────────────────────────────────────
// Lấy chi tiết chapter kèm seriesName (FE cần)
/**
 * @swagger
 * /chapters/{id}:
 *   get:
 *     summary: Lấy chi tiết chapter
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     responses:
 *       200:
 *         description: Chi tiết chapter kèm seriesName
 *       404:
 *         description: Chapter not found
 */
router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    const chapter = await Chapter.findById(req.params.id)
      .populate("series_id", "name author_id")
      .lean();

    if (!chapter) return next(new AppError("Chapter not found", 404));

    // Reader chỉ thấy published
    if (req.user.role === "Reader" && !chapter.is_published) {
      return next(new AppError("Chapter not found", 404));
    }

    return res.status(200).json({
      success: true,
      data: chapter,
      seriesName: chapter.series_id ? chapter.series_id.name : "",
    });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /chapters/:id ────────────────────────────────────────────────────
// Mangaka sửa chapter
/**
 * @swagger
 * /chapters/{id}:
 *   patch:
 *     summary: Cập nhật chapter
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *               title:
 *                 type: string
 *                 description: Tiêu đề chapter
 *               revision_notes:
 *                 type: string
 *                 description: Ghi chú sửa đổi
 *     responses:
 *       200:
 *         description: Cập nhật thành công
 *       400:
 *         description: Không thể sửa chapter đã published
 *       404:
 *         description: Chapter not found hoặc unauthorized
 */
router.patch("/:id", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.id,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    if (chapter.status === "published") {
      return next(new AppError("Cannot edit published chapter", 400));
    }

    if (req.body.title !== undefined) chapter.title = req.body.title;
    if (req.body.revision_notes !== undefined) chapter.revision_notes = req.body.revision_notes;

    await chapter.save();
    return res.status(200).json({ success: true, data: chapter });
  } catch (error) {
    next(error);
  }
});

// ─── POST /chapters/:id/pages ─────────────────────────────────────────────────
// Mangaka upload trang truyện (1 ảnh hoặc nhiều)
// Body: files (multipart/form-data, fieldname: "images")
/**
 * @swagger
 * /chapters/{id}/pages:
 *   post:
 *     summary: Upload pages cho chapter
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Các file ảnh (tối đa 50 ảnh)
 *     responses:
 *       201:
 *         description: Upload thành công, trả về danh sách pages
 *       400:
 *         description: No images uploaded / Chapter not found
 *       404:
 *         description: Chapter not found hoặc unauthorized
 */
router.post(
  "/:id/pages",
  authMiddleware,
  requireMangaka,
  upload.array("images", 50),
  async (req, res, next) => {
    try {
      const chapter = await Chapter.findOne({
        _id: req.params.id,
        submitted_by: req.user.nameid,
      });
      if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

      if (!req.files || req.files.length === 0) {
        return next(new AppError("No images uploaded", 400));
      }

      const existingPages = await Page.countDocuments({ chapter_id: chapter._id });

      const pages = await Promise.all(
        req.files.map((file, index) =>
          Page.create({
            chapter_id: chapter._id,
            page_number: existingPages + index + 1,
            original_image_url: `/uploads/chapters/${file.filename}`,
            uploaded_by: req.user.nameid,
            status: "raw",
          })
        )
      );

      return res.status(201).json({
        success: true,
        message: `${pages.length} page(s) uploaded`,
        data: pages,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /chapters/:id/pages ─────────────────────────────────────────────────
// Lấy tất cả pages của chapter
/**
 * @swagger
 * /chapters/{id}/pages:
 *   get:
 *     summary: Lấy danh sách pages của chapter
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     responses:
 *       200:
 *         description: Danh sách pages sắp xếp theo page_number
 *       404:
 *         description: Chapter not found
 */
router.get("/:id/pages", authMiddleware, requireMangakaOrTEOrEB, async (req, res, next) => {
  try {
    const chapter = await Chapter.findById(req.params.id).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    // Chapter chưa published → chỉ những role trên mới xem được
    // Chapter đã published → bất kỳ user đăng nhập nào cũng xem được
    if (!chapter.is_published) {
      const role = req.user.role;
      if (!["Mangaka", "Assistant", "Editor", "EB"].includes(role)) {
        return next(new AppError("Access denied", 403));
      }
    }

    const pages = await Page.find({ chapter_id: req.params.id })
      .sort({ page_number: 1 })
      .lean();

    return res.status(200).json({ success: true, data: pages });
  } catch (error) {
    next(error);
  }
});

// ─── GET /pages/:id ──────────────────────────────────────────────────────────
// Lấy chi tiết 1 page kèm tasks
/**
 * @swagger
 * /pages/{id}:
 *   get:
 *     summary: Lấy chi tiết page kèm tasks
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Page ID
 *     responses:
 *       200:
 *         description: Chi tiết page kèm danh sách tasks
 *       404:
 *         description: Page not found
 */
router.get("/pages/:id", authMiddleware, requireMangakaOrTEOrEB, async (req, res, next) => {
  try {
    const page = await Page.findById(req.params.id).lean();
    if (!page) return next(new AppError("Page not found", 404));

    // Page của chapter chưa published → chỉ Mangaka/Assistant/TE/EB xem được
    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (chapter && !chapter.is_published) {
      const role = req.user.role;
      if (!["Mangaka", "Assistant", "Editor", "EB"].includes(role)) {
        return next(new AppError("Access denied", 403));
      }
    }

    const tasks = await Task.find({ page_id: page._id })
        .populate("assigned_to", "username full_name phoneNumber")
        .populate("assigned_by", "username full_name phoneNumber")
        .populate("note_ids")
        .sort({ createdAt: 1 })
        .lean();

    return res.status(200).json({
      success: true,
      data: { ...page, tasks },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /chapters/:id/assign ────────────────────────────────────────────────
// Mangaka gán 1 assistant cho cả chapter
// Body: { assistant_id }
/**
 * @swagger
 * /chapters/{id}/assign:
 *   post:
 *     summary: Gán assistant và gửi tasks cho cả chapter
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *               - assistant_id
 *             properties:
 *               assistant_id:
 *                 type: string
 *                 description: Assistant user ID
 *     responses:
 *       200:
 *         description: Gán thành công
 *       400:
 *         description: Thiếu assistant_id / Chapter đã có assistant
 *       403:
 *         description: Assistant chưa ký hợp đồng hợp tác
 *       404:
 *         description: Chapter not found
 */
router.post("/:id/assign", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { assistant_id } = req.body;
    if (!assistant_id) {
      return next(new AppError("assistant_id is required", 400));
    }

    const chapter = await Chapter.findOne({
      _id: req.params.id,
      submitted_by: req.user.nameid,
    });
    if (!chapter) {
      return next(new AppError("Chapter not found or unauthorized", 404));
    }

    if (chapter.assistant_id) {
      return next(new AppError("Chapter đã có assistant, hãy gỡ trước khi gán mới", 400));
    }

    const assistant = await User.findById(assistant_id);
    if (!assistant || assistant.role !== "Assistant") {
      return next(new AppError("User không phải là Assistant", 400));
    }

    const cooperation = await Cooperation.findOne({
      mangaka_id: req.user.nameid,
      assistant_id,
      agreed_at: { $ne: null },
      $or: [
        { series_id: chapter.series_id },
        { series_id: null },
      ],
    });
    if (!cooperation) {
      return next(new AppError("Assistant chưa ký hợp đồng hợp tác với bạn", 403));
    }

    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";

    chapter.assistant_id = assistant_id;
    chapter.status = "pending_assistant";
    await chapter.save();

    // Lấy tất cả pages của chapter theo đúng thứ tự page_number
    const pages = await Page.find({ chapter_id: chapter._id }).sort({ page_number: 1 }).lean();

    // Lấy tất cả PageNotes của chapter từ DB
    const pageIds = pages.map((p) => p._id);
    const allNotes = await PageNote.find({ page_id: { $in: pageIds } }).lean();

    // Nhóm notes theo page_id
    const notesByPageId = {};
    for (const note of allNotes) {
      const pid = note.page_id.toString();
      if (!notesByPageId[pid]) notesByPageId[pid] = [];
      notesByPageId[pid].push(note);
    }

    // Lấy các page đã có task (tránh tạo trùng khi re-assign)
    const existingTaskPageIds = (
      await Task.find({ chapter_id: chapter._id, assigned_to: assistant_id }).distinct("page_id")
    ).map((id) => id.toString());

    const newTasks = [];
    const usedNoteIds = [];

    for (const page of pages) {
      const pageNotes = notesByPageId[page._id.toString()] || [];
      const hasExistingTask = existingTaskPageIds.includes(page._id.toString());

      if (pageNotes.length === 0) {
        // Page không có note: tạo 1 task placeholder nếu chưa có task nào cho page này
        if (!hasExistingTask) {
          const task = await Task.create({
            page_id: page._id,
            chapter_id: chapter._id,
            assigned_by: req.user.nameid,
            assigned_to: assistant_id,
            work_type: "other",
            region: { x: 0, y: 0, width: 100, height: 100 },
            description: `Task cho trang ${page.page_number} - chapter #${chapter.chapter_number}`,
            status: "pending",
          });
          newTasks.push(task);
          await Page.findByIdAndUpdate(page._id, { status: "has_task" });
        }
        continue;
      }

      // Mỗi note = 1 task, link đến note qua note_ids
      for (const note of pageNotes) {
        const task = await Task.create({
          page_id: page._id,
          chapter_id: chapter._id,
          assigned_by: req.user.nameid,
          assigned_to: assistant_id,
          work_type: note.taskType || "other",
          region: {
            x: note.x,
            y: note.y,
            width: note.w,
            height: note.h,
          },
          description: (note.text || "").trim(),
          note_ids: [note._id],
          status: "pending",
        });
        newTasks.push(task);
        usedNoteIds.push(note._id);
      }

      if (!hasExistingTask) {
        await Page.findByIdAndUpdate(page._id, { status: "has_task" });
      }
    }

    // Đánh dấu các note đã được dùng trong task
    if (usedNoteIds.length > 0) {
      await PageNote.updateMany(
        { _id: { $in: usedNoteIds } },
        { $set: { status: "used_in_task" } }
      );
    }

    await notifyChapterAssigned(Notification, assistant_id, chapter, seriesName);

    return res.status(200).json({
      success: true,
      message: `Đã gán assistant và tạo ${newTasks.length} task(s) cho chapter.`,
      data: {
        chapter,
        tasks_created: newTasks.length,
        tasks: newTasks,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /chapters/:id/assign ─────────────────────────────────────────────
// Mangaka gỡ assistant khỏi chapter
/**
 * @swagger
 * /chapters/{id}/assign:
 *   delete:
 *     summary: Gỡ assistant khỏi chapter
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     responses:
 *       200:
 *         description: Gỡ thành công
 *       400:
 *         description: Chapter chưa có assistant
 *       404:
 *         description: Chapter not found
 */
router.delete("/:id/assign", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.id,
      submitted_by: req.user.nameid,
    });
    if (!chapter) {
      return next(new AppError("Chapter not found or unauthorized", 404));
    }

    if (!chapter.assistant_id) {
      return next(new AppError("Chapter chưa có assistant", 400));
    }

    // Xóa các task đang pending của assistant trong chapter này
    await Task.deleteMany({
      chapter_id: chapter._id,
      assigned_to: chapter.assistant_id,
      status: "pending",
    });

    chapter.assistant_id = null;
    chapter.status = "draft";
    await chapter.save();

    return res.status(200).json({ success: true, message: "Đã gỡ assistant khỏi chapter" });
  } catch (error) {
    next(error);
  }
});

// ─── GET /chapters/my-assignments ────────────────────────────────────────────
// Assistant xem danh sách chapter được giao
/**
 * @swagger
 * /chapters/my-assignments:
 *   get:
 *     summary: Lấy danh sách chapter được giao (Assistant)
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Lọc theo chapter status (optional)
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Danh sách chapter kèm số pages và tiến độ tasks
 *       401:
 *         description: Unauthorized
 */
router.get("/my-assignments", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const filter = { assistant_id: req.user.nameid };
    if (status) filter.status = status;

    const [chapters, total] = await Promise.all([
      Chapter.find(filter)
        .populate("series_id", "name cover_image_url")
        .populate("submitted_by", "username full_name phoneNumber")
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean(),
      Chapter.countDocuments(filter),
    ]);

    // Lấy số pages và tasks cho mỗi chapter
    const chapterIds = chapters.map((c) => c._id);
    const [pageCounts, taskStats] = await Promise.all([
      Page.aggregate([
        { $match: { chapter_id: { $in: chapterIds } } },
        { $group: { _id: "$chapter_id", total: { $sum: 1 } } },
      ]),
      Task.aggregate([
        { $match: { chapter_id: { $in: chapterIds } } },
        {
          $group: {
            _id: "$chapter_id",
            total: { $sum: 1 },
            pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
            in_progress: { $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] } },
            submitted: { $sum: { $cond: [{ $eq: ["$status", "submitted"] }, 1, 0] } },
            approved: { $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const pageCountMap = Object.fromEntries(pageCounts.map((p) => [p._id.toString(), p.total]));
    const taskStatMap = Object.fromEntries(taskStats.map((t) => [t._id.toString(), t]));

    const enriched = chapters.map((c) => ({
      ...c,
      page_count: pageCountMap[c._id.toString()] || 0,
      tasks: taskStatMap[c._id.toString()] || { total: 0, pending: 0, in_progress: 0, submitted: 0, approved: 0 },
    }));

    return res.status(200).json({
      success: true,
      data: enriched,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /chapters/:id/complete-assistant-work ───────────────────────────────
// Assistant chủ động báo đã hoàn thành tất cả công việc trong chapter
/**
 * @swagger
 * /chapters/{id}/complete-assistant-work:
 *   post:
 *     summary: Assistant chủ động báo đã hoàn thành công việc trong chapter
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     responses:
 *       200:
 *         description: Đã thông báo cho Mangaka
 *       400:
 *         description: User không phải assistant được gán hoặc chapter không ở trạng thái pending_assistant
 *       404:
 *         description: Chapter not found
 */
router.post(
  "/:id/complete-assistant-work",
  authMiddleware,
  requireAssistant,
  async (req, res, next) => {
    try {
      const chapter = await Chapter.findById(req.params.id).lean();
      if (!chapter) return next(new AppError("Chapter not found", 404));

      if (!chapter.assistant_id || chapter.assistant_id.toString() !== req.user.nameid) {
        return next(new AppError("Bạn không phải assistant được gán cho chapter này", 400));
      }

      if (chapter.status !== "pending_assistant") {
        return next(new AppError("Chapter không ở trạng thái chờ assistant", 400));
      }

      const series = await Series.findById(chapter.series_id).lean();
      const seriesName = series ? series.name : "";

      await notifyChapterAssistantWorkComplete(Notification, chapter.submitted_by, chapter, seriesName);

      return res.status(200).json({
        success: true,
        message: "Đã thông báo cho Mangaka biết công việc đã hoàn thành",
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /pages/:id/notes ───────────────────────────────────────────────────
// Mangaka gửi note cho assistant xem trên từng page
/**
 * @swagger
 * /chapters/pages/{id}/notes:
 *   post:
 *     summary: Gửi note cho page
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Page ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - text
 *               - x
 *               - y
 *               - w
 *               - h
 *             properties:
 *               text:
 *                 type: string
 *                 description: Nội dung note
 *               x:
 *                 type: number
 *                 description: Tọa độ X (%)
 *               y:
 *                 type: number
 *                 description: Tọa độ Y (%)
 *               w:
 *                 type: number
 *                 description: Chiều rộng (%)
 *               h:
 *                 type: number
 *                 description: Chiều cao (%)
 *               taskType:
 *                 type: string
 *                 enum: [background, shading, fx, other]
 *                 description: Loại công việc
 *     responses:
 *       201:
 *         description: Note đã được tạo
 */
router.post("/pages/:id/notes", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { text, x, y, w, h, taskType } = req.body;
    if ([x, y, w, h].some((v) => v === undefined || v === null)) {
      return next(new AppError("x, y, w, h are required", 400));
    }

    const page = await Page.findById(req.params.id).lean();
    if (!page) {
      return next(new AppError("Page not found", 404));
    }

    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (!chapter || chapter.submitted_by.toString() !== req.user.nameid) {
      return next(new AppError("Bạn không có quyền gửi note cho page này", 403));
    }

    const note = await PageNote.create({
      page_id: page._id,
      author_id: req.user.nameid,
      text: text.trim(),
      x,
      y,
      w,
      h,
      taskType: taskType || "other",
    });

    res.status(201).json({
      success: true,
      message: "Note đã được gửi",
      data: note,
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /pages/:id/notes ───────────────────────────────────────────────────
// Assistant hoặc Mangaka xem danh sách note của page
/**
 * @swagger
 * /chapters/pages/{id}/notes:
 *   get:
 *     summary: Lấy danh sách note của page
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Page ID
 *     responses:
 *       200:
 *         description: Danh sách note
 */
router.get("/pages/:id/notes", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const page = await Page.findById(req.params.id).lean();
    if (!page) {
      return next(new AppError("Page not found", 404));
    }

    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (!chapter) {
      return next(new AppError("Chapter not found", 404));
    }

    const mangakaId = chapter.submitted_by.toString();
    const isMangaka = mangakaId === req.user.nameid;
    const isAssistant = chapter.assistant_id && chapter.assistant_id.toString() === req.user.nameid;

    if (!isMangaka && !isAssistant) {
      return next(new AppError("Bạn không có quyền xem note của page này", 403));
    }

    const notes = await PageNote.find({ page_id: page._id })
      .populate("author_id", "username full_name phoneNumber")
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      success: true,
      data: notes,
    });
  } catch (error) {
    next(error);
  }
});

// ─── PUT /pages/:id/notes/:noteId ──────────────────────────────────────────
// Mangaka chỉnh sửa note của mình
/**
 * @swagger
 * /chapters/pages/{id}/notes/{noteId}:
 *   put:
 *     summary: Chỉnh sửa note
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: noteId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - text
 *               - x
 *               - y
 *               - w
 *               - h
 *             properties:
 *               text:
 *                 type: string
 *               x:
 *                 type: number
 *               y:
 *                 type: number
 *               w:
 *                 type: number
 *               h:
 *                 type: number
 *               taskType:
 *                 type: string
 *                 enum: [background, shading, fx, other]
 *     responses:
 *       200:
 *         description: Note đã được cập nhật
 */
router.put("/pages/:id/notes/:noteId", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { text, x, y, w, h, taskType } = req.body;
    if ([x, y, w, h].some((v) => v === undefined || v === null)) {
      return next(new AppError("x, y, w, h are required", 400));
    }

    const isClientId = !mongoose.Types.ObjectId.isValid(req.params.noteId);
    if (isClientId) {
      const note = await PageNote.create({
        page_id: req.params.id,
        author_id: req.user.nameid,
        text: (text || '').trim(),
        x,
        y,
        w,
        h,
        taskType: taskType || "other",
      });
      return res.status(200).json({ success: true, message: "Note đã được tạo từ client ID", data: note });
    }
    const note = await PageNote.findById(req.params.noteId);
    if (!note || note.page_id.toString() !== req.params.id) {
      return next(new AppError("Note not found", 404));
    }

    if (note.author_id.toString() !== req.user.nameid) {
      return next(new AppError("Bạn chỉ có thể sửa note của mình", 403));
    }

    note.text = (text || '').trim();
    note.x = x;
    note.y = y;
    note.w = w;
    note.h = h;
    note.taskType = taskType || note.taskType;
    await note.save();

    res.json({
      success: true,
      message: "Note đã được cập nhật",
      data: note,
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /pages/:id/notes/:noteId ───────────────────────────────────────
// Mangaka xóa note của mình
/**
 * @swagger
 * /chapters/pages/{id}/notes/{noteId}:
 *   delete:
 *     summary: Xóa note
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: noteId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Note đã được xóa
 */
router.delete("/pages/:id/notes/:noteId", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    // Validate ObjectId trước để tránh CastError khi frontend gửi client-side ID
    if (!mongoose.Types.ObjectId.isValid(req.params.noteId)) {
      return res.json({ success: true, message: "Note đã được gỡ (client-side)" });
    }
    const note = await PageNote.findById(req.params.noteId);
    if (!note || note.page_id.toString() !== req.params.id) {
      return next(new AppError("Note not found", 404));
    }

    if (note.author_id.toString() !== req.user.nameid) {
      return next(new AppError("Bạn chỉ có thể xóa note của mình", 403));
    }

    await PageNote.findByIdAndDelete(req.params.noteId);

    res.json({
      success: true,
      message: "Note đã được xóa",
    });
  } catch (error) {
    next(error);
  }
});

// POST /chapters/pages/:pageId/snapshots
router.post("/pages/:pageId/snapshots", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { pageId } = req.params;
    const { note } = req.body;

    const page = await Page.findById(pageId).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const series = await Series.findById(chapter.series_id).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const isAuthor = series.author_id.toString() === req.user.nameid;
    const isAssigned = chapter.assistant_id?.toString() === req.user.nameid;
    if (!isAuthor && !isAssigned) {
      return next(new AppError("Khong co quyen tao snapshot", 403));
    }

    const currentLayers = await PageLayer.find({ page_id: pageId }).sort({ z_order: 1 }).lean();
    const layersSnapshot = currentLayers.map((l) => ({
      _id: l._id,
      name: l.name,
      image_url: l.image_url,
      blend_mode: l.blend_mode,
      opacity: l.opacity,
      visible: l.visible,
      z_order: l.z_order,
      x: l.x,
      y: l.y,
      width: l.width,
      height: l.height,
      rotation: l.rotation,
      scale: l.scale,
      locked: l.locked,
    }));

    const newVersion = (page.current_version || 0) + 1;

    await Page.findByIdAndUpdate(pageId, {
      $push: {
        snapshots: {
          $each: [{
            version: newVersion,
            layers: layersSnapshot,
            created_by: req.user.nameid,
            created_at: new Date(),
            note: note || "",
          }],
          $position: 0,
        },
      },
      $inc: { current_version: 1 },
    });

    res.status(201).json({
      success: true,
      data: {
        version: newVersion,
        layer_count: layersSnapshot.length,
        note: note || "",
      },
    });
  } catch (err) { next(err); }
});

// GET /chapters/pages/:pageId/snapshots
router.get("/pages/:pageId/snapshots", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { pageId } = req.params;

    const page = await Page.findById(pageId).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const series = await Series.findById(chapter.series_id).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const isAuthor = series.author_id.toString() === req.user.nameid;
    const isAssigned = chapter.assistant_id?.toString() === req.user.nameid;
    if (!isAuthor && !isAssigned) {
      return next(new AppError("Khong co quyen xem snapshot", 403));
    }

    const snapshots = (page.snapshots || []).map((s) => ({
      version: s.version,
      note: s.note,
      created_by: s.created_by,
      created_at: s.created_at,
      layer_count: s.layers?.length || 0,
    }));

    res.status(200).json({ success: true, data: snapshots });
  } catch (err) { next(err); }
});

// POST /chapters/pages/:pageId/snapshots/:version/restore
router.post("/pages/:pageId/snapshots/:version/restore", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { pageId, version } = req.params;

    const page = await Page.findById(pageId).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const series = await Series.findById(chapter.series_id).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const isAuthor = series.author_id.toString() === req.user.nameid;
    const isAssigned = chapter.assistant_id?.toString() === req.user.nameid;
    if (!isAuthor && !isAssigned) {
      return next(new AppError("Khong co quyen khoi phuc snapshot", 403));
    }

    const snapshot = (page.snapshots || []).find((s) => s.version === Number(version));
    if (!snapshot) return next(new AppError("Snapshot version not found", 404));

    await PageLayer.deleteMany({ page_id: pageId });

    if (snapshot.layers && snapshot.layers.length > 0) {
      const layersToRestore = snapshot.layers.map((l) => ({
        page_id: pageId,
        name: l.name,
        image_url: l.image_url,
        blend_mode: l.blend_mode,
        opacity: l.opacity,
        visible: l.visible,
        z_order: l.z_order,
        x: l.x,
        y: l.y,
        width: l.width,
        height: l.height,
        rotation: l.rotation,
        scale: l.scale,
        locked: l.locked,
      }));
      await PageLayer.insertMany(layersToRestore);
    }

    const restoredLayers = await PageLayer.find({ page_id: pageId }).sort({ z_order: 1 }).lean();

    res.status(200).json({
      success: true,
      message: `Da khoi phuc ve version ${version}`,
      data: restoredLayers,
    });
  } catch (err) { next(err); }
});

module.exports = router;
