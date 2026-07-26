const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const { CHAPTER_STATUS } = require("../utils/constants");
const User = require("../models/User");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const Notification = require("../models/Notification");
const Vote = require("../models/Vote");
const Task = require("../models/Task");
const TEReview = require("../models/TEReview");
const EBEvaluation = require("../models/EBEvaluation");
const Cooperation = require("../models/Cooperation");
const CooperationRequest = require("../models/CooperationRequest");
const Comment = require("../models/Comment");
const upload = require("../middleware/upload");

router.use(authMiddleware);
router.use(requireAdmin);

const getInitials = (name) => {
  if (!name) return "AD";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// ════════════════════════════════════════════════════════════════════════════
// 1. DASHBOARD
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/dashboard:
 *   get:
 *     summary: Lấy dữ liệu dashboard (Admin only)
 *     tags: [Admin - Dashboard]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Dữ liệu dashboard (stats, viewsPerDay, topManga, recentActivity)
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/dashboard", async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const [totalUsers, totalSeries, totalChapters, totalViewsAgg, topManga] = await Promise.all([
      User.countDocuments(),
      Series.countDocuments({ deleted_at: null }),
      Chapter.countDocuments(),
      Series.aggregate([
        { $match: { deleted_at: null } },
        { $group: { _id: null, total: { $sum: "$views_count" } } },
      ]),
      Series.find({ deleted_at: null })
        .sort({ views_count: -1 })
        .limit(5)
        .select("name cover_image_url views_count total_votes")
        .lean(),
    ]);

    const viewsPerDay = await Series.aggregate([
      { $unwind: { path: "$daily_views", preserveNullAndEmptyArrays: false } },
      { $match: { "daily_views.date": { $gte: startDate } } },
      { $group: { _id: "$daily_views.date", views: { $sum: "$daily_views.count" } } },
      { $sort: { _id: 1 } },
    ]);

    const recentActivity = await Notification.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("user_id", "username full_name phoneNumber")
      .lean();

    const formattedActivity = recentActivity.map((n) => ({
      id: n._id,
      type: n.type,
      message: n.title || n.message,
      time: n.createdAt,
    }));

    res.json({
      success: true,
      data: {
        stats: {
          totalViews: totalViewsAgg[0]?.total || 0,
          totalReads: totalChapters,
          totalUsers,
          totalComments: 0,
        },
        viewsPerDay: viewsPerDay.map((v) => ({ date: v._id, views: v.views })),
        topManga: topManga.map((s) => ({
          id: s._id,
          title: s.name,
          views: s.views_count || 0,
          thumbnail: s.cover_image_url || "",
        })),
        recentActivity: formattedActivity,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /admin/stats/genres:
 *   get:
 *     summary: Thống kê số truyện theo thể loại (genre)
 *     tags: [Admin - Stats]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách thể loại và số truyện
 */
router.get("/stats/genres", async (req, res, next) => {
  try {
    const genres = await Series.aggregate([
      { $match: { deleted_at: null, genre: { $exists: true, $ne: [] } } },
      { $unwind: "$genre" },
      { $group: { _id: "$genre", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const formatted = genres.map((g) => ({
      _id: g._id,
      name: g._id,
      count: g.count,
    }));

    res.json({ success: true, data: formatted });
  } catch (error) {
    next(error);
  }
});


// ════════════════════════════════════════════════════════════════════════════
// 2. MANGA (SERIES) — CRUD
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/manga:
 *   get:
 *     summary: Danh sách manga (series) (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Tìm theo tên truyện
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Lọc theo trạng thái
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Lọc theo category
 *       - in: query
 *         name: age_rating
 *         schema:
 *           type: string
 *           enum: [All ages, Teens 13+, Mature 17+, Adults Only 18+]
 *         description: Lọc theo age rating
 *       - in: query
 *         name: tag
 *         schema: { type: string }
 *         description: Lọc theo tag (match exact trong mảng tags)
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Danh sách manga
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       title: { type: string }
 *                       author: { type: string }
 *                       status: { type: string }
 *                       thumbnail: { type: string }
 *                       views: { type: integer }
 *                       category: { type: string }
 *                       tags:
 *                         type: array
 *                         items: { type: string }
 *                       age_rating:
 *                         type: string
 *                         enum: [All ages, Teens 13+, Mature 17+, Adults Only 18+]
 *                       createdAt: { type: string, format: date-time }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga", async (req, res, next) => {
  try {
    const { q, status, category, age_rating, tag, page = 1, limit = 20, include_deleted } = req.query;
    const filter = {};
    if (q) filter.name = { $regex: q, $options: "i" };
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (age_rating) filter.age_rating = age_rating;
    if (tag) filter.tags = tag;
    if (include_deleted !== "true") filter.deleted_at = null;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [data, total] = await Promise.all([
      Series.find(filter)
        .populate("author_id", "username full_name phoneNumber")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Series.countDocuments(filter),
    ]);

    const items = data.map((s) => ({
      id: s._id,
      title: s.name,
      author: s.author_id ? s.author_id.full_name || s.author_id.username : "",
      status: s.status,
      thumbnail: s.cover_image_url || "",
      views: s.views_count || 0,
      category: s.category || "",
      tags: s.tags || [],
      age_rating: s.age_rating || "All ages",
      createdAt: s.createdAt,
    }));

    res.json({
      success: true,
      data: items,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/manga/{id}:
 *   get:
 *     summary: Chi tiết manga (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Chi tiết manga kèm chapters }
 *       404: { description: Manga not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/manga/:id", async (req, res, next) => {
  try {
    const series = await Series.findOne({ _id: req.params.id, deleted_at: null })
      .populate("author_id", "username full_name phoneNumber")
      .lean();

    if (!series) return next(new AppError("Manga not found", 404));

    const chapters = await Chapter.find({ series_id: series._id })
      .select("chapter_number title createdAt")
      .sort({ chapter_number: 1 })
      .lean();

    res.json({
      success: true,
      data: {
        id: series._id,
        title: series.name,
        author: series.author_id ? series.author_id.full_name || series.author_id.username : "",
        description: series.description || series.synopsis || "",
        thumbnail: series.cover_image_url || "",
        status: series.status,
        category: series.category || "",
        tags: series.tags || [],
        age_rating: series.age_rating || "All ages",
        views: series.views_count || 0,
        total_votes: series.total_votes || 0,
        average_score: series.average_score || 0,
        createdAt: series.createdAt,
        chapters: chapters.map((c) => ({
          id: c._id,
          number: c.chapter_number,
          title: c.title || "",
          createdAt: c.createdAt,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/manga:
 *   post:
 *     summary: Tạo manga mới (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title: { type: string }
 *               author: { type: string }
 *               description: { type: string }
 *               thumbnail: { type: string }
 *               category: { type: string }
 *               tags:
 *                 type: array
 *                 items: { type: string }
 *               age_rating:
 *                 type: string
 *                 enum: [All ages, Teens 13+, Mature 17+, Adults Only 18+]
 *     responses:
 *       201: { description: Manga created }
 *       400: { description: Thiếu title }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.post("/manga", async (req, res, next) => {
  try {
    const {
      title,
      author,
      description,
      thumbnail,
      category,
      tags,
      age_rating,
    } = req.body;

    if (!title || !title.trim()) {
      return next(new AppError("title is required", 400));
    }

    let author_id = null;
    if (author) {
      const authorUser = await User.findOne({
        $or: [{ username: author }, { full_name: author }],
        role: "Mangaka",
      }).select("_id");
      if (authorUser) author_id = authorUser._id;
    }

    const series = await Series.create({
      name: title.trim(),
      description: description || "",
      cover_image_url: thumbnail || "",
      category: category || "",
      tags: Array.isArray(tags) ? tags : [],
      age_rating: age_rating || "All ages",
      author_id: author_id || req.user.nameid,
      status: "draft",
    });

    res.status(201).json({
      success: true,
      message: "Manga created",
      data: { id: series._id, title: series.name },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/manga/{id}:
 *   put:
 *     summary: Cập nhật manga (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *               author: { type: string }
 *               description: { type: string }
 *               thumbnail: { type: string }
 *               category: { type: string }
 *               tags:
 *                 type: array
 *                 items: { type: string }
 *               age_rating:
 *                 type: string
 *                 enum: [All ages, Teens 13+, Mature 17+, Adults Only 18+]
 *               status: { type: string }
 *     responses:
 *       200: { description: Manga updated }
 *       404: { description: Manga not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.put("/manga/:id", async (req, res, next) => {
  try {
    const series = await Series.findOne({ _id: req.params.id, deleted_at: null });
    if (!series) return next(new AppError("Manga not found", 404));

    const { title, author, description, thumbnail, category, tags, age_rating, status } = req.body;

    if (title !== undefined) series.name = title;
    if (description !== undefined) series.description = description;
    if (thumbnail !== undefined) series.cover_image_url = thumbnail;
    if (category !== undefined) series.category = category;
    if (tags !== undefined) series.tags = Array.isArray(tags) ? tags : [];
    if (age_rating !== undefined) {
      const validAges = ["All ages", "Teens 13+", "Mature 17+", "Adults Only 18+"];
      if (!validAges.includes(age_rating)) {
        return next(new AppError(`age_rating must be one of: ${validAges.join(", ")}`, 400));
      }
      series.age_rating = age_rating;
    }
    if (status !== undefined) {
      const validStatuses = ["draft", "submitted", "approved", "rejected", "published", "cancelled"];
      if (!validStatuses.includes(status)) {
        return next(new AppError(`status must be one of: ${validStatuses.join(", ")}`, 400));
      }
      series.status = status;
    }
    if (author) {
      const authorUser = await User.findOne({
        $or: [{ username: author }, { full_name: author }],
        role: "Mangaka",
      }).select("_id");
      if (authorUser) series.author_id = authorUser._id;
    }

    await series.save();

    res.json({
      success: true,
      message: "Manga updated",
      data: { id: series._id, title: series.name },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/manga/{id}:
 *   delete:
 *     summary: Xóa manga và toàn bộ chapters (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Manga deleted }
 *       404: { description: Manga not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.delete("/manga/:id", async (req, res, next) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) return next(new AppError("Manga not found", 404));

    // ─── Admin force-delete: KHÔNG giới hạn status ─────────────────────────
    // Admin có thể xóa bất kỳ series nào (kể cả đang published, approved_by_EB,
    // hiatus, ongoing, ...). Lý do: truyện vi phạm bản quyền, bị report nghiêm trọng, ...
    //
    // Hành vi:
    // 1. Series: soft delete (deleted_at + is_public=false + publication_status=dropped)
    // 2. Tất cả Chapter của series: soft delete (deleted_at) — giữ record để audit
    // 3. Tất cả Page + Task của các chapter: HARD DELETE — giải phóng storage
    // 4. Mangaka (author) vẫn thấy series của mình (kể cả đã delete) — xem GET /series và
    //    GET /authors/:authorId/series (filter bypass khi req.user là author).
    // 5. Reader / EB / TE / anonymous → KHÔNG thấy series đã delete.
    if (series.deleted_at) {
      return next(new AppError("Manga already deleted", 410));
    }

    const deletedAt = new Date();

    // 1. Soft delete Series
    series.deleted_at = deletedAt;
    series.is_public = false;
    series.publication_status = "dropped";
    await series.save();

    // 2. Soft delete tất cả chapters của series (giữ record để audit, restore được)
    const chapterUpdate = await Chapter.updateMany(
      { series_id: series._id, deleted_at: null },
      { $set: { deleted_at: deletedAt } }
    );

    // 3. Lấy danh sách chapter IDs (bao gồm cả chapter đã xóa trước đó) để cleanup Page + Task
    const allChapters = await Chapter.find({ series_id: series._id }).select("_id").lean();
    const allChapterIds = allChapters.map((c) => c._id);

    // Hard delete Pages + Tasks của TẤT CẢ chapters (kể cả đã soft-delete từ trước)
    const [pagesResult, tasksResult] = await Promise.all([
      Page.deleteMany({ chapter_id: { $in: allChapterIds } }),
      Task.deleteMany({ chapter_id: { $in: allChapterIds } }),
    ]);

    // 4. Notify author
    try {
      await Notification.create({
        user_id: series.author_id,
        type: "admin_series_force_deleted",
        title: "Truyện đã bị ẩn bởi Admin",
        message: `Series "${series.name}" đã bị Admin ẩn khỏi reader (force delete). ` +
                 `Toàn bộ chapter cũng đã bị ẩn. Liên hệ admin nếu có thắc mắc.`,
        is_read: false,
        related_entity_type: "series",
        related_entity_id: series._id,
      });
    } catch (notifErr) {
      console.error("[admin.deleteManga] notify author failed:", notifErr.message);
    }

    res.json({
      success: true,
      message: "Manga force-deleted (soft delete series + chapters, hard delete pages + tasks)",
      data: {
        id: series._id,
        title: series.name,
        deleted_at: series.deleted_at,
        chapters_soft_deleted: chapterUpdate.modifiedCount,
        pages_hard_deleted: pagesResult.deletedCount,
        tasks_hard_deleted: tasksResult.deletedCount,
      },
    });
  } catch (error) {
    next(error);
  }
});


// ════════════════════════════════════════════════════════════════════════════
// 3. CHAPTERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/manga/{mangaId}/chapters:
 *   get:
 *     summary: Danh sách chapter theo manga (Admin only)
 *     tags: [Admin - Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: mangaId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách chapter }
 *       404: { description: Manga not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/manga/:mangaId/chapters", async (req, res, next) => {
  try {
    const { mangaId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const series = await Series.findById(mangaId).select("_id name").lean();
    if (!series) return next(new AppError("Manga not found", 404));

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [chapters, total, pageCounts] = await Promise.all([
      Chapter.find({ series_id: mangaId })
        .populate("submitted_by", "username full_name phoneNumber")
        .sort({ chapter_number: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Chapter.countDocuments({ series_id: mangaId }),
      Page.aggregate([
        { $match: { chapter_id: { $in: [] } } },
        { $group: { _id: "$chapter_id", count: { $sum: 1 } } },
      ]),
    ]);

    const chapterIds = chapters.map((c) => c._id);
    const counts = await Page.aggregate([
      { $match: { chapter_id: { $in: chapterIds } } },
      { $group: { _id: "$chapter_id", count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(counts.map((p) => [p._id.toString(), p.count]));

    res.json({
      success: true,
      data: chapters.map((c) => ({
        id: c._id,
        number: c.chapter_number,
        title: c.title || "",
        pages: countMap[c._id.toString()] || 0,
        createdBy: c.submitted_by
          ? { id: c.submitted_by._id, name: c.submitted_by.full_name || c.submitted_by.username }
          : null,
        createdAt: c.createdAt,
      })),
      total,
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/chapters:
 *   post:
 *     summary: Tạo chapter mới (Admin only)
 *     tags: [Admin - Chapters]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [mangaId, number]
 *             properties:
 *               mangaId: { type: string }
 *               number: { type: integer }
 *               title: { type: string }
 *               pages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     url: { type: string }
 *     responses:
 *       201: { description: Chapter created }
 *       400: { description: Thiếu mangaId/number hoặc chapter đã tồn tại }
 *       404: { description: Manga not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.post("/chapters", async (req, res, next) => {
  try {
    const { mangaId, number, title, pages = [] } = req.body;

    if (!mangaId || number === undefined) {
      return next(new AppError("mangaId and number are required", 400));
    }

    const series = await Series.findById(mangaId).lean();
    if (!series) return next(new AppError("Manga not found", 404));

    const existing = await Chapter.findOne({ series_id: mangaId, chapter_number: number });
    if (existing) {
      return next(new AppError("Chapter number already exists in this manga", 409));
    }

    const chapter = await Chapter.create({
      series_id: mangaId,
      chapter_number: number,
      title: title || "",
      submitted_by: req.user.nameid,
      status: "draft",
    });

    if (Array.isArray(pages) && pages.length > 0) {
      const pageDocs = pages.map((p, index) => ({
        chapter_id: chapter._id,
        page_number: index + 1,
        original_image_url: p.url || "",
        uploaded_by: req.user.nameid,
        status: "raw",
      }));
      await Page.insertMany(pageDocs);
    }

    res.status(201).json({
      success: true,
      message: "Chapter created",
      data: { id: chapter._id, number: chapter.chapter_number },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/chapters/{id}:
 *   delete:
 *     summary: Xóa chapter (Admin only)
 *     tags: [Admin - Chapters]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Chapter deleted }
 *       404: { description: Chapter not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.delete("/chapters/:id", async (req, res, next) => {
  try {
    const chapter = await Chapter.findById(req.params.id);
    if (!chapter) return next(new AppError("Chapter not found", 404));

    await Page.deleteMany({ chapter_id: chapter._id });
    await Task.deleteMany({ chapter_id: chapter._id });
    await Chapter.findByIdAndDelete(chapter._id);

    res.json({
      success: true,
      message: "Chapter deleted",
      data: { id: chapter._id },
    });
  } catch (error) {
    next(error);
  }
});


// ════════════════════════════════════════════════════════════════════════════
// 4. USERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Danh sách users (Admin only)
 *     tags: [Admin - Users]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Tìm theo username/email/full_name
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách users }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/users", async (req, res, next) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (q) {
      filter.$or = [
        { username: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
        { full_name: { $regex: q, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(filter).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)).select("-password"),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: users.map((u) => ({
        id: u._id,
        name: u.full_name || u.username,
        email: u.email,
        role: u.role,
        status: u.status || "active",
        createdAt: u.created_at,
      })),
      total,
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/users/{id}:
 *   get:
 *     summary: Chi tiết user (Admin only)
 *     tags: [Admin - Users]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Chi tiết user }
 *       404: { description: User not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/users/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return next(new AppError("User not found", 404));

    res.json({
      success: true,
      data: {
        id: user._id,
        name: user.full_name || user.username,
        username: user.username,
        email: user.email,
        phoneNumber: user.phoneNumber || "",
        role: user.role,
        status: user.status || "active",
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/users/{id}/status:
 *   put:
 *     summary: Cập nhật trạng thái user (active/banned) (Admin only)
 *     tags: [Admin - Users]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [active, banned]
 *     responses:
 *       200: { description: User status updated }
 *       400: { description: Invalid status }
 *       404: { description: User not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.put("/users/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["active", "banned"].includes(status)) {
      return next(new AppError("status must be 'active' or 'banned'", 400));
    }

    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError("User not found", 404));

    if (user._id.toString() === req.user.nameid) {
      return next(new AppError("Cannot change your own status", 400));
    }

    user.status = status;
    await user.save();

    await Notification.create({
      user_id: user._id,
      type: status === "banned" ? "admin_user_banned" : "admin_user_unbanned",
      title: "Account status changed",
      message: `Tài khoản của bạn đã được ${status === "banned" ? "khóa" : "mở khóa"} bởi Admin.`,
      is_read: false,
    });

    res.json({
      success: true,
      message: `User status changed to ${status}`,
      data: {
        id: user._id,
        name: user.full_name || user.username,
        email: user.email,
        phoneNumber: user.phoneNumber || "",
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});


// ════════════════════════════════════════════════════════════════════════════
// 5. PROFILE (Admin)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/profile:
 *   get:
 *     summary: Lấy profile admin hiện tại
 *     tags: [Admin - Profile]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: Profile admin }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/profile", async (req, res, next) => {
  try {
    const user = await User.findById(req.user.nameid).select("-password");
    if (!user) return next(new AppError("Admin not found", 404));

    res.json({
      success: true,
      data: {
        id: user._id,
        name: user.full_name || user.username,
        email: user.email,
        phoneNumber: user.phoneNumber || "",
        role: user.role,
        status: user.status || "active",
        initials: getInitials(user.full_name || user.username),
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/profile:
 *   put:
 *     summary: Cập nhật profile admin
 *     tags: [Admin - Profile]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, description: "Full name mới" }
 *               email: { type: string }
 *               phoneNumber: { type: string }
 *     responses:
 *       200: { description: Profile updated }
 *       400: { description: Invalid input }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.put("/profile", async (req, res, next) => {
  try {
    const { name, email, phoneNumber } = req.body;
    const user = await User.findById(req.user.nameid);
    if (!user) return next(new AppError("Admin not found", 404));

    if (name !== undefined) user.full_name = name;
    if (email !== undefined) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return next(new AppError("Invalid email format", 400));
      const existing = await User.findOne({ email, _id: { $ne: user._id } });
      if (existing) return next(new AppError("Email already in use", 409));
      user.email = email;
    }
    if (phoneNumber !== undefined) user.phoneNumber = phoneNumber;

    await user.save();

    res.json({
      success: true,
      message: "Profile updated",
      data: {
        id: user._id,
        name: user.full_name || user.username,
        email: user.email,
        phoneNumber: user.phoneNumber || "",
        role: user.role,
        status: user.status || "active",
        initials: getInitials(user.full_name || user.username),
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});


// ════════════════════════════════════════════════════════════════════════════
// LEGACY APIs (giữ lại cho backward compat)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/stats:
 *   get:
 *     summary: Thống kê tổng quan hệ thống (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: Thống kê tổng quan }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/stats", async (req, res, next) => {
  try {
    const [totalUsers, userByRole, totalSeries, seriesByStatus, totalChapters, totalVotes, recentUsers] = await Promise.all([
      User.countDocuments(),
      User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
      Series.countDocuments(),
      Series.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Chapter.countDocuments(),
      Vote.countDocuments(),
      User.find().sort({ created_at: -1 }).limit(10).select("-password"),
    ]);

    res.json({
      success: true,
      data: {
        users: { total: totalUsers, byRole: userByRole },
        series: { total: totalSeries, byStatus: seriesByStatus },
        chapters: { total: totalChapters },
        votes: { total: totalVotes },
        recentUsers: recentUsers.map((u) => ({
          userId: u._id,
          username: u.username,
          role: u.role,
          createdAt: u.created_at,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/roles:
 *   get:
 *     summary: Thống kê theo role (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: Thống kê role }
 */
router.get("/roles", async (req, res, next) => {
  try {
    const stats = await User.aggregate([
      { $group: { _id: "$role", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});


// ─── Legacy: User CRUD (cho tương thích) ────────────────────────────────────

/**
 * @swagger
 * /admin/users-legacy:
 *   post:
 *     summary: Tạo user mới (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 */
router.post("/users-legacy", async (req, res, next) => {
  try {
    const { username, password, full_name, email, role } = req.body;
    if (!username || !password || !full_name || !email || !role) {
      return next(new AppError("All fields are required", 400));
    }
    const validRoles = ["Admin", "Mangaka", "Assistant", "Editor", "EB", "Reader"];
    if (!validRoles.includes(role)) {
      return next(new AppError(`Role must be one of: ${validRoles.join(", ")}`, 400));
    }
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) return next(new AppError("Username or email already exists", 409));
    const user = await User.create({ username, password, full_name, email, role });
    res.status(201).json({
      success: true,
      message: "User created successfully",
      data: { id: user._id, username: user.username, role: user.role },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/users-legacy/{id}:
 *   patch:
 *     summary: Cập nhật user (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 */
router.patch("/users-legacy/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError("User not found", 404));
    const { full_name, email } = req.body;
    if (full_name) user.full_name = full_name;
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return next(new AppError("Invalid email format", 400));
      const existing = await User.findOne({ email, _id: { $ne: user._id } });
      if (existing) return next(new AppError("Email already in use", 409));
      user.email = email;
    }
    await user.save();
    res.json({ success: true, message: "User updated", data: { id: user._id, role: user.role, email: user.email, full_name: user.full_name } });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/users-legacy/{id}/role:
 *   patch:
 *     summary: Thay đổi role (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 */
router.patch("/users-legacy/:id/role", async (req, res, next) => {
  try {
    const { role } = req.body;
    const validRoles = ["Admin", "Mangaka", "Assistant", "Editor", "EB", "Reader"];
    if (!validRoles.includes(role)) {
      return next(new AppError(`Role must be one of: ${validRoles.join(", ")}`, 400));
    }
    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError("User not found", 404));
    if (user._id.toString() === req.user.nameid) {
      return next(new AppError("Cannot change your own role", 400));
    }
    const oldRole = user.role;
    user.role = role;
    await user.save();
    await Notification.create({
      user_id: user._id,
      type: "admin_role_changed",
      title: "Role changed",
      message: `Vai trò của bạn đã được thay đổi từ ${oldRole} thành ${role} bởi Admin.`,
      is_read: false,
    });
    res.json({ success: true, message: `Role changed from ${oldRole} to ${role}`, data: { id: user._id, role: user.role } });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/users-legacy/{id}:
 *   delete:
 *     summary: Xóa user (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 */
router.delete("/users-legacy/:id", async (req, res, next) => {
  try {
    if (req.params.id === req.user.nameid) {
      return next(new AppError("Cannot delete your own account", 400));
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return next(new AppError("User not found", 404));
    res.json({ success: true, message: "User deleted", data: { id: user._id, username: user.username } });
  } catch (error) {
    next(error);
  }
});


// ─── Legacy: Series / Chapter management ───────────────────────────────────

/**
 * @swagger
 * /admin/series:
 *   get:
 *     summary: Danh sách series (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 */
router.get("/series", async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search, include_deleted } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) filter.name = { $regex: search, $options: "i" };
    if (include_deleted !== "true") filter.deleted_at = null;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [series, total] = await Promise.all([
      Series.find(filter).populate("author_id", "username full_name phoneNumber role").sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Series.countDocuments(filter),
    ]);
    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: series,
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/series/{id}:
 *   delete:
 *     summary: Xóa series (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 */
router.delete("/series/:id", async (req, res, next) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) return next(new AppError("Series not found", 404));

    // Admin force-delete: bỏ giới hạn status (legacy endpoint, cùng logic /manga/:id).
    if (series.deleted_at) {
      return next(new AppError("Series already deleted", 410));
    }

    const deletedAt = new Date();

    series.deleted_at = deletedAt;
    series.is_public = false;
    series.publication_status = "dropped";
    await series.save();

    const chapterUpdate = await Chapter.updateMany(
      { series_id: series._id, deleted_at: null },
      { $set: { deleted_at: deletedAt } }
    );
    const allChapters = await Chapter.find({ series_id: series._id }).select("_id").lean();
    const allChapterIds = allChapters.map((c) => c._id);
    const [pagesResult, tasksResult] = await Promise.all([
      Page.deleteMany({ chapter_id: { $in: allChapterIds } }),
      Task.deleteMany({ chapter_id: { $in: allChapterIds } }),
    ]);

    res.json({
      success: true,
      message: "Series force-deleted (soft delete series + chapters, hard delete pages + tasks)",
      data: {
        id: series._id,
        title: series.name,
        deleted_at: series.deleted_at,
        chapters_soft_deleted: chapterUpdate.modifiedCount,
        pages_hard_deleted: pagesResult.deletedCount,
        tasks_hard_deleted: tasksResult.deletedCount,
      },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/chapters-legacy:
 *   get:
 *     summary: Danh sách chapters (legacy)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 */
router.get("/chapters-legacy", async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [chapters, total] = await Promise.all([
      Chapter.find(filter)
        .populate("series_id", "name")
        .populate("submitted_by", "username full_name phoneNumber")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Chapter.countDocuments(filter),
    ]);
    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: chapters,
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/manga/series/{id}/status:
 *   patch:
 *     summary: Đổi status manga (legacy)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 */
router.patch("/manga/series/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ["draft", "submitted", "approved", "rejected", "published", "cancelled"];
    if (!validStatuses.includes(status)) {
      return next(new AppError(`Status must be one of: ${validStatuses.join(", ")}`, 400));
    }
    const series = await Series.findOne({ _id: req.params.id, deleted_at: null });
    if (!series) return next(new AppError("Series not found", 404));
    const oldStatus = series.status;
    series.status = status;
    await series.save();
    await Notification.create({
      user_id: series.author_id,
      type: "admin_series_status_changed",
      title: "Series status changed",
      message: `Series "${series.name}" status changed from ${oldStatus} to ${status} by Admin.`,
      is_read: false,
      related_entity_type: "series",
      related_entity_id: series._id,
    });
    res.json({ success: true, message: `Series status changed from ${oldStatus} to ${status}`, data: { id: series._id, status: series.status } });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/manga/series/{id}/publication-status:
 *   patch:
 *     summary: Đổi publication_status (hiatus / completed / dropped / upcoming / ongoing)
 *     description: |
 *       Admin chỉnh "trạng thái công bố" (`publication_status`) của series.
 *       Đây là field dùng để hiển thị cho reader (tạm hoãn, hoàn thành, hủy, ...),
 *       KHÁC với `status` (workflow duyệt nội bộ).
 *
 *       **Hợp lệ:** `upcoming | ongoing | hiatus | completed | dropped | null`
 *
 *       **Hành vi đặc biệt:**
 *       - Khi set `hiatus`: chuyển series sang chế độ "tạm hoãn". Job scheduledPublish sẽ tự skip
 *         các chapter `scheduled_publish_at` của series này cho đến khi admin đổi lại status khác.
 *       - Khi set `completed`: đánh dấu series đã hoàn thành (cho phép publish chapter cuối bypass buffer check).
 *       - Khi set `dropped`: tương đương trạng thái bị hủy/bỏ.
 *       - Khi set `ongoing`/`upcoming`/`null`: trở về hoạt động bình thường.
 *
 *       **Khuyến nghị:** Khi set `hiatus`, nên kèm `note` để lưu log lý do.
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publication_status]
 *             properties:
 *               publication_status:
 *                 type: string
 *                 enum: [upcoming, ongoing, hiatus, completed, dropped, null]
 *                 description: null = bỏ publication_status (legacy)
 *               note:
 *                 type: string
 *                 description: Lý do thay đổi (lưu vào notification cho author)
 *     responses:
 *       200:
 *         description: Đổi publication_status thành công
 *       400: { description: publication_status không hợp lệ }
 *       404: { description: Series not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.patch("/manga/series/:id/publication-status", async (req, res, next) => {
  try {
    const { publication_status, note } = req.body;
    const validValues = ["upcoming", "ongoing", "hiatus", "completed", "dropped", null];
    // JSON gửi lên thường không phân biệt null/undefined; chấp nhận cả chuỗi "null" do FE có thể gửi string
    const normalized = publication_status === "null" ? null : publication_status;
    if (!validValues.includes(normalized)) {
      return next(
        new AppError(
          `publication_status phải là một trong: ${validValues.filter((v) => v !== null).join(", ")} hoặc null`,
          400
        )
      );
    }
    const series = await Series.findOne({ _id: req.params.id, deleted_at: null });
    if (!series) return next(new AppError("Series not found", 404));

    const oldPubStatus = series.publication_status;
    series.publication_status = normalized;
    await series.save();

    // Notify author
    const label = normalized ?? "null";
    const VietnameseLabel = {
      upcoming: "sắp ra",
      ongoing: "đang tiến hành",
      hiatus: "tạm hoãn",
      completed: "hoàn thành",
      dropped: "đã hủy",
      null: "(bỏ trống)",
    }[normalized] || label;

    await Notification.create({
      user_id: series.author_id,
      type: "admin_series_publication_status_changed",
      title: "Trạng thái công bố series đã thay đổi",
      message: `Series "${series.name}" đã chuyển sang trạng thái "${VietnameseLabel}"${note ? `. Lý do: ${note}` : ""}.`,
      is_read: false,
      related_entity_type: "series",
      related_entity_id: series._id,
    });

    res.json({
      success: true,
      message: `Series publication_status changed from ${oldPubStatus ?? "null"} to ${label}`,
      data: {
        id: series._id,
        publication_status: series.publication_status,
      },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/manga/chapters/{id}/status:
 *   patch:
 *     summary: Đổi status chapter (legacy)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 */
router.patch("/manga/chapters/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ["draft", "pending_assistant", "pending_TE", "TE_revision", "pending_EB", "EB_revision", "approved_by_EB", "published"];
    if (!validStatuses.includes(status)) {
      return next(new AppError(`Status must be one of: ${validStatuses.join(", ")}`, 400));
    }
    const chapter = await Chapter.findById(req.params.id);
    if (!chapter) return next(new AppError("Chapter not found", 404));
    const oldStatus = chapter.status;
    chapter.status = status;
    chapter.is_published = status === "published";
    if (status === "published") {
      chapter.published_at = new Date();
      await Series.findByIdAndUpdate(chapter.series_id, {
        $set: { last_chapter_published_at: chapter.published_at },
      });
    }
    await chapter.save();
    await Notification.create({
      user_id: chapter.submitted_by,
      type: "admin_chapter_status_changed",
      title: "Chapter status changed",
      message: `Chapter #${chapter.chapter_number} status changed from ${oldStatus} to ${status} by Admin.`,
      is_read: false,
      related_entity_type: "chapter",
      related_entity_id: chapter._id,
    });
    res.json({ success: true, message: `Chapter status changed from ${oldStatus} to ${status}`, data: { id: chapter._id, status: chapter.status } });
  } catch (error) {
    next(error);
  }
});


// ════════════════════════════════════════════════════════════════════════════
// 6. EB REPRESENTATIVE (chỉ định tài khoản đại diện duy nhất của EB)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/eb-representative/candidates:
 *   get:
 *     summary: Danh sách user có role EB (để admin chọn đại diện) (Admin only)
 *     tags: [Admin - EB Representative]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách EB user kèm trạng thái đại diện hiện tại
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/eb-representative/candidates", async (req, res, next) => {
  try {
    const ebs = await User.find({ role: "EB" })
      .select("username full_name email status is_eb_representative")
      .sort({ is_eb_representative: -1, full_name: 1 })
      .lean();

    res.json({
      success: true,
      data: ebs.map((u) => ({
        id: u._id,
        username: u.username,
        name: u.full_name || u.username,
        email: u.email,
        status: u.status || "active",
        is_eb_representative: !!u.is_eb_representative,
      })),
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/eb-representative/{userId}:
 *   patch:
 *     summary: Chỉ định user làm đại diện EB duy nhất (Admin only)
 *     description: |
 *       Tự động bỏ cờ is_eb_representative của mọi EB user khác
 *       rồi set cờ cho user được chỉ định. Chỉ áp dụng với user có role = EB.
 *     tags: [Admin - EB Representative]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Đã set đại diện }
 *       400: { description: User không phải role EB }
 *       404: { description: User not found }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.patch("/eb-representative/:userId", async (req, res, next) => {
  try {
    const target = await User.findById(req.params.userId);
    if (!target) return next(new AppError("User not found", 404));

    if (target.role !== "EB") {
      return next(
        new AppError("Chỉ user có role 'EB' mới được chỉ định làm đại diện", 400)
      );
    }

    if (target.status === "banned") {
      return next(new AppError("User đang bị banned, không thể chỉ định", 400));
    }

    // Bỏ cờ ở tất cả EB user khác
    await User.updateMany(
      { role: "EB", _id: { $ne: target._id } },
      { $set: { is_eb_representative: false } }
    );

    // Set cờ cho user được chỉ định
    target.is_eb_representative = true;
    await target.save();

    // Gửi notification cho user
    await Notification.create({
      user_id: target._id,
      type: "admin_role_changed",
      title: "Bạn đã được chỉ định làm đại diện EB",
      message: "Bạn hiện là tài khoản đại diện duy nhất được phép lưu điểm chấm cho hội đồng EB.",
      is_read: false,
    });

    res.json({
      success: true,
      message: `Đã chỉ định "${target.full_name || target.username}" làm đại diện EB`,
      data: {
        id: target._id,
        username: target.username,
        name: target.full_name || target.username,
        email: target.email,
        role: target.role,
        status: target.status,
        is_eb_representative: true,
      },
    });
  } catch (error) {
    next(error);
  }
});


/**
 * @swagger
 * /admin/eb-representative:
 *   delete:
 *     summary: Bỏ chỉ định đại diện EB hiện tại (Admin only)
 *     tags: [Admin - EB Representative]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: Đã bỏ chỉ định }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.delete("/eb-representative", async (req, res, next) => {
  try {
    const result = await User.updateMany(
      { role: "EB", is_eb_representative: true },
      { $set: { is_eb_representative: false } }
    );

    res.json({
      success: true,
      message: "Đã bỏ chỉ định đại diện EB",
      data: { cleared_count: result.modifiedCount || 0 },
    });
  } catch (error) {
    next(error);
  }
});


router.post("/migrate-chapters-te-id", async (req, res, next) => {
  try {
    const db = mongoose.connection.db;
    const indexes = await db.collection("chapters").indexes();
    const hasTeIdIndex = indexes.some(
      (idx) => idx.key && idx.key.te_id !== undefined,
    );

    if (hasTeIdIndex) {
      return res.json({
        success: true,
        message: "Index on te_id already exists",
        data: { index: "te_id_1", action: "skipped" },
      });
    }

    await db.collection("chapters").createIndex({ te_id: 1 }, { background: true });
    res.json({
      success: true,
      message: "Created index on te_id",
      data: { index: "te_id_1", action: "created" },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// RANKINGS
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/rankings/stats:
 *   get:
 *     summary: Lấy overview stats cho rankings dashboard
 *     tags: [Admin - Rankings]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Stats overview
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 */
router.get("/rankings/stats", async (req, res, next) => {
  try {
    const SeriesStats = require("../models/SeriesStats");
    const now = new Date();

    // Get period keys
    const todayKey = SeriesStats.getPeriodKey("daily", now);
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayKey = SeriesStats.getPeriodKey("daily", yesterdayDate);

    const thisWeekKey = SeriesStats.getPeriodKey("weekly", now);
    const lastWeekDate = new Date(now);
    lastWeekDate.setDate(lastWeekDate.getDate() - 7);
    const lastWeekKey = SeriesStats.getPeriodKey("weekly", lastWeekDate);

    const thisMonthKey = SeriesStats.getPeriodKey("monthly", now);

    // Aggregate stats
    const [todayStats, yesterdayStats, thisWeekStats, lastWeekStats, thisMonthStats, activeSeries] =
      await Promise.all([
        // Today
        SeriesStats.aggregate([
          { $match: { period_type: "daily", period_key: todayKey } },
          { $group: { _id: null, totalViews: { $sum: "$views_count" }, totalVotes: { $sum: "$votes_count" } } },
        ]),
        // Yesterday
        SeriesStats.aggregate([
          { $match: { period_type: "daily", period_key: yesterdayKey } },
          { $group: { _id: null, totalViews: { $sum: "$views_count" }, totalVotes: { $sum: "$votes_count" } } },
        ]),
        // This week
        SeriesStats.aggregate([
          { $match: { period_type: "weekly", period_key: thisWeekKey } },
          { $group: { _id: null, totalViews: { $sum: "$views_count" }, totalVotes: { $sum: "$votes_count" } } },
        ]),
        // Last week
        SeriesStats.aggregate([
          { $match: { period_type: "weekly", period_key: lastWeekKey } },
          { $group: { _id: null, totalViews: { $sum: "$views_count" }, totalVotes: { $sum: "$votes_count" } } },
        ]),
        // This month
        SeriesStats.aggregate([
          { $match: { period_type: "monthly", period_key: thisMonthKey } },
          { $group: { _id: null, totalViews: { $sum: "$views_count" }, totalVotes: { $sum: "$votes_count" }, avgRating: { $avg: "$average_score" } } },
        ]),
        // Active series (has views this week)
        SeriesStats.countDocuments({ period_type: "weekly", period_key: thisWeekKey, views_count: { $gt: 0 } }),
      ]);

    const today = todayStats[0] || { totalViews: 0, totalVotes: 0 };
    const yesterday = yesterdayStats[0] || { totalViews: 0, totalVotes: 0 };
    const thisWeek = thisWeekStats[0] || { totalViews: 0, totalVotes: 0 };
    const lastWeek = lastWeekStats[0] || { totalViews: 0, totalVotes: 0 };
    const thisMonth = thisMonthStats[0] || { totalViews: 0, totalVotes: 0, avgRating: 0 };

    // Calculate % change
    const calcChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    res.json({
      success: true,
      data: {
        views_today: {
          value: today.totalViews,
          change: calcChange(today.totalViews, yesterday.totalViews),
        },
        views_this_week: {
          value: thisWeek.totalViews,
          change: calcChange(thisWeek.totalViews, lastWeek.totalViews),
        },
        votes_this_week: {
          value: thisWeek.totalVotes,
          change: calcChange(thisWeek.totalVotes, lastWeek.totalVotes),
        },
        active_series: {
          value: activeSeries,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /admin/rankings/list:
 *   get:
 *     summary: Lấy danh sách rankings
 *     tags: [Admin - Rankings]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [views, votes, rating]
 *         required: true
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [daily, weekly, monthly, all]
 *         default: weekly
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Rankings list
 *       400:
 *         description: Thiếu type
 */
router.get("/rankings/list", async (req, res, next) => {
  try {
    const { type = "views", period = "weekly", page = 1, limit = 100, search } = req.query;

    if (!["views", "votes", "rating"].includes(type)) {
      return next(new AppError("type phải là: views, votes, hoặc rating", 400));
    }

    const parsedPage = Math.max(parseInt(page) || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 100, 1), 100);
    const skip = (parsedPage - 1) * parsedLimit;

    if (period === "all") {
      const sortFieldMap = { views: "views_count", votes: "total_votes", rating: "average_score" };
      const sField = sortFieldMap[type];

      let query = { status: "published", deleted_at: null };
      if (search) {
        query.name = { $regex: search, $options: "i" };
      }

      const total = await Series.countDocuments(query);

      const rankings = await Series.find(query)
        .populate("author_id", "full_name")
        .sort({ [sField]: -1 })
        .skip(skip)
        .limit(parsedLimit)
        .select("name cover_image_url genre views_count total_votes average_score status author_id")
        .lean();

      const rankedData = rankings.map((s, idx) => ({
        id: s._id,
        _id: s._id,
        name: s.name,
        title: s.name,
        author: s.author_id?.full_name || "",
        cover_image_url: s.cover_image_url,
        rank: skip + idx + 1,
        views_today: 0,
        views_count: s.views_count,
        views_monthly: 0,
        views_total: s.views_count,
        votes_today: 0,
        votes_count: s.total_votes,
        votes_monthly: 0,
        votes_total: s.total_votes,
        average_score: s.average_score,
        total_votes: s.total_votes,
      }));

      return res.json({ success: true, data: { items: rankedData, total } });
    }

    // From SeriesStats
    const SeriesStats = require("../models/SeriesStats");
    const periodKey = SeriesStats.getPeriodKey(period);
    const monthPeriodKey = SeriesStats.getPeriodKey("monthly");
    const todayPeriodKey = SeriesStats.getPeriodKey("daily");

    const sortFieldMap = { views: "views_count", votes: "votes_count", rating: "average_score" };
    const sField = sortFieldMap[type];

    let seriesQuery = { status: "published", deleted_at: null };
    if (search) {
      seriesQuery.name = { $regex: search, $options: "i" };
    }

    // Get period stats
    const periodType = period === "daily" ? "daily" : period;
    const stats = await SeriesStats.aggregate([
      { $match: { period_type: periodType, period_key: periodKey } },
      { $sort: { [sField]: -1 } },
      { $facet: {
        metadata: [{ $count: "total" }],
        data: [{ $skip: skip }, { $limit: parsedLimit }],
      }},
    ]);

    const total = stats[0]?.metadata[0]?.total || 0;
    const statsData = stats[0]?.data || [];

    // Get series details
    const seriesIds = statsData.map((s) => s.series_id);
    const seriesMap = await Series.find({ ...seriesQuery, _id: { $in: seriesIds } })
      .populate("author_id", "full_name")
      .select("name cover_image_url genre status author_id")
      .lean()
      .then((arr) => {
        const map = {};
        arr.forEach((s) => { map[String(s._id)] = s; });
        return map;
      });

    // Get monthly & daily stats
    const [monthlyStats, dailyStats] = await Promise.all([
      SeriesStats.find({ series_id: { $in: seriesIds }, period_type: "monthly", period_key: monthPeriodKey }).lean(),
      SeriesStats.find({ series_id: { $in: seriesIds }, period_type: "daily", period_key: todayPeriodKey }).lean(),
    ]);

    const monthlyMap = {};
    monthlyStats.forEach((s) => { monthlyMap[String(s.series_id)] = s; });

    const dailyMap = {};
    dailyStats.forEach((s) => { dailyMap[String(s.series_id)] = s; });

    // Get total views/votes from Series
    const seriesTotals = await Series.find({ _id: { $in: seriesIds } })
      .select("_id views_count total_votes")
      .lean()
      .then((arr) => {
        const map = {};
        arr.forEach((s) => { map[String(s._id)] = s; });
        return map;
      });

    // Build ranked data
    const rankedData = statsData
      .map((s) => {
        const series = seriesMap[String(s.series_id)];
        if (!series) return null;
        const monthly = monthlyMap[String(s.series_id)] || {};
        const daily = dailyMap[String(s.series_id)] || {};
        const totals = seriesTotals[String(s.series_id)] || {};

        return {
          id: s.series_id,
          _id: s.series_id,
          name: series.name,
          title: series.name,
          author: series.author_id?.full_name || "",
          cover_image_url: series.cover_image_url,
          rank: 0,
          views_today: daily.views_count || 0,
          views_count: s.views_count,
          views_monthly: period !== "monthly" ? (monthly.views_count || 0) : s.views_count,
          views_total: totals.views_count || 0,
          votes_today: daily.votes_count || 0,
          votes_count: s.votes_count,
          votes_monthly: period !== "monthly" ? (monthly.votes_count || 0) : s.votes_count,
          votes_total: totals.total_votes || 0,
          average_score: s.average_score,
          total_votes: totals.total_votes || 0,
        };
      })
      .filter(Boolean);

    // Re-rank
    rankedData.forEach((item, idx) => { item.rank = skip + idx + 1; });

    res.json({ success: true, data: { items: rankedData, total } });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /admin/rankings/series/:id:
 *   get:
 *     summary: Chi tiết stats của 1 series (trend + top chapters)
 *     tags: [Admin - Rankings]
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
 *         description: Series stats detail
 *       404:
 *         description: Series not found
 */
router.get("/rankings/series/:id", async (req, res, next) => {
  try {
    const SeriesStats = require("../models/SeriesStats");
    const { id } = req.params;

    // Check series exists
    const series = await Series.findOne({ _id: id, deleted_at: null }).select("name cover_image_url").lean();
    if (!series) {
      return next(new AppError("Series not found", 404));
    }

    // Get daily trend (7 days)
    const now = new Date();
    const dailyTrends = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = SeriesStats.getPeriodKey("daily", d);
      const stat = await SeriesStats.findOne({
        series_id: id,
        period_type: "daily",
        period_key: key,
      }).lean();
      dailyTrends.push({
        date: key,
        views_count: stat ? stat.views_count : 0,
        votes_count: stat ? stat.votes_count : 0,
      });
    }

    // Get weekly trend (4 weeks)
    const weeklyTrends = [];
    for (let i = 3; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      const key = SeriesStats.getPeriodKey("weekly", d);
      const stat = await SeriesStats.findOne({
        series_id: id,
        period_type: "weekly",
        period_key: key,
      }).lean();
      weeklyTrends.push({
        week: key,
        views_count: stat ? stat.views_count : 0,
        votes_count: stat ? stat.votes_count : 0,
      });
    }

    // Get top 3 chapters by views
    const topChapters = await Chapter.find({ series_id: id, is_published: true })
      .sort({ views_count: -1 })
      .limit(3)
      .select("chapter_number title views_count")
      .lean();

    // Get series totals
    const seriesStats = await Series.findOne({ _id: id, deleted_at: null })
      .select("views_count total_votes average_score")
      .lean();

    res.json({
      success: true,
      data: {
        series: {
          _id: series._id,
          name: series.name,
          cover_image_url: series.cover_image_url,
          views_count: seriesStats.views_count,
          total_votes: seriesStats.total_votes,
          average_score: seriesStats.average_score,
        },
        trends: {
          daily: dailyTrends,
          weekly: weeklyTrends,
        },
        top_chapters: topChapters.map((c) => ({
          chapter_number: c.chapter_number,
          title: c.title || `Chapter ${c.chapter_number}`,
          views_count: c.views_count,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /admin/manga/{id}/comments:
 *   get:
 *     summary: Lấy danh sách bình luận của series (admin)
 *     tags: [Admin - Comments]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
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
 *         description: Danh sách bình luận
 *       404:
 *         description: Series không tìm thấy
 */
router.get("/manga/:id/comments", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const series = await Series.findOne({ _id: id, deleted_at: null }).select("_id").lean();
    if (!series) {
      return next(new AppError("Series not found", 404));
    }

    const [comments, total] = await Promise.all([
      Comment.find({ series_id: id, parent_id: null })
        .populate("reader_id", "username full_name avatar_url")
        .sort({ created_at: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Comment.countDocuments({ series_id: id, parent_id: null }),
    ]);

    const commentIds = comments.map((c) => c._id);
    const replyCounts = await Comment.aggregate([
      { $match: { parent_id: { $in: commentIds } } },
      { $group: { _id: "$parent_id", count: { $sum: 1 } } },
    ]);
    const replyCountMap = new Map(replyCounts.map((r) => [String(r._id), r.count]));

    const enrichedComments = comments.map((c) => ({
      id: c._id,
      user: {
        name: c.reader_id?.full_name || c.reader_id?.username || "Unknown",
        avatar_url: c.reader_id?.avatar_url || null,
      },
      content: c.content,
      createdAt: c.created_at,
      reply_count: replyCountMap.get(String(c._id)) || 0,
    }));

    return res.json({
      success: true,
      data: enrichedComments,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /admin/comments/{id}:
 *   delete:
 *     summary: Xoá bình luận (admin)
 *     tags: [Admin - Comments]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Comment ID
 *     responses:
 *       200:
 *         description: Xoá thành công
 *       404:
 *         description: Không tìm thấy bình luận
 */
router.delete("/comments/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const comment = await Comment.findById(id);
    if (!comment) {
      return next(new AppError("Comment not found", 404));
    }

    await Comment.deleteMany({
      $or: [{ _id: id }, { parent_id: id }],
    });

    return res.json({
      success: true,
      message: "Comment deleted successfully",
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PUBLICATION CALENDAR (Admin overview toàn hệ thống)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /admin/publication-calendar:
 *   get:
 *     summary: Lịch xuất bản toàn hệ thống (Admin only)
 *     tags: [Admin - Calendar]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date }
 *         description: Ngày bắt đầu (mặc định = hôm nay)
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date }
 *         description: Ngày kết thúc (mặc định = hôm nay + 30 ngày)
 *       - in: query
 *         name: schedule
 *         schema: { type: string, enum: [weekly, monthly] }
 *         description: Lọc theo tần suất (chỉ áp dụng cho chapter)
 *     responses:
 *       200:
 *         description: Calendar kèm stats tổng quan
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     range: { type: object }
 *                     overview:
 *                       type: object
 *                       properties:
 *                         total_series: { type: number }
 *                         total_chapters_published: { type: number }
 *                         chapters_scheduled_in_range: { type: number }
 *                         series_launches_in_range: { type: number }
 *                         series_by_status: { type: object }
 *                         series_by_publication_status: { type: object }
 *                     upcoming_series:
 *                       type: array
 *                       description: Series sắp publish (status=approved_by_EB, scheduled_publish_at trong range)
 *                     upcoming_chapters:
 *                       type: array
 *                       description: Chapter sắp publish (sort theo scheduled_publish_at)
 *                     days:
 *                       type: array
 */
router.get("/publication-calendar", async (req, res, next) => {
  try {
    const { from_date, to_date, schedule } = req.query;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const defaultTo = new Date(today);
    defaultTo.setDate(defaultTo.getDate() + 30);
    defaultTo.setHours(23, 59, 59, 999);

    const fromDate = from_date ? new Date(from_date) : today;
    const toDate = to_date ? new Date(to_date) : defaultTo;
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return next(new AppError("from_date / to_date không hợp lệ", 400));
    }
    if (fromDate > toDate) {
      return next(new AppError("from_date phải nhỏ hơn hoặc bằng to_date", 400));
    }
    const fromStart = new Date(fromDate);
    fromStart.setHours(0, 0, 0, 0);
    const toEnd = new Date(toDate);
    toEnd.setHours(23, 59, 59, 999);

    // ═── 1. Tổng quan hệ thống (Promise.all cho nhanh) ────────────────────────
    const [
      totalSeries,
      totalChaptersPublished,
      chaptersInRange,
      seriesInRange,
      seriesByStatusAgg,
      seriesByPubStatusAgg,
    ] = await Promise.all([
      Series.countDocuments({ deleted_at: null }),
      Chapter.countDocuments({ is_published: true }),
      Chapter.countDocuments({
        is_scheduled: true,
        status: CHAPTER_STATUS.APPROVED_BY_EB,
        scheduled_publish_at: { $gte: fromStart, $lte: toEnd },
      }),
      Series.countDocuments({
        scheduled_publish_at: { $gte: fromStart, $lte: toEnd, $ne: null },
        deleted_at: null,
      }),
      Series.aggregate([
        { $match: { deleted_at: null } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Series.aggregate([
        { $match: { deleted_at: null } },
        { $group: { _id: "$publication_status", count: { $sum: 1 } } },
      ]),
    ]);

    const seriesByStatus = {};
    seriesByStatusAgg.forEach((row) => {
      seriesByStatus[row._id || "unknown"] = row.count;
    });
    const seriesByPublicationStatus = {};
    seriesByPubStatusAgg.forEach((row) => {
      seriesByPublicationStatus[row._id || "unknown"] = row.count;
    });

    // ═── 2. Series sắp publish (ngày ra mắt) ────────────────────────────────
    const upcomingSeries = await Series.find({
      deleted_at: null,
      scheduled_publish_at: { $gte: fromStart, $lte: toEnd, $ne: null },
    })
      .populate("author_id", "username full_name")
      .select("_id name cover_image_url status publication_schedule publication_status scheduled_publish_at author_id")
      .sort({ scheduled_publish_at: 1 })
      .lean();

    // ═── 3. Chapter sắp publish (full list) ─────────────────────────────────
    const chapterFilter = {
      is_scheduled: true,
      status: CHAPTER_STATUS.APPROVED_BY_EB,
      scheduled_publish_at: { $gte: fromStart, $lte: toEnd },
    };
    if (schedule && ["weekly", "monthly"].includes(schedule)) {
      chapterFilter.publication_schedule = schedule;
    }

    const upcomingChapters = await Chapter.find(chapterFilter)
      .populate("series_id", "name cover_image_url status publication_schedule publication_status author_id")
      .populate("series_id.author_id", "username full_name")
      .populate("te_id", "username full_name")
      .populate("submitted_by", "username full_name")
      .sort({ scheduled_publish_at: 1, chapter_number: 1 })
      .lean();

    // ═── 4. Calendar theo ngày (gom tất cả) ─────────────────────────────────
    const daysMap = {};
    const toYMD = (d) => {
      const dt = new Date(d);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    };
    const weekdayLabels = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
    const ensureDay = (d) => {
      const key = toYMD(d);
      if (!daysMap[key]) {
        const dt = new Date(d);
        daysMap[key] = {
          date: key,
          weekday: weekdayLabels[dt.getDay()],
          series_launches: [],
          chapters: [],
        };
      }
      return daysMap[key];
    };

    upcomingSeries.forEach((s) => {
      if (!s.scheduled_publish_at) return;
      ensureDay(s.scheduled_publish_at).series_launches.push({
        _id: s._id,
        name: s.name,
        cover_image_url: s.cover_image_url,
        status: s.status,
        publication_schedule: s.publication_schedule,
        publication_status: s.publication_status,
        scheduled_publish_at: s.scheduled_publish_at,
        author: s.author_id,
      });
    });

    upcomingChapters.forEach((ch) => {
      if (!ch.scheduled_publish_at) return;
      ensureDay(ch.scheduled_publish_at).chapters.push({
        _id: ch._id,
        chapter_number: ch.chapter_number,
        title: ch.title,
        status: ch.status,
        scheduled_publish_at: ch.scheduled_publish_at,
        publication_schedule: ch.publication_schedule,
        te: ch.te_id,
        submitted_by: ch.submitted_by,
        series: ch.series_id
          ? {
              _id: ch.series_id._id,
              name: ch.series_id.name,
              cover_image_url: ch.series_id.cover_image_url,
              status: ch.series_id.status,
              publication_schedule: ch.series_id.publication_schedule,
              publication_status: ch.series_id.publication_status,
              author: ch.series_id.author_id,
            }
          : null,
      });
    });

    // Trải ngày liên tục để FE dễ render
    const days = [];
    const cursor = new Date(fromStart);
    while (cursor <= toEnd) {
      const key = toYMD(cursor);
      if (daysMap[key]) {
        daysMap[key].chapters.sort((a, b) => {
          const as = a.series?.name || "";
          const bs = b.series?.name || "";
          if (as !== bs) return as.localeCompare(bs);
          return (a.chapter_number || 0) - (b.chapter_number || 0);
        });
        days.push(daysMap[key]);
      } else {
        days.push({
          date: key,
          weekday: weekdayLabels[cursor.getDay()],
          series_launches: [],
          chapters: [],
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return res.status(200).json({
      success: true,
      data: {
        range: {
          from_date: toYMD(fromStart),
          to_date: toYMD(toEnd),
          total_days: days.length,
        },
        overview: {
          total_series: totalSeries,
          total_chapters_published: totalChaptersPublished,
          chapters_scheduled_in_range: chaptersInRange,
          series_launches_in_range: seriesInRange,
          series_by_status: seriesByStatus,
          series_by_publication_status: seriesByPublicationStatus,
        },
        upcoming_series: upcomingSeries,
        upcoming_chapters: upcomingChapters,
        days,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
