const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const { optionalAuth } = require("../middleware/auth");
const { requireMangaka, requireMangakaOrAssistant } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Series = require("../models/Series");
const { GENRES } = require("../models/Series");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const upload = require("../middleware/upload");
const { uploadCover, uploadToCloudinary } = require("../middleware/uploadCoverCloudinary");
const cloudinary = require("../config/cloudinary");

// ─── GET /series ─────────────────────────────────────────────────────────────
// Tất cả series đã publish (Reader thấy)
// Query params: genre, status, sort=average_score|createdAt
/**
 * @swagger
 * /series:
 *   get:
 *     summary: Get all series (filtered by user role)
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: genre
 *         schema:
 *           type: string
 *         description: Filter by genre
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by status (draft, published, etc.)
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           default: createdAt
 *         description: Sort field (average_score, createdAt)
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Items per page
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: List of series
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
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 */
router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const { genre, status, sort = "createdAt", order = "desc", page = 1, limit = 20, publication_status } = req.query;

    const filter = {};
    // Reader chỉ thấy published, Mangaka thấy draft của mình, EB/TE thấy tất cả
    // Anonymous user cũng chỉ thấy published như Reader
    if (!req.user || req.user.role === "Reader") {
      filter.is_public = true;
      filter.status = "published";
      filter.deleted_at = null; // Ẩn series đã bị admin force-delete
    } else if (req.user.role === "Mangaka") {
      filter.author_id = req.user.nameid;
      // Mangaka vẫn thấy series của mình kể cả khi đã admin force-delete
      // (để biết truyện bị ẩn và liên hệ admin)
    }
    // EB/TE thấy tất cả trừ series đã soft-delete (giữ thống nhất với admin list)
    else if (req.user.role === "EB" || req.user.role === "TE") {
      filter.deleted_at = null;
    }
    // Không cần else cho EB/TE vì không có filter (thấy tất cả)
    if (genre) {
      const genres = Array.isArray(genre) ? genre : [genre];
      filter.genre = { $in: genres };
    }
    if (status) filter.status = status;
    if (publication_status) filter.publication_status = publication_status;

    const sortObj = { [sort]: order === "asc" ? 1 : -1 };

    const [series, total] = await Promise.all([
      Series.find(filter)
        .populate("author_id", "username full_name phoneNumber")
        .sort(sortObj)
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Series.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: series,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /series/ranking ─────────────────────────────────────────────────────
/**
 * @swagger
 * /series/ranking:
 *   get:
 *     summary: Get series ranking (top 50 published series)
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *         description: Filter by release period
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: Ranked list of series
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
 *                 warnings:
 *                   type: array
 *                   description: Mangaka warnings for low-ranked series
 *                   items:
 *                     type: object
 *                     properties:
 *                       series_id:
 *                         type: string
 *                       series_name:
 *                         type: string
 *                       rank:
 *                         type: integer
 *                       average_score:
 *                         type: number
 *                       message:
 *                         type: string
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 */
router.get("/ranking", optionalAuth, async (req, res, next) => {
  try {
    const { period } = req.query;
    const filter = { is_public: true, status: "published" };
    if (period) filter.release_period = period;

    const ranking = await Series.find(filter)
      .populate("author_id", "username full_name phoneNumber")
      .sort({ average_score: -1, total_votes: -1 })
      .limit(50)
      .lean();

    // Cảnh báo cho Mangaka có series ranking thấp
    if (req.user && req.user.role === "Mangaka") {
      const mySeries = ranking.filter(
        (s) => s.author_id && s.author_id._id.toString() === req.user.nameid
      );
      const lowRankSeries = mySeries.filter(
        (s, i) => i > 15 || s.average_score < 5
      );
      if (lowRankSeries.length > 0) {
        // Cảnh báo sẽ được gửi qua notification route riêng
        return res.status(200).json({
          success: true,
          data: ranking,
          warnings: lowRankSeries.map((s, i) => ({
            series_id: s._id,
            series_name: s.name,
            rank: i + 1,
            average_score: s.average_score,
            message: `Series "${s.name}" có nguy cơ bị hủy do thứ hạng thấp.`,
          })),
        });
      }
    }

    return res.status(200).json({ success: true, data: ranking });
  } catch (error) {
    next(error);
  }
});

// ─── GET /series/mine ────────────────────────────────────────────────────────
/**
 * @swagger
 * /series/mine:
 *   get:
 *     summary: Get current Mangaka's series
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters: []
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: List of series owned by current Mangaka
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
 *       400:
 *         description: Mangaka role required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get("/mine", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const series = await Series.find({ author_id: req.user.nameid })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: series });
  } catch (error) {
    next(error);
  }
});

// ─── GET /series/:id ─────────────────────────────────────────────────────────
/**
 * @swagger
 * /series/{id}:
 *   get:
 *     summary: Get series details by ID
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: false
 *     responses:
 *       200:
 *         description: Series details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Series not found
 */
router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    const series = await Series.findById(req.params.id)
      .populate("author_id", "username full_name phoneNumber")
      .lean();

    if (!series) {
      return next(new AppError("Series not found", 404));
    }

    // Reader chỉ thấy published, Anonymous cũng chỉ thấy published
    if ((!req.user || req.user.role === "Reader") && series.status !== "published") {
      return next(new AppError("Series not found", 404));
    }

    // Mangaka chỉ thấy series của mình
    if (req.user && req.user.role === "Mangaka" && series.author_id._id.toString() !== req.user.nameid) {
      return next(new AppError("Series not found", 404));
    }

    return res.status(200).json({ success: true, data: series });
  } catch (error) {
    next(error);
  }
});

// ─── POST /series/:id/cover ──────────────────────────────────────────────────
/**
 * @swagger
 * /series/{id}/cover:
 *   post:
 *     summary: Upload series cover image
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - cover
 *             properties:
 *               cover:
 *                 type: string
 *                 format: binary
 *                 description: Cover image file uploaded to Cloudinary
 *     responses:
 *       200:
 *         description: Cover image uploaded successfully
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
 *                     cover_image_url:
 *                       type: string
 *                       description: Secure Cloudinary URL for series cover
 *       400:
 *         description: Bad request - No image uploaded or invalid file
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Not the series owner
 *       404:
 *         description: Series not found
 */
router.post(
  "/:id/cover",
  authMiddleware,
  requireMangaka,
  uploadCover.single("cover"),
  async (req, res, next) => {
    try {
      const series = await Series.findOne({
        _id: req.params.id,
        author_id: req.user.nameid,
      });

      if (!series) {
        return next(new AppError("Series not found or unauthorized", 404));
      }

      if (!req.file) {
        return next(new AppError("No image uploaded", 400));
      }

      const result = await uploadToCloudinary(req.file);
      series.cover_image_url = result.secure_url;
      await series.save();

      return res.status(200).json({
        success: true,
        message: "Cover image uploaded",
        data: { cover_image_url: series.cover_image_url },
      });
    } catch (error) {
      next(error);
    }
  }
);

// ─── POST /series ────────────────────────────────────────────────────────────
/**
 * @swagger
 * /series:
 *   post:
 *     summary: Create a new series (Mangaka only)
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Series name
 *               description:
 *                 type: string
 *                 description: Series description
 *               genre:
 *                 type: string
 *                 description: Series genre
 *               target_audience:
 *                 type: string
 *                 description: Target audience
 *               synopsis:
 *                 type: string
 *                 description: Series synopsis
 *               tags:
 *                 type: array
 *                 items: { type: string }
 *                 description: Danh sách tag (có thể gửi string CSV)
 *               age_rating:
 *                 type: string
 *                 enum: [All ages, Teens 13+, Mature 17+, Adults Only 18+]
 *               cover:
 *                 type: string
 *                 format: binary
 *                 description: Cover image file uploaded to Cloudinary
 *     responses:
 *       201:
 *         description: Series created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       400:
 *         description: Bad request - Missing required fields
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Mangaka role required
 */
router.post(
  "/",
  authMiddleware,
  requireMangaka,
  uploadCover.single("cover"),
  async (req, res, next) => {
    try {
      const { name, description, genre, target_audience, synopsis, tags, age_rating } = req.body;

      if (!name) {
        return next(new AppError("Series name is required", 400));
      }

      if (age_rating !== undefined && age_rating !== "") {
        const validAges = ["All ages", "Teens 13+", "Mature 17+", "Adults Only 18+"];
        if (!validAges.includes(age_rating)) {
          return next(new AppError(`age_rating must be one of: ${validAges.join(", ")}`, 400));
        }
      }

      // Parse genre: nhận mảng hoặc string CSV
      let parsedGenre = [];
      if (genre !== undefined && genre !== "") {
        parsedGenre = Array.isArray(genre)
          ? genre
          : (typeof genre === "string" ? genre.split(",").map((g) => g.trim()) : []);
        const invalid = parsedGenre.filter((g) => !GENRES.includes(g));
        if (invalid.length > 0) {
          return next(new AppError(`Invalid genres: ${invalid.join(", ")}. Valid genres: ${GENRES.join(", ")}`, 400));
        }
      }

      let cover_image_url = "";
      if (req.file) {
        const result = await uploadToCloudinary(req.file);
        cover_image_url = result.secure_url;
      }

      const series = await Series.create({
        name,
        description,
        genre: parsedGenre,
        target_audience,
        synopsis,
        cover_image_url,
        tags: Array.isArray(tags) ? tags : (typeof tags === "string" && tags.length ? tags.split(",").map((t) => t.trim()) : []),
        age_rating: age_rating || "All ages",
        author_id: req.user.nameid,
        status: "draft",
      });

      return res.status(201).json({ success: true, data: series });
    } catch (error) {
      next(error);
    }
  }
);

// ─── PATCH /series/:id ───────────────────────────────────────────────────────
// Mangaka chỉnh sửa series của mình
/**
 * @swagger
 * /series/{id}:
 *   patch:
 *     summary: Update series details (Mangaka only)
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Series name
 *               description:
 *                 type: string
 *                 description: Series description
 *               genre:
 *                 type: string
 *                 description: Series genre
 *               target_audience:
 *                 type: string
 *                 description: Target audience
 *               synopsis:
 *                 type: string
 *                 description: Series synopsis
 *               cover_image_url:
 *                 type: string
 *                 description: Cover image URL
 *     responses:
 *       200:
 *         description: Series updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Not the series owner
 *       404:
 *         description: Series not found
 */
router.patch("/:id", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const series = await Series.findOne({
      _id: req.params.id,
      author_id: req.user.nameid,
    });

    if (!series) {
      return next(new AppError("Series not found or unauthorized", 404));
    }

    const allowedFields = [
      "name", "description", "genre", "target_audience", "synopsis", "cover_image_url",
      "tags", "age_rating",
    ];

    if (req.body.age_rating !== undefined && req.body.age_rating !== "") {
      const validAges = ["All ages", "Teens 13+", "Mature 17+", "Adults Only 18+"];
      if (!validAges.includes(req.body.age_rating)) {
        return next(new AppError(`age_rating must be one of: ${validAges.join(", ")}`, 400));
      }
    }

    const { genre: rawGenre, ...rest } = req.body;

    if (rawGenre !== undefined) {
      let parsedGenre;
      if (rawGenre === "" || rawGenre === null) {
        parsedGenre = [];
      } else {
        parsedGenre = Array.isArray(rawGenre)
          ? rawGenre
          : (typeof rawGenre === "string" ? rawGenre.split(",").map((g) => g.trim()) : []);
        const invalid = parsedGenre.filter((g) => !GENRES.includes(g));
        if (invalid.length > 0) {
          return next(new AppError(`Invalid genres: ${invalid.join(", ")}. Valid genres: ${GENRES.join(", ")}`, 400));
        }
      }
      series.genre = parsedGenre;
    }

    allowedFields.forEach((field) => {
      if (field === "genre") return; // handled above
      if (rest[field] !== undefined) {
        if (field === "tags") {
          series.tags = Array.isArray(rest.tags)
            ? rest.tags
            : (typeof rest.tags === "string" && rest.tags.length
                ? rest.tags.split(",").map((t) => t.trim())
                : []);
        } else {
          series[field] = rest[field];
        }
      }
    });

    await series.save();
    return res.status(200).json({ success: true, data: series });
  } catch (error) {
    next(error);
  }
});

// ─── GET /series/:id/chapters ────────────────────────────────────────────────
// Lấy chapters của 1 series (theo role)
/**
 * @swagger
 * /series/{id}/chapters:
 *   get:
 *     summary: Get chapters for a series
 *     tags: [Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: false
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
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                 seriesName:
 *                   type: string
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Series not found
 */
router.get("/:id/chapters", optionalAuth, async (req, res, next) => {
  try {
    const series = await Series.findById(req.params.id).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const filter = { series_id: req.params.id };
    // Reader và Anonymous chỉ thấy published chapters
    if (!req.user || req.user.role === "Reader") {
      filter.is_published = true;
    }

    const chapters = await Chapter.find(filter)
      .populate("submitted_by", "username full_name phoneNumber")
      .populate("assistant_id", "username full_name phoneNumber")
      .select("+assistant_id")
      .sort({ chapter_number: 1 })
      .lean();

    // Đảm bảo assistant_id luôn có trong kết quả (kể cả khi null)
    chapters.forEach((c) => {
      if (c.assistant_id === undefined) c.assistant_id = null;
    });

    return res.status(200).json({
      success: true,
      data: chapters,
      seriesName: series.name,
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// SERIES END REQUEST (Mangaka gửi yêu cầu kết thúc truyện)
// ════════════════════════════════════════════════════════════════════════════════

const SeriesEndRequest = require("../models/SeriesEndRequest");
const Notification = require("../models/Notification");
const NotificationSubscription = require("../models/NotificationSubscription");
const Cooperation = require("../models/Cooperation");
const User = require("../models/User");
const { NOTIF_TYPES } = require("../utils/constants");

// ─── POST /series/:seriesId/end-request ────────────────────────────────────────
/**
 * @swagger
 * /series/{seriesId}/end-request:
 *   post:
 *     summary: Gửi yêu cầu kết thúc truyện (Mangaka only)
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - planned_final_chapter_number
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Lý do muốn kết thúc truyện (max 1000 ký tự)
 *               planned_final_chapter_number:
 *                 type: integer
 *                 minimum: 1
 *                 description: Chapter cuối dự kiến (bắt buộc)
 *     responses:
 *       201: { description: Yêu cầu đã được gửi }
 *       400: { description: Series không hợp lệ để end }
 *       404: { description: Series not found }
 *       409: { description: Đã có yêu cầu đang chờ duyệt }
 */
router.post("/:seriesId/end-request", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const { reason = "" } = req.body || {};
    const rawFinalChapterNumber = req.body?.planned_final_chapter_number;

    // 1. BẮT BUỘC: phải cung cấp chapter cuối muốn kết thúc
    if (
      rawFinalChapterNumber === undefined ||
      rawFinalChapterNumber === null ||
      rawFinalChapterNumber === ""
    ) {
      return next(
        new AppError("planned_final_chapter_number là bắt buộc. Vui lòng nhập số chapter cuối cùng bạn muốn kết thúc.", 400)
      );
    }

    const plannedFinalChapterNumber = Number(rawFinalChapterNumber);

    // Validate: phải là số dương
    if (!Number.isInteger(plannedFinalChapterNumber) || plannedFinalChapterNumber < 1) {
      return next(
        new AppError("planned_final_chapter_number phải là số nguyên dương (>= 1).", 400)
      );
    }

    // 2. Tìm series — chỉ author mới được gửi yêu cầu cho series của mình
    const series = await Series.findOne({
      _id: seriesId,
      author_id: req.user.nameid,
      deleted_at: null,
    }).lean();
    if (!series) return next(new AppError("Series not found or you are not the author", 404));

    // 2. Chỉ cho phép end khi publication_status đang active
    const allowed = ["upcoming", "ongoing", "hiatus"];
    if (!allowed.includes(series.publication_status)) {
      return next(
        new AppError(
          `Không thể yêu cầu end truyện khi publication_status = "${series.publication_status}". ` +
          `Chỉ áp dụng với: ${allowed.join(", ")}.`,
          400
        )
      );
    }

    // 3. Kiểm tra đã có request pending/approved đang active chưa
    const existing = await SeriesEndRequest.findOne({
      series_id: series._id,
      status: { $in: ["pending", "approved"] },
    });
    if (existing) {
      return next(
        new AppError("Đã có yêu cầu kết thúc truyện đang chờ xử lý hoặc đã được duyệt. Vui lòng chờ chapter chốt được publish hoặc hủy yêu cầu cũ nếu còn pending.", 409)
      );
    }

    // 4. Tạo request
    const endRequest = await SeriesEndRequest.create({
      series_id: series._id,
      requested_by: req.user.nameid,
      reason,
      planned_final_chapter_number: plannedFinalChapterNumber,
      status: "pending",
    });

    // 5. Thông báo cho tất cả Admin
    const admins = await User.find({ role: "Admin" }).select("_id").lean();
    const notifDocs = admins.map((admin) => ({
      user_id: admin._id,
      type: NOTIF_TYPES.SERIES_END_REQUEST_SUBMITTED,
      title: "Yêu cầu kết thúc truyện",
      message: `Mangaka "${req.user.full_name || req.user.username}" yêu cầu kết thúc truyện "${series.name}". Lý do: ${reason || "(không có)"}`,
      is_read: false,
      related_entity_type: "series_end_request",
      related_entity_id: endRequest._id,
      meta: {
        series_id: series._id,
        series_name: series.name,
        requested_by_name: req.user.full_name || req.user.username,
        reason,
      },
    }));
    if (notifDocs.length > 0) await Notification.insertMany(notifDocs);

    res.status(201).json({
      success: true,
      message: "Yêu cầu kết thúc truyện đã được gửi. Admin sẽ xem xét trong 7 ngày.",
      data: {
        id: endRequest._id,
        series_id: endRequest.series_id,
        status: endRequest.status,
        reason: endRequest.reason,
        planned_final_chapter_number: endRequest.planned_final_chapter_number,
        createdAt: endRequest.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /series/end-requests/my ───────────────────────────────────────────────
/**
 * @swagger
 * /series/end-requests/my:
 *   get:
 *     summary: Lấy lịch sử yêu cầu kết thúc truyện của Mangaka hiện tại
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, rejected, cancelled] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách yêu cầu }
 */
router.get("/end-requests/my", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { requested_by: req.user.nameid };
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [requests, total] = await Promise.all([
      SeriesEndRequest.find(filter)
        .populate("series_id", "name cover_image_url publication_status")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      SeriesEndRequest.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: requests.map((r) => ({
        id: r._id,
        series: r.series_id
          ? { id: r.series_id._id, name: r.series_id.name, cover_image_url: r.series_id.cover_image_url }
          : null,
        reason: r.reason,
        planned_final_chapter_number: r.planned_final_chapter_number,
        status: r.status,
        admin_note: r.admin_note || "",
        decided_at: r.decided_at,
        createdAt: r.createdAt,
      })),
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    next(error);
  }
});

// ─── DELETE /series/end-requests/:requestId ────────────────────────────────────
/**
 * @swagger
 * /series/end-requests/{requestId}:
 *   delete:
 *     summary: Hủy yêu cầu kết thúc truyện (chỉ khi pending & là người gửi)
 *     tags: [Series]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Đã hủy }
 *       404: { description: Không tìm thấy }
 *       409: { description: Yêu cầu không ở trạng thái pending }
 */
router.delete("/end-requests/:requestId", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const request = await SeriesEndRequest.findOne({
      _id: req.params.requestId,
      requested_by: req.user.nameid,
    });
    if (!request) return next(new AppError("Yêu cầu không tìm thấy", 404));
    if (request.status !== "pending") {
      return next(new AppError("Chỉ có thể hủy yêu cầu đang ở trạng thái pending", 409));
    }

    request.status = "cancelled";
    await request.save();

    res.json({
      success: true,
      message: "Đã hủy yêu cầu kết thúc truyện",
      data: { id: request._id, status: request.status },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
