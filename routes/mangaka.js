const express = require("express");
const authMiddleware = require("../middleware/auth");
const { requireRole } = require("../middleware/routes/requireRole");
const { uploadDraft } = require("../middleware/routes/upload");
const { MangaSeries, SERIES_STATUSES } = require("../models/MangaSeries");
const SeriesDraftFile = require("../models/SeriesDraftFile");
const Chapter = require("../models/Chapter");
const MangaPage = require("../models/MangaPage");
const PageNote = require("../models/PageNote");
const AssistantTask = require("../models/AssistantTask");
const EditorFeedback = require("../models/EditorFeedback");

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("Mangaka"));

// ─── 1. Tạo series mới (Draft) ─────────────────────────────────────────────
router.post("/series", async (req, res) => {
  try {
    const { title, description } = req.body;
    const mangaka_id = req.user.nameid;

    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Title is required",
      });
    }

    const existingSeries = await MangaSeries.findOne({
      title,
      mangaka_id,
      status: { $nin: ["Dropped"] },
    });

    if (existingSeries) {
      return res.status(409).json({
        success: false,
        message: "You already have a series with this title that is not dropped",
      });
    }

    const series = await MangaSeries.create({
      title,
      description: description || "",
      mangaka_id,
      status: "Draft",
    });

    return res.status(201).json({
      success: true,
      message: "Series created successfully",
      data: series,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error creating series",
      error: error.message,
    });
  }
});

// ─── 2. Upload bản thảo (Draft files) ────────────────────────────────────────
router.post(
  "/series/:seriesId/drafts",
  uploadDraft.array("files", 20),
  async (req, res) => {
    try {
      const { seriesId } = req.params;
      const mangaka_id = req.user.nameid;

      const series = await MangaSeries.findById(seriesId);

      if (!series) {
        return res.status(404).json({
          success: false,
          message: "Series not found",
        });
      }

      if (series.mangaka_id.toString() !== mangaka_id) {
        return res.status(403).json({
          success: false,
          message: "You are not the author of this series",
        });
      }

      if (
        series.status !== "Draft" &&
        series.status !== "TE_Rejected"
      ) {
        return res.status(400).json({
          success: false,
          message: `Cannot upload drafts when series status is '${series.status}'. Only 'Draft' or 'TE_Rejected' are allowed.`,
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No files uploaded",
        });
      }

      const existingDrafts = await SeriesDraftFile.find({ series_id: seriesId });
      const startPage = existingDrafts.length + 1;

      const draftRecords = await Promise.all(
        req.files.map((file, index) =>
          SeriesDraftFile.create({
            series_id: seriesId,
            page_number: startPage + index,
            file_url: `/uploads/drafts/${file.filename}`,
            original_filename: file.originalname,
          })
        )
      );

      return res.status(201).json({
        success: true,
        message: `${draftRecords.length} draft file(s) uploaded successfully`,
        data: draftRecords,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Error uploading draft files",
        error: error.message,
      });
    }
  }
);

// ─── 3. Xem danh sách series của mình ────────────────────────────────────────
router.get("/series/my", async (req, res) => {
  try {
    const mangaka_id = req.user.nameid;
    const { status } = req.query;

    const filter = { mangaka_id };
    if (status) filter.status = status;

    const seriesList = await MangaSeries.find(filter)
      .populate("mangaka_id", "username full_name")
      .populate("editor_id", "username full_name")
      .sort({ created_at: -1 });

    return res.status(200).json({
      success: true,
      count: seriesList.length,
      data: seriesList,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching series",
      error: error.message,
    });
  }
});

// ─── 4. Xem chi tiết series của mình ─────────────────────────────────────────
router.get("/series/:seriesId", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const mangaka_id = req.user.nameid;

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (series.mangaka_id.toString() !== mangaka_id) {
      return res.status(403).json({
        success: false,
        message: "You are not the author of this series",
      });
    }

    const drafts = await SeriesDraftFile.find({ series_id: seriesId }).sort({
      page_number: 1,
    });

    const chapters = await Chapter.find({ series_id: seriesId }).sort({
      chapter_number: 1,
    });

    const chaptersWithPages = await Promise.all(
      chapters.map(async (ch) => {
        const pages = await MangaPage.find({ chapter_id: ch._id }).sort({
          page_number: 1,
        });
        const tasks = await AssistantTask.find({
          page_id: { $in: pages.map((p) => p._id) },
        }).populate("chapter_id", "chapter_number");
        const feedbacks = await EditorFeedback.find({
          page_id: { $in: pages.map((p) => p._id) },
        }).populate("editor_id", "username full_name");

        return {
          ...ch.toJSON(),
          pages: pages.map((p) => ({
            ...p.toJSON(),
            tasks: tasks.filter((t) => t.page_id.toString() === p._id.toString()),
            feedbacks: feedbacks.filter((f) => f.page_id && f.page_id.toString() === p._id.toString()),
          })),
        };
      })
    );

    return res.status(200).json({
      success: true,
      data: {
        ...series.toJSON(),
        drafts,
        chapters: chaptersWithPages,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching series details",
      error: error.message,
    });
  }
});

// ─── 5. Gửi bản thảo cho TE duyệt ───────────────────────────────────────────
router.post("/series/:seriesId/submit-to-te", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const mangaka_id = req.user.nameid;

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (series.mangaka_id.toString() !== mangaka_id) {
      return res.status(403).json({
        success: false,
        message: "You are not the author of this series",
      });
    }

    if (
      series.status !== "Draft" &&
      series.status !== "TE_Rejected"
    ) {
      return res.status(400).json({
        success: false,
        message: `Cannot submit from status '${series.status}'. Only 'Draft' or 'TE_Rejected' allowed.`,
      });
    }

    const drafts = await SeriesDraftFile.find({ series_id: seriesId });
    if (drafts.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please upload at least one draft page before submitting",
      });
    }

    series.status = "Pending_TE";
    series.te_comment = null;
    await series.save();

    return res.status(200).json({
      success: true,
      message: "Series submitted to Tantou Editor for review",
      data: series,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error submitting series",
      error: error.message,
    });
  }
});

// ─── 6. Tạo chương mới ───────────────────────────────────────────────────────
router.post("/series/:seriesId/chapters", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const mangaka_id = req.user.nameid;
    const { chapter_number, title, deadline } = req.body;

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (series.mangaka_id.toString() !== mangaka_id) {
      return res.status(403).json({
        success: false,
        message: "You are not the author of this series",
      });
    }

    if (!["Published_Weekly", "Published_Monthly"].includes(series.status)) {
      return res.status(400).json({
        success: false,
        message: "Only published series can create chapters",
      });
    }

    if (!chapter_number) {
      return res.status(400).json({
        success: false,
        message: "chapter_number is required",
      });
    }

    const existingChapter = await Chapter.findOne({
      series_id: seriesId,
      chapter_number,
    });

    if (existingChapter) {
      return res.status(409).json({
        success: false,
        message: `Chapter ${chapter_number} already exists`,
      });
    }

    const chapter = await Chapter.create({
      series_id: seriesId,
      chapter_number,
      title: title || "",
      deadline: deadline ? new Date(deadline) : null,
      status: "In_Progress",
    });

    return res.status(201).json({
      success: true,
      message: `Chapter ${chapter_number} created successfully`,
      data: chapter,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error creating chapter",
      error: error.message,
    });
  }
});

// ─── 7a. Upload trang chương (file binary) — legacy ───────────────────────────
router.post(
  "/chapters/:chapterId/pages",
  uploadDraft.array("files", 20),
  async (req, res) => {
    try {
      const { chapterId } = req.params;
      const mangaka_id = req.user.nameid;

      const chapter = await Chapter.findById(chapterId);
      if (!chapter) {
        return res.status(404).json({
          success: false,
          message: "Chapter not found",
        });
      }

      const series = await MangaSeries.findById(chapter.series_id);
      if (series.mangaka_id.toString() !== mangaka_id) {
        return res.status(403).json({
          success: false,
          message: "You are not the author of this series",
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No files uploaded",
        });
      }

      const existingPages = await MangaPage.find({ chapter_id: chapterId });
      const startPage = existingPages.length + 1;

      const pageRecords = await Promise.all(
        req.files.map((file, index) =>
          MangaPage.create({
            chapter_id: chapterId,
            page_number: startPage + index,
            image_url: `/uploads/chapters/${file.filename}`,
            status: "Processing",
          })
        )
      );

      return res.status(201).json({
        success: true,
        message: `${pageRecords.length} page(s) uploaded successfully`,
        data: pageRecords,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Error uploading pages",
        error: error.message,
      });
    }
  }
);

// ─── 7b. Đăng ký page với URL + kích thước ảnh (CDN flow) ────────────────────
// POST /mangaka/chapters/:chapterId/pages/register
router.post("/chapters/:chapterId/pages/register", async (req, res) => {
  try {
    const { chapterId } = req.params;
    const mangaka_id = req.user.nameid;
    const { pages } = req.body;

    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({
        success: false,
        message: "Chapter not found",
      });
    }

    const series = await MangaSeries.findById(chapter.series_id);
    if (series.mangaka_id.toString() !== mangaka_id) {
      return res.status(403).json({
        success: false,
        message: "You are not the author of this series",
      });
    }

    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({
        success: false,
        message: "pages array is required and must not be empty",
      });
    }

    const existingPages = await MangaPage.find({ chapter_id: chapterId });
    const startPage = existingPages.length;

    const pageRecords = await Promise.all(
      pages.map((page, index) =>
        MangaPage.create({
          chapter_id: chapterId,
          page_number: startPage + index + 1,
          image_url: page.imageUrl || "",
          width: page.width || null,
          height: page.height || null,
          status: "Processing",
        })
      )
    );

    return res.status(201).json({
      success: true,
      message: `${pageRecords.length} page(s) registered successfully`,
      data: pageRecords,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error registering pages",
      error: error.message,
    });
  }
});

// ─── 8a. Giao việc cho Assistant (gửi nhiều notes cùng lúc) ──────────────────
// POST /mangaka/chapters/:chapterId/assistant-tasks
router.post("/chapters/:chapterId/assistant-tasks", async (req, res) => {
  try {
    const { chapterId } = req.params;
    const mangaka_id = req.user.nameid;
    const {
      page_id,
      page_index,
      page_image_url,
      image_width,
      image_height,
      notes,
      status,
    } = req.body;

    const chapter = await Chapter.findById(chapterId);
    if (!chapter) {
      return res.status(404).json({
        success: false,
        message: "Chapter not found",
      });
    }

    const series = await MangaSeries.findById(chapter.series_id);
    if (series.mangaka_id.toString() !== mangaka_id) {
      return res.status(403).json({
        success: false,
        message: "You are not the author of this series",
      });
    }

    let targetPageId = page_id;
    if (!targetPageId && page_index !== undefined) {
      const page = await MangaPage.findOne({
        chapter_id: chapterId,
        page_number: page_index + 1,
      });
      if (page) targetPageId = page._id;
    }

    if (!targetPageId) {
      return res.status(400).json({
        success: false,
        message: "page_id or valid page_index is required",
      });
    }

    if (!Array.isArray(notes) || notes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "notes array is required and must not be empty",
      });
    }

    const task = await AssistantTask.create({
      series_id: series._id,
      chapter_id: chapterId,
      page_id: targetPageId,
      page_index: page_index || 0,
      page_image_url: page_image_url || "",
      image_width: image_width || null,
      image_height: image_height || null,
      mangaka_id,
      notes: notes.map((n, i) => ({
        client_note_id: n.clientNoteId || null,
        x_percent: n.xPercent,
        y_percent: n.yPercent,
        width_percent: n.widthPercent,
        height_percent: n.heightPercent,
        task_type: n.taskType || "Other",
        assignee: n.assignee || null,
        message: n.message || "",
        sort_order: n.sortOrder || i,
        _tempId: n.clientNoteId || null,
      })),
      status: status || "pending_assistant",
    });

    return res.status(201).json({
      success: true,
      message: "Assistant task created successfully",
      data: task,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error creating assistant task",
      error: error.message,
    });
  }
});

// ─── 8b. Giao việc theo page cụ thể — legacy endpoint ───────────────────────
router.post("/pages/:pageId/tasks", async (req, res) => {
  try {
    const { pageId } = req.params;
    const mangaka_id = req.user.nameid;
    const { page_image_url, image_width, image_height, notes, status } = req.body;

    const page = await MangaPage.findById(pageId);
    if (!page) {
      return res.status(404).json({
        success: false,
        message: "Page not found",
      });
    }

    const chapter = await Chapter.findById(page.chapter_id);
    const series = await MangaSeries.findById(chapter.series_id);

    if (series.mangaka_id.toString() !== mangaka_id) {
      return res.status(403).json({
        success: false,
        message: "You are not the author of this series",
      });
    }

    const notesArray = Array.isArray(notes) && notes.length > 0
      ? notes.map((n, i) => ({
          client_note_id: n.clientNoteId || null,
          x_percent: n.xPercent,
          y_percent: n.yPercent,
          width_percent: n.widthPercent,
          height_percent: n.heightPercent,
          task_type: n.taskType || "Other",
          assignee: n.assignee || null,
          message: n.message || "",
          sort_order: n.sortOrder || i,
          _tempId: n.clientNoteId || null,
        }))
      : [];

    const task = await AssistantTask.create({
      series_id: series._id,
      chapter_id: chapter._id,
      page_id: pageId,
      page_index: page.page_number - 1,
      page_image_url: page_image_url || "",
      image_width: image_width || null,
      image_height: image_height || null,
      mangaka_id,
      notes: notesArray,
      status: status || "pending_assistant",
    });

    return res.status(201).json({
      success: true,
      message: "Task assigned successfully",
      data: task,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error assigning task",
      error: error.message,
    });
  }
});

// ─── 9. Xem tasks của mình ───────────────────────────────────────────────────
router.get("/tasks/my", async (req, res) => {
  try {
    const mangaka_id = req.user.nameid;
    const { status, series_id } = req.query;

    const filter = { mangaka_id };
    if (status) filter.status = status;
    if (series_id) filter.series_id = series_id;

    const tasks = await AssistantTask.find(filter)
      .populate("series_id", "title")
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

// ─── 10. Duyệt / từ chối task của Assistant ───────────────────────────────────
router.patch("/tasks/:taskId/review", async (req, res) => {
  try {
    const { taskId } = req.params;
    const mangaka_id = req.user.nameid;
    const { status, comment } = req.body;

    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "status must be 'Approved' or 'Rejected'",
      });
    }

    const task = await AssistantTask.findById(taskId);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    if (task.mangaka_id.toString() !== mangaka_id) {
      return res.status(403).json({
        success: false,
        message: "You are not the author of this series",
      });
    }

    task.status = status;
    await task.save();

    if (status === "Approved") {
      const allTasks = await AssistantTask.find({ page_id: task.page_id });
      const allApproved = allTasks.every((t) => t.status === "Approved");
      if (allApproved) {
        await MangaPage.findByIdAndUpdate(task.page_id, {
          status: "Approved",
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Task ${status.toLowerCase()}`,
      data: task,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error reviewing task",
      error: error.message,
    });
  }
});

module.exports = router;
