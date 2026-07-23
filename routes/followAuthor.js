const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireReader } = require("../middleware/roles");
const FollowAuthor = require("../models/FollowAuthor");
const User = require("../models/User");
const Series = require("../models/Series");
const { AppError } = require("../middleware/errorHandler");
const { ROLES } = require("../utils/constants");

/**
 * Helper: kiểm tra author có tồn tại và đúng role Mangaka không.
 * Trả về lean object với _id + thông tin hiển thị, hoặc null.
 */
async function getMangaka(authorId) {
  return await User.findOne({ _id: authorId, role: ROLES.MANGAKA })
    .select("_id username full_name avatar_url")
    .lean();
}

/**
 * @swagger
 * '/follow-author/{authorId}':
 *   post:
 *     tags: [FollowAuthors]
 *     summary: Follow a Mangaka (reader only)
 *     description: |
 *       Reader theo dõi một Mangaka. Khi author ra series mới (status="published"),
 *       sẽ nhận notification "new_series_from_author".
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
 *         description: Đã theo dõi tác giả (idempotent - nếu đã follow từ trước)
 *       201:
 *         description: Vừa tạo follow record mới
 *       400:
 *         description: Không thể tự theo dõi chính mình
 *       404:
 *         description: Author not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Reader only
 */
router.post(
  "/:authorId",
  authMiddleware,
  requireReader,
  async (req, res, next) => {
    try {
      const author = await getMangaka(req.params.authorId);
      if (!author) return next(new AppError("Author not found", 404));

      if (String(author._id) === String(req.user.nameid)) {
        return next(new AppError("Không thể tự theo dõi chính mình", 400));
      }

      try {
        const follow = await FollowAuthor.create({
          reader_id: req.user.nameid,
          author_id: author._id,
        });
        return res
          .status(201)
          .json({ success: true, message: "Đã theo dõi tác giả", data: follow });
      } catch (err) {
        if (err && err.code === 11000) {
          return res
            .status(200)
            .json({ success: true, message: "Đã theo dõi tác giả từ trước" });
        }
        throw err;
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * '/follow-author/{authorId}':
 *   delete:
 *     tags: [FollowAuthors]
 *     summary: Unfollow a Mangaka (reader only)
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
 *         description: Đã bỏ theo dõi (hoặc không có record)
 */
router.delete(
  "/:authorId",
  authMiddleware,
  requireReader,
  async (req, res, next) => {
    try {
      await FollowAuthor.findOneAndDelete({
        reader_id: req.user.nameid,
        author_id: req.params.authorId,
      });
      return res.status(200).json({ success: true, message: "Đã bỏ theo dõi" });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * '/follow-author/{authorId}/status':
 *   get:
 *     tags: [FollowAuthors]
 *     summary: Check whether the current reader is following an author (Risk D: có check role Mangaka)
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
 *         description: Trả về isFollowing
 *       404:
 *         description: Author not found (không phải Mangaka)
 */
router.get(
  "/:authorId/status",
  authMiddleware,
  requireReader,
  async (req, res, next) => {
    try {
      // Risk D: verify author tồn tại và là Mangaka trước khi check follow
      const author = await getMangaka(req.params.authorId);
      if (!author) return next(new AppError("Author not found", 404));

      const exists = await FollowAuthor.exists({
        reader_id: req.user.nameid,
        author_id: req.params.authorId,
      });
      return res.status(200).json({ success: true, isFollowing: !!exists });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * '/follow-author/mine':
 *   get:
 *     tags: [FollowAuthors]
 *     summary: List các Mangaka mà reader hiện tại đang theo dõi (kèm series_count)
 *     security:
 *       - BearerAuth: []
 *     parameters:
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
 *         description: Danh sách author đang theo dõi kèm số series public
 */
router.get("/mine", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      FollowAuthor.find({ reader_id: req.user.nameid })
        .sort({ created_at: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate({
          path: "author_id",
          select: "username full_name avatar_url",
        })
        .lean(),
      FollowAuthor.countDocuments({ reader_id: req.user.nameid }),
    ]);

    const authorIds = items.map((it) => it.author_id?._id).filter(Boolean);
    const seriesCount = await Series.aggregate([
      {
        $match: {
          author_id: { $in: authorIds },
          is_public: true,
          status: "published",
        },
      },
      { $group: { _id: "$author_id", count: { $sum: 1 } } },
    ]);
    const countMap = new Map(seriesCount.map((c) => [String(c._id), c.count]));

    const data = items.map((it) => ({
      ...it,
      series_count: countMap.get(String(it.author_id._id)) || 0,
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

module.exports = router;
