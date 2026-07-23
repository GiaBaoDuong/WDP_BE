const express = require("express");
const router = express.Router();
const { authMiddleware, optionalAuth } = require("../middleware/auth");
const { AppError } = require("../middleware/errorHandler");
const Vote = require("../models/Vote");
const Series = require("../models/Series");

/**
 * @swagger
 * /votes/series/{seriesId}:
 *   get:
 *     tags: [Votes]
 *     summary: List votes for a series (public, paginated, latest first)
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Votes list with reader info }
 *       404: { description: Series not found }
 */
router.get("/series/:seriesId", optionalAuth, async (req, res, next) => {
  try {
    const { seriesId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const series = await Series.findOne({
      _id: seriesId,
      is_public: true,
      status: "published",
    }).select("_id name average_score total_votes");
    if (!series) return next(new AppError("Series not found", 404));

    const [votes, total] = await Promise.all([
      Vote.find({ series_id: seriesId })
        .populate("reader_id", "username full_name avatar_url")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Vote.countDocuments({ series_id: seriesId }),
    ]);

    return res.status(200).json({
      success: true,
      data: votes,
      series: {
        _id: series._id,
        name: series.name,
        average_score: series.average_score,
        total_votes: series.total_votes,
      },
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
 * /votes/{id}:
 *   delete:
 *     tags: [Votes]
 *     summary: Delete a vote (vote owner or Admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Vote deleted }
 *       403: { description: Not authorized }
 *       404: { description: Vote not found }
 */
router.delete("/:id", authMiddleware, async (req, res, next) => {
  try {
    const vote = await Vote.findById(req.params.id);
    if (!vote) return next(new AppError("Vote not found", 404));

    const isOwner = String(vote.reader_id) === String(req.user.nameid);
    const isAdmin = req.user.role === "Admin";
    if (!isOwner && !isAdmin) {
      return next(new AppError("Not authorized to delete this vote", 403));
    }

    await vote.deleteOne();

    // Recompute Series.average_score và total_votes (không trigger updatedAt)
    const allVotes = await Vote.find({ series_id: vote.series_id });
    const total = allVotes.length;
    const avg = total > 0
      ? allVotes.reduce((s, v) => s + v.score, 0) / total
      : 0;
    await Series.findByIdAndUpdate(vote.series_id, {
      $set: {
        average_score: Math.round(avg * 10) / 10,
        total_votes: total,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Vote deleted successfully",
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;