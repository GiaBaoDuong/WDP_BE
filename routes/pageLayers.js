const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireMangakaOrAssistant } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const PageLayer = require("../models/PageLayer");
const Page = require("../models/Page");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");

async function checkChapterAccess(userId, pageId) {
  const page = await Page.findById(pageId).lean();
  if (!page) throw new AppError("Page not found", 404);

  const chapter = await Chapter.findById(page.chapter_id).lean();
  if (!chapter) throw new AppError("Chapter not found", 404);

  const series = await Series.findById(chapter.series_id).lean();
  if (!series) throw new AppError("Series not found", 404);

  const isAuthor = series.author_id.toString() === userId;
  const isAssigned = chapter.assistant_id?.toString() === userId;

  if (!isAuthor && !isAssigned) {
    throw new AppError("Khong co quyen truy cap chapter nay", 403);
  }

  return { page, chapter, series };
}

// POST /chapters/pages/:pageId/layers
router.post("/pages/:pageId/layers", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { pageId } = req.params;
    const { name, image_url, blend_mode, opacity, visible,
            z_order, x, y, width, height, rotation, scale, locked } = req.body;

    if (!image_url) {
      return next(new AppError("image_url la bat buoc", 400));
    }

    await checkChapterAccess(req.user.nameid, pageId);

    let order = z_order;
    if (order === undefined) {
      const max = await PageLayer.findOne({ page_id: pageId })
        .sort({ z_order: -1 }).select("z_order").lean();
      order = (max?.z_order ?? -1) + 1;
    }

    const layer = await PageLayer.create({
      page_id: pageId,
      name, image_url, blend_mode, opacity, visible,
      z_order: order, x, y, width, height, rotation, scale, locked,
    });

    return res.status(201).json({ success: true, data: layer });
  } catch (err) { next(err); }
});

// GET /chapters/pages/:pageId/layers
router.get("/pages/:pageId/layers", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { pageId } = req.params;

    await checkChapterAccess(req.user.nameid, pageId);

    const layers = await PageLayer.find({ page_id: pageId })
      .sort({ z_order: 1 }).lean();

    return res.status(200).json({ success: true, data: layers });
  } catch (err) { next(err); }
});

// PUT /chapters/layers/:id
router.put("/layers/:id", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const layer = await PageLayer.findById(req.params.id).lean();
    if (!layer) return next(new AppError("Layer not found", 404));

    await checkChapterAccess(req.user.nameid, layer.page_id.toString());

    const updated = await PageLayer.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    );

    return res.status(200).json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// PATCH /chapters/layers/:id
router.patch("/layers/:id", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const layer = await PageLayer.findById(req.params.id).lean();
    if (!layer) return next(new AppError("Layer not found", 404));

    await checkChapterAccess(req.user.nameid, layer.page_id.toString());

    const allowed = [
      "name", "image_url", "blend_mode", "opacity", "visible",
      "z_order", "x", "y", "width", "height", "rotation", "scale", "locked",
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return next(new AppError("Khong co truong hop hop le de cap nhat", 400));
    }

    const updated = await PageLayer.findByIdAndUpdate(
      req.params.id, updates, { new: true, runValidators: true }
    );

    return res.status(200).json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// DELETE /chapters/layers/:id
router.delete("/layers/:id", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const layer = await PageLayer.findById(req.params.id).lean();
    if (!layer) return next(new AppError("Layer not found", 404));

    await checkChapterAccess(req.user.nameid, layer.page_id.toString());

    await PageLayer.findByIdAndDelete(req.params.id);
    return res.status(200).json({ success: true, message: "Layer deleted" });
  } catch (err) { next(err); }
});

module.exports = router;
