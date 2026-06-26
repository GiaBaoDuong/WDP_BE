const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireEB, requireMangaka } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const EBEvaluation = require("../models/EBEvaluation");
const Notification = require("../models/Notification");
const Vote = require("../models/Vote");
const {
  notifySeriesApproved,
  notifyRankingWarning,
  notifyChapterEBRevision,
  notifyChapterScheduledPublish,
  notifyChapterPublishConfirmed,
  notifySeriesPublished,
} = require("../services/notificationService");
const {
  EB_CRITERIA_KEYS,
  EB_RESULT_LABELS,
  EB_RESULT_LABEL_TEXT,
  EB_EVALUATION_STATUS,
  NOTIF_TYPES,
} = require("../utils/constants");

// ─── Helper: phân loại kết quả theo phổ điểm ────────────────────────────────
const classifyByScore = (councilAvg) => {
  if (councilAvg < 2.5) return EB_RESULT_LABELS.NOT_PASS;
  if (councilAvg < 3.5) return EB_RESULT_LABELS.PASS;
  if (councilAvg < 4.25) return EB_RESULT_LABELS.GOOD;
  return EB_RESULT_LABELS.EXCELLENT;
};

const classifyText = (councilAvg) => {
  const label = classifyByScore(councilAvg);
  return EB_RESULT_LABEL_TEXT[label] || "";
};

// ─── Helper: xác định lịch xuất bản theo phỏng điểm ──────────────────────
const defaultScheduleByScore = (councilAvg) => {
  const classification = classifyByScore(councilAvg);
  if (classification === EB_RESULT_LABELS.PASS) return "monthly";
  if (classification === EB_RESULT_LABELS.GOOD || classification === EB_RESULT_LABELS.EXCELLENT) return "weekly";
  return null;
};

const durationDaysBySchedule = (schedule) => {
  if (schedule === "weekly") return 7;
  if (schedule === "monthly") return 30;
  return null;
};

/**
 * @swagger
 * /eb-evaluations/pending:
 *   get:
 *     tags: [EBEvaluations]
 *     summary: Get pending chapters for EB evaluation
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of pending chapters
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
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - EB role required
 */
// ─── GET /eb-evaluations/pending ─────────────────────────────────────────────
// EB xem chapter đang chờ duyệt, kèm điểm tổng hợp nếu đã có
router.get("/pending", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const chapters = await Chapter.find({ status: "pending_EB" })
      .populate("submitted_by", "username full_name phoneNumber")
      .populate("series_id", "name status publication_schedule")
      .sort({ updatedAt: 1 })
      .lean();

    // Gắn điểm EB mới nhất vào từng chapter
    const chaptersWithScores = await Promise.all(
      chapters.map(async (ch) => {
        const ev = await EBEvaluation.findOne({ chapter_id: ch._id })
          .sort({ createdAt: -1 })
          .lean();

        let councilAvg = 0;
        let classification = null;
        let classificationText = "";
        if (ev && ev.member_scores && ev.member_scores.length > 0) {
          const totals = {};
          EB_CRITERIA_KEYS.forEach((k) => {
            totals[k] = ev.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
          });
          const avgTotals = {};
          EB_CRITERIA_KEYS.forEach((k) => {
            avgTotals[k] = Math.round((totals[k] / ev.member_scores.length) * 100) / 100;
          });
          councilAvg =
            Math.round(
              (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
            ) / 100;
          classification = classifyByScore(councilAvg);
          classificationText = classifyText(councilAvg);
        }

        return {
          ...ch,
          council_average: councilAvg,
          classification,
          classification_text: classificationText,
          evaluation_id: ev?._id || null,
          evaluation_status: ev?.status || null,
          evaluation_locked: ev?.status === EB_EVALUATION_STATUS.LOCKED,
        };
      })
    );

    return res.status(200).json({ success: true, data: chaptersWithScores });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/series/{seriesId}/evaluate:
 *   post:
 *     tags: [EBEvaluations]
 *     summary: EB evaluates a series (first review or quick review)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               member_scores:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     content_script:
 *                       type: number
 *                     art:
 *                       type: number
 *                     characters:
 *                       type: number
 *                     commercial_potential:
 *                       type: number
 *                     publisher_fit:
 *                       type: number
 *               result:
 *                 type: string
 *                 enum: [approved, revision, rejected]
 *               publication_schedule:
 *                 type: string
 *               notes:
 *                 type: string
 *               quick_decision:
 *                 type: string
 *                 enum: [approved, revision, rejected]
 *               quick_notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Evaluation submitted successfully
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
 *                     series:
 *                       $ref: '#/components/schemas/Series'
 *                     evaluation:
 *                       $ref: '#/components/schemas/EBEvaluation'
 *       400:
 *         description: Validation error
 *       404:
 *         description: Series not found
 */
// ─── POST /eb-evaluations/series/:seriesId/evaluate ─────────────────────────
// EB đánh giá series (lần đầu: chấm điểm chi tiết; lần sau: duyệt nhanh)
// Body: { member_scores: [...], result, publication_schedule, notes }
// Hoặc: { quick_decision, quick_notes, result }
router.post("/series/:seriesId/evaluate", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { member_scores, result, publication_schedule, notes, quick_decision, quick_notes, scheduled_publish_at } = req.body;

    const series = await Series.findOne({ _id: req.params.seriesId });
    if (!series) return next(new AppError("Series not found", 404));

    // Kiểm tra lần đầu hay lần sau
    const isFirstReview = series.status === "draft" || series.status === "submitted";

    let evaluation;
    if (isFirstReview) {
      // Lần đầu: bắt buộc có member_scores
      if (!member_scores || !Array.isArray(member_scores) || member_scores.length === 0) {
        return next(new AppError("member_scores is required for first review", 400));
      }
      if (!result) return next(new AppError("result is required", 400));

      // Tính council_average từ member_scores
      const totals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        totals[k] = member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
      });
      const avgTotals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        avgTotals[k] = member_scores.length > 0
          ? Math.round((totals[k] / member_scores.length) * 100) / 100
          : 0;
      });
      const councilAvg =
        Math.round(
          (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
        ) / 100;
      const classification = classifyByScore(councilAvg);

      evaluation = await EBEvaluation.create({
        series_id: series._id,
        evaluated_by: req.user.nameid,
        first_review: true,
        member_scores: member_scores.map((m) => ({
          ...m,
          total_score:
            (m.content_script || 0) +
            (m.art || 0) +
            (m.characters || 0) +
            (m.commercial_potential || 0) +
            (m.publisher_fit || 0),
        })),
        result,
        publication_schedule: result === "approved" ? publication_schedule : null,
        scheduled_publish_at: scheduled_publish_at || null,
        notes: notes || "",
      });

      // Cập nhật series
      series.status = result;
      series.eb_evaluation_id = evaluation._id;
      if (result === "approved") {
        series.is_public = true;
        series.publication_schedule = publication_schedule;
      }
      await series.save();
    } else {
      // Lần sau: duyệt nhanh
      if (!quick_decision) return next(new AppError("quick_decision is required", 400));

      evaluation = await EBEvaluation.create({
        series_id: series._id,
        evaluated_by: req.user.nameid,
        first_review: false,
        quick_decision,
        quick_notes: quick_notes || "",
        result: quick_decision,
        notes: notes || "",
      });

      series.status = quick_decision;
      if (quick_decision === "approved") {
        series.is_public = true;
      }
      await series.save();
    }

    // Notify Mangaka
    if (result === "approved" || quick_decision === "approved") {
      await notifySeriesApproved(
        Notification,
        series.author_id,
        series.name,
        publication_schedule || "weekly"
      );
    }

    return res.status(201).json({ success: true, data: { series, evaluation } });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/chapter/{chapterId}/evaluate:
 *   post:
 *     tags: [EBEvaluations]
 *     summary: EB evaluates a chapter
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chapterId
 *         required: true
 *         schema:
 *           type: string
 *         description: Chapter ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               member_scores:
 *                 type: array
 *                 items:
 *                   type: object
 *               result:
 *                 type: string
 *                 enum: [approved, revision, rejected]
 *               notes:
 *                 type: string
 *               quick_decision:
 *                 type: string
 *                 enum: [approved, revision, rejected]
 *               quick_notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Chapter evaluation submitted
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
 *                     chapter:
 *                       $ref: '#/components/schemas/Chapter'
 *                     evaluation:
 *                       $ref: '#/components/schemas/EBEvaluation'
 *       404:
 *         description: Chapter not found or not pending EB
 */
// ─── POST /eb-evaluations/chapter/:chapterId/evaluate ─────────────────────────
// EB đánh giá chapter với logic:
// - < 2.5 → Không duyệt (EB_revision), ẩn nút xuất bản
// - 2.5 – < 3.5 → Duyệt, xuất bản theo tháng (30 ngày)
// - 3.5 – < 4.25 → Duyệt, xuất bản theo tuần (7 ngày)
// - 4.25 – 5     → Duyệt, xuất bản theo tuần (7 ngày)
// Body: { result: "approved"|"rejected"|"revision", scheduled_publish_at?, notes? }
//       hoặc { quick_decision, quick_notes?, scheduled_publish_at? }
// ─── POST /eb-evaluations/chapter/:chapterId/evaluate ──────────────────────
// EB chấm điểm Series (dùng chapter làm context để lấy series)
// CHỈ lưu EBEvaluation, KHÔNG đổi chapter/series status
router.post("/chapter/:chapterId/evaluate", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { result, notes, quick_decision, quick_notes, scheduled_publish_at } = req.body;

    const chapter = await Chapter.findOne({ _id: req.params.chapterId, status: "pending_EB" });
    if (!chapter) return next(new AppError("Chapter not found or not pending EB", 404));

    const series = await Series.findById(chapter.series_id).lean();
    if (!series) return next(new AppError("Series not found", 404));

    // Tính điểm từ member_scores (nếu có)
    let councilAvg = 0;
    const isFirstReview = series.status === "draft" || series.status === "submitted";
    
    if (isFirstReview && req.body.member_scores) {
      const totals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        totals[k] = req.body.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
      });
      const avgTotals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        avgTotals[k] = req.body.member_scores.length > 0
          ? Math.round((totals[k] / req.body.member_scores.length) * 100) / 100
          : 0;
      });
      councilAvg =
        Math.round(
          (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
        ) / 100;
    } else {
      // Lấy điểm từ evaluation gần nhất
      const latestEval = await EBEvaluation.findOne({ series_id: series._id })
        .sort({ createdAt: -1 })
        .lean();
      if (latestEval && latestEval.member_scores && latestEval.member_scores.length > 0) {
        const totals = {};
        EB_CRITERIA_KEYS.forEach((k) => {
          totals[k] = latestEval.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
        });
        const avgTotals = {};
        EB_CRITERIA_KEYS.forEach((k) => {
          avgTotals[k] = Math.round((totals[k] / latestEval.member_scores.length) * 100) / 100;
        });
        councilAvg =
          Math.round(
            (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
          ) / 100;
      }
    }

    const classification = classifyByScore(councilAvg);
    const classificationText = classifyText(councilAvg);
    const finalResult = result || quick_decision || null;

    // Lưu evaluation mới - CHỈ lưu điểm, không đổi status
    const newEvaluation = await EBEvaluation.create({
      series_id: chapter.series_id,
      chapter_id: chapter._id,
      evaluated_by: req.user.nameid,
      first_review: isFirstReview,
      member_scores: req.body.member_scores || [],
      quick_decision: quick_decision || null,
      quick_notes: quick_notes || "",
      result: finalResult,
      scheduled_publish_at: scheduled_publish_at || null,
      notes: notes || "",
      status: EB_EVALUATION_STATUS.LOCKED,
    });

    return res.status(201).json({
      success: true,
      data: {
        evaluation: newEvaluation,
        classification,
        classification_text: classificationText,
        council_average: councilAvg,
        message: councilAvg >= 2.5 || finalResult === "approved" 
          ? "Điểm đã được lưu. Series đủ điều kiện xuất bản." 
          : "Điểm thấp hơn 2.5. Series chưa đủ điều kiện xuất bản.",
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/series/{seriesId}:
 *   get:
 *     tags: [EBEvaluations]
 *     summary: Get evaluation history for a series
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     responses:
 *       200:
 *         description: Evaluation history
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
 *                     $ref: '#/components/schemas/EBEvaluation'
 */
// ─── GET /eb-evaluations/series/:seriesId ─────────────────────────────────────
// Xem lịch sử đánh giá của 1 series
router.get("/series/:seriesId", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const evaluations = await EBEvaluation.find({ series_id: req.params.seriesId })
      .populate("evaluated_by", "username full_name phoneNumber")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: evaluations });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/series/{seriesId}/decision:
 *   patch:
 *     tags: [EBEvaluations]
 *     summary: EB makes decision on an approved series
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *         description: Series ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - decision
 *             properties:
 *               decision:
 *                 type: string
 *                 enum: [continue, cancelled, change_schedule]
 *               schedule:
 *                 type: string
 *                 description: Required when decision is change_schedule
 *     responses:
 *       200:
 *         description: Decision updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Series'
 *       400:
 *         description: decision is required
 *       404:
 *         description: Series not found or not approved
 */
// ─── PATCH /eb-evaluations/series/:seriesId/decision ─────────────────────────
// EB ra quyết định với series đang xuất bản
// Body: { decision: "continue"|"cancelled"|"change_schedule", schedule }
router.patch("/series/:seriesId/decision", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { decision, schedule } = req.body;
    if (!decision) return next(new AppError("decision is required", 400));

    const series = await Series.findOne({ _id: req.params.seriesId, status: "approved" });
    if (!series) return next(new AppError("Series not found or not approved", 404));

    if (decision === "cancelled") {
      series.status = "cancelled";
      series.is_public = false;
      await series.save();

      await notifyRankingWarning(
        Notification,
        series.author_id,
        series.name,
        "N/A"
      );
    } else if (decision === "change_schedule" && schedule) {
      series.publication_schedule = schedule;
      await series.save();
    }

    return res.status(200).json({ success: true, data: series });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /eb-evaluations/votes/confirm:
 *   post:
 *     tags: [EBEvaluations]
 *     summary: EB confirms/updates reader votes for a series
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
 *               - release_period
 *               - votes
 *             properties:
 *               series_id:
 *                 type: string
 *               release_period:
 *                 type: string
 *               votes:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     reader_id:
 *                       type: string
 *                     score:
 *                       type: number
 *                     comment:
 *                       type: string
 *     responses:
 *       200:
 *         description: Votes confirmed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *       400:
 *         description: series_id, release_period, votes are required
 */
// ─── POST /eb-evaluations/votes/confirm ───────────────────────────────────────
// EB xác nhận/cập nhật dữ liệu vote từ Reader
// Body: { series_id, release_period, votes: [{reader_id, score, comment}] }
router.post("/votes/confirm", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { series_id, release_period, votes } = req.body;
    if (!series_id || !release_period || !votes) {
      return next(new AppError("series_id, release_period, votes are required", 400));
    }

    const results = await Promise.all(
      votes.map((v) =>
        Vote.findOneAndUpdate(
          { series_id, reader_id: v.reader_id, release_period },
          { score: v.score, comment: v.comment || "" },
          { upsert: true, returnDocument: "after" }
        )
      )
    );

    // Tính lại average_score và total_votes
    const seriesVotes = await Vote.find({ series_id, release_period });
    const avg =
      seriesVotes.reduce((s, v) => s + v.score, 0) / (seriesVotes.length || 1);
    await Series.findByIdAndUpdate(series_id, {
      average_score: Math.round(avg * 10) / 10,
      total_votes: seriesVotes.length,
    });

    return res.status(200).json({ success: true, data: results });
  } catch (error) {
    next(error);
  }
});

// ─── POST /eb-evaluations/chapter/:chapterId/confirm-publish ─────────────────
// EB xác nhận xuất bản Series sau khi đã chấm điểm
// Kiểm tra điểm >= 2.5 trước khi cho publish
router.post("/chapter/:chapterId/confirm-publish", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { scheduled_publish_at } = req.body;

    const chapter = await Chapter.findOne({ _id: req.params.chapterId });
    if (!chapter) return next(new AppError("Chapter not found", 404));

    const series = await Series.findById(chapter.series_id);
    if (!series) return next(new AppError("Series not found", 404));

    // Lấy evaluation mới nhất để kiểm tra điểm
    const latestEval = await EBEvaluation.findOne({ series_id: series._id })
      .sort({ createdAt: -1 })
      .lean();
    
    if (!latestEval) {
      return next(new AppError("Chưa có đánh giá nào. Vui lòng chấm điểm trước.", 400));
    }

    // Tính council_average từ member_scores
    let councilAvg = 0;
    if (latestEval.member_scores && latestEval.member_scores.length > 0) {
      const totals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        totals[k] = latestEval.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
      });
      const avgTotals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        avgTotals[k] = Math.round((totals[k] / latestEval.member_scores.length) * 100) / 100;
      });
      councilAvg =
        Math.round(
          (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
        ) / 100;
    }

    // Kiểm tra điểm >= 2.5 mới cho publish
    if (councilAvg < 2.5) {
      return next(new AppError(`Điểm ${councilAvg} thấp hơn 2.5. Series chưa đủ điều kiện xuất bản.`, 400));
    }

    // Cập nhật Series thành published - KHÔNG đổi chapter status
    series.status = "published";
    series.publication_schedule = scheduled_publish_at || series.publication_schedule;
    await series.save();

    // Gửi thông báo cho Mangaka
    await notifySeriesPublished(Notification, series.author_id, series, scheduled_publish_at);

    return res.status(200).json({
      success: true,
      data: {
        series: {
          _id: series._id,
          name: series.name,
          status: series.status,
          publication_schedule: series.publication_schedule,
        },
        council_average: councilAvg,
        message: "Series đã được xuất bản thành công.",
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
