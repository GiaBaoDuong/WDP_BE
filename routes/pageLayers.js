const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireMangakaOrAssistant } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const PageLayer = require("../models/PageLayer");
const Page = require("../models/Page");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const sharp = require("sharp");
const cloudinary = require("../config/cloudinary");
const https = require("https");

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

function mapBlendMode(blendMode) {
  return blendMode || "over";
}

async function applyOpacity(buffer, opacity) {
  if (opacity >= 1) return buffer;
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alphaIdx = 3;
  for (let i = alphaIdx; i < data.length; i += info.channels) {
    data[i] = Math.round(data[i] * opacity);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error("No URL provided"));
    const protocol = url.startsWith("https") ? https : require("http");
    const req = protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadImage(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Download timeout")); });
  });
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

    return res.status(201).json({ success: true, layer });
  } catch (err) { next(err); }
});

// GET /chapters/pages/:pageId/layers
router.get("/pages/:pageId/layers", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { pageId } = req.params;

    await checkChapterAccess(req.user.nameid, pageId);

    const layers = await PageLayer.find({ page_id: pageId })
      .sort({ z_order: 1 }).lean();

    return res.status(200).json({ success: true, layers });
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

// ─── POST /pages/:pageId/finalize ─────────────────────────────────────────────
// Gộp tất cả layers của 1 page thành ảnh final (PNG, giữ alpha channel)
router.post("/pages/:pageId/finalize", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { pageId } = req.params;
    const { page } = await checkChapterAccess(req.user.nameid, pageId);

    // Lấy tất cả layers visible, sort theo z_order (0 = dưới cùng)
    const layers = await PageLayer.find({ page_id: pageId, visible: true })
      .sort({ z_order: 1 })
      .lean();

    let finalImageBuffer;

    if (layers.length === 0) {
      // Không có layer → trả ảnh gốc của page
      if (!page.original_image_url) {
        return next(new AppError("Page does not have an original image", 400));
      }
      const origBuffer = await downloadImage(page.original_image_url);
      finalImageBuffer = origBuffer;
    } else {
      // Dùng layer dưới cùng làm base, đè các layer khác lên
      const baseBuffer = await downloadImage(layers[0].image_url);
      let compositeInput = await sharp(baseBuffer).ensureAlpha().png().toBuffer();

      for (let i = 1; i < layers.length; i++) {
        const layer = layers[i];
        const overlayBuffer = await downloadImage(layer.image_url);
        const processedOverlay = await applyOpacity(overlayBuffer, layer.opacity / 100);
        const blendMode = mapBlendMode(layer.blend_mode);

        compositeInput = await sharp(compositeInput)
          .composite([{
            input: processedOverlay,
            blend: blendMode,
            gravity: "top",
          }])
          .ensureAlpha()
          .png()
          .toBuffer();
      }

      finalImageBuffer = compositeInput;
    }

    // Upload lên Cloudinary
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "wdp/finals",
        format: "png",
        public_id: `page-${pageId}-${Date.now()}`,
        invalidate: true,
      },
      (err, result) => {
        if (err) return next(new AppError("Upload to Cloudinary failed: " + err.message, 500));
        return res.status(200).json({
          success: true,
          final_image_url: result.secure_url,
          final_composed_at: new Date().toISOString(),
          page_id: pageId,
        });
      }
    );

    uploadStream.end(finalImageBuffer);
  } catch (err) { next(err); }
});

module.exports = router;
