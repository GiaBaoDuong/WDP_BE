const express = require("express");
const router = express.Router();
const multer = require("multer");
const { authMiddleware } = require("../middleware/auth");
const { requireMangaka } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const User = require("../models/User");
const Series = require("../models/Series");
const FollowAuthor = require("../models/FollowAuthor");
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
 *                     user:
 *                       type: object
 *                       properties:
 *                         _id: { type: string }
 *                         username: { type: string }
 *                         full_name: { type: string }
 *                         email: { type: string }
 *                         avatar_url: { type: string, nullable: true }
 *                         cover_image_url: { type: string, nullable: true }
 *                         bio: { type: string }
 *                         social_links:
 *                           type: object
 *                           properties:
 *                             facebook: { type: string }
 *                             twitter: { type: string }
 *                             website: { type: string }
 *                         role: { type: string }
 *                         createdAt: { type: string, description: "Legacy field - kept for backward compatibility" }
 *                         joined_at: { type: string, format: date-time, description: "Same as createdAt" }
 *                     stats:
 *                       type: object
 *                       properties:
 *                         total_series: { type: integer }
 *                         published: { type: integer }
 *                         drafts: { type: integer }
 *                         followers_count: { type: integer }
 *                     series:
 *                       type: array
 *                       items:
 *                         type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Không phải mangaka
 */
router.get("/profile", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const userId = req.user.nameid;

    const [user, seriesCount, publishedCount, draftCount, followersCount] = await Promise.all([
      User.findById(userId).select("-password -otp -otp_expires").lean(),
      Series.countDocuments({ author_id: userId }),
      Series.countDocuments({ author_id: userId, status: "published" }),
      Series.countDocuments({ author_id: userId, status: "draft" }),
      FollowAuthor.countDocuments({ author_id: userId }),
    ]);

    if (!user) {
      return next(new AppError("Không tìm thấy người dùng", 404));
    }

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
          cover_image_url: user.cover_image_url || null,
          bio: user.bio || "",
          social_links: user.social_links || { facebook: "", twitter: "", website: "" },
          role: user.role,
          createdAt: user.created_at,
          joined_at: user.created_at,
        },
        stats: {
          total_series: seriesCount,
          published: publishedCount,
          drafts: draftCount,
          followers_count: followersCount,
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
 *                 description: Tên đầy đủ (2-100 ký tự)
 *               bio:
 *                 type: string
 *                 description: Giới thiệu bản thân
 *               avatar_base64:
 *                 type: string
 *                 description: Ảnh đại diện mã hóa Base64
 *               cover_image_base64:
 *                 type: string
 *                 description: Ảnh bìa mã hóa Base64
 *               social_links:
 *                 type: object
 *                 description: Liên kết mạng xã hội
 *                 properties:
 *                   facebook: { type: string, description: "Link Facebook" }
 *                   twitter: { type: string, description: "Link Twitter/X" }
 *                   website: { type: string, description: "Website cá nhân" }
 *     responses:
 *       200:
 *         description: Cập nhật thành công
 *       400:
 *         description: Dữ liệu không hợp lệ
 */
router.put("/profile", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const userId = req.user.nameid;
    const { full_name, bio, avatar_base64, cover_image_base64, social_links } = req.body;

    const updateData = {};

    if (full_name !== undefined) {
      if (typeof full_name !== "string" || full_name.trim().length < 2 || full_name.trim().length > 100) {
        return next(new AppError("Tên phải từ 2-100 ký tự", 400));
      }
      updateData.full_name = full_name.trim();
    }

    if (bio !== undefined) {
      updateData.bio = bio;
    }

    if (avatar_base64) {
      try {
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

    if (cover_image_base64) {
      try {
        const result = await cloudinary.uploader.upload(cover_image_base64, {
          folder: "wdp/mangakas/covers",
          width: 1200,
          height: 400,
          crop: "fill",
          gravity: "auto",
          format: "jpg",
          quality: "auto",
        });
        updateData.cover_image_url = result.secure_url;
      } catch (uploadError) {
        console.error("Cloudinary upload error:", uploadError);
        return next(new AppError("Không thể upload ảnh bìa", 400));
      }
    }

    if (social_links !== undefined) {
      updateData.social_links = social_links;
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
        cover_image_url: updatedUser.cover_image_url || null,
        bio: updatedUser.bio || "",
        social_links: updatedUser.social_links || { facebook: "", twitter: "", website: "" },
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
 *     summary: Lấy thông tin public của một mangaka (không yêu cầu auth, không trả email)
 *     tags: [Mangaka - Profile]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID của Mangaka
 *     responses:
 *       200:
 *         description: Thông tin public mangaka
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
 *                     user:
 *                       type: object
 *                       properties:
 *                         _id: { type: string }
 *                         username: { type: string }
 *                         full_name: { type: string }
 *                         avatar_url: { type: string, nullable: true }
 *                         cover_image_url: { type: string, nullable: true }
 *                         bio: { type: string }
 *                         social_links:
 *                           type: object
 *                           properties:
 *                             facebook: { type: string }
 *                             twitter: { type: string }
 *                             website: { type: string }
 *                         role: { type: string }
 *                         joined_at: { type: string, format: date-time }
 *                       description: Không có email
 *                     stats:
 *                       type: object
 *                       properties:
 *                         total_series: { type: integer }
 *                         published: { type: integer }
 *                         drafts: { type: integer }
 *                         followers_count: { type: integer }
 *                     series:
 *                       type: array
 *                       description: Chỉ trả series published
 *                       items:
 *                         type: object
 *       404:
 *         description: Không tìm thấy mangaka
 */
router.get("/profile/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id)
      .select("username full_name avatar_url cover_image_url bio social_links role created_at")
      .lean();

    if (!user || user.role !== "Mangaka") {
      return next(new AppError("Không tìm thấy mangaka", 404));
    }

    const [totalSeries, publishedSeries, draftSeries, followersCount] = await Promise.all([
      Series.countDocuments({ author_id: id }),
      Series.countDocuments({ author_id: id, status: "published" }),
      Series.countDocuments({ author_id: id, status: "draft" }),
      FollowAuthor.countDocuments({ author_id: id }),
    ]);

    const series = await Series.find({ author_id: id, status: "published" })
      .select("name cover_image_url status genre views_count total_votes average_score chapter_count createdAt")
      .sort({ average_score: -1 })
      .lean();

    res.json({
      success: true,
      data: {
        user: {
          _id: user._id,
          username: user.username,
          full_name: user.full_name,
          avatar_url: user.avatar_url || null,
          cover_image_url: user.cover_image_url || null,
          bio: user.bio || "",
          social_links: user.social_links || { facebook: "", twitter: "", website: "" },
          role: user.role,
          joined_at: user.created_at,
        },
        stats: {
          total_series: totalSeries,
          published: publishedSeries,
          drafts: draftSeries,
          followers_count: followersCount,
        },
        series: series.map((s) => ({ ...s, status: "published" })),
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
