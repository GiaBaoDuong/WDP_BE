const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { requireAssistant } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const cloudinary = require("../config/cloudinary");
const User = require("../models/User");
const Cooperation = require("../models/Cooperation");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Task = require("../models/Task");
const Revenue = require("../models/Revenue");
const Wallet = require("../models/Wallet");
const { COIN_UNIT_SCALE, unitsToCoinString } = require("../utils/coinUnit");

const toId = (value) => {
  if (!value) return "";
  return String(value._id || value);
};

const shapeUser = (user) => ({
  id: toId(user._id),
  _id: user._id,
  username: user.username,
  full_name: user.full_name,
  email: user.email,
  role: user.role,
  avatar_url: user.avatar_url || null,
  cover_image_url: user.cover_image_url || null,
  bio: user.bio || "",
  social_links: user.social_links || {
    facebook: "",
    twitter: "",
    website: "",
  },
  joined_at: user.created_at || null,
});

/**
 * @swagger
 * /assistant/profile:
 *   get:
 *     summary: Lấy profile và thống kê của Assistant đang đăng nhập
 *     tags: [Assistant - Profile]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: |
 *           Assistant profile. Các field `earnings`, `pendingEarnings`,
 *           `availableEarnings`, `withdrawnEarnings`, `pendingBalance` và
 *           `availableBalance` là raw CoinUnit. Các field kết thúc bằng
 *           `Coin` là chuỗi Coin đã chia theo `coinUnitScale`, dùng để hiển thị.
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Chỉ role Assistant được truy cập
 *       404:
 *         description: User not found
 */
router.get(
  "/profile",
  authMiddleware,
  requireAssistant,
  async (req, res, next) => {
    try {
      const userId = req.user.nameid;
      const mongoUserId = new mongoose.Types.ObjectId(String(userId));

      const [user, cooperations, chapters, taskStats, revenueStats, wallet] =
        await Promise.all([
          User.findById(userId)
            .select("-password -otp -otp_expires")
            .lean(),
          Cooperation.find({
            assistant_id: userId,
            agreed_at: { $ne: null },
          })
            .populate("mangaka_id", "username full_name avatar_url")
            .populate("series_id", "name cover_image_url status author_id")
            .sort({ agreed_at: -1 })
            .lean(),
          Chapter.find({ assistant_id: userId })
            .select("series_id status")
            .lean(),
          Task.aggregate([
            { $match: { assigned_to: mongoUserId } },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                approved: {
                  $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] },
                },
              },
            },
          ]),
          Revenue.aggregate([
            {
              $match: {
                user_id: mongoUserId,
                user_role: "Assistant",
              },
            },
            {
              $group: {
                _id: null,
                earnings: { $sum: "$coin_amount" },
                pending: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", "pending"] },
                      "$coin_amount",
                      0,
                    ],
                  },
                },
                available: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", "available"] },
                      "$coin_amount",
                      0,
                    ],
                  },
                },
                withdrawn: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", "withdrawn"] },
                      "$coin_amount",
                      0,
                    ],
                  },
                },
              },
            },
          ]),
          Wallet.findOne({ user_id: userId }).lean(),
        ]);

      if (!user) return next(new AppError("User not found", 404));

      const chapterCountBySeries = new Map();
      const seriesIds = new Set();

      chapters.forEach((chapter) => {
        const seriesId = toId(chapter.series_id);
        if (!seriesId) return;
        seriesIds.add(seriesId);
        chapterCountBySeries.set(
          seriesId,
          (chapterCountBySeries.get(seriesId) || 0) + 1
        );
      });

      cooperations.forEach((cooperation) => {
        const seriesId = toId(cooperation.series_id);
        if (seriesId) seriesIds.add(seriesId);
      });

      const relatedSeries = seriesIds.size
        ? await Series.find({ _id: { $in: [...seriesIds] } })
            .select(
              "name cover_image_url status genre views_count total_votes average_score author_id updatedAt"
            )
            .populate("author_id", "username full_name avatar_url")
            .sort({ updatedAt: -1 })
            .lean()
        : [];

      const explicitCooperationBySeries = new Map();
      const generalCooperationByMangaka = new Map();
      cooperations.forEach((cooperation) => {
        const seriesId = toId(cooperation.series_id);
        const mangakaId = toId(cooperation.mangaka_id);
        if (seriesId) explicitCooperationBySeries.set(seriesId, cooperation);
        else if (mangakaId) generalCooperationByMangaka.set(mangakaId, cooperation);
      });

      const series = relatedSeries.map((item) => {
        const seriesId = toId(item._id);
        const mangakaId = toId(item.author_id);
        const cooperation =
          explicitCooperationBySeries.get(seriesId) ||
          generalCooperationByMangaka.get(mangakaId);

        return {
          id: seriesId,
          _id: item._id,
          name: item.name,
          cover_image_url: item.cover_image_url || null,
          status: item.status,
          genre: item.genre || [],
          views_count: item.views_count || 0,
          total_votes: item.total_votes || 0,
          average_score: item.average_score || 0,
          mangaka: item.author_id
            ? {
                id: toId(item.author_id),
                username: item.author_id.username,
                full_name: item.author_id.full_name,
                avatar_url: item.author_id.avatar_url || null,
              }
            : null,
          chaptersParticipated: chapterCountBySeries.get(seriesId) || 0,
          cooperated_at: cooperation?.agreed_at || null,
        };
      });

      const taskSummary = taskStats[0] || { total: 0, approved: 0 };
      const revenueSummary = revenueStats[0] || {
        earnings: 0,
        pending: 0,
        available: 0,
        withdrawn: 0,
      };

      return res.json({
        success: true,
        data: {
          user: shapeUser(user),
          stats: {
            totalSeries: series.length,
            chapters: chapters.length,
            totalTasks: taskSummary.total,
            approvedTasks: taskSummary.approved,
            earnings: revenueSummary.earnings,
            earningsCoin: unitsToCoinString(revenueSummary.earnings),
            pendingEarnings: revenueSummary.pending,
            pendingEarningsCoin: unitsToCoinString(revenueSummary.pending),
            availableEarnings: revenueSummary.available,
            availableEarningsCoin: unitsToCoinString(revenueSummary.available),
            withdrawnEarnings: revenueSummary.withdrawn,
            withdrawnEarningsCoin: unitsToCoinString(revenueSummary.withdrawn),
            pendingBalance: wallet?.pending_balance || 0,
            pendingBalanceCoin: unitsToCoinString(wallet?.pending_balance || 0),
            availableBalance: wallet?.available_balance || 0,
            availableBalanceCoin: unitsToCoinString(wallet?.available_balance || 0),
            coinUnitScale: COIN_UNIT_SCALE,
          },
          series,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /assistant/profile:
 *   put:
 *     summary: Cập nhật profile của Assistant đang đăng nhập
 *     tags: [Assistant - Profile]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name: { type: string }
 *               bio: { type: string }
 *               avatar_base64: { type: string }
 *               cover_image_base64: { type: string }
 *               social_links:
 *                 type: object
 *                 properties:
 *                   facebook: { type: string }
 *                   twitter: { type: string }
 *                   website: { type: string }
 *     responses:
 *       200:
 *         description: Cập nhật thành công
 *       400:
 *         description: Dữ liệu không hợp lệ
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Chỉ role Assistant được truy cập
 */
router.put(
  "/profile",
  authMiddleware,
  requireAssistant,
  async (req, res, next) => {
    try {
      const userId = req.user.nameid;
      const {
        full_name,
        bio,
        avatar_base64,
        cover_image_base64,
        social_links,
      } = req.body;
      const updateData = {};

      if (full_name !== undefined) {
        if (
          typeof full_name !== "string" ||
          full_name.trim().length < 2 ||
          full_name.trim().length > 100
        ) {
          return next(new AppError("Tên phải từ 2-100 ký tự", 400));
        }
        updateData.full_name = full_name.trim();
      }

      if (bio !== undefined) {
        if (typeof bio !== "string" || bio.length > 500) {
          return next(new AppError("Bio không được quá 500 ký tự", 400));
        }
        updateData.bio = bio.trim();
      }

      if (social_links !== undefined) {
        if (
          !social_links ||
          typeof social_links !== "object" ||
          Array.isArray(social_links)
        ) {
          return next(new AppError("social_links phải là object", 400));
        }
        updateData.social_links = {
          facebook: social_links.facebook || "",
          twitter: social_links.twitter || "",
          website: social_links.website || "",
        };
      }

      if (avatar_base64) {
        try {
          const result = await cloudinary.uploader.upload(avatar_base64, {
            folder: "wdp/assistants/avatars",
            width: 300,
            height: 300,
            crop: "fill",
            gravity: "face",
            format: "jpg",
            quality: "auto",
          });
          updateData.avatar_url = result.secure_url;
        } catch (uploadError) {
          console.error("Cloudinary assistant avatar upload error:", uploadError);
          return next(new AppError("Không thể upload ảnh đại diện", 400));
        }
      }

      if (cover_image_base64) {
        try {
          const result = await cloudinary.uploader.upload(cover_image_base64, {
            folder: "wdp/assistants/covers",
            width: 1200,
            height: 400,
            crop: "fill",
            gravity: "auto",
            format: "jpg",
            quality: "auto",
          });
          updateData.cover_image_url = result.secure_url;
        } catch (uploadError) {
          console.error("Cloudinary assistant cover upload error:", uploadError);
          return next(new AppError("Không thể upload ảnh bìa", 400));
        }
      }

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: updateData },
        { new: true, runValidators: true }
      )
        .select("-password -otp -otp_expires")
        .lean();

      if (!updatedUser) return next(new AppError("User not found", 404));

      return res.json({
        success: true,
        message: "Cập nhật profile Assistant thành công",
        data: shapeUser(updatedUser),
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
