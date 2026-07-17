const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireReader } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Comment = require("../models/Comment");
const Series = require("../models/Series");
const User = require("../models/User");

/**
 * @swagger
 * /comments:
 *   post:
 *     tags: [Comments]
 *     summary: Create a new comment on a series
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - series_id
 *               - content
 *             properties:
 *               series_id:
 *                 type: string
 *                 description: Series ID to comment on
 *               content:
 *                 type: string
 *                 maxLength: 500
 *                 description: Comment content
 *               parent_id:
 *                 type: string
 *                 description: Parent comment ID for replies (optional)
 *     responses:
 *       201:
 *         description: Comment created successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Series not available for comments or unauthorized
 *       404:
 *         description: Series or parent comment not found
 */
// ─── POST /comments ───────────────────────────────────────────────────────────
router.post("/", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { series_id, content, parent_id } = req.body;

    if (!series_id) {
      return next(new AppError("series_id is required", 400));
    }
    if (!content || content.trim().length === 0) {
      return next(new AppError("content is required", 400));
    }
    if (content.length > 500) {
      return next(new AppError("Content cannot exceed 500 characters", 400));
    }

    const series = await Series.findOne({
      _id: series_id,
      is_public: true,
      status: "published",
    });
    if (!series) {
      return next(new AppError("Series not found or not available for comments", 404));
    }

    if (parent_id) {
      const parentComment = await Comment.findById(parent_id);
      if (!parentComment) {
        return next(new AppError("Parent comment not found", 404));
      }
      if (String(parentComment.series_id) !== String(series_id)) {
        return next(new AppError("Parent comment does not belong to this series", 400));
      }
    }

    const comment = await Comment.create({
      series_id,
      reader_id: req.user.nameid,
      content: content.trim(),
      parent_id: parent_id || null,
    });

    const populatedComment = await Comment.findById(comment._id)
      .populate("reader_id", "username full_name avatar_url")
      .lean();

    return res.status(201).json({
      success: true,
      data: populatedComment,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /comments/series/{seriesId}:
 *   get:
 *     tags: [Comments]
 *     summary: Get comments for a series (with pagination)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
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
 *         description: List of comments (top-level only, no replies)
 *       404:
 *         description: Series not found
 */
// ─── GET /comments/series/:seriesId ───────────────────────────────────────────
router.get("/series/:seriesId", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const series = await Series.findOne({
      _id: seriesId,
      is_public: true,
      status: "published",
    }).select("_id");
    if (!series) {
      return next(new AppError("Series not found", 404));
    }

    const [comments, total] = await Promise.all([
      Comment.find({ series_id: seriesId, parent_id: null })
        .populate("reader_id", "username full_name avatar_url")
        .sort({ created_at: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Comment.countDocuments({ series_id: seriesId, parent_id: null }),
    ]);

    const commentIds = comments.map((c) => c._id);
    const replyCounts = await Comment.aggregate([
      { $match: { parent_id: { $in: commentIds } } },
      { $group: { _id: "$parent_id", count: { $sum: 1 } } },
    ]);
    const replyCountMap = new Map(replyCounts.map((r) => [String(r._id), r.count]));

    const enrichedComments = comments.map((c) => ({
      ...c,
      reply_count: replyCountMap.get(String(c._id)) || 0,
    }));

    return res.status(200).json({
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
 * /comments/{commentId}/replies:
 *   get:
 *     tags: [Comments]
 *     summary: Get replies for a comment
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: commentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Comment ID
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
 *         description: List of replies
 *       404:
 *         description: Comment not found
 */
// ─── GET /comments/:commentId/replies ────────────────────────────────────────
router.get("/:commentId/replies", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { commentId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const parentComment = await Comment.findById(commentId);
    if (!parentComment) {
      return next(new AppError("Comment not found", 404));
    }

    const [replies, total] = await Promise.all([
      Comment.find({ parent_id: commentId })
        .populate("reader_id", "username full_name avatar_url")
        .sort({ created_at: 1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Comment.countDocuments({ parent_id: commentId }),
    ]);

    return res.status(200).json({
      success: true,
      data: replies,
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
 * /comments/{commentId}:
 *   patch:
 *     tags: [Comments]
 *     summary: Update a comment (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: commentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Comment ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 maxLength: 500
 *     responses:
 *       200:
 *         description: Comment updated successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Not authorized to update this comment
 *       404:
 *         description: Comment not found
 */
// ─── PATCH /comments/:commentId ─────────────────────────────────────────────
router.patch("/:commentId", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return next(new AppError("content is required", 400));
    }
    if (content.length > 500) {
      return next(new AppError("Content cannot exceed 500 characters", 400));
    }

    const comment = await Comment.findById(commentId);
    if (!comment) {
      return next(new AppError("Comment not found", 404));
    }

    if (String(comment.reader_id) !== String(req.user.nameid)) {
      return next(new AppError("Not authorized to update this comment", 403));
    }

    comment.content = content.trim();
    await comment.save();

    const populatedComment = await Comment.findById(comment._id)
      .populate("reader_id", "username full_name avatar_url")
      .lean();

    return res.status(200).json({
      success: true,
      data: populatedComment,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /comments/{commentId}:
 *   delete:
 *     tags: [Comments]
 *     summary: Delete a comment (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: commentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Comment ID
 *     responses:
 *       200:
 *         description: Comment deleted successfully
 *       403:
 *         description: Not authorized to delete this comment
 *       404:
 *         description: Comment not found
 */
// ─── DELETE /comments/:commentId ─────────────────────────────────────────────
router.delete("/:commentId", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { commentId } = req.params;

    const comment = await Comment.findById(commentId);
    if (!comment) {
      return next(new AppError("Comment not found", 404));
    }

    if (String(comment.reader_id) !== String(req.user.nameid)) {
      return next(new AppError("Not authorized to delete this comment", 403));
    }

    await Comment.deleteMany({
      $or: [{ _id: commentId }, { parent_id: commentId }],
    });

    return res.status(200).json({
      success: true,
      message: "Comment deleted successfully",
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
