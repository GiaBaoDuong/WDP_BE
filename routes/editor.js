const express = require("express");
const authMiddleware = require("../middleware/auth");
const { requireRole } = require("../middleware/routes/requireRole");
const { MangaSeries } = require("../models/MangaSeries");
const SeriesDraftFile = require("../models/SeriesDraftFile");
const Chapter = require("../models/Chapter");
const MangaPage = require("../models/MangaPage");
const EditorFeedback = require("../models/EditorFeedback");
const AssistantTask = require("../models/AssistantTask");

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("Editor"));

// ─── 1. Xem danh sách series chờ TE duyệt ──────────────────────────────────
router.get("/pending-review", async (req, res) => {
  try {
    const seriesList = await MangaSeries.find({ status: "Pending_TE" })
      .populate("mangaka_id", "username full_name")
      .sort({ updated_at: 1 });

    return res.status(200).json({
      success: true,
      count: seriesList.length,
      data: seriesList,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching pending series",
      error: error.message,
    });
  }
});

// ─── 2. Xem chi tiết series để duyệt ────────────────────────────────────────
router.get("/series/:seriesId/review", async (req, res) => {
  try {
    const { seriesId } = req.params;

    const series = await MangaSeries.findById(seriesId)
      .populate("mangaka_id", "username full_name");

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    const drafts = await SeriesDraftFile.find({ series_id: seriesId }).sort({
      page_number: 1,
    });

    return res.status(200).json({
      success: true,
      data: {
        ...series.toJSON(),
        drafts,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching series for review",
      error: error.message,
    });
  }
});

// ─── 3. TE duyệt series: gửi EB (Approved) hoặc trả về sửa (Rejected) ───────
router.patch("/series/:seriesId/review", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const editor_id = req.user.nameid;
    const { decision, comment } = req.body;

    if (!["Approved", "Rejected"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "decision must be 'Approved' or 'Rejected'",
      });
    }

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (series.status !== "Pending_TE") {
      return res.status(400).json({
        success: false,
        message: `This series is not pending review. Current status: '${series.status}'`,
      });
    }

    if (decision === "Approved") {
      series.status = "Pending_EB";
      series.editor_id = editor_id;
      series.te_comment = comment || null;
    } else {
      series.status = "TE_Rejected";
      series.editor_id = editor_id;
      series.te_comment = comment || "Please revise your draft and resubmit.";
    }

    await series.save();

    return res.status(200).json({
      success: true,
      message:
        decision === "Approved"
          ? "Series approved by TE and submitted to EB for final decision"
          : "Series returned to Mangaka for revision",
      data: series,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error reviewing series",
      error: error.message,
    });
  }
});

// ─── 4. TE gán series cho mình ───────────────────────────────────────────────
router.post("/series/:seriesId/claim", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const editor_id = req.user.nameid;

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (series.status !== "Pending_TE") {
      return res.status(400).json({
        success: false,
        message: `Cannot claim series with status '${series.status}'`,
      });
    }

    if (series.editor_id && series.editor_id.toString() === editor_id) {
      return res.status(400).json({
        success: false,
        message: "You have already claimed this series",
      });
    }

    series.editor_id = editor_id;
    await series.save();

    return res.status(200).json({
      success: true,
      message: "Series claimed successfully",
      data: series,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error claiming series",
      error: error.message,
    });
  }
});

// ─── 5. TE đánh dấu feedback với tọa độ % (khoanh vùng trên ảnh) ─────────────
// POST /editor/series/:seriesId/feedback
router.post("/series/:seriesId/feedback", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const editor_id = req.user.nameid;
    const { chapter_id, page_id, markups, status } = req.body;

    if (!Array.isArray(markups) || markups.length === 0) {
      return res.status(400).json({
        success: false,
        message: "markups array is required and must not be empty",
      });
    }

    const series = await MangaSeries.findById(seriesId);
    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (page_id) {
      const page = await MangaPage.findById(page_id);
      if (!page) {
        return res.status(404).json({
          success: false,
          message: "Page not found",
        });
      }
    }

    const feedback = await EditorFeedback.create({
      series_id: seriesId,
      chapter_id: chapter_id || null,
      page_id: page_id || null,
      editor_id,
      markups: markups.map((m) => ({
        client_markup_id: m.clientMarkupId || null,
        x_percent: m.xPercent,
        y_percent: m.yPercent,
        width_percent: m.widthPercent,
        height_percent: m.heightPercent,
        markup_type: m.markupType || "error",
        comment: m.comment || "",
        _tempId: m.clientMarkupId || null,
      })),
      status: status || "Pending",
    });

    return res.status(201).json({
      success: true,
      message: "Feedback with markup regions created successfully",
      data: feedback,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error creating feedback",
      error: error.message,
    });
  }
});

// ─── 6. TE/EB xem feedbacks của một series ─────────────────────────────────────
// GET /editor/series/:seriesId/feedbacks
router.get("/series/:seriesId/feedbacks", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const { page_id, status } = req.query;

    const filter = { series_id: seriesId };
    if (page_id) filter.page_id = page_id;
    if (status) filter.status = status;

    const feedbacks = await EditorFeedback.find(filter)
      .populate("editor_id", "username full_name")
      .populate("chapter_id", "chapter_number")
      .populate("page_id", "page_number image_url")
      .sort({ created_at: -1 });

    return res.status(200).json({
      success: true,
      count: feedbacks.length,
      data: feedbacks,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching feedbacks",
      error: error.message,
    });
  }
});

// ─── 7. TE resolve feedback ──────────────────────────────────────────────────
router.patch("/feedbacks/:feedbackId/resolve", async (req, res) => {
  try {
    const { feedbackId } = req.params;
    const editor_id = req.user.nameid;

    const feedback = await EditorFeedback.findById(feedbackId);
    if (!feedback) {
      return res.status(404).json({
        success: false,
        message: "Feedback not found",
      });
    }

    if (feedback.editor_id.toString() !== editor_id) {
      return res.status(403).json({
        success: false,
        message: "You can only resolve your own feedbacks",
      });
    }

    feedback.status = "Resolved";
    await feedback.save();

    return res.status(200).json({
      success: true,
      message: "Feedback resolved",
      data: feedback,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error resolving feedback",
      error: error.message,
    });
  }
});

// ─── 8. TE xem series đang quản lý ──────────────────────────────────────────
router.get("/my-series", async (req, res) => {
  try {
    const editor_id = req.user.nameid;

    const seriesList = await MangaSeries.find({
      editor_id,
      status: { $in: ["Pending_TE", "Pending_EB", "Published_Weekly", "Published_Monthly"] },
    })
      .populate("mangaka_id", "username full_name")
      .sort({ updated_at: -1 });

    return res.status(200).json({
      success: true,
      count: seriesList.length,
      data: seriesList,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching your series",
      error: error.message,
    });
  }
});

// ─── 9. TE theo dõi tiến độ chapters của series ──────────────────────────────
router.get("/series/:seriesId/progress", async (req, res) => {
  try {
    const { seriesId } = req.params;

    const series = await MangaSeries.findById(seriesId);
    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    const chapters = await Chapter.find({ series_id: seriesId }).sort({
      chapter_number: 1,
    });

    const chaptersWithProgress = await Promise.all(
      chapters.map(async (ch) => {
        const pages = await MangaPage.find({ chapter_id: ch._id });
        const approvedPages = pages.filter((p) => p.status === "Approved").length;
        return {
          ...ch.toJSON(),
          total_pages: pages.length,
          approved_pages: approvedPages,
          progress_percent:
            pages.length > 0
              ? Math.round((approvedPages / pages.length) * 100)
              : 0,
        };
      })
    );

    return res.status(200).json({
      success: true,
      data: chaptersWithProgress,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching progress",
      error: error.message,
    });
  }
});

// ─── 10. TE duyệt chapter (hoàn thành chương) ───────────────────────────────
router.patch("/chapters/:chapterId/complete", async (req, res) => {
  try {
    const { chapterId } = req.params;
    const editor_id = req.user.nameid;

    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({
        success: false,
        message: "Chapter not found",
      });
    }

    const series = await MangaSeries.findById(chapter.series_id);
    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (!["Published_Weekly", "Published_Monthly"].includes(series.status)) {
      return res.status(400).json({
        success: false,
        message: "Only published series can complete chapters",
      });
    }

    chapter.status = "Completed";
    await chapter.save();

    return res.status(200).json({
      success: true,
      message: "Chapter marked as completed",
      data: chapter,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error completing chapter",
      error: error.message,
    });
  }
});

// ─── 11. TE xem tasks của series (xem ai đang vẽ gì) ─────────────────────────
router.get("/series/:seriesId/tasks", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const { status } = req.query;

    const filter = { series_id: seriesId };
    if (status) filter.status = status;

    const tasks = await AssistantTask.find(filter)
      .populate("chapter_id", "chapter_number")
      .populate("page_id", "page_number image_url")
      .sort({ sent_at: -1 });

    return res.status(200).json({
      success: true,
      count: tasks.length,
      data: tasks,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching tasks",
      error: error.message,
    });
  }
});

module.exports = router;
