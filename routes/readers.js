const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireReader } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Vote = require("../models/Vote");
const { SCORE_LABELS } = require("../models/Vote");
const Page = require("../models/Page");
const Bookshelf = require("../models/Bookshelf");
const ReadingHistory = require("../models/ReadingHistory");
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
// Query params:
//   - genre    : string | string[]  → lọc theo 1 hoặc nhiều genre (match trong mảng `genre` của Series)
//   - tags     : string | string[]  → lọc theo 1 hoặc nhiều tag   (match trong mảng `tags`  của Series)
//   - title    : string             → regex search theo `name`
//   - sort     : string             → field để sort, default 'average_score'
//   - page     : int                → trang, default 1
//   - limit    : int                → số item/trang, default 20
router.get("/series", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { title, sort = "average_score", page = 1, limit = 20 } = req.query;

    // Genre: chấp nhận string, CSV, hoặc mảng query (?genre=A&genre=B)
    const rawGenres = req.query.genre;
    const { GENRES } = require("../models/Series");
    let genreArr = [];
    if (rawGenres !== undefined) {
      genreArr = Array.isArray(rawGenres)
        ? rawGenres
        : String(rawGenres).split(",").map((g) => g.trim()).filter(Boolean);
      // Loại bỏ genre không nằm trong whitelist để tránh query vô nghĩa trả 0 kết quả
      genreArr = genreArr.filter((g) => GENRES.includes(g));
    }

    // Tags: CSV hoặc mảng
    const rawTags = req.query.tags;
    let tagArr = [];
    if (rawTags !== undefined) {
      tagArr = Array.isArray(rawTags)
        ? rawTags
        : String(rawTags).split(",").map((t) => t.trim()).filter(Boolean);
    }

    const filter = { is_public: true, status: "published" };
    if (genreArr.length > 0) filter.genre = { $in: genreArr };
    if (tagArr.length > 0) filter.tags = { $in: tagArr };
    if (title) filter.name = { $regex: String(title), $options: "i" };

    const [series, total] = await Promise.all([
      Series.find(filter)
        .populate("author_id", "username full_name phoneNumber avatar_url")
        .sort({ [sort]: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Series.countDocuments(filter),
    ]);

    // Enrich: gắn total_chapters đã publish cho từng series
    const seriesIds = series.map((s) => s._id);
    const chapterCounts = await Chapter.aggregate([
      { $match: { series_id: { $in: seriesIds }, is_published: true } },
      { $group: { _id: "$series_id", count: { $sum: 1 }, latest_chapter_number: { $max: "$chapter_number" } } },
    ]);
    const countMap = new Map(chapterCounts.map((c) => [String(c._id), c]));

    const enriched = series.map((s) => {
      const stats = countMap.get(String(s._id));
      return {
        ...s,
        total_chapters: stats?.count || 0,
        latest_chapter_number: stats?.latest_chapter_number || null,
      };
    });

    return res.status(200).json({
      success: true,
      data: enriched,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/genres:
 *   get:
 *     tags: [Readers]
 *     summary: Get the whitelist of valid genres for Series
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Array of genre names that are accepted by Series model
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { type: string }
 */
// ─── GET /reader/genres ─────────────────────────────────────────────────────
// Trả về whitelist thể loại hợp lệ của Series (Series.GENRES) — client dùng để render checkbox lọc.
router.get("/genres", authMiddleware, requireReader, (req, res) => {
  const { GENRES } = require("../models/Series");
  return res.status(200).json({ success: true, data: GENRES });
});

/**
 * @swagger
 * /reader/tags:
 *   get:
 *     tags: [Readers]
 *     summary: Get distinct tags currently used by published series
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Sorted distinct tags collected from published public series
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: array
 *                   items: { type: string }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Reader role required
 */
// ─── GET /reader/tags ───────────────────────────────────────────────────────
// Trả về danh sách tag hiện đang được sử dụng bởi các series public & published.
// Dùng distinct để chỉ trả tag thật (không kèm whitelist cứng).
router.get("/tags", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const tags = await Series.distinct("tags", {
      is_public: true,
      status: "published",
      tags: { $exists: true, $ne: [] },
    });
    const cleaned = (Array.isArray(tags) ? tags : [])
      .filter(Boolean)
      .map((t) => String(t).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "vi"));
    return res.status(200).json({ success: true, data: cleaned });
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
      .populate("author_id", "username full_name phoneNumber avatar_url")
      .lean();

    if (!series) return next(new AppError("Series not found", 404));

    // Enrich: total_chapters đã publish + latest_chapter
    const [chapterStats, latestChapter] = await Promise.all([
      Chapter.aggregate([
        { $match: { series_id: series._id, is_published: true } },
        { $group: { _id: null, count: { $sum: 1 }, latest_chapter_number: { $max: "$chapter_number" } } },
      ]),
      Chapter.findOne({ series_id: series._id, is_published: true })
        .sort({ chapter_number: -1 })
        .select("_id chapter_number title published_at")
        .lean(),
    ]);

    const enriched = {
      ...series,
      total_chapters: chapterStats[0]?.count || 0,
      latest_chapter_number: chapterStats[0]?.latest_chapter_number || null,
      latest_chapter: latestChapter || null,
    };

    return res.status(200).json({ success: true, data: enriched });
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
      data: chapters.map((c) => ({
        _id: c._id,
        chapter_number: c.chapter_number,
        title: c.title,
        published_at: c.published_at,
        views_count: c.views_count || 0,
        submitted_by: c.submitted_by,
      })),
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
 *                 maximum: 5
 *                 description: Score from 1 to 5 (1=Rất dở, 2=Dở, 3=Bình thường, 4=Hay, 5=Xuất sắc)
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
    if (score < 1 || score > 5) {
      return next(new AppError("Score must be between 1 and 5", 400));
    }

    const series = await Series.findOne({ _id: series_id, is_public: true });
    if (!series) return next(new AppError("Series not found", 404));

    const release_period = getCurrentPeriod();
    const score_label = SCORE_LABELS[score] || "Bình thường";

    const vote = await Vote.findOneAndUpdate(
      { series_id, reader_id: req.user.nameid, release_period },
      { score, score_label, comment: comment || "", release_period },
      { upsert: true, returnDocument: "after" }
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
      score_label,
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

// ─── GET /reader/chapters/:id/pages ──────────────────────────────────────────
/**
 * @swagger
 * /reader/chapters/{id}/pages:
 *   get:
 *     tags: [Readers]
 *     summary: Get pages for reading a chapter
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
 *         description: List of pages for the chapter
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
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       page_number:
 *                         type: integer
 *                       final_image_url:
 *                         type: string
 *                       width:
 *                         type: integer
 *                       height:
 *                         type: integer
 *                 chapter:
 *                   type: object
 *                   properties:
 *                     _id:
 *                       type: string
 *                     chapter_number:
 *                       type: integer
 *                     title:
 *                       type: string
 *                 series:
 *                   type: object
 *                   properties:
 *                     _id:
 *                       type: string
 *                     name:
 *                       type: string
 *       404:
 *         description: Chapter not found or not published
 */
// Reader lấy danh sách pages để đọc truyện
router.get("/chapters/:id/pages", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.id,
      is_published: true,
    })
      .populate("series_id", "name")
      .lean();

    if (!chapter) {
      return next(new AppError("Chapter not found or not published", 404));
    }

    const pages = await Page.find({ chapter_id: req.params.id })
      .select("page_number final_image_url width height")
      .sort({ page_number: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: pages,
      chapter: {
        _id: chapter._id,
        chapter_number: chapter.chapter_number,
        title: chapter.title,
      },
      series: {
        _id: chapter.series_id._id,
        name: chapter.series_id.name,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /reader/chapters/:id/view ──────────────────────────────────────────
// Reader đánh dấu 1 lượt đọc cho chapter (mobile chỉ gọi sau khi đọc ≥ 15s).
// - Tăng `Chapter.views_count` bằng `$inc` để tránh race condition.
// - Trả về `views_count` mới để mobile cập nhật cache ngay.
router.post("/chapters/:id/view", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOneAndUpdate(
      { _id: req.params.id, is_published: true },
      { $inc: { views_count: 1 } },
      { new: true, projection: { _id: 1, views_count: 1, series_id: 1 } }
    ).lean();

    if (!chapter) {
      return next(new AppError("Chapter not found or not published", 404));
    }

    return res.status(200).json({
      success: true,
      data: {
        chapter_id: chapter._id,
        series_id: chapter.series_id,
        views_count: chapter.views_count,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// READING HISTORY - Lịch sử đọc của reader (lưu DB, dùng chung cho mọi thiết bị)
// ════════════════════════════════════════════════════════════════════════════

const READING_HISTORY_DEFAULT_LIMIT = 50;
const READING_HISTORY_MAX_LIMIT = 100;

/**
 * @swagger
 * /reader/history:
 *   get:
 *     tags: [Readers]
 *     summary: Lấy lịch sử đọc của reader hiện tại (sort theo read_at desc)
 *     security:
 *       - BearerAuth: []
 */
router.get("/history", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const limit = Math.min(
      READING_HISTORY_MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit) || READING_HISTORY_DEFAULT_LIMIT)
    );

    const items = await ReadingHistory.find({ reader_id: req.user.nameid })
      .sort({ read_at: -1 })
      .limit(limit)
      .populate({
        path: "series_id",
        select:
          "name cover_image_url genre total_chapters views_count status is_public",
        populate: { path: "author_id", select: "username full_name avatar_url" },
      })
      .lean();

    // Bỏ các entry có series đã bị ẩn / gỡ
    const data = items
      .filter((it) => it.series_id && it.series_id.is_public && it.series_id.status === "published")
      .map((it) => ({
        _id: it._id,
        series_id: it.series_id._id,
        last_read_chapter: it.last_read_chapter || 0,
        read_at: it.read_at,
        series: it.series_id,
      }));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/history:
 *   post:
 *     tags: [Readers]
 *     summary: Ghi nhận / cập nhật lịch sử đọc (idempotent theo (reader, series))
 */
router.post("/history", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { series_id, last_read_chapter } = req.body;
    if (!series_id) {
      return next(new AppError("series_id is required", 400));
    }

    const series = await Series.findOne({
      _id: series_id,
      is_public: true,
      status: "published",
    }).select("_id");
    if (!series) {
      return next(new AppError("Series not found or not published", 404));
    }

    const chapterNum = Number.isFinite(Number(last_read_chapter))
      ? Math.max(0, parseInt(last_read_chapter))
      : 0;

    const entry = await ReadingHistory.findOneAndUpdate(
      { reader_id: req.user.nameid, series_id },
      {
        $set: { last_read_chapter: chapterNum, read_at: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    return res.status(200).json({
      success: true,
      data: {
        _id: entry._id,
        series_id,
        last_read_chapter: entry.last_read_chapter,
        read_at: entry.read_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/history/:seriesId", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const result = await ReadingHistory.findOneAndDelete({
      reader_id: req.user.nameid,
      series_id: req.params.seriesId,
    }).lean();

    return res.status(200).json({
      success: true,
      removed: !!result,
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/history", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const result = await ReadingHistory.deleteMany({
      reader_id: req.user.nameid,
    });

    return res.status(200).json({
      success: true,
      deleted: result.deletedCount || 0,
    });
  } catch (error) {
    next(error);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// BOOKSHELF - Tủ sách của reader
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /reader/bookshelf:
 *   get:
 *     tags: [Readers]
 *     summary: Lấy danh sách truyện trong tủ sách của reader hiện tại
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
 *         description: Danh sách truyện đã lưu (kèm thông tin series & số chapter đã publish)
 *       401:
 *         description: Unauthorized
 */
// ─── GET /reader/bookshelf ──────────────────────────────────────────────────
// Reader lấy danh sách truyện đã lưu vào tủ sách
router.get("/bookshelf", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      Bookshelf.find({ reader_id: req.user.nameid })
        .sort({ added_at: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate({
          path: "series_id",
          select: "name cover_image_url genre author_id status is_public",
          populate: { path: "author_id", select: "username full_name avatar_url" },
        })
        .lean(),
      Bookshelf.countDocuments({ reader_id: req.user.nameid }),
    ]);

    // Chỉ trả về các series vẫn còn public + published
    const validSeriesIds = items
      .filter((it) => it.series_id && it.series_id.is_public && it.series_id.status === "published")
      .map((it) => it.series_id._id);

    const chapterStats = await Chapter.aggregate([
      { $match: { series_id: { $in: validSeriesIds }, is_published: true } },
      {
        $group: {
          _id: "$series_id",
          count: { $sum: 1 },
          latest_chapter_number: { $max: "$chapter_number" },
        },
      },
    ]);
    const statsMap = new Map(chapterStats.map((c) => [String(c._id), c]));

    const data = items
      .filter((it) => it.series_id && it.series_id.is_public && it.series_id.status === "published")
      .map((it) => {
        const stats = statsMap.get(String(it.series_id._id));
        return {
          _id: it._id,
          added_at: it.added_at,
          series: {
            ...it.series_id,
            total_chapters: stats?.count || 0,
            latest_chapter_number: stats?.latest_chapter_number || null,
          },
        };
      });

    return res.status(200).json({
      success: true,
      data,
      pagination: { total, page: pageNum, limit: limitNum },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/bookshelf:
 *   post:
 *     tags: [Readers]
 *     summary: Thêm 1 truyện vào tủ sách (idempotent)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [series_id]
 *             properties:
 *               series_id:
 *                 type: string
 *     responses:
 *       201:
 *         description: Đã thêm vào tủ sách
 *       200:
 *         description: Truyện đã có sẵn trong tủ sách (idempotent)
 *       404:
 *         description: Series không tồn tại / chưa publish
 *       400:
 *         description: Thiếu series_id
 */
// ─── POST /reader/bookshelf ─────────────────────────────────────────────────
// Reader thêm truyện vào tủ sách
// Body: { series_id }
router.post("/bookshelf", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { series_id } = req.body;
    if (!series_id) return next(new AppError("series_id is required", 400));

    const series = await Series.findOne({
      _id: series_id,
      is_public: true,
      status: "published",
    }).select("_id");
    if (!series) return next(new AppError("Series not found or not published", 404));

    try {
      const item = await Bookshelf.create({
        reader_id: req.user.nameid,
        series_id,
      });
      return res.status(201).json({
        success: true,
        data: item,
        in_bookshelf: true,
        message: "Added to bookshelf",
      });
    } catch (err) {
      // Duplicate key -> đã có sẵn, idempotent
      if (err && err.code === 11000) {
        const existing = await Bookshelf.findOne({
          reader_id: req.user.nameid,
          series_id,
        }).lean();
        return res.status(200).json({
          success: true,
          data: existing,
          in_bookshelf: true,
          message: "Already in bookshelf",
        });
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/bookshelf/{seriesId}:
 *   delete:
 *     tags: [Readers]
 *     summary: Xóa 1 truyện khỏi tủ sách
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Đã xóa khỏi tủ (hoặc không tồn tại)
 *       401:
 *         description: Unauthorized
 */
// ─── DELETE /reader/bookshelf/:seriesId ─────────────────────────────────────
// Reader xóa truyện khỏi tủ sách
router.delete("/bookshelf/:seriesId", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const result = await Bookshelf.findOneAndDelete({
      reader_id: req.user.nameid,
      series_id: req.params.seriesId,
    }).lean();

    return res.status(200).json({
      success: true,
      removed: !!result,
      in_bookshelf: false,
      message: result ? "Removed from bookshelf" : "Was not in bookshelf",
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /reader/bookshelf/check:
 *   get:
 *     tags: [Readers]
 *     summary: Kiểm tra 1 danh sách series_id có nằm trong tủ sách không
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: series_ids
 *         schema:
 *           type: string
 *         description: Danh sách series_id phân cách bằng dấu phẩy
 *         required: true
 *     responses:
 *       200:
 *         description: Object map series_id sang boolean (true = trong tủ, false = chưa có)
 *       400:
 *         description: Thiếu series_ids
 */
// ─── GET /reader/bookshelf/check?series_ids=id1,id2 ──────────────────────────
// Reader kiểm tra nhiều series cùng lúc có trong tủ sách không
router.get("/bookshelf/check", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const raw = req.query.series_ids;
    if (!raw) return next(new AppError("series_ids is required", 400));

    const ids = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return next(new AppError("series_ids is required", 400));

    const saved = await Bookshelf.find({
      reader_id: req.user.nameid,
      series_id: { $in: ids },
    })
      .select("series_id")
      .lean();

    const savedSet = new Set(saved.map((s) => String(s.series_id)));
    const map = {};
    ids.forEach((id) => {
      map[id] = savedSet.has(id);
    });

    return res.status(200).json({ success: true, data: map });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
