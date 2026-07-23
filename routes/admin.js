const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
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
      Series.countDocuments(),
      Chapter.countDocuments(),
      Series.aggregate([{ $group: { _id: null, total: { $sum: "$views_count" } } }]),
      Series.find()
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
    const { q, status, category, age_rating, tag, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (q) filter.name = { $regex: q, $options: "i" };
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (age_rating) filter.age_rating = age_rating;
    if (tag) filter.tags = tag;

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
    const series = await Series.findById(req.params.id)
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
    const series = await Series.findById(req.params.id);
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

    const chapters = await Chapter.find({ series_id: series._id }).select("_id");
    const chapterIds = chapters.map((c) => c._id);

    await Page.deleteMany({ chapter_id: { $in: chapterIds } });
    await Task.deleteMany({ chapter_id: { $in: chapterIds } });
    await Chapter.deleteMany({ series_id: series._id });
    await Vote.deleteMany({ series_id: series._id });
    await Series.findByIdAndDelete(series._id);

    res.json({
      success: true,
      message: "Manga and its chapters deleted",
      data: { id: series._id, title: series.name },
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
    const { page = 1, limit = 20, status, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) filter.name = { $regex: search, $options: "i" };
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
    const chapterIds = (await Chapter.find({ series_id: series._id }).select("_id")).map((c) => c._id);
    await Page.deleteMany({ chapter_id: { $in: chapterIds } });
    await Task.deleteMany({ chapter_id: { $in: chapterIds } });
    await Chapter.deleteMany({ series_id: series._id });
    await Series.findByIdAndDelete(series._id);
    res.json({ success: true, message: "Series and all its chapters deleted", data: { id: series._id, title: series.name } });
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
    const series = await Series.findById(req.params.id);
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
    if (status === "published") chapter.published_at = new Date();
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
          period: "today",
        },
        views_this_week: {
          value: thisWeek.totalViews,
          change: calcChange(thisWeek.totalViews, lastWeek.totalViews),
          period: "weekly",
        },
        votes_this_week: {
          value: thisWeek.totalVotes,
          change: calcChange(thisWeek.totalVotes, lastWeek.totalVotes),
          period: "weekly",
        },
        active_series: {
          value: activeSeries,
          period: "weekly",
        },
        views_this_month: thisMonth.totalViews,
        avg_rating_this_month: Math.round((thisMonth.avgRating || 0) * 10) / 10,
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
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
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
    const { type = "views", period = "weekly", limit = 10, search } = req.query;

    if (!["views", "votes", "rating"].includes(type)) {
      return next(new AppError("type phải là: views, votes, hoặc rating", 400));
    }

    const parsedLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 100);

    if (period === "all") {
      // All-time from Series
      const sortFieldMap = { views: "views_count", votes: "total_votes", rating: "average_score" };
      const sField = sortFieldMap[type];

      let query = { status: "published" };
      if (search) {
        query.name = { $regex: search, $options: "i" };
      }

      const rankings = await Series.find(query)
        .sort({ [sField]: -1 })
        .limit(parsedLimit)
        .select("name cover_image_url genre views_count total_votes average_score status")
        .lean();

      const rankedData = rankings.map((s, idx) => ({
        rank: idx + 1,
        series_id: s._id,
        name: s.name,
        cover_image_url: s.cover_image_url,
        genre: s.genre || [],
        views_count: s.views_count,
        views_monthly: null,
        votes_count: s.total_votes,
        votes_monthly: null,
        average_score: s.average_score,
        status: s.status,
      }));

      return res.json({ success: true, data: rankedData, meta: { type, period, limit: parsedLimit, total: rankedData.length } });
    }

    // From SeriesStats
    const SeriesStats = require("../models/SeriesStats");
    const periodKey = SeriesStats.getPeriodKey(period);
    const monthPeriodKey = SeriesStats.getPeriodKey("monthly");

    const sortFieldMap = { views: "views_count", votes: "votes_count", rating: "average_score" };
    const sField = sortFieldMap[type];

    // Build query
    let matchQuery = { period_type: period, period_key: periodKey };
    let seriesQuery = { status: "published" };
    if (search) {
      seriesQuery.name = { $regex: search, $options: "i" };
    }

    // Get weekly/monthly stats
    const statsQuery = [
      {
        $match: {
          period_type: period === "daily" ? "daily" : period,
          period_key: periodKey,
        },
      },
      { $sort: { [sField]: -1 } },
      { $limit: parsedLimit * 2 }, // Get more to filter by search
    ];

    const stats = await SeriesStats.aggregate(statsQuery);

    // Get series details
    const seriesIds = stats.map((s) => s.series_id);
    const seriesMap = await Series.find({ ...seriesQuery, _id: { $in: seriesIds } })
      .select("name cover_image_url genre status")
      .lean()
      .then((arr) => {
        const map = {};
        arr.forEach((s) => { map[String(s._id)] = s; });
        return map;
      });

    // Get monthly stats for comparison
    const monthlyStats = await SeriesStats.find({
      series_id: { $in: seriesIds },
      period_type: "monthly",
      period_key: monthPeriodKey,
    }).lean();
    const monthlyMap = {};
    monthlyStats.forEach((s) => { monthlyMap[String(s.series_id)] = s; });

    // Build ranked data
    let rankedData = stats
      .map((s, idx) => {
        const series = seriesMap[String(s.series_id)];
        if (!series) return null;
        const monthly = monthlyMap[String(s.series_id)] || {};
        return {
          rank: idx + 1,
          series_id: s.series_id,
          name: series.name,
          cover_image_url: series.cover_image_url,
          genre: series.genre || [],
          views_count: s.views_count,
          views_monthly: period !== "monthly" ? (monthly.views_count || 0) : null,
          votes_count: s.votes_count,
          votes_monthly: period !== "monthly" ? (monthly.votes_count || 0) : null,
          average_score: s.average_score,
          status: series.status,
        };
      })
      .filter(Boolean)
      .slice(0, parsedLimit);

    // Re-rank after filter
    rankedData.forEach((item, idx) => { item.rank = idx + 1; });

    res.json({
      success: true,
      data: rankedData,
      meta: {
        type,
        period,
        period_label: period === "daily" ? "today" : period === "weekly" ? "this_week" : period === "monthly" ? "this_month" : "all_time",
        limit: parsedLimit,
        total: rankedData.length,
      },
    });
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
    const series = await Series.findById(id).select("name cover_image_url").lean();
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
    const seriesStats = await Series.findById(id)
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

module.exports = router;
