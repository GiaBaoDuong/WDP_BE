const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireAdmin, requireAdminOrEB } = require("../middleware/roles");
const User = require("../models/User");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Notification = require("../models/Notification");

router.use(authMiddleware);
router.use(requireAdmin);

// ─── Dashboard Stats ───────────────────────────────────────────────────────────

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

// ─── Nations Management ────────────────────────────────────────────────────────

router.get("/nations", async (req, res) => {
  try {
    const Nation = require("../models/Nations");
    const nations = await Nation.find().sort({ nationName: 1 });
    res.json({ success: true, count: nations.length, data: nations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/nations", async (req, res) => {
  try {
    const Nation = require("../models/Nations");
    const { nationName, continent } = req.body;
    if (!nationName || !continent) return res.status(400).json({ success: false, message: "nationName and continent required" });

    const existing = await Nation.findOne({ nationName });
    if (existing) return res.status(409).json({ success: false, message: "Nation already exists" });

    const nation = await Nation.create({ nationName, continent });
    res.status(201).json({ success: true, message: "Nation created", data: nation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put("/nations/:id", async (req, res) => {
  try {
    const Nation = require("../models/Nations");
    const nation = await Nation.findById(req.params.id);
    if (!nation) return res.status(404).json({ success: false, message: "Nation not found" });

    const { nationName, continent } = req.body;
    if (nationName) nation.nationName = nationName;
    if (continent) nation.continent = continent;
    await nation.save();

    res.json({ success: true, message: "Nation updated", data: nation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete("/nations/:id", async (req, res) => {
  try {
    const Nation = require("../models/Nations");
    const nation = await Nation.findByIdAndDelete(req.params.id);
    if (!nation) return res.status(404).json({ success: false, message: "Nation not found" });
    res.json({ success: true, message: "Nation deleted", data: { nationId: nation._id, nationName: nation.nationName } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── TE/EB Management ──────────────────────────────────────────────────────────

router.get("/te-eb/te", async (req, res) => {
  try {
    const editors = await User.find({ role: "Editor" }).select("-password").sort({ created_at: 1 });
    res.json({ success: true, count: editors.length, data: editors });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/te-eb/eb", async (req, res) => {
  try {
    const ebs = await User.find({ role: "EB" }).select("-password").sort({ created_at: 1 });
    res.json({ success: true, count: ebs.length, data: ebs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── System ────────────────────────────────────────────────────────────────────

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
