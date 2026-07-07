const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const authMiddleware = require("../middleware/auth");
const { requireMangaka, requireAssistant } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Task = require("../models/Task");
const Page = require("../models/Page");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const Cooperation = require("../models/Cooperation");
const Notification = require("../models/Notification");
const upload = require("../middleware/upload");
const { uploadResult } = require("../middleware/uploadResult");
const {
  notifyTaskAssigned,
  notifyTaskSubmitted,
  notifyTaskRevision,
  notifyTaskApproved,
  notifyTaskAcknowledged,
  notifyChapterAllTasksApproved,
} = require("../services/notificationService");

/**
 * @swagger
 * /tasks:
 *   post:
 *     summary: Tạo task mới (Mangaka giao việc cho Assistant)
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - page_id
 *               - assigned_to
 *               - work_type
 *               - region
 *             properties:
 *               page_id:
 *                 type: string
 *                 description: ID của trang cần giao việc
 *               assigned_to:
 *                 type: string
 *                 description: ID của Assistant được giao việc
 *               work_type:
 *                 type: string
 *                 enum: [background, shading, effects, details, other]
 *               region:
 *                 type: object
 *                 properties:
 *                   x:
 *                     type: number
 *                   y:
 *                     type: number
 *                   width:
 *                     type: number
 *                   height:
 *                     type: number
 *               description:
 *                 type: string
 *                 description: Mô tả chi tiết công việc
 *     responses:
 *       201:
 *         description: Task được tạo thành công
 *       400:
 *         description: Thiếu thông tin bắt buộc
 *       403:
 *         description: Assistant chưa ký hợp đồng hợp tác
 *       404:
 *         description: Page hoặc Chapter không tìm thấy
 */
router.post("/", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { page_id, assigned_to, work_type, region, description } = req.body;

    if (!page_id || !assigned_to || !work_type || !region) {
      return next(new AppError("page_id, assigned_to, work_type, region are required", 400));
    }

    const page = await Page.findById(page_id).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const series = await Series.findById(chapter.series_id).lean();
    if (!series || series.author_id.toString() !== req.user.nameid) {
      return next(new AppError("Unauthorized", 403));
    }

    // Chỉ Assistant đã ký hợp tác mới được giao việc
    // Lưu ý: Cooperation schema dùng agreed_at (không có field status),
    // và series_id=null nghĩa là hợp tác toàn cục (áp dụng mọi series).
    const cooperation = await Cooperation.findOne({
      mangaka_id: req.user.nameid,
      assistant_id: assigned_to,
      agreed_at: { $ne: null },
      $or: [
        { series_id: chapter.series_id },
        { series_id: null },
      ],
    });
    if (!cooperation) {
      return next(
        new AppError("Assistant chưa ký hợp đồng hợp tác với bạn", 403)
      );
    }

    const task = await Task.create({
      page_id,
      chapter_id: page.chapter_id,
      assigned_by: req.user.nameid,
      assigned_to,
      work_type,
      region,
      description: description || "",
      status: "pending",
    });

    // Cập nhật page status
    await Page.findByIdAndUpdate(page_id, { status: "has_task" });

    // Notification cho Assistant
    await notifyTaskAssigned(Notification, assigned_to, task, page);

    return res.status(201).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /tasks/my-assignments:
 *   get:
 *     summary: Lấy danh sách công việc được giao (Assistant)
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by status
 *       - in: query
 *         name: chapter_id
 *         schema:
 *           type: string
 *         description: Filter by chapter ID
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
 *         description: Danh sách công việc
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
 *                     $ref: '#/components/schemas/Task'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 */
router.get("/my-assignments", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const { status, chapter_id, page = 1, limit = 20 } = req.query;

    const filter = {
      assigned_to: req.user.nameid,
      is_current_round: true,
      status: { $ne: "archived" },
    };
    if (status) filter.status = status;
    if (chapter_id) filter.chapter_id = chapter_id;

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate("page_id", "page_number original_image_url chapter_id result_image_url status")
        .populate("chapter_id", "chapter_number title series_id")
        .populate("assigned_by", "username full_name phoneNumber")
        .populate({ path: "note_ids", select: "text x y w h taskType" })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Task.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: tasks,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /tasks/:id ──────────────────────────────────────────────────────────
// Lấy full detail 1 task (ảnh gốc, tọa độ, note) — FE dùng khi mở chi tiết task
router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    // Reserved sub-paths (e.g. /tasks/stats, /tasks/my-assignments, /tasks/pending-review)
    // must not be cast to ObjectId.
    const reserved = new Set(["stats", "my-assignments", "pending-review"]);
    if (reserved.has(req.params.id)) {
      return next();
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid task id", 400));
    }
    const task = await Task.findById(req.params.id)
      .populate("page_id", "page_number original_image_url result_image_url status chapter_id")
      .populate("chapter_id", "chapter_number title series_id")
      .populate("assigned_by", "username full_name")
      .populate("assigned_to", "username full_name")
      .populate({ path: "note_ids", select: "text x y w h taskType status createdAt" })
      .lean();
    if (!task) return next(new AppError("Task not found", 404));
    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /tasks/chapter/{chapterId}:
 *   get:
 *     summary: Lấy tất cả tasks trong một chapter (Mangaka)
 *     tags: [Tasks]
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
 *         description: Danh sách tasks trong chapter
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
 *                     $ref: '#/components/schemas/Task'
 *       404:
 *         description: Chapter không tìm thấy hoặc không có quyền truy cập
 */
router.get("/chapter/:chapterId", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    const tasks = await Task.find({ chapter_id: chapter._id, is_current_round: true })
      .populate("page_id", "page_number original_image_url result_image_url status")
      .populate("assigned_to", "username full_name phoneNumber")
      .populate("note_ids")
      .sort({ "page_id.page_number": 1, createdAt: 1 })
      .lean();

    return res.status(200).json({ success: true, data: tasks });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /pages/{pageId}/tasks:
 *   get:
 *     summary: Lấy tất cả tasks của một page (Mangaka hoặc Assistant được gán)
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: pageId
 *         required: true
 *         schema:
 *           type: string
 *         description: Page ID
 *     responses:
 *       200:
 *         description: Danh sách tasks của page
 *       403:
 *         description: Không có quyền truy cập
 *       404:
 *         description: Page not found
 */
router.get("/page/:pageId", authMiddleware, async (req, res, next) => {
  try {
    const page = await Page.findById(req.params.pageId).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const isMangaka = chapter.submitted_by.toString() === req.user.nameid;
    const isAssigned = chapter.assistant_id?.toString() === req.user.nameid;

    if (!isMangaka && !isAssigned) {
      return next(new AppError("Không có quyền xem tasks của page này", 403));
    }

    const tasks = await Task.find({ page_id: page._id, is_current_round: true })
      .populate("assigned_by", "username full_name phoneNumber")
      .populate("note_ids")
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({ success: true, data: tasks });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /tasks/{id}/start:
 *   patch:
 *     summary: Assistant bắt đầu làm task
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của task
 *     responses:
 *       200:
 *         description: Task đã bắt đầu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Task'
 *       400:
 *         description: Task không thể bắt đầu với trạng thái hiện tại
 *       404:
 *         description: Task không tìm thấy
 */
router.patch("/:id/start", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid task id", 400));
    }
    const task = await Task.findOne({
      _id: req.params.id,
      assigned_to: req.user.nameid,
    });
    if (!task) return next(new AppError("Task not found", 404));
    if (task.status !== "pending" && task.status !== "revision") {
      return next(new AppError("Task cannot be started in current status", 400));
    }

    task.status = "in_progress";
    if (task.status === "revision") task.revision_note = "";
    await task.save();

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /tasks/{id}/submit:
 *   post:
 *     summary: Assistant nộp kết quả công việc
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của task
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - result_image
 *             properties:
 *               result_image:
 *                 type: string
 *                 format: binary
 *                 description: File ảnh kết quả công việc
 *     responses:
 *       200:
 *         description: Task đã được nộp thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Task'
 *       400:
 *         description: Task phải đang in_progress và cần upload ảnh
 *       404:
 *         description: Task không tìm thấy
 */
router.post(
  "/:id/submit",
  authMiddleware,
  requireAssistant,
  upload.single("result_image"),
  async (req, res, next) => {
    try {
      const task = await Task.findOne({
        _id: req.params.id,
        assigned_to: req.user.nameid,
      });
      if (!task) return next(new AppError("Task not found", 404));
      if (task.status !== "in_progress") {
        return next(new AppError("Task must be in_progress to submit", 400));
      }

      if (!req.file) {
        return next(new AppError("result_image file is required", 400));
      }

      task.result_image_url = `/uploads/chapters/${req.file.filename}`;
      task.status = "submitted";
      await task.save();

      // Cập nhật page status
      await Page.findByIdAndUpdate(task.page_id, { status: "submitted" });

      // Notify Mangaka
      await notifyTaskSubmitted(Notification, task.assigned_by, task);

      return res.status(200).json({ success: true, data: task });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /tasks/{id}/upload-result:
 *   patch:
 *     summary: Assistant upload ảnh kết quả lên Cloudinary (Cách 2 - 2 bước)
 *     description: |
 *       Bước 1 của flow 2 bước. Upload ảnh đã gộp layer lên Cloudinary,
 *       LƯU URL vào task nhưng KHÔNG đổi status (vẫn giữ pending/in_progress/revision).
 *       Sau khi upload xong tất cả task, bấm submit-all để đổi status.
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của task
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - result_image_url
 *             properties:
 *               result_image_url:
 *                 type: string
 *                 description: URL ảnh đã upload lên Cloudinary
 *     responses:
 *       200:
 *         description: Upload thành công, URL đã lưu vào task
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     task_id:
 *                       type: string
 *                     result_image_url:
 *                       type: string
 *                     status:
 *                       type: string
 *       400:
 *         description: Task không hợp lệ để upload (đã submitted/approved)
 *       403:
 *         description: Không phải assistant được gán task
 *       404:
 *         description: Task không tìm thấy
 */
router.patch(
  "/:id/upload-result",
  authMiddleware,
  requireAssistant,
  async (req, res, next) => {
    try {
      const { result_image_url } = req.body;

      if (!result_image_url) {
        return next(new AppError("result_image_url là bắt buộc", 400));
      }

      // Validate URL hợp lệ (Cloudinary hoặc bất kỳ URL ảnh nào)
      try {
        new URL(result_image_url);
      } catch {
        return next(new AppError("result_image_url không hợp lệ", 400));
      }

      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return next(new AppError("Invalid task id", 400));
      }

      const task = await Task.findOne({
        _id: req.params.id,
        assigned_to: req.user.nameid,
      });
      if (!task) return next(new AppError("Task not found", 404));

      // Chỉ cho phép upload khi task đang ở trạng thái hợp lệ
      if (!["pending", "in_progress", "revision"].includes(task.status)) {
        return next(
          new AppError(
            `Task đang ở trạng thái "${task.status}", không thể upload ảnh. Chỉ cho phép: pending, in_progress, revision`,
            400
          )
        );
      }

      // Lưu URL ảnh, KHÔNG đổi status
      task.result_image_url = result_image_url;
      await task.save();

      return res.status(200).json({
        success: true,
        message: "Đã lưu URL ảnh, chưa nộp. Bấm submit-all để nộp tất cả.",
        data: {
          task_id: task._id,
          result_image_url: task.result_image_url,
          status: task.status, // Vẫn giữ nguyên status
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /tasks/batch-upload-results:
 *   patch:
 *     summary: Assistant upload nhiều ảnh cùng lúc (Cách 2 - batch)
 *     description: |
 *       Upload nhiều task cùng lúc. Mỗi task gửi kèm URL Cloudinary.
 *       Dùng khi Assistant đã gộp layer xong nhiều task và muốn upload 1 lần.
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tasks
 *             properties:
 *               tasks:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - task_id
 *                     - result_image_url
 *                   properties:
 *                     task_id:
 *                       type: string
 *                       description: ID của task
 *                     result_image_url:
 *                       type: string
 *                       description: URL ảnh đã upload lên Cloudinary
 *     responses:
 *       200:
 *         description: Upload thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     successful:
 *                       type: integer
 *                     failed:
 *                       type: integer
 *                     results:
 *                       type: array
 *       400:
 *         description: Dữ liệu không hợp lệ
 */
router.patch(
  "/batch-upload-results",
  authMiddleware,
  requireAssistant,
  async (req, res, next) => {
    try {
      const { tasks } = req.body;

      if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
        return next(new AppError("tasks phải là mảng không rỗng", 400));
      }

      const results = {
        total: tasks.length,
        successful: 0,
        failed: 0,
        results: [],
      };

      for (const item of tasks) {
        try {
          if (!item.task_id || !item.result_image_url) {
            results.results.push({
              task_id: item.task_id || "unknown",
              success: false,
              error: "Thiếu task_id hoặc result_image_url",
            });
            results.failed++;
            continue;
          }

          // Validate URL
          try {
            new URL(item.result_image_url);
          } catch {
            results.results.push({
              task_id: item.task_id,
              success: false,
              error: "URL không hợp lệ",
            });
            results.failed++;
            continue;
          }

          const task = await Task.findOneAndUpdate(
            {
              _id: item.task_id,
              assigned_to: req.user.nameid,
              status: { $in: ["pending", "in_progress", "revision"] },
            },
            {
              $set: { result_image_url: item.result_image_url },
            },
            { new: true }
          );

          if (!task) {
            results.results.push({
              task_id: item.task_id,
              success: false,
              error: "Task không tìm thấy hoặc không ở trạng thái hợp lệ",
            });
            results.failed++;
            continue;
          }

          results.results.push({
            task_id: task._id,
            success: true,
            status: task.status,
            result_image_url: task.result_image_url,
          });
          results.successful++;
        } catch (err) {
          results.results.push({
            task_id: item.task_id,
            success: false,
            error: err.message,
          });
          results.failed++;
        }
      }

      return res.status(200).json({
        success: true,
        message: `Upload ${results.successful}/${results.total} task thành công`,
        data: results,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /tasks/{id}/approve:
 *   patch:
 *     summary: Mangaka duyệt task
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của task
 *     responses:
 *       200:
 *         description: Task đã được duyệt. Gửi notification cho Assistant. Nếu tất cả tasks trong chapter đã duyệt, gửi notification cho Mangaka biết chapter sẵn sàng gửi TE.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Task'
 *       400:
 *         description: Task phải đang ở trạng thái submitted hoặc in_review
 *       404:
 *         description: Task không tìm thấy
 */
router.patch("/:id/approve", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid task id", 400));
    }
    const task = await Task.findOne({
      _id: req.params.id,
      assigned_by: req.user.nameid,
    });
    if (!task) return next(new AppError("Task not found", 404));
    if (task.status !== "submitted" && task.status !== "in_review") {
      return next(new AppError("Task must be submitted or in_review to approve", 400));
    }

    task.status = "approved";
    await task.save();

    // Notify Assistant: task đã được duyệt
    await notifyTaskApproved(Notification, task.assigned_to, task);

    // Cập nhật page → approved nếu tất cả tasks đã duyệt
    const allTasksOnPage = await Task.find({ page_id: task.page_id });
    const allApprovedOnPage = allTasksOnPage.every((t) => t.status === "approved");
    if (allApprovedOnPage) {
      await Page.findByIdAndUpdate(task.page_id, { status: "approved" });
    }

    // Kiểm tra xem TẤT CẢ tasks trong chapter đã được duyệt chưa
    const allChapterTasks = await Task.find({ chapter_id: task.chapter_id });
    const allApprovedInChapter = allChapterTasks.every((t) => t.status === "approved");
    if (allApprovedInChapter) {
      const chapter = await Chapter.findById(task.chapter_id).lean();
      if (chapter) {
        const series = await Series.findById(chapter.series_id).lean();
        const seriesName = series ? series.name : "";
        await notifyChapterAllTasksApproved(
          Notification,
          chapter.submitted_by,
          chapter,
          seriesName,
          allChapterTasks.length
        );
      }
    }

    // Cập nhật stats cho Cooperation
    await Cooperation.findOneAndUpdate(
      { mangaka_id: req.user.nameid, assistant_id: task.assigned_to },
      { $inc: { total_approved_tasks: 1 } }
    );

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /tasks/{id}/revision:
 *   patch:
 *     summary: Mangaka yêu cầu chỉnh sửa task
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của task
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note:
 *                 type: string
 *                 description: Ghi chú yêu cầu chỉnh sửa
 *     responses:
 *       200:
 *         description: Task đã được gửi vào revision
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Task'
 *       400:
 *         description: Task phải đang ở trạng thái submitted hoặc in_review
 *       404:
 *         description: Task không tìm thấy
 */
router.patch("/:id/revision", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid task id", 400));
    }
    const { note } = req.body;
    const task = await Task.findOne({
      _id: req.params.id,
      assigned_by: req.user.nameid,
    });
    if (!task) return next(new AppError("Task not found", 404));
    if (task.status !== "submitted" && task.status !== "in_review") {
      return next(new AppError("Task must be submitted or in_review to request revision", 400));
    }

    task.status = "revision";
    task.revision_note = note || "";
    task.result_image_url = "";
    await task.save();

    await Page.findByIdAndUpdate(task.page_id, { status: "revision" });

    await notifyTaskRevision(Notification, task.assigned_to, task, note);

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /tasks/stats:
 *   get:
 *     summary: Lấy thống kê công việc (Assistant)
 *     tags: [Tasks]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: year
 *         schema:
 *           type: integer
 *         description: Year for stats (default current year)
 *       - in: query
 *         name: month
 *         schema:
 *           type: integer
 *         description: Month for stats (default current month)
 *     responses:
 *       200:
 *         description: Thống kê công việc
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
 *                     approvedTasksThisMonth:
 *                       type: integer
 *                       description: Số task đã duyệt trong tháng
 *                     totalApprovedTasks:
 *                       type: integer
 *                       description: Tổng số task đã duyệt
 *                     period:
 *                       type: string
 *                       description: Tháng/năm thống kê (YYYY-MM)
 */
router.get("/stats", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const now = new Date();
    const targetYear = parseInt(year) || now.getFullYear();
    const targetMonth = parseInt(month) || now.getMonth() + 1;

    const startDate = new Date(targetYear, targetMonth - 1, 1);
    const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59);

    const filter = {
      assigned_to: req.user.nameid,
      is_current_round: true,
      status: "approved",
      updatedAt: { $gte: startDate, $lte: endDate },
    };

    const [approvedTasks, statsData] = await Promise.all([
      Task.find(filter).lean(),
      Cooperation.aggregate([
        { $match: { assistant_id: new (require("mongoose").Types.ObjectId)(req.user.nameid) } },
        {
          $group: {
            _id: null,
            totalTasks: { $sum: "$total_approved_tasks" },
          },
        },
      ]),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        approvedTasksThisMonth: approvedTasks.length,
        totalApprovedTasks: statsData[0]?.totalTasks || 0,
        period: `${targetYear}-${String(targetMonth).padStart(2, "0")}`,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /tasks/:id/acknowledge ────────────────────────────────────────────
// Mangaka nhận (acknowledge) task đã submit → status: in_review
// Bước trung gian trước khi approve/revision.
router.patch("/:id/acknowledge", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid task id", 400));
    }
    const task = await Task.findOne({
      _id: req.params.id,
      assigned_by: req.user.nameid,
    });
    if (!task) return next(new AppError("Task not found", 404));
    if (task.status !== "submitted" && task.status !== "in_review") {
      return next(new AppError("Chỉ acknowledge task đang submitted hoặc in_review", 400));
    }

    const wasInReview = task.status === "in_review";
    task.status = "in_review";
    await task.save();

    // Cập nhật page → in_review (chỉ lần đầu tiên)
    if (!wasInReview) {
      await Page.findByIdAndUpdate(task.page_id, { status: "in_review" });
    }

    // Notify Assistant
    if (!wasInReview) {
      await notifyTaskAcknowledged(Notification, task.assigned_to, task);
    }

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
});

// ─── GET /tasks/pending-review ────────────────────────────────────────────────
// Mangaka xem danh sách task đang chờ kiểm duyệt (submitted + in_review)
router.get("/pending-review", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { chapter_id, page = 1, limit = 20 } = req.query;
    const filter = {
      assigned_by: req.user.nameid,
      is_current_round: true,
      status: { $in: ["submitted", "in_review"] },
    };
    if (chapter_id) filter.chapter_id = chapter_id;

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate("page_id", "page_number original_image_url result_image_url status chapter_id")
        .populate("chapter_id", "chapter_number title series_id")
        .populate("assigned_to", "username full_name phoneNumber")
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Task.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: tasks,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /tasks/chapter/:chapterId/submit-all-by-assistant ──────────────────
// Assistant nộp TOÀN BỘ task của 1 chapter cùng lúc.
// Dùng SAU KHI đã upload ảnh qua /tasks/:id/upload-result (Cách 2 - 2 bước).
//
// Flow:
//   Bước 1: PATCH /tasks/:id/upload-result → upload ảnh Cloudinary, lưu URL vào task (KHÔNG đổi status)
//   Bước 2: POST /tasks/chapter/:id/submit-all-by-assistant → đổi status tất cả task → submitted
//
// Body: application/json (KHÔNG cần upload file vì ảnh đã có ở bước 1)
//
// Logic:
//   1. Lấy tất cả task của chapter thuộc assistant hiện tại
//   2. Validate: tất cả task phải có result_image_url (đã upload ở bước 1)
//   3. Validate: tất cả task phải đang ở trạng thái pending/in_progress/revision
//   4. Set status: → "submitted"
//   5. Cập nhật page.status = "submitted"
//   6. Set chapter.status = "submitted_by_assistant"
//   7. Notify Mangaka
router.post(
  "/chapter/:chapterId/submit-all-by-assistant",
  authMiddleware,
  requireAssistant,
  async (req, res, next) => {
    try {
      const { chapterId } = req.params;

      const chapter = await Chapter.findById(chapterId).lean();
      if (!chapter) return next(new AppError("Chapter not found", 404));
      if (chapter.assistant_id?.toString() !== req.user.nameid) {
        return next(new AppError("Bạn không phải assistant của chapter này", 403));
      }

      // Lấy tất cả task vòng hiện tại của chapter thuộc assistant
      const allTasks = await Task.find({
        chapter_id: chapterId,
        assigned_to: req.user.nameid,
        is_current_round: true,
      });

      // Dedupe theo page_id: nếu có nhiều task cùng page (do data cũ hoặc flow
      // POST /chapters + PATCH submit tạo 2 lần trước đây), chỉ giữ 1 task "active"
      // (status ưu tiên revision > in_progress > pending > approved) để tránh
      // submit-all fail vì có 1 task đã approved trùng page.
      const STATUS_PRIORITY = { revision: 4, in_progress: 3, pending: 2, approved: 1, submitted: 0, in_review: 0 };
      const dedupeByPage = new Map();
      for (const t of allTasks) {
        const key = t.page_id.toString();
        const existing = dedupeByPage.get(key);
        if (!existing || (STATUS_PRIORITY[t.status] ?? -1) > (STATUS_PRIORITY[existing.status] ?? -1)) {
          dedupeByPage.set(key, t);
        }
      }
      const tasks = Array.from(dedupeByPage.values());

      if (tasks.length === 0) {
        return next(new AppError("Không có task nào trong chapter", 400));
      }

      // Lấy tất cả pages (để lấy page_number)
      const pages = await Page.find({ chapter_id: chapterId }).lean();
      const pageMap = {};
      pages.forEach((p) => { pageMap[p._id.toString()] = p; });

      // Validate 1: Tất cả task phải có result_image_url
      const missingImageTasks = tasks.filter((t) => !t.result_image_url);
      if (missingImageTasks.length > 0) {
        return next(
          new AppError(
            `${missingImageTasks.length} task chưa có ảnh. Vui lòng upload ảnh qua /tasks/:id/upload-result trước.`,
            400
          )
        );
      }

      // Validate 2: Chỉ cho phép submit các task đang pending/in_progress/revision
      const invalidTasks = tasks.filter(
        (t) => !["pending", "in_progress", "revision"].includes(t.status)
      );
      if (invalidTasks.length > 0) {
        return next(
          new AppError(
            `${invalidTasks.length} task không ở trạng thái hợp lệ để submit: ${invalidTasks.map((t) => t.status).join(", ")}`,
            400
          )
        );
      }

      // Sort tasks theo page.page_number, createdAt để hiển thị đẹp
      const sortedTasks = tasks
        .map((t) => ({ ...t.toObject(), _page: pageMap[t.page_id.toString()] }))
        .sort((a, b) => {
          const pa = a._page?.page_number || 999;
          const pb = b._page?.page_number || 999;
          if (pa !== pb) return pa - pb;
          return new Date(a.createdAt) - new Date(b.createdAt);
        });

      // Cập nhật status tất cả task → submitted
      const updatedTasks = [];
      for (const task of sortedTasks) {
        await Task.findByIdAndUpdate(task._id, {
          status: "submitted",
          revision_note: "", // Xóa note revision nếu có
        });
        updatedTasks.push({
          ...task,
          status: "submitted",
        });

        // Cập nhật page status
        if (task._page) {
          await Page.findByIdAndUpdate(task.page_id, { status: "submitted" });
        }
      }

      // Cập nhật chapter status
      await Chapter.findByIdAndUpdate(chapterId, {
        status: "submitted_by_assistant",
      });

      // Notify Mangaka (1 lần duy nhất cho cả chapter)
      await notifyTaskSubmitted(Notification, chapter.submitted_by, {
        chapter_id: chapter._id,
        page_count: updatedTasks.length,
      });

      return res.status(200).json({
        success: true,
        message: `Đã nộp ${updatedTasks.length} task(s) thành công.`,
        data: {
          chapter_id: chapterId,
          total_tasks: updatedTasks.length,
          tasks: updatedTasks.map((t) => ({
            task_id: t._id,
            page_number: t._page?.page_number,
            result_image_url: t.result_image_url,
            status: t.status,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /tasks/chapter/{chapterId}/prepare-status:
 *   get:
 *     summary: Xem trạng thái chuẩn bị upload ảnh của chapter (Cách 2)
 *     description: |
 *       Dùng cho Assistant xem bao nhiêu task đã upload ảnh, bao nhiêu task còn thiếu.
 *       Giúp theo dõi tiến độ trước khi bấm submit-all.
 *     tags: [Tasks]
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
 *         description: Trạng thái prepare của chapter
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
 *                     chapter_id:
 *                       type: string
 *                     total_tasks:
 *                       type: integer
 *                     ready_to_submit:
 *                       type: integer
 *                       description: Số task đã upload ảnh (có result_image_url)
 *                     pending_upload:
 *                       type: integer
 *                       description: Số task chưa upload ảnh
 *                     can_submit:
 *                       type: boolean
 *                       description: Có thể submit-all hay không
 *                     tasks:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           task_id:
 *                             type: string
 *                           page_number:
 *                             type: integer
 *                           status:
 *                             type: string
 *                           has_image:
 *                             type: boolean
 *                           result_image_url:
 *                             type: string
 *       403:
 *         description: Không phải assistant của chapter
 *       404:
 *         description: Chapter không tìm thấy
 */
router.get(
  "/chapter/:chapterId/prepare-status",
  authMiddleware,
  requireAssistant,
  async (req, res, next) => {
    try {
      const { chapterId } = req.params;

      const chapter = await Chapter.findById(chapterId).lean();
      if (!chapter) return next(new AppError("Chapter not found", 404));
      if (chapter.assistant_id?.toString() !== req.user.nameid) {
        return next(new AppError("Bạn không phải assistant của chapter này", 403));
      }

      // Lấy tất cả tasks vòng hiện tại của chapter thuộc assistant
      const tasks = await Task.find({
        chapter_id: chapterId,
        assigned_to: req.user.nameid,
        is_current_round: true,
      })
        .populate("page_id", "page_number")
        .lean();

      if (tasks.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            chapter_id: chapterId,
            total_tasks: 0,
            ready_to_submit: 0,
            pending_upload: 0,
            can_submit: false,
            tasks: [],
          },
        });
      }

      // Lấy tất cả pages (để lấy page_number)
      const pages = await Page.find({ chapter_id: chapterId }).lean();
      const pageMap = {};
      pages.forEach((p) => { pageMap[p._id.toString()] = p; });

      // Sort tasks theo page.page_number, createdAt
      const sortedTasks = tasks
        .map((t) => ({ ...t, _page: pageMap[t.page_id?.toString()] }))
        .sort((a, b) => {
          const pa = a._page?.page_number || 999;
          const pb = b._page?.page_number || 999;
          if (pa !== pb) return pa - pb;
          return new Date(a.createdAt) - new Date(b.createdAt);
        });

      const taskDetails = sortedTasks.map((t) => ({
        task_id: t._id,
        page_number: t._page?.page_number || "?",
        status: t.status,
        has_image: !!t.result_image_url,
        result_image_url: t.result_image_url || null,
      }));

      const readyToSubmit = sortedTasks.filter(
        (t) => t.result_image_url && ["pending", "in_progress", "revision"].includes(t.status)
      ).length;

      const pendingUpload = sortedTasks.filter(
        (t) => !t.result_image_url || !["pending", "in_progress", "revision"].includes(t.status)
      ).length;

      return res.status(200).json({
        success: true,
        data: {
          chapter_id: chapterId,
          total_tasks: tasks.length,
          ready_to_submit: readyToSubmit,
          pending_upload: pendingUpload,
          can_submit: readyToSubmit === tasks.length,
          tasks: taskDetails,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── GET /tasks/chapter/:chapterId/ordered-by-page ────────────────────────────
// Mangaka xem tasks theo thứ tự page (để duyệt từng cái một).
// Trả về: mỗi page có 1 object, bên trong là các task theo thứ tự createdAt.
router.get(
  "/chapter/:chapterId/ordered-by-page",
  authMiddleware,
  requireMangaka,
  async (req, res, next) => {
    try {
      const { chapterId } = req.params;

      const chapter = await Chapter.findOne({
        _id: chapterId,
        submitted_by: req.user.nameid,
      }).lean();
      if (!chapter) {
        return next(new AppError("Chapter not found or unauthorized", 404));
      }

      // Lấy tất cả tasks của chapter
      const tasks = await Task.find({ chapter_id: chapterId })
        .populate("page_id", "page_number original_image_url result_image_url status")
        .populate("assigned_to", "username full_name phoneNumber")
        .populate({ path: "note_ids", select: "text x y w h taskType status" })
        .lean();

      // Lấy tất cả pages của chapter
      const pages = await Page.find({ chapter_id: chapterId })
        .sort({ page_number: 1 })
        .lean();

      // Gom tasks theo page
      const tasksByPage = {};
      for (const t of tasks) {
        const pid = t.page_id?._id?.toString() || t.page_id?.toString();
        if (!pid) continue;
        if (!tasksByPage[pid]) tasksByPage[pid] = [];
        tasksByPage[pid].push(t);
      }

      // Sắp xếp task trong mỗi page theo createdAt
      Object.keys(tasksByPage).forEach((pid) => {
        tasksByPage[pid].sort(
          (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
        );
      });

      // Build response: danh sách page (theo thứ tự), mỗi page có tasks
      const orderedPages = pages.map((page) => {
        const pageTasks = tasksByPage[page._id.toString()] || [];
        const allApproved = pageTasks.length > 0 && pageTasks.every((t) => t.status === "approved");
        const anySubmitted = pageTasks.some(
          (t) => t.status === "submitted" || t.status === "in_review"
        );
        const anyRevision = pageTasks.some((t) => t.status === "revision");

        return {
          _id: page._id,
          page_number: page.page_number,
          original_image_url: page.original_image_url,
          result_image_url: page.result_image_url,
          status: page.status,
          tasks: pageTasks,
          summary: {
            total_tasks: pageTasks.length,
            approved: pageTasks.filter((t) => t.status === "approved").length,
            pending: pageTasks.filter((t) => t.status === "pending").length,
            in_progress: pageTasks.filter((t) => t.status === "in_progress").length,
            submitted: pageTasks.filter((t) => t.status === "submitted").length,
            in_review: pageTasks.filter((t) => t.status === "in_review").length,
            revision: pageTasks.filter((t) => t.status === "revision").length,
            can_approve: allApproved,
            needs_attention: anySubmitted || anyRevision,
          },
        };
      });

      // Thống kê tổng
      const totalStats = {
        total_pages: pages.length,
        total_tasks: tasks.length,
        approved: tasks.filter((t) => t.status === "approved").length,
        pending: tasks.filter((t) => t.status === "pending").length,
        in_progress: tasks.filter((t) => t.status === "in_progress").length,
        submitted: tasks.filter((t) => t.status === "submitted").length,
        in_review: tasks.filter((t) => t.status === "in_review").length,
        revision: tasks.filter((t) => t.status === "revision").length,
      };

      return res.status(200).json({
        success: true,
        data: {
          chapter: {
            _id: chapter._id,
            chapter_number: chapter.chapter_number,
            title: chapter.title,
            status: chapter.status,
          },
          pages: orderedPages,
          stats: totalStats,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
