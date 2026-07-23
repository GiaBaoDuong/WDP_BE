const express = require("express");
const router = express.Router();
const multer = require("multer");
const { authMiddleware } = require("../middleware/auth");
const { requireMangaka } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const User = require("../models/User");
const Series = require("../models/Series");
const cloudinary = require("cloudinary").v2;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ════════════════════════════════════════════════════════════════════════════
// GET /mangaka/profile - Lấy thông tin profile của mangaka đang đăng nhập
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /mangaka/profile:
 *   get:
 *     summary: Lấy thông tin profile của mangaka đang đăng nhập
 *     tags: [Mangaka - Profile]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Thông tin profile mangaka
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Không phải mangaka
 */
router.get("/profile", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId).select("-password -otp -otp_expires").lean();

    if (!user) {
      return next(new AppError("Không tìm thấy người dùng", 404));
    }

    // Lấy thêm stats
    const seriesCount = await Series.countDocuments({ author_id: userId });
    const publishedCount = await Series.countDocuments({ author_id: userId, status: "published" });
    const draftCount = await Series.countDocuments({ author_id: userId, status: "draft" });

    // Lấy danh sách series của mangaka
    const series = await Series.find({ author_id: userId })
      .select("name cover_image_url status genre views_count total_votes average_score chapter_count createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      success: true,
      data: {
        user: {
          _id: user._id,
          username: user.username,
          full_name: user.full_name,
          email: user.email,
          avatar_url: user.avatar_url || null,
          bio: user.bio || "",
          role: user.role,
          createdAt: user.created_at,
        },
        stats: {
          total_series: seriesCount,
          published: publishedCount,
          drafts: draftCount,
        },
        series: series,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PUT /mangaka/profile - Cập nhật thông tin profile
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /mangaka/profile:
 *   put:
 *     summary: Cập nhật thông tin profile mangaka
 *     tags: [Mangaka - Profile]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name:
 *                 type: string
 *               bio:
 *                 type: string
 *               avatar_base64:
 *                 type: string
 *                 description: Base64 encoded image (optional)
 *     responses:
 *       200:
 *         description: Cập nhật thành công
 *       400:
 *         description: Dữ liệu không hợp lệ
 */
router.put("/profile", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { full_name, bio, avatar_base64 } = req.body;

    const updateData = {};

    // Validate full_name
    if (full_name !== undefined) {
      if (typeof full_name !== "string" || full_name.trim().length < 2 || full_name.trim().length > 100) {
        return next(new AppError("Tên phải từ 2-100 ký tự", 400));
      }
      updateData.full_name = full_name.trim();
    }

    // Validate bio
    if (bio !== undefined) {
      if (typeof bio !== "string" || bio.length > 500) {
        return next(new AppError("Bio không được quá 500 ký tự", 400));
      }
      updateData.bio = bio.trim();
    }

    // Upload avatar nếu có
    if (avatar_base64) {
      try {
        // Upload lên Cloudinary
        const result = await cloudinary.uploader.upload(avatar_base64, {
          folder: "wdp/mangakas/avatars",
          width: 300,
          height: 300,
          crop: "fill",
          gravity: "face",
          format: "jpg",
          quality: "auto",
        });

        updateData.avatar_url = result.secure_url;
      } catch (uploadError) {
        console.error("Cloudinary upload error:", uploadError);
        return next(new AppError("Không thể upload ảnh đại diện", 400));
      }
    }

    // Cập nhật user
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select("-password -otp -otp_expires").lean();

    res.json({
      success: true,
      message: "Cập nhật profile thành công",
      data: {
        _id: updatedUser._id,
        username: updatedUser.username,
        full_name: updatedUser.full_name,
        email: updatedUser.email,
        avatar_url: updatedUser.avatar_url || null,
        bio: updatedUser.bio || "",
        role: updatedUser.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /mangaka/profile/:id - Lấy thông tin public của một mangaka (cho reader)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /mangaka/profile/{id}:
 *   get:
 *     summary: Lấy thông tin public của một mangaka
 *     tags: [Mangaka - Profile]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Thông tin public mangaka
 *       404:
 *         description: Không tìm thấy mangaka
 */
router.get("/profile/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id)
      .select("full_name avatar_url bio role created_at")
      .lean();

    if (!user || user.role !== "Mangaka") {
      return next(new AppError("Không tìm thấy mangaka", 404));
    }

    // Lấy stats
    const seriesCount = await Series.countDocuments({ author_id: id, status: "published" });
    const totalViews = await Series.aggregate([
      { $match: { author_id: user._id, status: "published" } },
      { $group: { _id: null, total: { $sum: "$views_count" } } },
    ]);
    const totalVotes = await Series.aggregate([
      { $match: { author_id: user._id, status: "published" } },
      { $group: { _id: null, total: { $sum: "$total_votes" } } },
    ]);

    // Lấy series published
    const series = await Series.find({ author_id: id, status: "published" })
      .select("name cover_image_url genre views_count total_votes average_score chapter_count createdAt")
      .sort({ average_score: -1 })
      .lean();

    res.json({
      success: true,
      data: {
        user: {
          _id: user._id,
          full_name: user.full_name,
          avatar_url: user.avatar_url || null,
          bio: user.bio || "",
          role: user.role,
          joined_at: user.created_at,
        },
        stats: {
          total_series: seriesCount,
          total_views: totalViews[0]?.total || 0,
          total_votes: totalVotes[0]?.total || 0,
        },
        series: series,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
