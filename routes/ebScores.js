const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireEB } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const Page = require("../models/Page");
const EBEvaluation = require("../models/EBEvaluation");
const User = require("../models/User");
const Notification = require("../models/Notification");
const {
  EB_CRITERIA_KEYS,
  EB_SCORE_MIN,
  EB_SCORE_MAX,
  EB_SCORE_STEP,
  EB_EVALUATION_STATUS,
  EB_RESULT_LABELS,
  EB_RESULT_LABEL_TEXT,
  EB_EDIT_WINDOW_HOURS,
} = require("../utils/constants");

// ─── Validation helpers ───────────────────────────────────────────────────────

const isValidScore = (v) =>
  v !== undefined &&
  typeof v === "number" &&
  v >= EB_SCORE_MIN &&
  v <= EB_SCORE_MAX &&
  (v * 2) % 1 === 0;

const validateScores = (scores) => {
  if (!scores || typeof scores !== "object") return false;
  for (const key of EB_CRITERIA_KEYS) {
    if (!isValidScore(scores[key])) return false;
  }
  return true;
};

const calcAverage = (scores) => {
  const sum = EB_CRITERIA_KEYS.reduce((acc, k) => acc + (scores[k] || 0), 0);
  return Math.round((sum / EB_CRITERIA_KEYS.length) * 100) / 100;
};

const classifyResult = (avg) => {
  if (avg < 2.5) return EB_RESULT_LABELS.NOT_PASS;
  if (avg < 3.5) return EB_RESULT_LABELS.PASS;
  if (avg < 4.25) return EB_RESULT_LABELS.GOOD;
  return EB_RESULT_LABELS.EXCELLENT;
};

const getResultText = (avg) => {
  const label = classifyResult(avg);
  return EB_RESULT_LABEL_TEXT[label] || "";
};

// ─── GET /eb-scores/series/:seriesId/chapters ────────────────────────────────
// EB chọn series đang chấm → trả danh sách chapter ở trạng thái pending_EB
// kèm cover_image, page_count, submitted_at
router.get("/series/:seriesId/chapters", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const series = await Series.findById(req.params.seriesId).lean();
    if (!series) return next(new AppError("Series not found", 404));

    const chapters = await Chapter.find({
      series_id: req.params.seriesId,
      status: "pending_EB",
    })
      .populate("submitted_by", "username full_name")
      .sort({ chapter_number: 1 })
      .lean();

    const chaptersWithPages = await Promise.all(
      chapters.map(async (ch) => {
        const pageCount = await Page.countDocuments({ chapter_id: ch._id });
        const pages = await Page.find({ chapter_id: ch._id })
          .select("result_image_url page_number")
          .sort({ page_number: 1 })
          .limit(5)
          .lean();
        return {
          ...ch,
          page_count: pageCount,
          preview_urls: pages.map((p) => p.result_image_url || p.original_image_url),
        };
      })
    );

    return res.status(200).json({
      success: true,
      data: {
        series: {
          _id: series._id,
          name: series.name,
          cover_image_url: series.cover_image_url,
          status: series.status,
        },
        chapters: chaptersWithPages,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /eb-scores/series/:seriesId/pending-chapters ─────────────────────────
// EB xem TẤT CẢ series có chapter đang chờ chấm (pending_EB)
// Dùng cho dropdown "series đang chấm"
router.get("/series/pending", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const pendingChapters = await Chapter.find({ status: "pending_EB" })
      .populate("series_id", "name cover_image_url status")
      .populate("submitted_by", "username full_name")
      .sort({ updatedAt: -1 })
      .lean();

    // Gom nhóm theo series
    const seriesMap = new Map();
    for (const ch of pendingChapters) {
      const sid = ch.series_id._id.toString();
      if (!seriesMap.has(sid)) {
        seriesMap.set(sid, {
          series: ch.series_id,
          chapters: [],
        });
      }
      seriesMap.get(sid).chapters.push(ch);
    }

    return res.status(200).json({
      success: true,
      data: Array.from(seriesMap.values()),
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /eb-scores/chapter/:chapterId/preview ─────────────────────────────────
// Hiện ảnh preview của chapter từ TE submit
router.get("/chapter/:chapterId/preview", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      status: { $in: ["pending_EB", "EB_revision"] },
    })
      .populate("series_id", "name cover_image_url")
      .populate("submitted_by", "username full_name")
      .lean();

    if (!chapter) return next(new AppError("Chapter not found or not pending EB", 404));

    const pages = await Page.find({ chapter_id: chapter._id })
      .select("original_image_url result_image_url page_number status")
      .sort({ page_number: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        chapter: {
          _id: chapter._id,
          chapter_number: chapter.chapter_number,
          title: chapter.title,
          status: chapter.status,
        },
        series: chapter.series_id,
        submitted_by: chapter.submitted_by,
        pages: pages.map((p) => ({
          _id: p._id,
          page_number: p.page_number,
          image_url: p.result_image_url || p.original_image_url,
          status: p.status,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /eb-scores/chapter/:chapterId/summary ─────────────────────────────────
// Bảng thống kê điểm thành viên hội đồng + bảng điểm tổng hợp
router.get("/chapter/:chapterId/summary", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const chapter = await Chapter.findById(req.params.chapterId).lean();
    if (!chapter) return next(new AppError("Chapter not found", 404));

    // Lấy evaluation mới nhất cho chapter này
    const evaluation = await EBEvaluation.findOne({ chapter_id: chapter._id })
      .sort({ createdAt: -1 })
      .lean();

    const series = await Series.findById(chapter.series_id).lean();

    // Bảng 1: thống kê điểm từng thành viên
    const memberStats = evaluation
      ? evaluation.member_scores.map((m) => ({
          member_name: m.member_name,
          scores: m.scores,
          average: m.average,
          overall_comment: m.overall_comment,
          saved_at: m.saved_at,
        }))
      : [];

    // Bảng 2: điểm tổng hợp hội đồng
    let aggregate = null;
    if (evaluation && evaluation.member_scores.length > 0) {
      const totals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        totals[k] = evaluation.member_scores.reduce((acc, m) => acc + (m.scores?.[k] || 0), 0);
      });
      const avgTotals = {};
      EB_CRITERIA_KEYS.forEach((k) => {
        avgTotals[k] = Math.round((totals[k] / evaluation.member_scores.length) * 100) / 100;
      });
      const councilAvg =
        Math.round(
          (EB_CRITERIA_KEYS.reduce((acc, k) => acc + avgTotals[k], 0) / EB_CRITERIA_KEYS.length) * 100
        ) / 100;

      aggregate = {
        scores_per_criteria: avgTotals,
        council_average: councilAvg,
        total_score: Math.round(councilAvg * EB_CRITERIA_KEYS.length * 100) / 100,
        label_code: classifyResult(councilAvg),
        label_text: getResultText(councilAvg),
        member_count: evaluation.member_scores.length,
        can_approve: classifyResult(councilAvg) !== EB_RESULT_LABELS.NOT_PASS,
        is_locked: evaluation.status === EB_EVALUATION_STATUS.LOCKED,
      };
    }

    return res.status(200).json({
      success: true,
      data: {
        chapter_id: chapter._id,
        series_id: chapter.series_id,
        series_name: series?.name || "",
        evaluation_id: evaluation?._id || null,
        evaluation_status: evaluation?.status || null,
        story_type: evaluation?.story_type || "",
        member_stats: memberStats,
        aggregate,
        edit_window: evaluation?.last_saved_at
          ? (() => {
              const elapsedMs = Date.now() - new Date(evaluation.last_saved_at).getTime();
              const windowMs = EB_EDIT_WINDOW_HOURS * 60 * 60 * 1000;
              const remainingMs = Math.max(0, windowMs - elapsedMs);
              return {
                can_edit:
                  evaluation.status !== EB_EVALUATION_STATUS.LOCKED && remainingMs > 0,
                last_saved_at: evaluation.last_saved_at,
                editable_until: new Date(
                  new Date(evaluation.last_saved_at).getTime() + windowMs
                ),
                remaining_hours: Math.floor(remainingMs / (60 * 60 * 1000)),
                remaining_minutes: Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000)),
                window_hours: EB_EDIT_WINDOW_HOURS,
                is_locked: evaluation.status === EB_EVALUATION_STATUS.LOCKED,
              };
            })()
          : {
              can_edit: true,
              last_saved_at: null,
              editable_until: null,
              remaining_hours: EB_EDIT_WINDOW_HOURS,
              remaining_minutes: 0,
              window_hours: EB_EDIT_WINDOW_HOURS,
              is_locked: evaluation?.status === EB_EVALUATION_STATUS.LOCKED,
            },
        criteria_labels: EB_CRITERIA_KEYS.reduce((acc, k) => {
          acc[k] = k
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
          return acc;
        }, {}),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /eb-scores/chapter/:chapterId/save ──────────────────────────────────
// EB đại diện lưu điểm chấm cho cả hội đồng (chỉ 1 tài khoản có quyền)
// Trong vòng EB_EDIT_WINDOW_HOURS (24h) kể từ lần lưu gần nhất → cho phép sửa
// Hết thời gian → 403, phải gọi lock thủ công
router.post("/chapter/:chapterId/save", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const { scores, comments, overall_comment, story_type, result } = req.body;

    // 1. Chỉ user có is_eb_representative = true mới được lưu điểm
    const currentUser = await User.findById(req.user.nameid).lean();
    if (!currentUser || !currentUser.is_eb_representative) {
      return next(
        new AppError(
          "Chỉ tài khoản đại diện EB mới có quyền lưu điểm chấm cho hội đồng",
          403
        )
      );
    }

    // 2. Validate chapter
    const chapter = await Chapter.findOne({
      _id: req.params.chapterId,
      status: { $in: ["pending_EB", "EB_revision"] },
    });
    if (!chapter) return next(new AppError("Chapter not found or not pending EB", 404));

    // 3. Validate scores: 5 tiêu chí, mỗi cái 0–5 step 0.5
    if (!validateScores(scores)) {
      return next(
        new AppError(
          `Each score must be a number between ${EB_SCORE_MIN} and ${EB_SCORE_MAX} with step ${EB_SCORE_STEP}. All 5 criteria are required.`,
          400
        )
      );
    }

    const average = calcAverage(scores);
    const totalScore = Math.round(average * EB_CRITERIA_KEYS.length * 100) / 100;
    const now = new Date();
    const memberName = (currentUser.full_name || currentUser.username).trim();

    // 4. Tìm hoặc tạo evaluation cho chapter này
    let evaluation = await EBEvaluation.findOne({ chapter_id: chapter._id });

    if (!evaluation) {
      const series = await Series.findById(chapter.series_id).lean();
      evaluation = await EBEvaluation.create({
        series_id: chapter.series_id,
        chapter_id: chapter._id,
        evaluated_by: req.user.nameid,
        first_review: series?.status !== "approved",
        story_type: story_type || "",
        status: EB_EVALUATION_STATUS.SCORING,
      });
    } else if (evaluation.status === EB_EVALUATION_STATUS.LOCKED) {
      return next(new AppError("Evaluation đã bị khóa, không thể chỉnh sửa", 400));
    }

    // 5. Kiểm tra 24h edit window — chỉ áp dụng cho lần sửa (không phải lần lưu đầu)
    if (evaluation.last_saved_at) {
      const elapsedMs = now.getTime() - new Date(evaluation.last_saved_at).getTime();
      const elapsedHours = elapsedMs / (1000 * 60 * 60);
      if (elapsedHours > EB_EDIT_WINDOW_HOURS) {
        const remainMs = 0;
        return next(
          new AppError(
            `Đã hết thời gian cho phép chỉnh sửa (${EB_EDIT_WINDOW_HOURS}h). Evaluation cần được khóa thủ công.`,
            403
          )
        );
      }
    }

    // 6. Ghi điểm của đại diện EB vào member_scores[0] (giữ 1 bản ghi duy nhất)
    const memberScore = {
      member_name: memberName,
      member_id: req.user.nameid,
      scores,
      comments: comments || {},
      overall_comment: overall_comment || "",
      average,
      total_score: totalScore,
      saved_at: now,
    };

    if (evaluation.member_scores.length > 0) {
      evaluation.member_scores[0] = memberScore;
    } else {
      evaluation.member_scores.push(memberScore);
    }

    if (story_type) evaluation.story_type = story_type;
    if (result) evaluation.result = result;
    evaluation.status = EB_EVALUATION_STATUS.SAVED;
    evaluation.last_saved_by = req.user.nameid;
    evaluation.last_saved_at = now;
    await evaluation.save();

    // 7. Tính thời gian còn lại có thể sửa
    const remainingMs = Math.max(
      0,
      EB_EDIT_WINDOW_HOURS * 60 * 60 * 1000 - (now.getTime() - now.getTime())
    );
    const remainingHours = EB_EDIT_WINDOW_HOURS; // vừa lưu → còn nguyên 24h
    const editableUntil = new Date(now.getTime() + EB_EDIT_WINDOW_HOURS * 60 * 60 * 1000);

    // 8. Gửi notification về cho Mangaka
    const series = await Series.findById(chapter.series_id).lean();
    const mangakaUser = await User.findById(chapter.submitted_by).lean();

    if (mangakaUser) {
      const { notifyUser } = require("../services/notificationService");
      await notifyUser(Notification, chapter.submitted_by, {
        type: "eb_score_saved",
        title: "EB đã lưu điểm chấm",
        message: `Đại diện EB "${memberName}" đã lưu điểm chấm cho chapter #${chapter.chapter_number} - "${chapter.title}" của series "${series?.name || ""}".`,
        meta: {
          chapter_id: chapter._id,
          series_id: chapter.series_id,
          evaluation_id: evaluation._id,
          member_name: memberName,
          average,
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: "Điểm đã được lưu thành công",
      data: {
        evaluation_id: evaluation._id,
        member_name: memberName,
        scores,
        average,
        total_score: totalScore,
        evaluation_status: evaluation.status,
        edit_window: {
          can_edit: true,
          remaining_hours: remainingHours,
          editable_until: editableUntil,
          window_hours: EB_EDIT_WINDOW_HOURS,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /eb-scores/evaluation/:id/lock ─────────────────────────────────────
// Khóa evaluation → không cho chỉnh sửa nữa
router.patch("/evaluation/:id/lock", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const evaluation = await EBEvaluation.findById(req.params.id);
    if (!evaluation) return next(new AppError("Evaluation not found", 404));

    if (evaluation.status === EB_EVALUATION_STATUS.LOCKED) {
      return next(new AppError("Evaluation is already locked", 400));
    }

    evaluation.status = EB_EVALUATION_STATUS.LOCKED;
    await evaluation.save();

    return res.status(200).json({
      success: true,
      message: "Evaluation đã được khóa",
      data: { _id: evaluation._id, status: evaluation.status },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /eb-scores/evaluation/:id ─────────────────────────────────────────────
// Lấy chi tiết 1 evaluation (dùng để FE load lại form)
router.get("/evaluation/:id", authMiddleware, requireEB, async (req, res, next) => {
  try {
    const evaluation = await EBEvaluation.findById(req.params.id).lean();
    if (!evaluation) return next(new AppError("Evaluation not found", 404));

    return res.status(200).json({
      success: true,
      data: evaluation,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
