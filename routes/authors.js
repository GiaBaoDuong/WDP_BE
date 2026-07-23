const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const User = require("../models/User");
const Series = require("../models/Series");
const FollowAuthor = require("../models/FollowAuthor");
const { AppError } = require("../middleware/errorHandler");

// ════════════════════════════════════════════════════════════════════════════
// GET /authors/:authorId - Lấy profile author + stats
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * '/authors/{authorId}':
 *   get:
 *     summary: Lấy thông tin public của một author
 *     tags: [Authors]
 *     parameters:
 *       - in: path
 *         name: authorId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Thông tin author
 *       404:
 *         description: Không tìm thấy author
 */
router.get("/:authorId", async (req, res, next) => {
  try {
    const { authorId } = req.params;

    const author = await User.findById(authorId)
      .select("full_name avatar_url bio social_links role created_at")
      .lean();

    if (!author || author.role !== "Mangaka") {
      return next(new AppError("Không tìm thấy author", 404));
    }

    // Stats
    const [seriesStats, followersCount] = await Promise.all([
      Series.aggregate([
        { $match: { author_id: author._id, status: "published" } },
        {
          $group: {
            _id: null,
            total_series: { $sum: 1 },
            total_views: { $sum: "$views_count" },
            total_votes: { $sum: "$total_votes" },
            avg_score: { $avg: "$average_score" },
          },
        },
      ]),
      FollowAuthor.countDocuments({ author_id: author._id }),
    ]);

    const stats = seriesStats[0] || { total_series: 0, total_views: 0, total_votes: 0, avg_score: 0 };

    res.json({
      success: true,
      data: {
        _id: author._id,
        full_name: author.full_name,
        avatar_url: author.avatar_url || null,
        bio: author.bio || "",
        social_links: author.social_links || { facebook: "", twitter: "", website: "" },
        role: author.role,
        joined_at: author.created_at,
        stats: {
          total_series: stats.total_series,
          total_views: stats.total_views,
          total_votes: stats.total_votes,
          average_score: Math.round(stats.avg_score * 10) / 10,
          followers_count: followersCount,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /authors/:authorId/series - List series public (paginated)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * '/authors/{authorId}/series':
 *   get:
 *     summary: Lấy danh sách series công khai của author (phân trang)
 *     tags: [Authors]
 *     parameters:
 *       - in: path
 *         name: authorId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 12
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [published, draft, all]
 *           default: published
 *     responses:
 *       200:
 *         description: Danh sách series
 */
router.get("/:authorId/series", async (req, res, next) => {
  try {
    const { authorId } = req.params;
    const { page = 1, limit = 12, status = "published" } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 12));
    const skip = (pageNum - 1) * limitNum;

    // Verify author exists
    const author = await User.findById(authorId).select("_id role").lean();
    if (!author || author.role !== "Mangaka") {
      return next(new AppError("Không tìm thấy author", 404));
    }

    // Build query
    const query = { author_id: authorId };
    if (status !== "all") {
      query.status = status;
    }

    const [series, total] = await Promise.all([
      Series.find(query)
        .select("name cover_image_url genre status views_count total_votes average_score chapter_count createdAt updatedAt")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Series.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: series,
      meta: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /authors/:authorId/followers/count - Đếm followers
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * '/authors/{authorId}/followers/count':
 *   get:
 *     summary: Đếm số người theo dõi author
 *     tags: [Authors]
 *     parameters:
 *       - in: path
 *         name: authorId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Số followers
 */
router.get("/:authorId/followers/count", async (req, res, next) => {
  try {
    const { authorId } = req.params;

    // Verify author exists
    const author = await User.findById(authorId).select("_id role").lean();
    if (!author || author.role !== "Mangaka") {
      return next(new AppError("Không tìm thấy author", 404));
    }

    const count = await FollowAuthor.countDocuments({ author_id: authorId });

    res.json({
      success: true,
      data: {
        author_id: authorId,
        followers_count: count,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// /authors/:authorId/follow - Follow/Unfollow/Check status
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * '/authors/{authorId}/follow':
 *   get:
 *     summary: Kiểm tra đang theo dõi author hay chưa
 *     tags: [Authors]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Trạng thái theo dõi
 *   post:
 *     summary: Theo dõi một author
 *     tags: [Authors]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Theo dõi thành công
 *       400:
 *         description: Đã theo dõi rồi
 *   delete:
 *     summary: Bỏ theo dõi author
 *     tags: [Authors]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Bỏ theo dõi thành công
 */

router.get("/:authorId/follow", authMiddleware, async (req, res, next) => {
  try {
    const { authorId } = req.params;
    const readerId = req.user._id;

    const existing = await FollowAuthor.findOne({ reader_id: readerId, author_id: authorId });

    res.json({
      success: true,
      data: {
        is_following: !!existing,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:authorId/follow", authMiddleware, async (req, res, next) => {
  try {
    const { authorId } = req.params;
    const readerId = req.user._id;

    if (String(readerId) === String(authorId)) {
      return next(new AppError("Không thể tự theo dõi chính mình", 400));
    }

    const author = await User.findById(authorId).select("_id role").lean();
    if (!author || author.role !== "Mangaka") {
      return next(new AppError("Không tìm thấy author", 404));
    }

    const existing = await FollowAuthor.findOne({ reader_id: readerId, author_id: authorId });
    if (existing) {
      return next(new AppError("Đã theo dõi author này rồi", 400));
    }

    await FollowAuthor.create({ reader_id: readerId, author_id: authorId });

    res.json({
      success: true,
      message: "Theo dõi thành công",
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/:authorId/follow", authMiddleware, async (req, res, next) => {
  try {
    const { authorId } = req.params;
    const readerId = req.user._id;

    const result = await FollowAuthor.deleteOne({ reader_id: readerId, author_id: authorId });

    if (result.deletedCount === 0) {
      return next(new AppError("Bạn chưa theo dõi author này", 400));
    }

    res.json({
      success: true,
      message: "Đã bỏ theo dõi",
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
