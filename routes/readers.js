const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireReader } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Vote = require("../models/Vote");
const { getCurrentPeriod } = require("../utils/helpers");

/**
 * @swagger
 * /reader/series:
 *   get:
 *     tags: [Readers]
 *     summary: Get published series for readers
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: genre
 *         schema:
 *           type: string
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           default: average_score
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
 *         description: List of published series
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Series'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Reader role required
 */
// ─── GET /reader/series ───────────────────────────────────────────────────────
// Reader xem danh sách series đã publish
router.get("/series", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { genre, sort = "average_score", page = 1, limit = 20 } = req.query;

    const filter = { is_public: true, status: "published" };
    if (genre) filter.genre = genre;

    const [series, total] = await Promise.all([
      Series.find(filter)
        .populate("author_id", "username full_name phoneNumber")
        .sort({ [sort]: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Series.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: series,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/series/{id}:
 *   get:
 *     tags: [Readers]
 *     summary: Get series details for a reader
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     responses:
 *       200:
 *         description: Series details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Series'
 *       404:
 *         description: Series not found
 */
// ─── GET /reader/series/:id ─────────────────────────────────────────────────
// Reader xem chi tiết series
router.get("/series/:id", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const series = await Series.findOne({
      _id: req.params.id,
      is_public: true,
      status: "published",
    })
      .populate("author_id", "username full_name phoneNumber")
      .lean();

    if (!series) return next(new AppError("Series not found", 404));

    return res.status(200).json({ success: true, data: series });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/series/{id}/chapters:
 *   get:
 *     tags: [Readers]
 *     summary: Get published chapters for a series
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     responses:
 *       200:
 *         description: List of published chapters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Chapter'
 *                 seriesName:
 *                   type: string
 *       404:
 *         description: Series not found
 */
// ─── GET /reader/series/:id/chapters ─────────────────────────────────────────
// Reader xem chapters đã publish
router.get("/series/:id/chapters", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const series = await Series.findOne({
      _id: req.params.id,
      is_public: true,
      status: "published",
    }).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const chapters = await Chapter.find({
      series_id: req.params.id,
      is_published: true,
    })
      .populate("submitted_by", "username full_name phoneNumber")
      .sort({ chapter_number: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: chapters,
      seriesName: series.name,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/chapters/{id}:
 *   get:
 *     tags: [Readers]
 *     summary: Get chapter details for a reader
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     responses:
 *       200:
 *         description: Chapter details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Chapter'
 *                 seriesName:
 *                   type: string
 *       404:
 *         description: Chapter not found
 */
// ─── GET /reader/chapters/:id ─────────────────────────────────────────────────
// Reader xem chi tiết chapter
router.get("/chapters/:id", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.id,
      is_published: true,
    })
      .populate("series_id", "name author_id")
      .lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    return res.status(200).json({
      success: true,
      data: chapter,
      seriesName: chapter.series_id ? chapter.series_id.name : "",
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/votes:
 *   post:
 *     tags: [Readers]
 *     summary: Submit a vote for a series
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
 *               - score
 *             properties:
 *               series_id:
 *                 type: string
 *               score:
 *                 type: number
 *                 minimum: 1
 *                 maximum: 10
 *               comment:
 *                 type: string
 *     responses:
 *       201:
 *         description: Vote submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Vote'
 *                 seriesStats:
 *                   type: object
 *                   properties:
 *                     average_score:
 *                       type: number
 *                     total_votes:
 *                       type: integer
 *       400:
 *         description: Validation error
 *       404:
 *         description: Series not found
 */
// ─── POST /reader/votes ───────────────────────────────────────────────────────
// Reader vote cho series
// Body: { series_id, score, comment }
router.post("/votes", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { series_id, score, comment } = req.body;

    if (!series_id || score === undefined) {
      return next(new AppError("series_id and score are required", 400));
    }
    if (score < 1 || score > 10) {
      return next(new AppError("Score must be between 1 and 10", 400));
    }

    const series = await Series.findOne({ _id: series_id, is_public: true });
    if (!series) return next(new AppError("Series not found", 404));

    const release_period = getCurrentPeriod();

    const vote = await Vote.findOneAndUpdate(
      { series_id, reader_id: req.user.nameid, release_period },
      { score, comment: comment || "", release_period },
      { upsert: true, new: true }
    );

    // Tính lại average
    const allVotes = await Vote.find({ series_id, release_period });
    const avg = allVotes.reduce((s, v) => s + v.score, 0) / allVotes.length;
    series.average_score = Math.round(avg * 10) / 10;
    series.total_votes = allVotes.length;
    await series.save();

    return res.status(201).json({
      success: true,
      data: vote,
      seriesStats: {
        average_score: series.average_score,
        total_votes: series.total_votes,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/votes/mine:
 *   get:
 *     tags: [Readers]
 *     summary: Get current user's votes
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: series_id
 *         schema:
 *           type: string
 *         description: Filter by series ID (optional)
 *     responses:
 *       200:
 *         description: User's votes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Vote'
 *       401:
 *         description: Unauthorized
 */
// ─── GET /reader/votes/mine ──────────────────────────────────────────────────
// Reader xem vote của mình
router.get("/votes/mine", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { series_id } = req.query;
    const filter = { reader_id: req.user.nameid };
    if (series_id) filter.series_id = series_id;

    const votes = await Vote.find(filter)
      .populate("series_id", "name genre")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: votes });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
