const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { requireMangaka, requireAssistant } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Task = require("../models/Task");
const Page = require("../models/Page");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const Cooperation = require("../models/Cooperation");
const Notification = require("../models/Notification");
const PageNote = require("../models/PageNote");
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

// ─── Helpers: revision_annotations derivation ────────────────────────────────
// PageNote hiện dùng x/y/w/h. FE spec muốn region { x, y, width, height } +
// status "open" | "resolved" (map từ PageNote.status).
const REVISION_TASKTYPE_MAP = {
  art: "other",
  lineart: "other",
  paint: "other",
  shading: "shading",
  effects: "fx",
  fx: "fx",
  background: "background",
  details: "other",
  fill: "other",
  content: "other",
  dialogue: "other",
  script: "other",
  other: "other",
};

function mapErrorTypeToTaskType(errorType) {
  if (!errorType || typeof errorType !== "string") return "other";
  const key = String(errorType).toLowerCase().trim();
  return REVISION_TASKTYPE_MAP[key] || "other";
}

function toApiAnnotation(noteDoc, taskId) {
  return {
    _id: noteDoc._id,
    task_id: taskId,
    page_id: noteDoc.page_id,
    content: noteDoc.text,
    error_type: noteDoc.taskType,
    region: {
      x: noteDoc.x,
      y: noteDoc.y,
      width: noteDoc.w,
      height: noteDoc.h,
    },
    status: noteDoc.status === "used_in_task" ? "resolved" : "open",
    note_kind: noteDoc.note_kind,
    revision_round: noteDoc.revision_round,
    author_role: noteDoc.author_role,
    created_at: noteDoc.createdAt,
  };
}

// Derive revision_annotations cho 1 task dựa trên note_ids đã populate.
// Chỉ lấy PageNote có note_kind="revision" và revision_round === task.round (vòng hiện tại).
// `task` đã được .populate("note_ids") hoặc .lean() có note_ids là array id/object.
function deriveRevisionAnnotations(task) {
  if (!task || !Array.isArray(task.note_ids)) return [];
  const currentRound = task.round || 1;
  const notes = task.note_ids.filter(
    (n) => n && n.note_kind === "revision" && n.revision_round === currentRound
  );
  return notes.map((n) => toApiAnnotation(n, task._id));
}

// Validate 1 annotation. Trả về null nếu OK, hoặc string mô tả lỗi.
function validateAnnotationShape(ann, idx, taskPageId) {
  if (!ann || typeof ann !== "object") {
    return `annotation[${idx}] phải là object`;
  }
  // page_id optional — nếu có phải khớp task.page_id
  if (ann.page_id !== undefined && ann.page_id !== null) {
    if (!mongoose.Types.ObjectId.isValid(ann.page_id)) {
      return `annotation[${idx}].page_id không phải ObjectId hợp lệ`;
    }
    if (String(ann.page_id) !== String(taskPageId)) {
      return `annotation[${idx}].page_id không thuộc task/chapter`;
    }
  }
  // content (alias: text) bắt buộc
  const content = ann.content !== undefined ? ann.content : ann.text;
  if (typeof content !== "string" || content.trim() === "") {
    return `annotation[${idx}].content không được rỗng`;
  }
  // x, y bắt buộc
  const x = Number(ann.x);
  const y = Number(ann.y);
  if (!Number.isFinite(x) || x < 0 || x > 100) {
    return `annotation[${idx}].x phải nằm trong khoảng 0-100`;
  }
  if (!Number.isFinite(y) || y < 0 || y > 100) {
    return `annotation[${idx}].y phải nằm trong khoảng 0-100`;
  }
  // width/w (alias: w) > 0
  const width = Number(ann.w !== undefined ? ann.w : ann.width);
  const height = Number(ann.h !== undefined ? ann.h : ann.height);
  if (!Number.isFinite(width) || width <= 0) {
    return `annotation[${idx}].width phải > 0`;
  }
  if (!Number.isFinite(height) || height <= 0) {
    return `annotation[${idx}].height phải > 0`;
  }
  if (width > 100) return `annotation[${idx}].width không được vượt quá 100`;
  if (height > 100) return `annotation[${idx}].height không được vượt quá 100`;
  if (x + width > 100 + 1e-9) return `annotation[${idx}] x + width vượt quá 100`;
  if (y + height > 100 + 1e-9) return `annotation[${idx}] y + height vượt quá 100`;
  return null;
}

// Chuẩn hóa input revision_annotations — chấp nhận cả 2 format:
//  - flat array: [ { content, x, y, w, h, error_type } ]
//  - object map (cũ): { page_0: [...], page_1: [...] }
// Trả về { normalized, warnings }
function normalizeRevisionAnnotations(rawInput, taskPageId) {
  if (rawInput === undefined || rawInput === null) {
    return { normalized: [], warnings: [] };
  }
  const warnings = [];
  let flat = [];
  if (Array.isArray(rawInput)) {
    flat = rawInput;
  } else if (typeof rawInput === "object") {
    // Format cũ { page_X: [ ... ] } → ép thành flat array (mọi annotation đều gán task.page_id)
    // Bỏ qua key không khớp "page_0"
    const pages = Object.keys(rawInput);
    if (pages.length > 0 && pages[0].startsWith("page_") && Array.isArray(rawInput[pages[0]])) {
      flat = pages.flatMap((k) => Array.isArray(rawInput[k]) ? rawInput[k] : []);
      warnings.push(`revision_annotations ở format cũ { page_N: [...] } — chỉ ghi nhận annotation cho page của task`);
    } else {
      // Không rõ format → trả empty + warning
      warnings.push("revision_annotations không đúng định dạng (mong đợi array)");
    }
  } else {
    warnings.push("revision_annotations không đúng định dạng (mong đợi array)");
  }
  // Mỗi ann có thể kèm page_id; nếu không thì BE tự gán task.page_id
  const normalized = flat.map((a) => ({
    ...a,
    page_id: a && a.page_id ? a.page_id : taskPageId,
  }));
  return { normalized, warnings };
}

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
        .populate({ path: "note_ids", select: "text x y w h taskType note_kind author_role revision_round status createdAt" })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Task.countDocuments(filter),
    ]);

    const tasksWithAnnotations = tasks.map((t) => ({
      ...t,
      revision_round: t.round,
      revision_annotations: deriveRevisionAnnotations(t),
    }));

    return res.status(200).json({
      success: true,
      data: tasksWithAnnotations,
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
      .populate({ path: "note_ids", select: "text x y w h taskType note_kind author_role revision_round status createdAt" })
      .lean();
    if (!task) return next(new AppError("Task not found", 404));
    return res.status(200).json({
      success: true,
      data: {
        ...task,
        revision_round: task.round,
        revision_annotations: deriveRevisionAnnotations(task),
      },
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

    const tasks = await Task.find({ chapter_id: chapter._id, is_current_round: true })
      .populate("page_id", "page_number original_image_url result_image_url status")
      .populate("assigned_to", "username full_name phoneNumber")
      .populate({
        path: "note_ids",
        select: "text x y w h taskType note_kind author_role revision_round status createdAt",
      })
      .sort({ "page_id.page_number": 1, createdAt: 1 })
      .lean();

    const tasksWithAnnotations = tasks.map((t) => ({
      ...t,
      revision_round: t.round,
      revision_annotations: deriveRevisionAnnotations(t),
    }));

    return res.status(200).json({ success: true, data: tasksWithAnnotations });
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
            { returnDocument: 'after' }
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
 *     summary: Mangaka yêu cầu chỉnh sửa task (backward-compatible)
 *     description: >
 *       Chuyển task sang status "revision". Endpoint backward-compatible — chỉ truyền
 *       { note } vẫn hoạt động như cũ. Nếu truyền thêm revision_notes/revision_annotations,
 *       BE sẽ lưu vào chapter và tự tạo PageNote (note_kind="revision") + gắn vào
 *       task.note_ids. Chapter status sẽ tự chuyển sang "revision_requested" nếu
 *       chapter đang ở trạng thái "submitted_by_assistant" hoặc "in_review".
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
 *                 description: Ghi chú yêu cầu chỉnh sửa (text đơn giản, backward-compatible)
 *               revision_notes:
 *                 type: string
 *                 description: Ghi chú tổng hợp cho chapter (optional)
 *               revision_annotations:
 *                 type: object
 *                 description: >
 *                   Annotations theo page key (page_0, page_1...).
 *                   Mỗi item: { text, x, y, w, h, taskType, error_type }
 *                 example:
 *                   page_0:
 *                     - text: "Sửa shading vùng mặt"
 *                       x: 12.5
 *                       y: 30.0
 *                       w: 25.0
 *                       h: 18.0
 *                       taskType: "shading"
 *                       error_type: "art"
 *     responses:
 *       200:
 *         description: Task đã được gửi vào revision (status = "revision")
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Task'
 *                 chapter:
 *                   type: object
 *                   description: Chapter sau khi cập nhật (nếu có)
 *                   properties:
 *                     _id: { type: string }
 *                     status: { type: string }
 *                     revision_notes: { type: string }
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
    const { note, revision_notes, revision_annotations } = req.body;
    const task = await Task.findOne({
      _id: req.params.id,
      assigned_by: req.user.nameid,
    });
    if (!task) return next(new AppError("Task not found or unauthorized", 404));
    if (task.status !== "submitted" && task.status !== "in_review") {
      return next(
        new AppError(
          `Task hiện ở trạng thái '${task.status}' — chỉ chấp nhận submitted hoặc in_review`,
          400
        )
      );
    }

    // 1. Chuẩn hóa + validate revision_annotations (backward-compat)
    const { normalized: annsInput, warnings: annWarnings } = normalizeRevisionAnnotations(
      revision_annotations,
      task.page_id
    );
    const validationErrors = [];
    for (let i = 0; i < annsInput.length; i++) {
      const err = validateAnnotationShape(annsInput[i], i, task.page_id);
      if (err) validationErrors.push(err);
    }
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_REVISION_ANNOTATIONS",
        message: "Tọa độ revision annotation không hợp lệ",
        errors: validationErrors,
      });
    }

    // 2. Tính vòng revision mới
    const nextRound = (task.round || 1) + 1;

    // 3. Cập nhật task + page (status → revision, round tăng 1, note)
    task.status = "revision";
    task.round = nextRound;
    task.revision_note = note || revision_notes || "";
    task.result_image_url = "";
    await task.save();

    await Page.findByIdAndUpdate(task.page_id, { status: "revision" });

    // 4. Tạo PageNote (idempotent) + cập nhật chapter
    const createdNoteIds = [];
    const chapter = await Chapter.findById(task.chapter_id);
    let createdNotes = [];

    if (annsInput.length > 0) {
      // Dedupe: query PageNote đã tồn tại cho round mới
      const existingNotes = await PageNote.find({
        page_id: task.page_id,
        note_kind: "revision",
        author_id: req.user.nameid,
        revision_round: nextRound,
        text: { $in: annsInput.map((a) => String(a.content ?? a.text).trim()) },
      }).lean();

      const existingKeySet = new Set(
        existingNotes.map((n) =>
          `${n.text}|${n.x}|${n.y}|${n.w}|${n.h}|${n.taskType}`
        )
      );

      // 4a. Tạo các annotation chưa tồn tại (trong transaction nếu được)
      const toCreate = annsInput
        .map((a) => {
          const content = String(a.content ?? a.text).trim();
          const x = Number(a.x);
          const y = Number(a.y);
          const width = Number(a.w !== undefined ? a.w : a.width);
          const height = Number(a.h !== undefined ? a.h : a.height);
          const taskType = mapErrorTypeToTaskType(a.error_type || a.taskType);
          return { content, x, y, width, height, taskType };
        })
        .filter((a) => !existingKeySet.has(`${a.content}|${a.x}|${a.y}|${a.width}|${a.height}|${a.taskType}`));

      let session = null;
      try {
        session = await mongoose.startSession();
        await session.withTransaction(async () => {
          if (toCreate.length > 0) {
            const docs = toCreate.map((a) => ({
              page_id: task.page_id,
              author_id: req.user.nameid,
              text: a.content,
              x: a.x,
              y: a.y,
              w: a.width,
              h: a.height,
              taskType: a.taskType,
              note_kind: "revision",
              author_role: "mangaka",
              revision_round: nextRound,
              status: "active",
            }));
            const inserted = await PageNote.create(docs, { session });
            createdNotes = inserted;
            createdNoteIds.push(...inserted.map((n) => n._id));
          }
        });
      } catch (txErr) {
        // Fallback: chạy tuần tự (Mongo standalone không hỗ trợ transaction)
        if (session) {
          try { session.endSession(); } catch {}
          session = null;
        }
        if (toCreate.length > 0) {
          const docs = toCreate.map((a) => ({
            page_id: task.page_id,
            author_id: req.user.nameid,
            text: a.content,
            x: a.x,
            y: a.y,
            w: a.width,
            h: a.height,
            taskType: a.taskType,
            note_kind: "revision",
            author_role: "mangaka",
            revision_round: nextRound,
            status: "active",
          }));
          const inserted = await PageNote.create(docs);
          createdNotes = inserted;
          createdNoteIds.push(...inserted.map((n) => n._id));
        }
      } finally {
        if (session) {
          try { session.endSession(); } catch {}
        }
      }

      // 4b. Gộp ID mới + cũ vào task.note_ids (idempotent — set unique)
      const existingIds = (task.note_ids || []).map((id) => String(id));
      const allIds = [
        ...new Set([
          ...existingIds,
          ...createdNoteIds.map((id) => String(id)),
          ...existingNotes.map((n) => String(n._id)),
        ]),
      ];
      task.note_ids = allIds;
      await task.save();

      // 4c. Append vào chapter.revision_annotations (giữ logic cũ — dùng để hiển thị lịch sử)
      if (chapter) {
        const newAnns = [...createdNotes, ...existingNotes].map((n) => ({
          page_id: n.page_id,
          region: {
            x: n.x,
            y: n.y,
            width: n.w,
            height: n.h,
          },
          content: n.text,
          error_type: n.taskType,
        }));
        chapter.revision_annotations = [
          ...(chapter.revision_annotations || []),
          ...newAnns,
        ];
      }
    }

    // 5. Chapter update (giữ logic cũ)
    if (chapter) {
      if (revision_notes !== undefined) chapter.revision_notes = revision_notes;
      chapter.revision_history = [
        ...(chapter.revision_history || []),
        {
          at: new Date(),
          by: req.user.nameid,
          round: nextRound,
          note: note || revision_notes || "Yêu cầu sửa",
          annotation_count: annsInput.length,
        },
      ];
      if (["in_review", "submitted_by_assistant"].includes(chapter.status)) {
        chapter.status = "revision_requested";
      }
      await chapter.save();
    }

    // 6. Notification
    await notifyTaskRevision(Notification, task.assigned_to, task, task.revision_note);

    // 7. Reload task có note_ids populate để trả về
    const taskForResponse = await Task.findById(task._id)
      .populate({
        path: "note_ids",
        select: "text x y w h taskType note_kind author_role revision_round status createdAt",
      })
      .lean();
    const revisionAnnotations = deriveRevisionAnnotations(taskForResponse);

    return res.status(200).json({
      success: true,
      message: `Đã gửi yêu cầu sửa vòng ${nextRound} cho Assistant`,
      warnings: annWarnings,
      data: {
        task: {
          ...taskForResponse,
          revision_round: taskForResponse.round,
          revision_annotations: revisionAnnotations,
        },
      },
      chapter: chapter
        ? { _id: chapter._id, status: chapter.status, revision_notes: chapter.revision_notes }
        : undefined,
    });
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
//   1. Lấy tất cả task vòng hiện tại (is_current_round: true) của chapter thuộc assistant
//   2. Validate: task chưa approved phải có result_image_url
//   3. Validate: task phải ở trạng thái pending/in_progress/revision/approved
//      (approved được phép — nộp lại cả task đã duyệt vòng trước để Mangaka duyệt lại)
//   4. Set status: → "submitted" (reset cả approved về submitted)
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

      // Validate 2: Cho phép submit task ở pending/in_progress/revision VÀ cả approved
      // (vòng duyệt lại: trang đã approved ở vòng trước vẫn phải gửi lại cùng chapter
      //  để Mangaka duyệt lại từ đầu — chỉ là không bắt buộc upload ảnh mới nếu không sửa)
      const SUBMITTABLE_STATUSES = ["pending", "in_progress", "revision", "approved"];
      const invalidTasks = tasks.filter(
        (t) => !SUBMITTABLE_STATUSES.includes(t.status)
      );
      if (invalidTasks.length > 0) {
        return next(
          new AppError(
            `${invalidTasks.length} task không ở trạng thái hợp lệ để submit: ${invalidTasks.map((t) => t.status).join(", ")}`,
            400
          )
        );
      }

      // Validate 3 (chỉ áp dụng task CHƯA approved): phải có result_image_url
      // Task đã approved ở vòng trước có thể giữ nguyên ảnh cũ → không bắt buộc có ảnh mới.
      const missingImageTasks = tasks.filter(
        (t) => t.status !== "approved" && !t.result_image_url
      );
      if (missingImageTasks.length > 0) {
        return next(
          new AppError(
            `${missingImageTasks.length} task chưa có ảnh. Vui lòng upload ảnh qua /tasks/:id/upload-result trước.`,
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

      // Cập nhật status tất cả task → submitted (reset cả task đã approved ở vòng trước)
      const updatedTasks = [];
      let resubmittedCount = 0;
      for (const task of sortedTasks) {
        const previousStatus = task.status;
        await Task.findByIdAndUpdate(task._id, {
          status: "submitted",
          revision_note: "", // Xóa note revision nếu có
        });
        updatedTasks.push({
          ...task,
          previous_status: previousStatus,
          status: "submitted",
        });
        if (previousStatus === "approved") resubmittedCount += 1;

        // Cập nhật page status — kể cả page đã approved ở vòng trước,
        // để Mangaka thấy toàn bộ page trong danh sách duyệt lại.
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
        message: `Đã nộp ${updatedTasks.length} task(s) thành công (${resubmittedCount} task đã duyệt vòng trước được gửi lại).`,
        data: {
          chapter_id: chapterId,
          chapter_status: "submitted_by_assistant",
          total_tasks: updatedTasks.length,
          resubmitted_count: resubmittedCount,
          tasks: updatedTasks.map((t) => ({
            task_id: t._id,
            page_id: t.page_id,
            page_number: t._page?.page_number,
            result_image_url: t.result_image_url,
            previous_status: t.previous_status,
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
