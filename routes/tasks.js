const express = require("express");
const router = express.Router();
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
const {
  notifyTaskAssigned,
  notifyTaskSubmitted,
  notifyTaskRevision,
  notifyTaskApproved,
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

    const filter = { assigned_to: req.user.nameid };
    if (status) filter.status = status;
    if (chapter_id) filter.chapter_id = chapter_id;

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate("page_id", "page_number original_image_url chapter_id")
        .populate("chapter_id", "chapter_number title series_id")
        .populate("assigned_by", "username full_name phoneNumber")
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

    const tasks = await Task.find({ chapter_id: chapter._id })
      .populate("page_id", "page_number original_image_url result_image_url status")
      .populate("assigned_to", "username full_name phoneNumber")
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

    const tasks = await Task.find({ page_id: page._id })
      .populate("assigned_by", "username full_name phoneNumber")
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
 *         description: Task phải đang ở trạng thái submitted
 *       404:
 *         description: Task không tìm thấy
 */
router.patch("/:id/approve", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      assigned_by: req.user.nameid,
    });
    if (!task) return next(new AppError("Task not found", 404));
    if (task.status !== "submitted") {
      return next(new AppError("Task must be submitted to approve", 400));
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
 *         description: Task phải đang ở trạng thái submitted
 *       404:
 *         description: Task không tìm thấy
 */
router.patch("/:id/revision", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { note } = req.body;
    const task = await Task.findOne({
      _id: req.params.id,
      assigned_by: req.user.nameid,
    });
    if (!task) return next(new AppError("Task not found", 404));
    if (task.status !== "submitted") {
      return next(new AppError("Task must be submitted to request revision", 400));
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
      status: "approved",
      updatedAt: { $gte: startDate, $lte: endDate },
    };

    const [approvedTasks, statsData] = await Promise.all([
      Task.find(filter).lean(),
      Cooperation.aggregate([
        { $match: { assistant_id: require("mongoose").Types.ObjectId(req.user.nameid) } },
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

module.exports = router;
