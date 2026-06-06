const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireMangaka, requireMangakaOrAssistant, requireAssistant } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const Series = require("../models/Series");
const Task = require("../models/Task");
const User = require("../models/User");
const Cooperation = require("../models/Cooperation");
const PageNote = require("../models/PageNote");
const Notification = require("../models/Notification");
const upload = require("../middleware/upload");
const { notifyChapterAssigned } = require("../services/notificationService");

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
router.get("/:id/pages", authMiddleware, async (req, res, next) => {
  try {
    const chapter = await Chapter.findById(req.params.id).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

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
router.get("/pages/:id", authMiddleware, async (req, res, next) => {
  try {
    const page = await Page.findById(req.params.id).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const tasks = await Task.find({ page_id: page._id })
      .populate("assigned_to", "username full_name")
      .populate("assigned_by", "username full_name")
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
 *     summary: Gán 1 assistant cho cả chapter
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
    });
    if (!cooperation) {
      return next(new AppError("Assistant chưa ký hợp đồng hợp tác với bạn", 403));
    }

    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";

    // Gán assistant vào chapter
    chapter.assistant_id = assistant_id;
    chapter.status = "pending_assistant";
    await chapter.save();

    // Lấy tất cả pages chưa có task, tạo task cho mỗi page
    const pages = await Page.find({ chapter_id: chapter._id }).lean();
    const existingTaskPageIds = (
      await Task.find({ chapter_id: chapter._id }).distinct("page_id")
    ).map((id) => id.toString());

    const newTasks = [];
    for (const page of pages) {
      if (!existingTaskPageIds.includes(page._id.toString())) {
        const task = await Task.create({
          page_id: page._id,
          chapter_id: chapter._id,
          assigned_by: req.user.nameid,
          assigned_to: assistant_id,
          work_type: "other",
          region: { x: 0, y: 0, width: 100, height: 100 },
          description: `Task cho page ${page.page_number} - chapter #${chapter.chapter_number}`,
          price: 0,
          status: "pending",
        });
        newTasks.push(task);
        await Page.findByIdAndUpdate(page._id, { status: "has_task" });
      }
    }

    await notifyChapterAssigned(Notification, assistant_id, chapter, seriesName);

    return res.status(200).json({
      success: true,
      message: `Đã gán assistant cho chapter. Đã tạo ${newTasks.length} task(s).`,
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
        .populate("submitted_by", "username full_name")
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
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: Nội dung note
 *     responses:
 *       201:
 *         description: Note đã được tạo
 */
router.post("/pages/:id/notes", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return next(new AppError("content is required", 400));
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
      content: content.trim(),
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
      .populate("author_id", "username full_name")
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
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *     responses:
 *       200:
 *         description: Note đã được cập nhật
 */
router.put("/pages/:id/notes/:noteId", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return next(new AppError("content is required", 400));
    }

    const note = await PageNote.findById(req.params.noteId);
    if (!note || note.page_id.toString() !== req.params.id) {
      return next(new AppError("Note not found", 404));
    }

    if (note.author_id.toString() !== req.user.nameid) {
      return next(new AppError("Bạn chỉ có thể sửa note của mình", 403));
    }

    note.content = content.trim();
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

module.exports = router;
