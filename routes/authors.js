const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { AppError } = require("../middleware/errorHandler");
const { ROLES } = require("../utils/constants");
const User = require("../models/User");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const FollowAuthor = require("../models/FollowAuthor");

/**
 * Helper: Verify author tồn tại, là Mangaka, active
 */
async function verifyAuthor(authorId) {
  if (!mongoose.Types.ObjectId.isValid(authorId)) return null;
  return await User.findOne({
    _id: authorId,
    role: ROLES.MANGAKA,
    status: "active",
  })
    .select("_id username full_name avatar_url bio social_links created_at")
    .lean();
}

// ============================================================================
// GET /authors/:authorId - Lấy profile công khai của tác giả
// ============================================================================
/**
 * @swagger
 * '/authors/{authorId}':
 *   get:
 *     summary: Lấy profile công khai của tác giả
 *     tags: [Authors]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: authorId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Thông tin author kèm stats
 *       404:
 *         description: Author not found hoặc không phải Mangaka
 */
router.get("/:authorId", authMiddleware, async (req, res, next) => {
  try {
    const { authorId } = req.params;

    const author = await verifyAuthor(authorId);
    if (!author) return next(new AppError("Author not found", 404));

    // Parallel queries: series stats + followers count + isFollowing
    const [publishedSeries, totalFollowers] = await Promise.all([
      Series.find({
        author_id: authorId,
        is_public: true,
        status: "published",
      }).select("_id"),
      FollowAuthor.countDocuments({ author_id: authorId }),
    ]);

    const seriesIds = publishedSeries.map((s) => s._id);

    // Aggregate chapter count
    const chapterStats = await Chapter.aggregate([
      { $match: { series_id: { $in: seriesIds }, is_published: true } },
      { $group: { _id: null, total: { $sum: 1 } } },
    ]);

    // Aggregate average score
    const avgScoreResult = await Series.aggregate([
      {
        $match: {
          author_id: new mongoose.Types.ObjectId(authorId),
          is_public: true,
          status: "published",
          average_score: { $gt: 0 },
        },
      },
      { $group: { _id: null, avg_score: { $avg: "$average_score" } } },
    ]);

    const totalChapters = chapterStats[0]?.total || 0;
    const avgScore = avgScoreResult[0]?.avg_score || 0;

    const responseData = {
      _id: author._id,
      username: author.username,
      full_name: author.full_name,
      avatar_url: author.avatar_url || "",
      bio: author.bio || "",
      social_links: author.social_links || { facebook: "", twitter: "", website: "" },
      joined_at: author.created_at,
      stats: {
        total_series: publishedSeries.length,
        total_chapters: totalChapters,
        total_followers: totalFollowers,
        average_rating: avgScore > 0 ? parseFloat(avgScore.toFixed(2)) : 0,
      },
    };

    // Chỉ thêm isFollowing nếu user là Reader
    if (req.user.role === ROLES.READER) {
      const isFollowing = await FollowAuthor.exists({
        reader_id: req.user.nameid,
        author_id: authorId,
      });
      responseData.isFollowing = !!isFollowing;
    }

    return res.status(200).json({ success: true, data: responseData });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// GET /authors/:authorId/series - List series public của tác giả
// ============================================================================
/**
 * @swagger
 * '/authors/{authorId}/series':
 *   get:
 *     summary: List series public của tác giả
 *     tags: [Authors]
 *     security:
 *       - BearerAuth: []
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
 *           default: 20
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [updatedAt, createdAt, average_score]
 *           default: updatedAt
 *       - in: query
 *         name: publication_status
 *         schema:
 *           type: string
 *           enum: [ongoing, completed, hiatus, dropped]
 *     responses:
 *       200:
 *         description: Danh sách series với pagination
 */
router.get("/:authorId/series", authMiddleware, async (req, res, next) => {
  try {
    const { authorId } = req.params;
    const {
      page = 1,
      limit = 20,
      sort = "updatedAt",
      publication_status,
    } = req.query;

    const author = await verifyAuthor(authorId);
    if (!author) return next(new AppError("Author not found", 404));

    const filter = {
      author_id: authorId,
    };

    // Phân quyền hiển thị series:
    // - Chính author (Mangaka) xem trang của mình: thấy TẤT CẢ series (kể cả admin-force-deleted)
    //   → biết truyện nào đã bị ẩn, liên hệ admin.
    // - Người khác (Reader, EB, TE, Mangaka khác, anonymous): chỉ thấy series public + published,
    //   loại trừ series đã soft-delete.
    const isSelfView =
      req.user && req.user.nameid && String(req.user.nameid) === String(authorId);

    if (!isSelfView) {
      filter.is_public = true;
      filter.status = "published";
      filter.deleted_at = null;
    }
    // isSelfView: không thêm filter is_public / status / deleted_at → author thấy tất cả.

    if (publication_status) filter.publication_status = publication_status;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const sortMap = {
      updatedAt: { updatedAt: -1 },
      createdAt: { createdAt: -1 },
      average_score: { average_score: -1 },
    };
    const sortOption = sortMap[sort] || { updatedAt: -1 };

    const [items, total] = await Promise.all([
      Series.find(filter)
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum)
        .populate("author_id", "username full_name avatar_url")
        .lean(),
      Series.countDocuments(filter),
    ]);

    // Enrich với chapter stats
    const seriesIds = items.map((s) => s._id);
    const chapterStats = await Chapter.aggregate([
      { $match: { series_id: { $in: seriesIds }, is_published: true } },
      {
        $group: {
          _id: "$series_id",
          total_chapters: { $sum: 1 },
          latest_chapter_number: { $max: "$chapter_number" },
        },
      },
    ]);
    const chapterMap = new Map(chapterStats.map((c) => [String(c._id), c]));

    const data = items.map((s) => ({
      _id: s._id,
      name: s.name,
      cover_image_url: s.cover_image_url || "",
      genre: s.genre || [],
      synopsis: s.synopsis || "",
      average_score: s.average_score || 0,
      total_votes: s.total_votes || 0,
      views_count: s.views_count || 0,
      publication_status: s.publication_status || null,
      total_chapters: chapterMap.get(String(s._id))?.total_chapters || 0,
      latest_chapter_number: chapterMap.get(String(s._id))?.latest_chapter_number || 0,
      updatedAt: s.updatedAt,
      author_id: s.author_id,
    }));

    return res.status(200).json({
      success: true,
      data,
      pagination: { total, page: pageNum, limit: limitNum },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// GET /authors/:authorId/followers/count - Đếm người theo dõi (public)
// ============================================================================
/**
 * @swagger
 * '/authors/{authorId}/followers/count':
 *   get:
 *     summary: Đếm số người theo dõi tác giả (public)
 *     tags: [Authors]
 *     parameters:
 *       - in: path
 *         name: authorId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Số người theo dõi
 */
router.get("/:authorId/followers/count", async (req, res, next) => {
  try {
    const { authorId } = req.params;

    const author = await verifyAuthor(authorId);
    if (!author) return next(new AppError("Author not found", 404));

    const count = await FollowAuthor.countDocuments({ author_id: authorId });
    return res.status(200).json({
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

// ============================================================================
// GET /authors/:authorId/follow - Kiểm tra đang theo dõi hay không
// POST /authors/:authorId/follow - Theo dõi author
// DELETE /authors/:authorId/follow - Bỏ theo dõi author
// ============================================================================
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

    const result = await FollowAuthor.deleteOne({
      reader_id: readerId,
      author_id: authorId,
    });

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
