const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");
const { authMiddleware } = require("../middleware/auth");
const { requireMangaka, requireMangakaOrAssistant, requireAssistant, requireMangakaOrTEOrEB, requireReader } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const PageLayer = require("../models/PageLayer");
const Series = require("../models/Series");
const PurchasedChapter = require("../models/PurchasedChapter");
const { uploadLayer, cloudinary } = require("../middleware/uploadCloudinary");
const { uploadChapterPage } = require("../middleware/uploadChapterPage");
const { uploadToCloudinary: uploadSingleToCloudinary, uploadCover } = require("../middleware/uploadCoverCloudinary");
const Task = require("../models/Task");
const User = require("../models/User");
const Cooperation = require("../models/Cooperation");
const PageNote = require("../models/PageNote");
const Notification = require("../models/Notification");
const upload = require("../middleware/upload");
const { ROLES, FREE_CHAPTER_AUTO_LIMIT, FIXED_CHAPTER_COIN_PRICE } = require("../utils/constants");
const { notifyChapterAssigned } = require("../services/notificationService");
const {
  notifyChapterAssistantWorkComplete,
  notifyTaskSubmitted,
} = require("../services/notificationService");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

// Memory storage cho page uploads (upload thẳng lên Cloudinary)
const uploadPages = multer({
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
async function uploadToCloudinary(file, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", allowed_formats: ["jpg", "jpeg", "png", "webp"] },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(file.buffer);
  });
}

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

// ─── Helpers: revision_annotations derivation (mirror of routes/tasks.js) ────
function toApiRevisionAnnotation(noteDoc, taskId) {
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

function deriveRevisionAnnotations(task) {
  if (!task || !Array.isArray(task.note_ids)) return [];
  const currentRound = task.round || 1;
  return task.note_ids
    .filter((n) => n && n.note_kind === "revision" && n.revision_round === currentRound)
    .map((n) => toApiRevisionAnnotation(n, task._id));
}

// ─── Helpers: validate assistant + lock after sale ───────────────────────────
// Quy tắc (xem yêu cầu #5):
//   1. assistant_id phải là ObjectId hợp lệ
//   2. User tồn tại và role = "Assistant"
//   3. Assistant không trùng Mangaka
//   4. Có Cooperation accepted với Mangaka
//   5. Cooperation.series_id = null (chung) HOẶC = seriesId của chapter
//
// Khóa (yêu cầu #8):
//   - Nếu chapter đã có ít nhất 1 PurchasedChapter → không cho phép
//     thay đổi hoặc xóa assistant_id (code: assistant_locked_after_sale).

/**
 * Validate assistant_id trước khi gán vào chapter.
 *
 * @returns {Promise<[Error|null, string|null]>}
 *   [error, validatedAssistantId]
 */
async function validateAssistantForChapter(assistantId, mangakaId, seriesId) {
  if (!assistantId) {
    return [null, null];
  }
  if (!mongoose.Types.ObjectId.isValid(assistantId)) {
    return [
      new AppError("assistant_id không hợp lệ", 400, {
        code: "assistant_invalid_id",
      }),
      null,
    ];
  }
  if (String(assistantId) === String(mangakaId)) {
    return [
      new AppError(
        "assistant_id không được trùng với Mangaka sở hữu series",
        400,
        { code: "assistant_is_mangaka" }
      ),
      null,
    ];
  }
  const assistant = await User.findById(assistantId);
  if (!assistant) {
    return [
      new AppError("Assistant không tồn tại", 404, {
        code: "assistant_not_found",
      }),
      null,
    ];
  }
  if (assistant.role !== "Assistant") {
    return [
      new AppError(
        "User được gán làm assistant phải có role = Assistant",
        400,
        { code: "invalid_assistant_role" }
      ),
      null,
    ];
  }
  const cooperation = await Cooperation.findOne({
    mangaka_id: mangakaId,
    assistant_id: assistantId,
    agreed_at: { $ne: null },
    $or: [{ series_id: seriesId }, { series_id: null }],
  });
  if (!cooperation) {
    return [
      new AppError(
        "Assistant chưa ký hợp đồng hợp tác hợp lệ với Mangaka cho series này",
        403,
        { code: "assistant_not_in_cooperation" }
      ),
      null,
    ];
  }
  return [null, assistantId];
}

/**
 * Kiểm tra chapter đã phát sinh giao dịch mua nào chưa.
 * @returns {Promise<boolean>}
 */
async function chapterHasPurchases(chapterId) {
  const cnt = await PurchasedChapter.countDocuments({ chapter_id: chapterId });
  return cnt > 0;
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
 *         multipart/form-data:
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
 *                 type: string
 *                 description: Số thứ tự chapter (number string)
 *               title:
 *                 type: string
 *                 description: Tiêu đề chapter (optional)
 *               assistant_id:
 *                 type: string
 *                 description: "User ID của assistant (optional, nhưng bắt buộc khi series đã publish). Sẽ set chapter.assistant_id ngay khi tạo. Phải có Cooperation đã accepted với Mangaka (cùng series hoặc chung). Logic chia doanh thu: Mangaka 60% / Assistant 40% (sau khi trừ 20% phí nền tảng)."
 *               access_type:
 *                 type: string
 *                 enum: [FREE, PAID]
 *                 description: "Chỉ chapter 1 mặc định FREE (luôn FREE). Từ chapter 2 trở đi MẶC ĐỊNH PAID và BẮT BUỘC nhập coin_price. Nếu muốn FREE thì truyền rõ access_type=FREE."
 *               coin_price:
 *                 type: number
 *                 description: "Số Coin mua chapter. Bắt buộc khi access_type=PAID (mặc định cho chapter 2+). Mặc định 0 cho chapter FREE."
 *     responses:
 *       201:
 *         description: Chapter được tạo thành công
 *       400:
 *         description: "Thiếu series_id hoặc chapter_number. Lỗi validation assistant_id: assistant_invalid_id, assistant_is_mangaka, invalid_assistant_role, assistant_not_in_cooperation."
 *       403:
 *         description: Assistant có id hợp lệ nhưng chưa có Cooperation hợp lệ với Mangaka.
 *       404:
 *         description: Series not found, unauthorized, hoặc assistant_not_found.
 *       409:
 *         description: Chapter number đã tồn tại trong series
 */
router.post("/", authMiddleware, requireMangaka, uploadPages.array("pages", 50), async (req, res, next) => {
  try {
    // FormData:
    //   series_id          (text)
    //   chapter_number     (text)
    //   title              (text, optional)
    //   assistant_id       (text, optional, user_id của assistant — set chapter.assistant_id ngay khi tạo)
    //   pages[0].image     (file)         ← ảnh gốc page 1
    //   pages[0].note      (text, optional)
    //   pages[0].work_type (text, optional: background|shading|effects|details|other)
    //   pages[0].assigned_to (text, optional, user_id của assistant cho task per-page)
    //   pages[0].x, .y, .w, .h             ← 0-100 (% của ảnh)
    //   pages[1]...                         (nhiều page)
    const seriesId = req.body.series_id;
    const chapterNumber = req.body.chapter_number;
    const title = req.body.title || "";
    const assistantIdTopLevel = req.body.assistant_id || "";

    if (!seriesId || chapterNumber === undefined) {
      return next(new AppError("series_id and chapter_number are required", 400));
    }

    const series = await Series.findOne({ _id: seriesId, author_id: req.user.nameid });
    if (!series) return next(new AppError("Series not found or unauthorized", 404));

    // ─── Determine access_type & coin_price ───────────────────────────────
    // Quy tắc mới (cố định giá):
    //   - Chapter 1                → luôn FREE, coin_price = 0
    //                                 (kể cả user truyền access_type=PAID cũng bị ép về FREE).
    //   - Chapter >= 2              → mặc định PAID, coin_price CỐ ĐỊNH = 5 Coin
    //                                 (Mangaka không cần truyền coin_price; nếu truyền cũng bị bỏ).
    //                                 Muốn FREE thì truyền rõ access_type=FREE.
    const num = Number(chapterNumber);
    if (!Number.isFinite(num) || num < 1) {
      return next(new AppError("chapter_number không hợp lệ", 400));
    }

    let accessType;
    let coinPrice;

    if (num <= FREE_CHAPTER_AUTO_LIMIT) {
      // Chapter 1: ép FREE cứng, bỏ qua mọi input của user
      accessType = "FREE";
      coinPrice = 0;
    } else {
      // Chapter 2+: cho phép user override access_type = FREE.
      // Nếu không truyền / truyền PAID → mặc định PAID, giá cố định 5 Coin.
      const rawAccessType = req.body.access_type;
      const upper = rawAccessType ? String(rawAccessType).toUpperCase() : null;
      if (upper === "FREE") {
        accessType = "FREE";
        coinPrice = 0;
      } else if (upper === "PAID" || upper === null || upper === undefined) {
        accessType = "PAID";
        coinPrice = FIXED_CHAPTER_COIN_PRICE;
      } else {
        return next(
          new AppError("access_type phải là FREE hoặc PAID", 400)
        );
      }
    }

    // Lưu ý: Debut Gate KHÔNG chặn ở POST /chapters — Mangaka được tạo nhiều chapter.
    // Gate chuyển sang chặn ở POST /chapters/:chapterId/submit-to-te (chỉ cho submit chapter 1 khi series locked).

    // Nếu FE gửi assistant_id ở top-level → validate User + Cooperation ngay tại đây
    // để set chapter.assistant_id ngay khi tạo (FE đã gửi sẵn theo contract mới).
    // Validate đầy đủ theo quy tắc mới (yêu cầu #5):
    //   - ObjectId hợp lệ
    //   - User tồn tại + role Assistant
    //   - Không trùng Mangaka
    //   - Có Cooperation accepted (cùng series hoặc chung)
    let validatedAssistantId = null;
    if (assistantIdTopLevel) {
      const [asstErr, asstId] = await validateAssistantForChapter(
        assistantIdTopLevel,
        req.user.nameid,
        seriesId
      );
      if (asstErr) return next(asstErr);
      validatedAssistantId = asstId;
    }

    // Series đã publish → bắt buộc phải có assistant.
    // Chấp nhận 1 trong 2:
    //   - assistant_id ở top-level body (sẽ được set vào chapter.assistant_id)
    //   - assigned_to per-page (giữ flow cũ, FE gửi pages[i].assigned_to)
    if (series.status === "published" && !validatedAssistantId) {
      const hasAnyAssistant = req.files && req.files.some((f) => {
        const i = req.files.indexOf(f);
        return req.body[`pages[${i}].assigned_to`];
      });
      if (!hasAnyAssistant) {
        return next(new AppError("Series đã publish, bắt buộc phải assign assistant cho chapter", 400));
      }
    }

    const dup = await Chapter.findOne({ series_id: seriesId, chapter_number: Number(chapterNumber) });
    if (dup) return next(new AppError("Chapter number already exists", 409));

    if (!req.files || req.files.length === 0) {
      const chapter = await Chapter.create({
        series_id: seriesId,
        chapter_number: Number(chapterNumber),
        title,
        submitted_by: req.user.nameid,
        assistant_id: validatedAssistantId,
        access_type: accessType,
        coin_price: coinPrice,
        status: validatedAssistantId ? "pending_assistant" : "draft",
      });
      return res.status(201).json({ success: true, data: chapter, pages: [], tasks: [] });
    }

    const folder = `wdp/chapters/${seriesId}/${Date.now()}`;
    const uploadResults = await Promise.all(
      req.files.map((f) => uploadToCloudinary(f, folder))
    );

    // Tạo chapter
    const chapter = await Chapter.create({
      series_id: seriesId,
      chapter_number: Number(chapterNumber),
      title,
      submitted_by: req.user.nameid,
      assistant_id: validatedAssistantId,
      access_type: accessType,
      coin_price: coinPrice,
      status: "pending_assistant",
    });

    // Parse metadata cho từng page
    const createdPages = [];
    const createdTasks = [];
    for (let i = 0; i < req.files.length; i++) {
      const f = req.files[i];
      const u = uploadResults[i];
      const get = (k) => req.body[`pages[${i}].${k}`];
      // Per-page: ưu tiên pages[i].assigned_to; KHÔNG fallback về top-level assistant_id ở đây
      // (Task là opt-in per-page, có note/region mới nên tạo).
      // assistant_id top-level chỉ set vào chapter.assistant_id — đủ để pass check published.
      const md = {
        note: get("note"),
        work_type: get("work_type"),
        assigned_to: get("assigned_to") || null,
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
        // status: chỉ "has_task" nếu assigned_to có, ngược lại để Mongoose dùng default
        ...(md.assigned_to ? { status: "has_task" } : {}),
      });
      createdPages.push(page);

      // Tạo PageNote (note + tọa độ) — CHỈ khi có note thực từ user
      // Tránh tạo note placeholder full-page khi user chỉ upload ảnh thuần
      let note = null;
      const noteText = (md.note || "").trim();
      const hasRealNote = noteText.length > 0 || (md.assigned_to && md.assigned_to.trim().length > 0);
      if (hasRealNote) {
        note = await PageNote.create({
          page_id: page._id,
          author_id: req.user.nameid,
          text: noteText,
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
          round: 1,
          is_current_round: true,
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
    // Reserved sub-paths (e.g. /chapters/my-assignments) must not be cast to ObjectId.
    const reserved = new Set(["my-assignments"]);
    if (reserved.has(req.params.id)) {
      return next();
    }

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

    // Load tasks vòng hiện tại cho chapter + populate note_ids (ảnh+tọa độ+note)
    const Task = require("../models/Task");
    const tasks = await Task.find({ chapter_id: chapter._id, is_current_round: true })
      .populate({
        path: "note_ids",
        select: "text x y w h taskType note_kind author_role revision_round status createdAt",
      })
      .populate("assigned_to", "username full_name")
      .lean();

    const tasksByPage = {};
    for (const t of tasks) {
      const key = String(t.page_id);
      if (!tasksByPage[key]) tasksByPage[key] = [];
      tasksByPage[key].push({
        ...t,
        revision_round: t.round,
        revision_annotations: deriveRevisionAnnotations(t),
      });
    }
    const pagesWithTasks = pages.map((p) => ({
      ...p,
      original_image_url: p.original_image_url,
      tasks: tasksByPage[String(p._id)] || [],
    }));

    // Build revision_annotations_by_page (page_N: [...]) từ chapter.revision_annotations
    const pageIndexMap = {};
    pages.forEach((p, idx) => { pageIndexMap[String(p._id)] = idx; });
    const revision_annotations_by_page = {};
    (chapter.revision_annotations || []).forEach((ann) => {
      const idx = pageIndexMap[ann.page_id?.toString()];
      if (idx === undefined) return;
      const key = `page_${idx}`;
      if (!revision_annotations_by_page[key]) revision_annotations_by_page[key] = [];
      revision_annotations_by_page[key].push({
        text: ann.content,
        x: ann.region?.x,
        y: ann.region?.y,
        w: ann.region?.width,
        h: ann.region?.height,
        error_type: ann.error_type,
      });
    });

    return res.status(200).json({
      success: true,
      data: {
        ...chapter,
        pages: pagesWithTasks,
        revision_notes: chapter.revision_notes || null,
        revision_annotations: chapter.revision_annotations || [],
        revision_annotations_by_page,
      },
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
 *               action:
 *                 type: string
 *                 enum: [submit]
 *                 description: >
 *                   "submit" = gửi cả chapter cho Assistant (kèm revision_annotations
 *                   optional nếu muốn tạo task từ annotations).
 *                   Vòng revision 2+ cũng dùng action=submit với revision_annotations
 *                   (mỗi lần submit sẽ tạo round mới, mark task vòng cũ inactive).
 *               assigned_to:
 *                 type: string
 *                 description: User ID của Assistant (khi action=submit)
 *               revision_annotations:
 *                 type: object
 *                 description: >
 *                   Annotations theo page key (page_0, page_1...).
 *                   Value = array of { text, x, y, w, h, taskType, error_type }.
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
 *         description: Cập nhật thành công
 *       400:
 *         description: Không thể sửa chapter đã published
 *       404:
 *         description: Chapter not found hoặc unauthorized
 */
router.patch("/:id", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    // Reserved sub-paths guard (defensive — không có route conflict hiện tại nhưng để chắc)
    const reserved = new Set(["my-assignments"]);
    if (reserved.has(req.params.id)) {
      return next();
    }

    const chapter = await Chapter.findOne({
      _id: req.params.id,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    if (chapter.status === "published") {
      return next(new AppError("Cannot edit published chapter", 400));
    }

    const { title, revision_notes, revision_annotations, action } = req.body;

    // ─── "Gửi cả chapter" ───────────────────────────────────────────────────
    if (action === "submit") {
      const pages = await Page.find({ chapter_id: chapter._id }).lean();

      if (pages.length === 0) {
        return next(new AppError("No pages to submit", 400));
      }

      // 1) Tìm round hiện tại lớn nhất của chapter → round mới = max + 1
      const lastTask = await Task.findOne({ chapter_id: chapter._id })
        .sort({ round: -1 })
        .select("round")
        .lean();
      const nextRound = (lastTask?.round ?? 0) + 1;

      // 2) Mark các task vòng cũ (is_current_round=true + chưa approved/submitted) thành inactive
      //    → chỉ mark những task đang mở, task đã đóng (approved/submitted) giữ nguyên
      const markInactiveResult = await Task.updateMany(
        {
          chapter_id: chapter._id,
          is_current_round: true,
          status: { $in: ["pending", "in_progress", "revision"] },
        },
        { $set: { is_current_round: false } }
      );
      const inactiveCount = markInactiveResult.modifiedCount || 0;

      // Tạo map page_index → page doc để lookup nhanh
      const pageIndexMap = {};
      pages.forEach((p, idx) => {
        pageIndexMap[`page_${idx}`] = p;
      });

      // Tạo task cho mỗi annotation trong revision_annotations
      // (key = pageKey, value = array of annotations)
      const createdTasks = [];
      const chapterAnnotations = []; // Lưu vào chapter.revision_annotations

      if (revision_annotations && typeof revision_annotations === "object") {
        for (const [pageKey, annotations] of Object.entries(revision_annotations)) {
          const page = pageIndexMap[pageKey];
          if (!page || !Array.isArray(annotations)) continue;

          for (const ann of annotations) {
            // Map FE work_type → BE error_type enum
            const workTypeToErrorType = {
              background: "art",
              shading: "art",
              effects: "art",
              details: "art",
              fill: "art",
              content: "content",
              dialogue: "dialogue",
              script: "script",
              other: "other",
            };

            // Transform FE format → Chapter schema format
            const chapterAnn = {
              page_id: page._id,
              region: {
                x: Number(ann.x ?? ann.region?.x ?? 0),
                y: Number(ann.y ?? ann.region?.y ?? 0),
                width: Number(ann.w ?? ann.width ?? ann.region?.width ?? 100),
                height: Number(ann.h ?? ann.height ?? ann.region?.height ?? 100),
              },
              content: ann.text || ann.content || "",
              error_type: ann.error_type || workTypeToErrorType[ann.taskType] || "other",
            };
            chapterAnnotations.push(chapterAnn);

            // Tạo Task cho annotation — round mới, is_current_round=true
            // Ưu tiên: ann.assigned_to (per-note) → req.body.assigned_to (top-level) → chapter.assistant_id (từ API /assign)
            const assignedTo = ann.assigned_to || req.body.assigned_to || chapter.assistant_id || null;
            if (assignedTo) {
              const task = await Task.create({
                page_id: page._id,
                chapter_id: chapter._id,
                assigned_by: req.user.nameid,
                assigned_to: assignedTo,
                work_type: ann.taskType || ann.work_type || "other",
                region: {
                  x: chapterAnn.region.x,
                  y: chapterAnn.region.y,
                  width: chapterAnn.region.width,
                  height: chapterAnn.region.height,
                },
                description: ann.text || ann.content || "",
                revision_note: revision_notes || "",
                status: "pending",
                round: nextRound,
                is_current_round: true,
              });
              createdTasks.push(task);
            }
          }
        }
      }

      // Fallback: nếu không có revision_annotations, tạo task từ PageNote cũ
      if (chapterAnnotations.length === 0) {
        for (const page of pages) {
          const note = await PageNote.findOne({ page_id: page._id }).lean();
          const assignedTo = req.body.assigned_to || chapter.assistant_id || null;

          if (note && assignedTo) {
            const task = await Task.create({
              page_id: page._id,
              chapter_id: chapter._id,
              assigned_by: req.user.nameid,
              assigned_to: assignedTo,
              work_type: note.taskType || "other",
              region: {
                x: note.x ?? 0,
                y: note.y ?? 0,
                width: note.w ?? note.width ?? 100,
                height: note.h ?? note.height ?? 100,
              },
              description: note.text || "",
              revision_note: revision_notes || "",
              note_ids: [note._id],
              status: "pending",
              round: nextRound,
              is_current_round: true,
            });
            createdTasks.push(task);
          }
        }
      }

      chapter.status = "pending_assistant";
      if (revision_notes !== undefined) chapter.revision_notes = revision_notes;
      chapter.revision_annotations = chapterAnnotations;
      chapter.revision_source = "Mangaka";
      await chapter.save();

      return res.status(200).json({
        success: true,
        message: "Chapter submitted to assistant",
        data: {
          chapter,
          round: nextRound,
          tasks_created: createdTasks.length,
          tasks_marked_inactive: inactiveCount,
        },
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

// ─── PATCH /chapters/:id/cover ──────────────────────────────────────────────
// Mangaka cập nhật ảnh bìa cho chapter (upload lên Cloudinary).
// Body: multipart/form-data với field "cover" (image).
// Gửi body rỗng sẽ xóa ảnh bìa đã set trước đó.
/**
 * @swagger
 * /chapters/{id}/cover:
 *   patch:
 *     summary: Cập nhật / xóa ảnh bìa của chapter
 *     description: >
 *       Mangaka sở hữu chapter upload ảnh bìa (field "cover") lên Cloudinary và
 *       lưu URL vào Chapter.cover_image_url. Nếu gửi multipart không kèm file
 *       và không kèm remove=true thì trả về 400. Gửi remove=true (JSON hoặc
 *       form field) để xóa ảnh bìa đã set trước đó (fallback về ảnh trang đầu
 *       hoặc ảnh bìa series).
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
 *       required: false
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               cover:
 *                 type: string
 *                 format: binary
 *                 description: File ảnh bìa (jpeg, jpg, png, webp, ≤ 10MB)
 *               remove:
 *                 type: boolean
 *                 description: Đặt true để xóa ảnh bìa đã lưu
 *     responses:
 *       200:
 *         description: Cập nhật ảnh bìa thành công
 *       400:
 *         description: Thiếu file cover hoặc chapter đã published
 *       404:
 *         description: Chapter not found hoặc unauthorized
 */
router.patch(
  "/:id/cover",
  authMiddleware,
  requireMangaka,
  uploadCover.single("cover"),
  async (req, res, next) => {
    try {
      const chapter = await Chapter.findOne({
        _id: req.params.id,
        submitted_by: req.user.nameid,
      });
      if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

      if (chapter.status === "published") {
        return next(new AppError("Cannot edit published chapter", 400));
      }

      const wantsRemove =
        req.body?.remove === true ||
        req.body?.remove === "true" ||
        req.body?.remove === "1";

      if (!req.file && !wantsRemove) {
        return next(
          new AppError("Vui lòng gửi file 'cover' hoặc đặt remove=true để xóa ảnh bìa", 400)
        );
      }

      if (wantsRemove) {
        chapter.cover_image_url = "";
      } else {
        const folder = `wdp/chapters/covers/${chapter._id}`;
        const result = await uploadSingleToCloudinary(req.file, folder, "chapter-cover");
        chapter.cover_image_url = result.secure_url;
      }

      await chapter.save();
      return res.status(200).json({
        success: true,
        data: {
          _id: chapter._id,
          cover_image_url: chapter.cover_image_url,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /chapters/:id/submit-revision ─────────────────────────────────────
// Mangaka gửi lại chapter cho Assistant sau khi yêu cầu sửa (round 2+)
// Body: { revision_notes, revision_annotations, action }
// action=submit-revision: chuyển chapter sang pending_assistant, tạo task mới cho annotations
/**
 * @swagger
 * /chapters/{id}/submit-revision:
 *   post:
 *     summary: Mangaka gửi yêu cầu sửa (round 2+) cho Assistant
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
 *               revision_notes:
 *                 type: string
 *                 description: Ghi chú tổng hợp cho toàn chapter
 *               revision_annotations:
 *                 type: object
 *                 description: >
 *                   Annotations theo page key. Key = page_{index} (0-based).
 *                   Value = array of { text, x, y, w, h, taskType, error_type }
 *                 example:
 *                   page_0:
 *                     - text: "Sửa shading vùng mặt"
 *                       x: 12.5
 *                       y: 30.0
 *                       w: 25.0
 *                       h: 18.0
 *                       taskType: "shading"
 *                       error_type: "art"
 *                   page_1: []
 *     responses:
 *       200:
 *         description: Yêu cầu sửa đã được gửi cho Assistant
 *       400:
 *         description: Chapter không ở trạng thái hợp lệ để submit revision
 *       403:
 *         description: Không có quyền
 *       404:
 *         description: Chapter not found
 */
// ─── DELETE /chapters/:id ───────────────────────────────────────────────────
// Mangaka xóa chapter (chỉ khi status === "draft")
// Cascade: Chapter → Page → Task → PageNote → PageLayer (toàn bộ dữ liệu liên quan)
/**
 * @swagger
 * /chapters/{id}:
 *   delete:
 *     summary: Xóa chapter (chỉ ở trạng thái draft)
 *     description: >
 *       Mangaka sở hữu chapter xóa khi chapter còn ở trạng thái "draft".
 *       Cascade xóa toàn bộ: Page, Task, PageNote (note của page),
 *       PageLayer (ảnh lớp). Sau khi chapter được gửi cho Assistant
 *       (status !== draft) thì không xóa được.
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
 *         description: Chapter đã được xóa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     pages_deleted: { type: integer }
 *                     tasks_deleted: { type: integer }
 *                     notes_deleted: { type: integer }
 *                     layers_deleted: { type: integer }
 *       400:
 *         description: >
 *           Chỉ xóa được chapter ở trạng thái "draft" hoặc "pending_assistant"
 *           VÀ chapter chưa có page nào.
 *           Ví dụ message: "Chỉ xóa được chapter ở trạng thái draft hoặc pending_assistant
 *           (hiện tại: \"submitted_by_assistant\")"
 *           hoặc: "Chỉ xóa được chapter chưa có page nào (hiện tại: 3 page(s))".
 *       403:
 *         description: Không có quyền xóa chapter này
 *       404:
 *         description: Chapter not found
 */
router.delete("/:id", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    // Reserved sub-paths guard
    const reserved = new Set(["my-assignments"]);
    if (reserved.has(req.params.id)) {
      return next();
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid chapter id", 400));
    }

    const chapter = await Chapter.findOne({
      _id: req.params.id,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    const DELETABLE_STATUSES = ["draft", "pending_assistant"];
    if (!DELETABLE_STATUSES.includes(chapter.status)) {
      return next(
        new AppError(
          `Chỉ xóa được chapter ở trạng thái draft hoặc pending_assistant (hiện tại: "${chapter.status}")`,
          400
        )
      );
    }

    // Chapter đã có page (kể cả khi status còn draft/pending_assistant) → KHÔNG cho xóa
    // để tránh mất task / note / layer đã tạo. Cascade bên dưới vẫn chạy đầy đủ.
    const pageCount = await Page.countDocuments({ chapter_id: chapter._id });
    if (pageCount > 0) {
      return next(
        new AppError(
          `Chỉ xóa được chapter chưa có page nào (hiện tại: ${pageCount} page(s))`,
          400
        )
      );
    }

    // ─── Cascade delete ────────────────────────────────────────────────────
    // 1) Lấy tất cả page ids của chapter
    const pageIds = await Page.find({ chapter_id: chapter._id })
      .select("_id")
      .lean();
    const pageIdStrs = pageIds.map((p) => p._id);

    // 2) Xóa tasks (theo chapter_id, tránh ảnh hưởng chapter khác)
    const tasksDeleteResult = await Task.deleteMany({ chapter_id: chapter._id });

    // 3) Xóa notes & layers của các page thuộc chapter (chỉ trong các page này)
    let notesDeleteResult = { deletedCount: 0 };
    let layersDeleteResult = { deletedCount: 0 };
    if (pageIdStrs.length > 0) {
      notesDeleteResult = await PageNote.deleteMany({ page_id: { $in: pageIdStrs } });
      const PageLayer = require("../models/PageLayer");
      layersDeleteResult = await PageLayer.deleteMany({ page_id: { $in: pageIdStrs } });
    }

    // 4) Xóa pages
    const pagesDeleteResult = await Page.deleteMany({ chapter_id: chapter._id });

    // 5) Xóa chapter
    await Chapter.deleteOne({ _id: chapter._id });

    return res.status(200).json({
      success: true,
      message: "Chapter đã được xóa",
      data: {
        id: chapter._id,
        pages_deleted: pagesDeleteResult.deletedCount || 0,
        tasks_deleted: tasksDeleteResult.deletedCount || 0,
        notes_deleted: notesDeleteResult.deletedCount || 0,
        layers_deleted: layersDeleteResult.deletedCount || 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/submit-revision", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    if (req.params.id && typeof req.params.id === "string" && req.params.id.includes(":")) {
      // Prevent route collision with paths that contain colons
    }

    const chapter = await Chapter.findOne({
      _id: req.params.id,
      submitted_by: req.user.nameid,
    });
    if (!chapter) return next(new AppError("Chapter not found or unauthorized", 404));

    // Chỉ cho phép submit-revision khi chapter đang ở trạng thái revision
    const revisionAllowedStatuses = ["revision", "submitted_by_assistant", "in_review"];
    if (!revisionAllowedStatuses.includes(chapter.status)) {
      return next(new AppError(`Không thể submit revision: chapter đang ở trạng thái "${chapter.status}"`, 400));
    }

    const { revision_notes, revision_annotations } = req.body;
    const pages = await Page.find({ chapter_id: chapter._id }).lean();

    // Xác định round mới
    const lastTask = await Task.findOne({ chapter_id: chapter._id })
      .sort({ round: -1 })
      .select("round")
      .lean();
    const nextRound = (lastTask?.round ?? 0) + 1;

    // Mark các task vòng cũ thành inactive
    await Task.updateMany(
      {
        chapter_id: chapter._id,
        is_current_round: true,
        status: { $in: ["pending", "in_progress", "revision"] },
      },
      { $set: { is_current_round: false } }
    );

    // Map page_index → page doc
    const pageIndexMap = {};
    pages.forEach((p, idx) => {
      pageIndexMap[`page_${idx}`] = p;
    });

    const chapterAnnotations = [];
    const createdTasks = [];

    if (revision_annotations && typeof revision_annotations === "object") {
      for (const [pageKey, annotations] of Object.entries(revision_annotations)) {
        const page = pageIndexMap[pageKey];
        if (!page || !Array.isArray(annotations)) continue;

        for (const ann of annotations) {
          if (!ann.text || ann.text.trim() === "") continue;

          const workTypeToErrorType = {
            background: "art", shading: "art", effects: "art",
            details: "art", fill: "art", content: "content",
            dialogue: "dialogue", script: "script", other: "other",
          };

          const chapterAnn = {
            page_id: page._id,
            region: {
              x: Number(ann.x ?? 0),
              y: Number(ann.y ?? 0),
              width: Number(ann.w ?? ann.width ?? 100),
              height: Number(ann.h ?? ann.height ?? 100),
            },
            content: ann.text,
            error_type: ann.error_type || workTypeToErrorType[ann.taskType] || "other",
          };
          chapterAnnotations.push(chapterAnn);

          const assignedTo = ann.assigned_to || chapter.assistant_id || null;
          if (assignedTo) {
            const task = await Task.create({
              page_id: page._id,
              chapter_id: chapter._id,
              assigned_by: req.user.nameid,
              assigned_to: assignedTo,
              work_type: ann.taskType || "other",
              region: { ...chapterAnn.region },
              description: ann.text,
              revision_note: revision_notes || "",
              status: "pending",
              round: nextRound,
              is_current_round: true,
            });
            createdTasks.push(task);
          }
        }
      }
    }

    // Cập nhật chapter
    chapter.status = "pending_assistant";
    if (revision_notes !== undefined) chapter.revision_notes = revision_notes;
    chapter.revision_annotations = chapterAnnotations;
    chapter.revision_source = "Mangaka";
    await chapter.save();

    // Update pages status
    await Page.updateMany(
      { chapter_id: chapter._id },
      { $set: { status: "has_task" } }
    );

    return res.status(200).json({
      success: true,
      message: "Revision submitted to assistant",
      data: {
        chapter_id: chapter._id,
        round: nextRound,
        tasks_created: createdTasks.length,
        revision_annotations: chapterAnnotations,
      },
    });
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
  uploadChapterPage.single("page"),
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

      const uploadResult = req.file; // CloudinaryStorage đã trả kết quả upload sẵn

      // Lấy metadata từ body
      const noteText = (req.body.note || "").trim();
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
        original_image_url: uploadResult.path || uploadResult.secure_url || uploadResult.url || "",
        width: uploadResult.width || uploadResult.metadata?.width || 0,
        height: uploadResult.height || uploadResult.metadata?.height || 0,
        uploaded_by: req.user.nameid,
        // status: chỉ "has_task" nếu có assigned_to, ngược lại dùng default của schema
        ...(assignedTo ? { status: "has_task" } : {}),
      });

      // Tạo PageNote (note + tọa độ) — CHỈ khi user thực sự gửi note hoặc có assigned_to
      // Tránh tạo note placeholder full-page khi user chỉ upload ảnh thuần
      let note = null;
      const hasRealNote = noteText.length > 0 || (assignedTo && String(assignedTo).trim().length > 0);
      if (hasRealNote) {
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
 *                 description: Assistant user ID. Phải có Cooperation đã accepted với Mangaka cho series của chapter (cùng series hoặc cooperation chung).
 *     responses:
 *       200:
 *         description: Gán thành công
 *       400:
 *         description: Thiếu assistant_id / Chapter đã có assistant / assistant_locked_after_sale (chapter đã phát sinh giao dịch mua).
 *       403:
 *         description: Assistant chưa ký hợp đồng hợp tác (assistant_not_in_cooperation)
 *       404:
 *         description: Chapter not found hoặc assistant_not_found
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

    // Quy tắc #8: nếu chapter đã phát sinh giao dịch mua → không cho gán.
    if (await chapterHasPurchases(chapter._id)) {
      return next(
        new AppError(
          "Không thể thay đổi Assistant vì chapter đã phát sinh giao dịch mua",
          400,
          { code: "assistant_locked_after_sale" }
        )
      );
    }

    // Validate đầy đủ theo quy tắc mới (yêu cầu #5 + #6).
    const [asstErr, validatedAssistantId] = await validateAssistantForChapter(
      assistant_id,
      req.user.nameid,
      chapter.series_id
    );
    if (asstErr) return next(asstErr);

    const series = await Series.findById(chapter.series_id).lean();
    const seriesName = series ? series.name : "";

    chapter.assistant_id = validatedAssistantId;
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

    // Lấy các page đã có task vòng hiện tại (tránh tạo trùng khi re-assign)
    const existingTaskPageIds = (
      await Task.find({ chapter_id: chapter._id, assigned_to: assistant_id, is_current_round: true }).distinct("page_id")
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
            round: 1,
            is_current_round: true,
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
          round: 1,
          is_current_round: true,
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
 *         description: Chapter chưa có assistant / assistant_locked_after_sale (chapter đã phát sinh giao dịch mua, không thể gỡ Assistant).
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

    // Quy tắc #8: chapter đã phát sinh giao dịch mua → không cho xóa assistant_id.
    if (await chapterHasPurchases(chapter._id)) {
      return next(
        new AppError(
          "Không thể thay đổi Assistant vì chapter đã phát sinh giao dịch mua",
          400,
          { code: "assistant_locked_after_sale" }
        )
      );
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
 *         description: >
 *           Danh sách chapter kèm số pages, tiến độ tasks, cover_url,
 *           revision_notes, revision_annotations, revision_annotations_by_page
 *           (key page_N: { text, x, y, w, h, error_type }) và notes (đầy đủ fields
 *           từ task.note_ids, có note_kind, revision_round, x, y, w, h, taskType)
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

    // Lấy số pages, tasks, cover và note_ids của current round cho mỗi chapter
    const chapterIds = chapters.map((c) => c._id);
    const [pageCounts, taskStats, firstPages, taskNoteIds] = await Promise.all([
      Page.aggregate([
        { $match: { chapter_id: { $in: chapterIds } } },
        { $group: { _id: "$chapter_id", total: { $sum: 1 } } },
      ]),
      Task.aggregate([
        { $match: { chapter_id: { $in: chapterIds }, is_current_round: true } },
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
      // Lấy page đầu tiên (page_number nhỏ nhất) mỗi chapter để làm cover
      Page.aggregate([
        { $match: { chapter_id: { $in: chapterIds } } },
        { $sort: { page_number: 1 } },
        { $group: { _id: "$chapter_id", firstPageUrl: { $first: "$original_image_url" } } },
      ]),
      // Lấy note_ids từ tasks current round để populate notes cho Assistant
      Task.find({ chapter_id: { $in: chapterIds }, is_current_round: true })
        .select("chapter_id note_ids")
        .lean(),
    ]);

    const pageCountMap = Object.fromEntries(pageCounts.map((p) => [p._id.toString(), p.total]));
    const taskStatMap = Object.fromEntries(taskStats.map((t) => [t._id.toString(), t]));
    const firstPageMap = Object.fromEntries(firstPages.map((p) => [p._id.toString(), p.firstPageUrl]));

    // Build map chapterId → all note_ids from current round tasks
    const noteIdsByChapter = {};
    for (const task of taskNoteIds) {
      const cid = task.chapter_id.toString();
      if (!noteIdsByChapter[cid]) noteIdsByChapter[cid] = [];
      noteIdsByChapter[cid].push(...(task.note_ids || []));
    }

    // Populate notes in 1 batch
    const allNoteIds = [...new Set(Object.values(noteIdsByChapter).flat())];
    const notesMap = {};
    if (allNoteIds.length > 0) {
      const notes = await PageNote.find({ _id: { $in: allNoteIds } })
        .populate("author_id", "username full_name phoneNumber")
        .lean();
      for (const n of notes) {
        notesMap[n._id.toString()] = n;
      }
    }

    // Build page index map (page_id → page_index) cho mỗi chapter
    const allPages = await Page.find({ chapter_id: { $in: chapterIds } })
      .select("_id chapter_id page_number")
      .lean();
    const pageIndexByChapter = {};
    for (const p of allPages) {
      const cid = p.chapter_id.toString();
      if (!pageIndexByChapter[cid]) pageIndexByChapter[cid] = [];
      pageIndexByChapter[cid].push(p);
    }
    for (const cid of Object.keys(pageIndexByChapter)) {
      pageIndexByChapter[cid].sort((a, b) => a.page_number - b.page_number);
    }

    const enriched = chapters.map((c) => {
      const cid = c._id.toString();
      const firstPageUrl = firstPageMap[cid];
      const cover_url =
        c.cover_image_url || firstPageUrl || c.series_id?.cover_image_url || null;
      const noteIds = noteIdsByChapter[cid] || [];
      const populatedNotes = noteIds.map((nid) => notesMap[nid.toString()]).filter(Boolean);

      // Build revision_annotations_by_page (page_N: [...]) từ revision_annotations array
      const pageIndexMap = {};
      (pageIndexByChapter[cid] || []).forEach((p, idx) => {
        pageIndexMap[p._id.toString()] = idx;
      });
      const revision_annotations_by_page = {};
      (c.revision_annotations || []).forEach((ann) => {
        const idx = pageIndexMap[ann.page_id?.toString()];
        if (idx === undefined) return;
        const key = `page_${idx}`;
        if (!revision_annotations_by_page[key]) revision_annotations_by_page[key] = [];
        revision_annotations_by_page[key].push({
          text: ann.content,
          x: ann.region?.x,
          y: ann.region?.y,
          w: ann.region?.width,
          h: ann.region?.height,
          error_type: ann.error_type,
        });
      });

      return {
        ...c,
        page_count: pageCountMap[cid] || 0,
        tasks: taskStatMap[cid] || { total: 0, pending: 0, in_progress: 0, submitted: 0, approved: 0 },
        cover_url,
        revision_notes: c.revision_notes || null,
        revision_annotations: c.revision_annotations || [],
        revision_annotations_by_page,
        notes: populatedNotes,
      };
    });

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
 *               note_kind:
 *                 type: string
 *                 enum: [brief, revision]
 *                 default: brief
 *                 description: Loại note (brief = gửi lần đầu, revision = yêu cầu sửa)
 *               revision_round:
 *                 type: integer
 *                 default: 1
 *                 description: Vòng sửa (tự động tăng nếu không truyền)
 *     responses:
 *       201:
 *         description: Note đã được tạo
 */
router.post("/pages/:id/notes", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { text, x, y, w, h, taskType, note_kind, revision_round } = req.body;
    if (!text || typeof text !== "string" || text.trim() === "") {
      return next(new AppError("text is required", 400));
    }
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

    // Auto-detect revision_round from chapter's latest task round if not provided
    let resolvedRound = revision_round || 1;
    if (note_kind === "revision" && !revision_round) {
      const latestTask = await Task.findOne({ chapter_id: chapter._id })
        .sort({ round: -1 })
        .select("round")
        .lean();
      resolvedRound = (latestTask?.round ?? 0) + 1;
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
      note_kind: note_kind || "brief",
      author_role: "mangaka",
      revision_round: resolvedRound,
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
 *       - in: query
 *         name: note_kind
 *         schema:
 *           type: string
 *           enum: [brief, revision]
 *         description: Lọc theo loại note (brief = gửi lần đầu, revision = yêu cầu sửa)
 *       - in: query
 *         name: revision_round
 *         schema:
 *           type: integer
 *         description: Lọc theo vòng sửa
 *     responses:
 *       200:
 *         description: >
 *           Danh sách note. Response có dạng { data: { page, notes: [{ _id, text, x, y, w, h,
 *           taskType, note_kind, author_role, revision_round, author_id }] } }
 */
router.get("/pages/:id/notes", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { note_kind, revision_round } = req.query;
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

    const noteFilter = { page_id: page._id };
    if (note_kind && ["brief", "revision"].includes(note_kind)) {
      noteFilter.note_kind = note_kind;
    }
    if (revision_round && !isNaN(parseInt(revision_round))) {
      noteFilter.revision_round = parseInt(revision_round);
    }

    const notes = await PageNote.find(noteFilter)
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
    if (!text || typeof text !== "string" || text.trim() === "") {
      return next(new AppError("text is required", 400));
    }
    if ([x, y, w, h].some((v) => v === undefined || v === null)) {
      return next(new AppError("x, y, w, h are required", 400));
    }

    const isClientId = !mongoose.Types.ObjectId.isValid(req.params.noteId);
    if (isClientId) {
      const note = await PageNote.create({
        page_id: req.params.id,
        author_id: req.user.nameid,
        text: text.trim(),
        x,
        y,
        w,
        h,
        taskType: taskType || "other",
        note_kind: "brief",
        author_role: "mangaka",
        revision_round: 1,
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
            final_image_url: imageUrl,
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
        { returnDocument: "after" }
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

// ─── POST /chapters/:chapterId/purchase ─────────────────────────────────────
// Reader mua chapter trả phí bằng Coin (trừ trong ví).
/**
 * @swagger
 * /chapters/{chapterId}/purchase:
 *   post:
 *     summary: (Reader) Mở khóa chapter trả phí bằng Coin
 *     tags: [Chapters]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Mua thành công }
 *       400: { description: Chapter free / không đủ coin / chưa published }
 *       403: { description: Không phải Reader }
 */
router.post(
  "/:chapterId/purchase",
  authMiddleware,
  requireReader,
  async (req, res, next) => {
    try {
      const chapterPurchaseService = require("../services/chapterPurchaseService");
      const result = await chapterPurchaseService.purchaseChapter(
        req.user.nameid,
        req.params.chapterId
      );
      return res.status(200).json({
        success: true,
        message: result.alreadyOwned
          ? "Bạn đã sở hữu chapter này"
          : "Mua chapter thành công",
        data: {
          purchased_chapter: result.purchased,
          already_owned: result.alreadyOwned,
          revenue_count: result.revenue.length,
        },
      });
    } catch (error) {
      if (error instanceof require("../services/chapterPurchaseService").PurchaseError) {
        return next(new AppError(error.message, error.statusCode));
      }
      next(error);
    }
  }
);

// ─── GET /chapters/:chapterId/access ──────────────────────────────────────────
// Reader kiểm tra trạng thái truy cập chapter (đã mua / cần mua / free)
/**
 * @swagger
 * /chapters/{chapterId}/access:
 *   get:
 *     summary: (Reader) Kiểm tra quyền truy cập chapter
 *     tags: [Chapters]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Trạng thái truy cập }
 */
router.get(
  "/:chapterId/access",
  authMiddleware,
  requireReader,
  async (req, res, next) => {
    try {
      const chapter = await Chapter.findById(req.params.chapterId)
        .select("access_type coin_price is_published series_id chapter_number title")
        .lean();
      if (!chapter) return next(new AppError("Chapter not found", 404));

      if (chapter.access_type === "FREE") {
        return res.json({
          success: true,
          data: {
            access_type: "FREE",
            is_unlocked: true,
            needs_purchase: false,
            coin_price: 0,
          },
        });
      }

      // Chapter PAID: kiểm tra đã mua chưa
      const PurchasedChapter = require("../models/PurchasedChapter");
      const purchased = await PurchasedChapter.findOne({
        reader_id: req.user.nameid,
        chapter_id: req.params.chapterId,
      }).lean();

      return res.json({
        success: true,
        data: {
          access_type: "PAID",
          is_unlocked: !!purchased,
          needs_purchase: !purchased,
          coin_price: chapter.coin_price,
          purchased_at: purchased ? purchased.purchased_at : null,
          chapter: {
            _id: chapter._id,
            chapter_number: chapter.chapter_number,
            title: chapter.title,
            series_id: chapter.series_id,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
