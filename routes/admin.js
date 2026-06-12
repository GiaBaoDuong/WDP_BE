const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireAdmin, requireAdminOrEB } = require("../middleware/roles");
const User = require("../models/User");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Notification = require("../models/Notification");
const Vote = require("../models/Vote");
const Task = require("../models/Task");
const Page = require("../models/Page");
const TEReview = require("../models/TEReview");
const EBEvaluation = require("../models/EBEvaluation");
const Cooperation = require("../models/Cooperation");
const CooperationRequest = require("../models/CooperationRequest");

router.use(authMiddleware);
router.use(requireAdmin);

// ─── Dashboard Stats ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/stats:
 *   get:
 *     summary: Lấy thống kê dashboard (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Thống kê hệ thống
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     users: { type: object }
 *                     series: { type: object }
 *                     chapters: { type: object }
 *                     votes: { type: object }
 *                     recentUsers: { type: array }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/stats", async (req, res) => {
  try {
    const [
      totalUsers,
      userByRole,
      totalSeries,
      seriesByStatus,
      totalChapters,
      totalVotes,
      recentUsers,
    ] = await Promise.all([
      User.countDocuments(),
      User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
      Series.countDocuments(),
      Series.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Chapter.countDocuments(),
      require("../models/Vote").countDocuments(),
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── User Management ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: Lấy danh sách users (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *         description: Số trang
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *         description: Số lượng user mỗi trang
 *       - in: query
 *         name: role
 *         schema: { type: string }
 *         description: Filter theo role
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Tìm kiếm theo username, email, full_name
 *     responses:
 *       200:
 *         description: Danh sách users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 pagination: { type: object }
 *                 data: { type: array }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/users", async (req, res) => {
  try {
    const { page = 1, limit = 20, role, search } = req.query;
    const filter = {};

    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { full_name: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [users, total] = await Promise.all([
      User.find(filter).sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)).select("-password"),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: users,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/users/{id}:
 *   get:
 *     summary: Lấy chi tiết user (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: User ID
 *     responses:
 *       200:
 *         description: Chi tiết user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data: { type: object }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: User not found }
 *       500: { description: Server error }
 */
router.get("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const [seriesCount, chapterCount] = await Promise.all([
      Series.countDocuments({ author: user._id }),
      Chapter.countDocuments({ author: user._id }),
    ]);

    res.json({
      success: true,
      data: { ...user.toJSON(), seriesCount, chapterCount },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/users:
 *   post:
 *     summary: Tạo user mới (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, full_name, email, role]
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *               full_name: { type: string }
 *               email: { type: string }
 *               role: { type: string, enum: [Admin, Mangaka, Assistant, Editor, EB, Reader] }
 *     responses:
 *       201:
 *         description: User created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data: { type: object }
 *       400: { description: Missing fields or invalid data }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       409: { description: Username or email already exists }
 *       500: { description: Server error }
 */
router.post("/users", async (req, res) => {
  try {
    const { username, password, full_name, email, role } = req.body;

    if (!username || !password || !full_name || !email || !role) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const validRoles = ["Admin", "Mangaka", "Assistant", "Editor", "EB", "Reader"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${validRoles.join(", ")}` });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }

    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) return res.status(409).json({ success: false, message: "Username or email already exists" });

    const user = await User.create({ username, password, full_name, email, role });

    res.status(201).json({
      success: true,
      message: "User created successfully",
      data: { userId: user._id, username: user.username, role: user.role },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/users/{id}:
 *   patch:
 *     summary: Cập nhật user (Admin only)
 *     tags: [Admin]
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
 *               full_name: { type: string }
 *               email: { type: string }
 *     responses:
 *       200: { description: User updated }
 *       400: { description: Invalid email or email already in use }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: User not found }
 *       500: { description: Server error }
 */
router.patch("/users/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const { full_name, email } = req.body;
    if (full_name) user.full_name = full_name;
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return res.status(400).json({ success: false, message: "Invalid email format" });
      const existing = await User.findOne({ email, _id: { $ne: user._id } });
      if (existing) return res.status(409).json({ success: false, message: "Email already in use" });
      user.email = email;
    }

    await user.save();
    res.json({ success: true, message: "User updated", data: { userId: user._id, role: user.role, email: user.email, full_name: user.full_name } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/users/{id}/role:
 *   patch:
 *     summary: Thay đổi role của user (Admin only)
 *     tags: [Admin]
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
 *             required: [role]
 *             properties:
 *               role: { type: string, enum: [Admin, Mangaka, Assistant, Editor, EB, Reader] }
 *     responses:
 *       200: { description: Role changed }
 *       400: { description: Invalid role or cannot change own role }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: User not found }
 *       500: { description: Server error }
 */
router.patch("/users/:id/role", async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ["Admin", "Mangaka", "Assistant", "Editor", "EB", "Reader"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${validRoles.join(", ")}` });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (user._id.toString() === req.user.nameid) {
      return res.status(400).json({ success: false, message: "Cannot change your own role" });
    }

    const oldRole = user.role;
    user.role = role;
    await user.save();

    await Notification.create({
      user: user._id,
      type: "admin_role_changed",
      message: `Vai trò của bạn đã được thay đổi từ ${oldRole} thành ${role} bởi Admin.`,
      isRead: false,
    });

    res.json({ success: true, message: `Role changed from ${oldRole} to ${role}`, data: { userId: user._id, role: user.role } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/users/{id}:
 *   delete:
 *     summary: Xóa user (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: User deleted }
 *       400: { description: Cannot delete own account }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: User not found }
 *       500: { description: Server error }
 */
router.delete("/users/:id", async (req, res) => {
  try {
    if (req.params.id === req.user.nameid) {
      return res.status(400).json({ success: false, message: "Cannot delete your own account" });
    }

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    res.json({ success: true, message: "User deleted", data: { userId: user._id, username: user.username } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Content Moderation ────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/series:
 *   get:
 *     summary: Lấy danh sách series (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách series }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/series", async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) filter.title = { $regex: search, $options: "i" };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [series, total] = await Promise.all([
      Series.find(filter).populate("author", "username full_name role").sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)),
      Series.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: series,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/series/{id}:
 *   delete:
 *     summary: Xóa series và toàn bộ chapters (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Series deleted }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Series not found }
 *       500: { description: Server error }
 */
router.delete("/series/:id", async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) return res.status(404).json({ success: false, message: "Series not found" });

    await Chapter.deleteMany({ series: series._id });
    await Series.findByIdAndDelete(series._id);

    await Notification.create({
      user: series.author,
      type: "admin_content_removed",
      message: `Series "${series.title}" đã bị xoá bởi Admin.`,
      isRead: false,
    });

    res.json({ success: true, message: "Series and all its chapters deleted", data: { seriesId: series._id, title: series.title } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/chapters:
 *   get:
 *     summary: Lấy danh sách chapters (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách chapters }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/chapters", async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [chapters, total] = await Promise.all([
      Chapter.find(filter)
        .populate("series", "title")
        .populate("author", "username")
        .sort({ created_at: -1 })
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
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/chapters/{id}:
 *   delete:
 *     summary: Xóa chapter (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Chapter deleted }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Chapter not found }
 *       500: { description: Server error }
 */
router.delete("/chapters/:id", async (req, res) => {
  try {
    const chapter = await Chapter.findById(req.params.id);
    if (!chapter) return res.status(404).json({ success: false, message: "Chapter not found" });

    await Chapter.findByIdAndDelete(chapter._id);

    await Notification.create({
      user: chapter.author,
      type: "admin_content_removed",
      message: `Chapter #${chapter.chapter_number} đã bị xoá bởi Admin.`,
      isRead: false,
    });

    res.json({ success: true, message: "Chapter deleted", data: { chapterId: chapter._id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── TE/EB Management ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/te-eb/te:
 *   get:
 *     summary: Lấy danh sách TE (Editor) (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách Editor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count: { type: integer }
 *                 data: { type: array }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/te-eb/te", async (req, res) => {
  try {
    const editors = await User.find({ role: "Editor" }).select("-password").sort({ created_at: 1 });
    res.json({ success: true, count: editors.length, data: editors });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/te-eb/eb:
 *   get:
 *     summary: Lấy danh sách EB (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách EB
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count: { type: integer }
 *                 data: { type: array }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/te-eb/eb", async (req, res) => {
  try {
    const ebs = await User.find({ role: "EB" }).select("-password").sort({ created_at: 1 });
    res.json({ success: true, count: ebs.length, data: ebs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Manga — Series Management ─────────────────────────────────────────────────

/**
 * @swagger
 * /admin/manga/series:
 *   get:
 *     summary: Lấy danh sách series cho admin manga (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách series }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/series", async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) filter.name = { $regex: search, $options: "i" };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [series, total] = await Promise.all([
      Series.find(filter)
        .populate("author_id", "username full_name role")
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Series.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: series,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/series/{id}:
 *   get:
 *     summary: Lấy chi tiết series (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Chi tiết series }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Series not found }
 *       500: { description: Server error }
 */
router.get("/manga/series/:id", async (req, res) => {
  try {
    const series = await Series.findById(req.params.id).populate("author_id", "username full_name role");
    if (!series) return res.status(404).json({ success: false, message: "Series not found" });

    const [chapterCount, voteCount, voteAvg] = await Promise.all([
      Chapter.countDocuments({ series_id: series._id }),
      Vote.countDocuments({ series_id: series._id }),
      Vote.aggregate([{ $match: { series_id: series._id } }, { $group: { _id: null, avg: { $avg: "$score" } } }]),
    ]);

    res.json({
      success: true,
      data: {
        ...series.toJSON(),
        chapterCount,
        voteCount,
        averageScore: voteAvg[0]?.avg || null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/series/{id}/status:
 *   patch:
 *     summary: Thay đổi trạng thái series (Admin only)
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
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [draft, submitted, approved, rejected, published, cancelled] }
 *     responses:
 *       200: { description: Status changed }
 *       400: { description: Invalid status }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Series not found }
 *       500: { description: Server error }
 */
router.patch("/manga/series/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["draft", "submitted", "approved", "rejected", "published", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${validStatuses.join(", ")}` });
    }

    const series = await Series.findById(req.params.id);
    if (!series) return res.status(404).json({ success: false, message: "Series not found" });

    const oldStatus = series.status;
    series.status = status;
    await series.save();

    await Notification.create({
      user_id: series.author_id,
      type: "admin_series_status_changed",
      title: "Series status changed",
      message: `Series "${series.name}" status changed from ${oldStatus} to ${status} by Admin.`,
      isRead: false,
      related_entity_type: "series",
      related_entity_id: series._id,
    });

    res.json({ success: true, message: `Series status changed from ${oldStatus} to ${status}`, data: { seriesId: series._id, status: series.status } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Manga — Chapter Management ───────────────────────────────────────────────

/**
 * @swagger
 * /admin/manga/chapters:
 *   get:
 *     summary: Lấy danh sách chapters (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách chapters }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/chapters", async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [chapters, total] = await Promise.all([
      Chapter.find(filter)
        .populate("series_id", "name")
        .populate("submitted_by", "username")
        .sort({ created_at: -1 })
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
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/chapters/{id}:
 *   get:
 *     summary: Lấy chi tiết chapter kèm pages và tasks (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Chi tiết chapter }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Chapter not found }
 *       500: { description: Server error }
 */
router.get("/manga/chapters/:id", async (req, res) => {
  try {
    const chapter = await Chapter.findById(req.params.id)
      .populate("series_id", "name")
      .populate("submitted_by", "username")
      .populate("assistant_id", "username");

    if (!chapter) return res.status(404).json({ success: false, message: "Chapter not found" });

    const pages = await Page.find({ chapter_id: chapter._id }).populate("uploaded_by", "username");
    const tasks = await Task.find({ chapter_id: chapter._id }).populate("assigned_to", "username").populate("assigned_by", "username");

    res.json({
      success: true,
      data: {
        ...chapter.toJSON(),
        pages,
        tasks,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/chapters/{id}/status:
 *   patch:
 *     summary: Thay đổi trạng thái chapter (Admin only)
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
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [draft, pending_assistant, pending_TE, TE_revision, pending_EB, EB_revision, published] }
 *     responses:
 *       200: { description: Status changed }
 *       400: { description: Invalid status }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Chapter not found }
 *       500: { description: Server error }
 */
router.patch("/manga/chapters/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["draft", "pending_assistant", "pending_TE", "TE_revision", "pending_EB", "EB_revision", "published"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${validStatuses.join(", ")}` });
    }

    const chapter = await Chapter.findById(req.params.id);
    if (!chapter) return res.status(404).json({ success: false, message: "Chapter not found" });

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
      isRead: false,
      related_entity_type: "chapter",
      related_entity_id: chapter._id,
    });

    res.json({ success: true, message: `Chapter status changed from ${oldStatus} to ${status}`, data: { chapterId: chapter._id, status: chapter.status } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Manga — Task Management ────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/manga/tasks:
 *   get:
 *     summary: Lấy danh sách tasks (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách tasks }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/tasks", async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .populate("chapter_id", "chapter_number series_id")
        .populate("page_id", "page_number")
        .populate("assigned_to", "username full_name")
        .populate("assigned_by", "username")
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Task.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: tasks,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/tasks/stats:
 *   get:
 *     summary: Lấy thống kê tasks (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: Thống kê tasks }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/tasks/stats", async (req, res) => {
  try {
    const [total, byStatus, byWorkType, totalEarnings] = await Promise.all([
      Task.countDocuments(),
      Task.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Task.aggregate([{ $group: { _id: "$work_type", count: { $sum: 1 } } }]),
      Task.aggregate([{ $match: { status: { $in: ["approved", "submitted"] } } }, { $group: { _id: null, total: { $sum: "$price" } } }]),
    ]);

    res.json({
      success: true,
      data: {
        total,
        byStatus,
        byWorkType,
        totalEarnings: totalEarnings[0]?.total || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Manga — Vote Management ────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/manga/votes:
 *   get:
 *     summary: Lấy danh sách votes (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: series_id
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách votes }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/votes", async (req, res) => {
  try {
    const { page = 1, limit = 20, series_id } = req.query;
    const filter = {};
    if (series_id) filter.series_id = series_id;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [votes, total] = await Promise.all([
      Vote.find(filter)
        .populate("series_id", "name")
        .populate("reader_id", "username")
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Vote.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: votes,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/votes/{id}:
 *   delete:
 *     summary: Xóa vote (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Vote deleted }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Vote not found }
 *       500: { description: Server error }
 */
router.delete("/manga/votes/:id", async (req, res) => {
  try {
    const vote = await Vote.findByIdAndDelete(req.params.id);
    if (!vote) return res.status(404).json({ success: false, message: "Vote not found" });

    await Series.findByIdAndUpdate(vote.series_id, { $inc: { total_votes: -1 } });

    res.json({ success: true, message: "Vote deleted", data: { voteId: vote._id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Manga — Cooperation Management ─────────────────────────────────────────────

/**
 * @swagger
 * /admin/manga/cooperations:
 *   get:
 *     summary: Lấy danh sách cooperations (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách cooperations }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/cooperations", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [cooperations, total] = await Promise.all([
      Cooperation.find()
        .populate("mangaka_id", "username full_name")
        .populate("assistant_id", "username full_name")
        .populate("series_id", "name")
        .sort({ agreed_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Cooperation.countDocuments(),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: cooperations,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/cooperation-requests:
 *   get:
 *     summary: Lấy danh sách cooperation requests (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách cooperation requests }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/cooperation-requests", async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [requests, total] = await Promise.all([
      CooperationRequest.find(filter)
        .populate("mangaka_id", "username full_name")
        .populate("assistant_id", "username full_name")
        .populate("series_id", "name")
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      CooperationRequest.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: requests,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Manga — TE/EB Review Management ───────────────────────────────────────────

/**
 * @swagger
 * /admin/manga/te-reviews:
 *   get:
 *     summary: Lấy danh sách TE reviews (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: decision
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách TE reviews }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/te-reviews", async (req, res) => {
  try {
    const { page = 1, limit = 20, decision } = req.query;
    const filter = {};
    if (decision) filter.decision = decision;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [reviews, total] = await Promise.all([
      TEReview.find(filter)
        .populate("chapter_id", "chapter_number series_id")
        .populate("reviewed_by", "username")
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      TEReview.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: reviews,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/eb-evaluations:
 *   get:
 *     summary: Lấy danh sách EB evaluations (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: result
 *         schema: { type: string }
 *     responses:
 *       200: { description: Danh sách EB evaluations }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/eb-evaluations", async (req, res) => {
  try {
    const { page = 1, limit = 20, result } = req.query;
    const filter = {};
    if (result) filter.result = result;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [evaluations, total] = await Promise.all([
      EBEvaluation.find(filter)
        .populate("series_id", "name")
        .populate("chapter_id", "chapter_number")
        .populate("evaluated_by", "username")
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      EBEvaluation.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: evaluations,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── Manga — Notification Management ───────────────────────────────────────────

/**
 * @swagger
 * /admin/manga/notifications:
 *   get:
 *     summary: Lấy danh sách notifications (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: is_read
 *         schema: { type: string, enum: [true, false] }
 *     responses:
 *       200: { description: Danh sách notifications }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/manga/notifications", async (req, res) => {
  try {
    const { page = 1, limit = 20, is_read } = req.query;
    const filter = {};
    if (is_read !== undefined) filter.is_read = is_read === "true";

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [notifications, total] = await Promise.all([
      Notification.find(filter)
        .populate("user_id", "username")
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Notification.countDocuments(filter),
    ]);

    res.json({
      success: true,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      data: notifications,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/notifications/{id}:
 *   delete:
 *     summary: Xóa notification (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Notification deleted }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Notification not found }
 *       500: { description: Server error }
 */
router.delete("/manga/notifications/:id", async (req, res) => {
  try {
    const notification = await Notification.findByIdAndDelete(req.params.id);
    if (!notification) return res.status(404).json({ success: false, message: "Notification not found" });
    res.json({ success: true, message: "Notification deleted", data: { notificationId: notification._id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


/**
 * @swagger
 * /admin/manga/notifications/broadcast:
 *   post:
 *     summary: Gửi thông báo broadcast tới tất cả users (Admin only)
 *     tags: [Admin - Manga]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, message]
 *             properties:
 *               title: { type: string }
 *               message: { type: string }
 *     responses:
 *       201: { description: Notifications sent }
 *       400: { description: Title and message are required }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.post("/manga/notifications/broadcast", async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, message: "Title and message are required" });

    const users = await User.find().select("_id");
    const notifications = users.map((u) => ({
      user_id: u._id,
      type: "broadcast",
      title,
      message,
      isRead: false,
    }));

    await Notification.insertMany(notifications);

    res.status(201).json({ success: true, message: `${notifications.length} notifications sent`, data: { count: notifications.length } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── System ────────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/roles:
 *   get:
 *     summary: Lấy thống kê theo role (Admin only)
 *     tags: [Admin]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Thống kê role
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
 *                       _id: { type: string }
 *                       count: { type: integer }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       500: { description: Server error }
 */
router.get("/roles", async (req, res) => {
  try {
    const stats = await User.aggregate([
      { $group: { _id: "$role", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
