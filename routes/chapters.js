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
const { uploadLayer, cloudinary } = require("../middleware/uploadCloudinary");
const Task = require("../models/Task");
const User = require("../models/User");
const Cooperation = require("../models/Cooperation");
const PageNote = require("../models/PageNote");
const Notification = require("../models/Notification");
const upload = require("../middleware/upload");
const { ROLES } = require("../utils/constants");
const { notifyChapterAssigned } = require("../services/notificationService");
const {
  notifyChapterAssistantWorkComplete,
} = require("../services/notificationService");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

async function getImageDimensions(url) {
  if (!url) return { width: 0, height: 0 };
  try {
    if (url.includes("cloudinary.com")) {
      const publicIdMatch = url.match(/\/upload\/(.+?)\.(jpg|jpeg|png|webp)/i);
      if (publicIdMatch) {
        try {
          const resource = await new Promise((resolve, reject) => {
            cloudinary.api.resource(publicIdMatch[1], { resource_type: "image" }, (err, res) => {
              if (err) reject(err);
              else resolve(res);
            });
          });
          return { width: resource.width, height: resource.height };
        } catch {}
      }
    }
    if (url.startsWith("/uploads/")) {
      const localPath = path.join(__dirname, "..", "public", url);
      if (fs.existsSync(localPath)) {
        const buf = await sharp(localPath).metadata();
        return { width: buf.width || 0, height: buf.height || 0 };
      }
    }
    const resp = await fetch(url);
    const arr = await resp.arrayBuffer();
    const { width, height } = await sharp(Buffer.from(arr)).metadata();
    return { width: width || 0, height: height || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

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
router.post("/", authMiddleware, requireMangaka, upload.array("pages", 50), async (req, res, next) => {
  try {
    // FormData:
    //   series_id          (text)
    //   chapter_number     (text)
    //   title              (text, optional)
    //   pages[0].image     (file)         ← ảnh gốc page 1
    //   pages[0].note      (text, optional)
    //   pages[0].work_type (text, optional: background|shading|effects|details|other)
    //   pages[0].assigned_to (text, optional, user_id của assistant)
    //   pages[0].x, .y, .w, .h             ← 0-100 (% của ảnh)
    //   pages[1]...                         (nhiều page)
    const seriesId = req.body.series_id;
    const chapterNumber = req.body.chapter_number;
    const title = req.body.title || "";

    if (!seriesId || chapterNumber === undefined) {
      return next(new AppError("series_id and chapter_number are required", 400));
    }

    const series = await Series.findOne({ _id: seriesId, author_id: req.user.nameid });
    if (!series) return next(new AppError("Series not found or unauthorized", 404));

    const dup = await Chapter.findOne({ series_id: seriesId, chapter_number: Number(chapterNumber) });
    if (dup) return next(new AppError("Chapter number already exists", 409));

    if (!req.files || req.files.length === 0) {
      const chapter = await Chapter.create({
        series_id: seriesId,
        chapter_number: Number(chapterNumber),
        title,
        submitted_by: req.user.nameid,
        status: "draft",
      });
      return res.status(201).json({ success: true, data: chapter, pages: [], tasks: [] });
    }

    // Upload tất cả ảnh page lên Cloudinary song song
    const uploadResults = await Promise.all(
      req.files.map((f) =>
        cloudinary.uploader.upload(f.path, {
          folder: `wdp/chapters/${seriesId}/${Date.now()}`,
          resource_type: "image",
        })
      )
    );

    // Tạo chapter
    const chapter = await Chapter.create({
      series_id: seriesId,
      chapter_number: Number(chapterNumber),
      title,
      submitted_by: req.user.nameid,
      status: "pending_assistant",
    });

    // Parse metadata cho từng page
    const createdPages = [];
    const createdTasks = [];
    for (let i = 0; i < req.files.length; i++) {
      const f = req.files[i];
      const u = uploadResults[i];
      const get = (k) => req.body[`pages[${i}].${k}`];
      const md = {
        note: get("note"),
        work_type: get("work_type"),
        assigned_to: get("assigned_to"),
        x: get("x"),
        y: get("y"),
        w: get("w"),
        h: get("h"),
      };

      const page = await Page.create({
        chapter_id: chapter._id,
        page_number: i + 1,
        original_image_url: u.secure_url,
        width: u.width || 0,
        height: u.height || 0,
        uploaded_by: req.user.nameid,
        status: "has_task",
      });
      createdPages.push(page);

      // Tạo PageNote (note + tọa độ)
      let note = null;
      if (md.note || md.x !== undefined) {
        note = await PageNote.create({
          page_id: page._id,
          author_id: req.user.nameid,
          text: md.note || "",
          x: Number(md.x ?? 0),
          y: Number(md.y ?? 0),
          w: Number(md.w ?? 100),
          h: Number(md.h ?? 100),
          taskType: md.work_type || "other",
          status: "used_in_task",
        });
      }

      // Tạo Task (nếu có assigned_to)
      if (md.assigned_to) {
        const task = await Task.create({
          page_id: page._id,
          chapter_id: chapter._id,
          assigned_by: req.user.nameid,
          assigned_to: md.assigned_to,
          work_type: md.work_type || "other",
          region: {
            x: Number(md.x ?? 0),
            y: Number(md.y ?? 0),
            width: Number(md.w ?? 100),
            height: Number(md.h ?? 100),
          },
          description: md.note || "",
          note_ids: note ? [note._id] : [],
          status: "pending",
        });
        createdTasks.push(task);
      }
    }

    return res.status(201).json({
      success: true,
      data: chapter,
      pages: createdPages,
      tasks: createdTasks,
    });
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

    // Load pages để Assistant/Mangaka thấy ảnh gốc + result
    const pages = await Page.find({ chapter_id: chapter._id })
      .sort({ page_number: 1, createdAt: 1 })
      .select("_id chapter_id page_number original_image_url result_image_url status current_version")
      .lean();

    // Load tasks cho chapter + populate note_ids (ảnh+tọa độ+note)
    const Task = require("../models/Task");
    const tasks = await Task.find({ chapter_id: chapter._id })
      .populate("note_ids")
      .populate("assigned_to", "username full_name")
      .lean();

    const tasksByPage = {};
    for (const t of tasks) {
      const key = String(t.page_id);
      if (!tasksByPage[key]) tasksByPage[key] = [];
      tasksByPage[key].push(t);
    }
    const pagesWithTasks = pages.map((p) => ({
      ...p,
      original_image_url: p.original_image_url,
      tasks: tasksByPage[String(p._id)] || [],
    }));

    return res.status(200).json({
      success: true,
      data: { ...chapter, pages: pagesWithTasks },
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

    const { title, revision_notes, action } = req.body;

    // ─── "Gửi cả chapter" ───────────────────────────────────────────────────
    if (action === "submit") {
      const pages = await Page.find({ chapter_id: chapter._id }).lean();

      if (pages.length === 0) {
        return next(new AppError("No pages to submit", 400));
      }

      // Tạo task cho mỗi page (nếu chưa có task)
      const createdTasks = [];
      for (const page of pages) {
        const existingTask = await Task.findOne({ page_id: page._id });
        if (existingTask) continue;

        const note = await PageNote.findOne({ page_id: page._id }).lean();
        const assignedTo = req.body.assigned_to || null;

        const task = await Task.create({
          page_id: page._id,
          chapter_id: chapter._id,
          assigned_by: req.user.nameid,
          assigned_to: assignedTo,
          work_type: note?.taskType || "other",
          region: {
            x: note?.x ?? 0,
            y: note?.y ?? 0,
            width: note?.w ?? 100,
            height: note?.h ?? 100,
          },
          description: note?.text || "",
          note_ids: note ? [note._id] : [],
          status: "pending",
        });
        createdTasks.push(task);
      }

      chapter.status = "pending_assistant";
      if (revision_notes !== undefined) chapter.revision_notes = revision_notes;
      await chapter.save();

      return res.status(200).json({
        success: true,
        message: "Chapter submitted to assistant",
        data: { chapter, tasks_created: createdTasks.length },
      });
    }

    // ─── Chỉnh sửa thường ──────────────────────────────────────────────────
    if (title !== undefined) chapter.title = title;
    if (revision_notes !== undefined) chapter.revision_notes = revision_notes;

    await chapter.save();
    return res.status(200).json({ success: true, data: chapter });
  } catch (error) {
    next(error);
  }
});

// ─── POST /chapters/:id/pages ─────────────────────────────────────────────────
// Mangaka upload từng page lên Cloudinary, kèm note + tọa độ (lưu ngay vào DB)
// Body: multipart/form-data
//   - page         (file, 1 ảnh)
//   - note         (text, optional)
//   - work_type    (text, optional: background|shading|effects|details|other)
//   - assigned_to  (text, optional, user_id của assistant)
//   - x, y, w, h   (number, 0-100, optional)
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
  upload.single("page"),
  async (req, res, next) => {
    try {
      const chapter = await Chapter.findOne({
        _id: req.params.id,
        submitted_by: req.user.nameid,
      });
      if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

      if (!req.file) {
        return next(new AppError("No image uploaded", 400));
      }

      // Upload lên Cloudinary
      const uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: `wdp/chapters/${chapter.series_id}/${chapter._id}`,
        resource_type: "image",
      });

      // Lấy metadata từ body
      const noteText = req.body.note || "";
      const workType = req.body.work_type || "other";
      const x = Number(req.body.x ?? 0);
      const y = Number(req.body.y ?? 0);
      const w = Number(req.body.w ?? 100);
      const h = Number(req.body.h ?? 100);
      const assignedTo = req.body.assigned_to || null;

      const existingPages = await Page.countDocuments({ chapter_id: chapter._id });

      const page = await Page.create({
        chapter_id: chapter._id,
        page_number: existingPages + 1,
        original_image_url: uploadResult.secure_url,
        width: uploadResult.width || 0,
        height: uploadResult.height || 0,
        uploaded_by: req.user.nameid,
        status: "has_task",
      });

      let note = null;
      if (noteText || true) {
        note = await PageNote.create({
          page_id: page._id,
          author_id: req.user.nameid,
          text: noteText,
          x,
          y,
          w,
          h,
          taskType: workType,
          status: assignedTo ? "used_in_task" : "active",
        });
      }

      let task = null;
      if (assignedTo) {
        task = await Task.create({
          page_id: page._id,
          chapter_id: chapter._id,
          assigned_by: req.user.nameid,
          assigned_to: assignedTo,
          work_type: workType,
          region: { x, y, width: w, height: h },
          description: noteText,
          note_ids: note ? [note._id] : [],
          status: "pending",
        });
      }

      return res.status(201).json({
        success: true,
        data: { page, note, task },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── DELETE /chapters/pages/:pageId ────────────────────────────────────────
// Xóa 1 page: xóa ảnh trên Cloudinary, xóa PageNote, xóa Task, xóa Page
router.delete("/pages/:pageId", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const page = await Page.findById(req.params.pageId);
    if (!page) return next(new AppError("Page not found", 404));

    const chapter = await Chapter.findById(page.chapter_id);
    if (!chapter || chapter.submitted_by.toString() !== req.user.nameid) {
      return next(new AppError("Unauthorized", 403));
    }

    // Xóa ảnh trên Cloudinary
    const url = page.original_image_url || "";
    if (url.includes("res.cloudinary.com")) {
      try {
        const parts = url.split("/upload/");
        if (parts[1]) {
          const segments = parts[1].split("/");
          segments.pop(); // bỏ extension
          const publicId = segments.join("/").replace(/^v\d+\//, "");
          await cloudinary.uploader.destroy(publicId);
        }
      } catch (err) {
        console.warn("[Cloudinary] delete page image failed:", err.message);
      }
    }

    // Xóa PageNote liên quan
    await PageNote.deleteMany({ page_id: page._id });

    // Xóa Task liên quan
    await Task.deleteMany({ page_id: page._id });

    // Xóa Page
    await Page.deleteOne({ _id: page._id });

    // Đánh lại page_number cho các page còn lại
    const remaining = await Page.find({ chapter_id: chapter._id }).sort({ page_number: 1 });
    await Promise.all(
      remaining.map((p, idx) =>
        Page.updateOne({ _id: p._id }, { page_number: idx + 1 })
      )
    );

    return res.status(200).json({ success: true, message: "Page deleted" });
  } catch (error) {
    next(error);
  }
});

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
router.get("/:id/pages", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const chapter = await Chapter.findById(req.params.id).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    if (!chapter.is_published) {
      const role = req.user.role;
      if (![ROLES.MANGAKA, ROLES.ASSISTANT, ROLES.EDITOR, ROLES.EB].includes(role)) {
        return next(new AppError("Access denied", 403));
      }
    }

    const pages = await Page.find({ chapter_id: req.params.id })
      .sort({ page_number: 1 })
      .lean();

    const pagesWithDims = await Promise.all(pages.map(async (p) => {
      let width = p.width;
      let height = p.height;
      if ((!width || !height) && p.original_image_url) {
        const dims = await getImageDimensions(p.original_image_url);
        width = dims.width;
        height = dims.height;
        if (width || height) {
          await Page.findByIdAndUpdate(p._id, { width, height });
        }
      }
      return { ...p, width: width || 0, height: height || 0 };
    }));

    return res.status(200).json({ success: true, data: pagesWithDims });
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
      if (![ROLES.MANGAKA, ROLES.ASSISTANT, ROLES.EDITOR, ROLES.EB].includes(role)) {
        return next(new AppError("Access denied", 403));
      }
    }

    const tasks = await Task.find({ page_id: page._id })
        .populate("assigned_to", "username full_name phoneNumber")
        .populate("assigned_by", "username full_name phoneNumber")
        .populate("note_ids")
        .sort({ createdAt: 1 })
        .lean();

    let width = page.width;
    let height = page.height;
    if ((!width || !height) && page.original_image_url) {
      const dims = await getImageDimensions(page.original_image_url);
      width = dims.width;
      height = dims.height;
      if (width || height) {
        await Page.findByIdAndUpdate(page._id, { width, height });
      }
    }

    return res.status(200).json({
      success: true,
      _id: page._id,
      chapter_id: page.chapter_id,
      original_image_url: page.original_image_url || "",
      page_number: page.page_number,
      width: width || 0,
      height: height || 0,
      status: page.status,
    });
  } catch (error) {
    next(error);
  }
});

// Lấy ảnh kết quả cuối cùng của page (cho Assistant/Mangaka hiển thị final result)
/**
 * @swagger
 * /pages/{id}/final:
 *   get:
 *     summary: Lấy ảnh kết quả cuối (final) của page
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
 *         description: Trả về result_image_url + status
 *       404:
 *         description: Page not found
 */
router.get("/pages/:id/final", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const page = await Page.findById(req.params.id)
      .select("result_image_url status chapter_id current_version snapshots")
      .lean();
    if (!page) return next(new AppError("Page not found", 404));

    // Chapter chưa published → check role
    const chapter = await Chapter.findById(page.chapter_id).select("is_published").lean();
    if (chapter && !chapter.is_published) {
      const role = req.user.role;
      if (!["Mangaka", "Assistant", "Editor", "EB"].includes(role)) {
        return next(new AppError("Access denied", 403));
      }
    }

    // Nếu có snapshot mới nhất → ưu tiên trả về layers từ snapshot (assistant render realtime)
    const latestSnapshot = page.snapshots && page.snapshots.length
      ? page.snapshots[page.snapshots.length - 1]
      : null;

    return res.status(200).json({
      success: true,
      final_image_url: page.result_image_url || "",
      page_id: page._id,
      status: page.status,
      current_version: page.current_version,
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
      data: {
        page: {
          _id: page._id,
          chapter_id: page.chapter_id,
          page_number: page.page_number,
          original_image_url: page.original_image_url,
          result_image_url: page.result_image_url,
          status: page.status,
          current_version: page.current_version,
        },
        notes,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /pages/:id/layers ───────────────────────────────────────────────────
// Assistant/Mangaka lấy danh sách layer ảnh của page (do Mangaka hoặc Assistant tạo)
/**
 * @swagger
 * /chapters/pages/{id}/layers:
 *   get:
 *     summary: Lấy danh sách layer ảnh của page
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Danh sách layer (image_url, position, opacity, blend_mode…)
 *       404:
 *         description: Page not found
 */
router.get("/pages/:id/layers", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const page = await Page.findById(req.params.id).lean();
    if (!page) return next(new AppError("Page not found", 404));

    const chapter = await Chapter.findById(page.chapter_id).lean();
    if (chapter && !chapter.is_published) {
      const role = req.user.role;
      if (!["Mangaka", "Assistant", "Editor", "EB"].includes(role)) {
        return next(new AppError("Access denied", 403));
      }
    }

    const layers = await PageLayer.find({ page_id: page._id })
      .sort({ z_order: 1, createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      layers,
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /pages/:id/layers ──────────────────────────────────────────────────
// Assistant hoặc Mangaka upload layer mới cho page
/**
 * @swagger
 * /chapters/pages/{id}/layers:
 *   post:
 *     summary: Upload layer mới cho page
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: File ảnh layer (PNG/JPG/WebP, max 10MB)
 *               index:
 *                 type: integer
 *                 description: Vị trí z_order mong muốn (mặc định append cuối)
 *     responses:
 *       201:
 *         description: Layer đã được tạo
 *       400:
 *         description: Thiếu file image
 *       404:
 *         description: Page not found
 */
router.post(
  "/pages/:id/layers",
  authMiddleware,
  requireMangakaOrAssistant,
  uploadLayer.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return next(new AppError("Image is required", 400));
      }

      const page = await Page.findById(req.params.id);
      if (!page) return next(new AppError("Page not found", 404));

      const chapter = await Chapter.findById(page.chapter_id).lean();
      if (!chapter) return next(new AppError("Chapter not found", 404));

      const series = await Series.findById(chapter.series_id).lean();
      if (!series) return next(new AppError("Series not found", 404));

      const isAuthor = series.author_id.toString() === req.user.nameid;
      const isAssigned = chapter.assistant_id?.toString() === req.user.nameid;
      if (!isAuthor && !isAssigned) {
        return next(new AppError("Khong co quyen truy cap chapter nay", 403));
      }

      const layerCount = await PageLayer.countDocuments({ page_id: page._id });

      let zOrder;
      if (req.body.index !== undefined && req.body.index !== null && req.body.index !== "") {
        const parsed = parseInt(req.body.index, 10);
        zOrder = Number.isFinite(parsed) && parsed >= 0 ? parsed : layerCount;
      } else {
        zOrder = layerCount;
      }

      const imageUrl = req.file.path || req.file.secure_url;

      const layer = await PageLayer.create({
        page_id: page._id,
        name: `Layer ${zOrder + 1}`,
        image_url: imageUrl,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        opacity: 100,
        visible: true,
        blend_mode: "source-over",
        z_order: zOrder,
        locked: false,
        created_by: req.user.nameid,
        note: req.body.note || "",
        version: 1,
      });

      return res.status(201).json({
        success: true,
        layer,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── DELETE /pages/layers/:layerId ───────────────────────────────────────────
// Assistant hoặc Mangaka xóa layer (đồng thời xóa file trên Cloudinary)
/**
 * @swagger
 * /chapters/pages/layers/{layerId}:
 *   delete:
 *     summary: Xóa layer
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: layerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Xóa thành công
 *       404:
 *         description: Layer not found
 */
router.delete(
  "/pages/layers/:layerId",
  authMiddleware,
  requireMangakaOrAssistant,
  async (req, res, next) => {
    try {
      const layer = await PageLayer.findById(req.params.layerId);
      if (!layer) return next(new AppError("Layer not found", 404));

      // Xóa file trên Cloudinary (nếu là URL Cloudinary)
      const url = layer.image_url || "";
      if (url.includes("res.cloudinary.com")) {
        try {
          const parts = url.split("/upload/");
          if (parts[1]) {
            const after = parts[1].split(".");
            after.pop(); // bỏ extension
            // bỏ version v123... nếu có
            const segments = after.join(".").split("/").filter(s => !/^v\d+$/.test(s));
            const publicId = segments.join("/");
            await cloudinary.uploader.destroy(publicId);
          }
        } catch (err) {
          console.warn("[Cloudinary] delete layer failed:", err.message);
          // không fail request — vẫn xóa DB
        }
      }

      await PageLayer.deleteOne({ _id: layer._id });

      return res.status(200).json({
        success: true,
        message: "Layer deleted",
      });
    } catch (error) {
      next(error);
    }
  }
);

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

// ─── POST /chapters/:chapterId/submit-all ──────────────────────────────────────
// Assistant nộp TOÀN BỘ chapter (tất cả pages) cho Mangaka duyệt.
// Với mỗi page trong chapter, lấy ảnh theo thứ tự ưu tiên:
//   1. File upload mới (multipart files[i])   → upload lên Cloudinary
//   2. page.result_image_url (đã qua /finalize) → dùng luôn
//   3. Không có gì                              → giữ nguyên ảnh hiện tại, vẫn mark "submitted"
//
// Sau khi submit: chapter.status = "submitted_by_assistant", notify Mangaka.
const { uploadResult } = require("../middleware/uploadResult");
router.post(
  "/:chapterId/submit-all",
  authMiddleware,
  requireAssistant,
  uploadResult.fields([{ name: "files", maxCount: 100 }]),
  async (req, res, next) => {
    try {
      const { chapterId } = req.params;
      const chapter = await Chapter.findById(chapterId).lean();
      if (!chapter) return next(new AppError("Chapter not found", 404));
      if (chapter.assistant_id?.toString() !== req.user.nameid) {
        return next(new AppError("Khong co quyen truy cap chapter nay", 403));
      }

      const files = req.files?.files || [];
      const pages = await Page.find({ chapter_id: chapterId })
        .sort({ page_number: 1 })
        .lean();

      if (pages.length === 0) {
        return next(new AppError("Chapter has no pages", 400));
      }

      const pageUpdates = [];
      const result_image_urls = [];
      const newFiles = [];
      const reused = [];

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        let imageUrl = "";
        let source = "";

        // 1) File mới (nếu có)
        if (files[i]) {
          imageUrl = files[i].path;
          source = "new_upload";
        }
        // 2) Ảnh đã finalize từ trước
        else if (page.result_image_url) {
          imageUrl = page.result_image_url;
          source = "finalize_reuse";
        }
        // 3) Không có gì → giữ nguyên ảnh gốc (original_image_url)
        else if (page.original_image_url) {
          imageUrl = page.original_image_url;
          source = "original_fallback";
        }
        else {
          console.warn(`[submit-all] Page ${page._id} (page_number=${page.page_number}) has no image at all — skipping`);
          continue;
        }

        pageUpdates.push(
          Page.findByIdAndUpdate(page._id, {
            result_image_url: imageUrl,
            status: "submitted",
          }).then(() => {
            result_image_urls.push(imageUrl);
            if (source === "new_upload") newFiles.push({ page_number: page.page_number, url: imageUrl });
            else if (source === "finalize_reuse") reused.push({ page_number: page.page_number, url: imageUrl });
          })
        );
      }

      if (pageUpdates.length === 0) {
        return next(new AppError("Khong co anh de submit (cac page chua co original_image_url, result_image_url va khong co file upload)", 400));
      }

      await Promise.all(pageUpdates);

      // Cập nhật chapter status
      const updatedChapter = await Chapter.findByIdAndUpdate(
        chapterId,
        {
          status: "submitted_by_assistant",
          $push: {
            revision_history: {
              at: new Date(),
              by: req.user.nameid,
              note: "Assistant submitted",
            },
          },
        },
        { new: true }
      ).lean();

      // Notify Mangaka (submitted_by)
      await notifyTaskSubmitted(
        Notification,
        chapter.submitted_by,
        { chapter_id: chapterId, page_count: pages.length, new_uploads: newFiles.length, reused: reused.length }
      );

      return res.status(200).json({
        success: true,
        _id: chapterId,
        status: "submitted_to_mangaka",
        submitted_at: new Date().toISOString(),
        result_image_urls,
        page_count: pages.length,
        new_uploads: newFiles,
        reused_from_finalize: reused,
        chapter_id: chapterId,
        submitted_by: req.user.nameid,
        chapter: updatedChapter,
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
