const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
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
  // Sharp hỗ trợ: clear, source, over, in, out, atop, dest, dest-over, dest-in,
  // dest-out, dest-atop, xor, add, saturate, multiply, screen, overlay, darken,
  // lighten, colour-dodge, colour-burn, hard-light, soft-light, difference, exclusion
  // FE/DB lưu "source-over" / "normal" → trả về null để sharp dùng mặc định (over)
  if (blendMode == null) return null;
  if (typeof blendMode !== "string") return null;
  const v = blendMode.trim().toLowerCase();
  if (v === "" || v === "normal" || v === "source-over") return null;
  return blendMode;
}

function normalizeBlendModeInput(value) {
  // Ép input từ FE về chuẩn: "normal" / "" / undefined → null
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "normal" || v === "source-over") return null;
  return value;
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
      name, image_url,
      blend_mode: normalizeBlendModeInput(blend_mode),
      opacity, visible,
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
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid layer id", 400));
    }
    const layer = await PageLayer.findById(req.params.id).lean();
    if (!layer) return next(new AppError("Layer not found", 404));

    await checkChapterAccess(req.user.nameid, layer.page_id.toString());

    if (req.body.blend_mode !== undefined) {
      req.body.blend_mode = normalizeBlendModeInput(req.body.blend_mode);
    }

    const updated = await PageLayer.findByIdAndUpdate(
      req.params.id, req.body, { returnDocument: "after", runValidators: true }
    );

    return res.status(200).json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// PATCH /chapters/layers/:id
async function patchLayerHandler(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid layer id", 400));
    }
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
    if (req.body.blend_mode !== undefined) {
      updates.blend_mode = normalizeBlendModeInput(req.body.blend_mode);
    }
    if (Object.keys(updates).length === 0) {
      return next(new AppError("Khong co truong hop hop le de cap nhat", 400));
    }

    const updated = await PageLayer.findByIdAndUpdate(
      req.params.id, updates, { returnDocument: "after", runValidators: true }
    );

    return res.status(200).json({ success: true, data: updated });
  } catch (err) { next(err); }
}
router.patch("/layers/:id", authMiddleware, requireMangakaOrAssistant, patchLayerHandler);

// DELETE /chapters/layers/:id
async function deleteLayerHandler(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid layer id", 400));
    }
    const layer = await PageLayer.findById(req.params.id).lean();
    if (!layer) return next(new AppError("Layer not found", 404));

    await checkChapterAccess(req.user.nameid, layer.page_id.toString());

    await PageLayer.findByIdAndDelete(req.params.id);
    return res.status(200).json({ success: true, message: "Layer deleted" });
  } catch (err) { next(err); }
}
router.delete("/layers/:id", authMiddleware, requireMangakaOrAssistant, deleteLayerHandler);

// ─── Aliases ──────────────────────────────────────────────────────────────────
// FE đang gọi path có prefix /pages/:pageId/, nhưng route chính chỉ có /layers/:id.
// Các alias này chỉ là wrapper, ignore :pageId (handler chính tự resolve từ layer id).

// PATCH /chapters/pages/:pageId/layers/:id
router.patch(
  "/pages/:pageId/layers/:id",
  authMiddleware, requireMangakaOrAssistant,
  async (req, res, next) => {
    req.params.id = req.params.id;
    return patchLayerHandler(req, res, next);
  }
);

// DELETE /chapters/pages/:pageId/layers/:id
router.delete(
  "/pages/:pageId/layers/:id",
  authMiddleware, requireMangakaOrAssistant,
  deleteLayerHandler
);

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

    // Lấy metadata của page để biết kích thước canvas
    const pageMeta = await Page.findById(pageId).select("width height").lean();
    const canvasWidth = pageMeta?.width || 1920;
    const canvasHeight = pageMeta?.height || 1080;

    let finalImageBuffer;

    if (layers.length === 0) {
      // Không có layer → trả ảnh gốc của page
      if (!page.original_image_url) {
        return next(new AppError("Page does not have an original image", 400));
      }
      const origBuffer = await downloadImage(page.original_image_url);
      finalImageBuffer = await sharp(origBuffer)
        .resize(canvasWidth, canvasHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    } else {
      // Bước 1: Tạo canvas trong suốt với kích thước cố định
      let composite = sharp({
        create: {
          width: canvasWidth,
          height: canvasHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      }).png();

      // Bước 2: Lấy ảnh gốc làm base (nếu có) → tránh lỗi khi layer Assistant trong suốt
      if (page.original_image_url) {
        try {
          const origBuffer = await downloadImage(page.original_image_url);
          const resizedOrig = await sharp(origBuffer)
            .resize(canvasWidth, canvasHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();
          composite = sharp(resizedOrig);
        } catch (err) {
          console.warn("[finalize] Cannot load original image, continue with transparent base:", err.message);
          composite = sharp({
            create: {
              width: canvasWidth,
              height: canvasHeight,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
          }).png();
        }
      }

      // Bước 3: Đè từng layer lên theo z_order
      for (const layer of layers) {
        try {
          let layerBuffer = await downloadImage(layer.image_url);
          const layerMeta = await sharp(layerBuffer).metadata();

          // Resize layer xuống còn <= canvas (sharp không tự resize, composite yêu cầu vậy).
          // Nếu layer đã nhỏ hơn thì giữ nguyên.
          if (layerMeta.width > canvasWidth || layerMeta.height > canvasHeight) {
            layerBuffer = await sharp(layerBuffer)
              .resize({
                width: canvasWidth,
                height: canvasHeight,
                fit: "inside",
                withoutEnlargement: true,
              })
              .toBuffer();
          }

          const processedBuffer = await applyOpacity(layerBuffer, (layer.opacity ?? 100) / 100);
          const blendMode = mapBlendMode(layer.blend_mode);

          const baseBuffer = await composite.png().toBuffer();

          // Đặt layer theo tọa độ tuyệt đối (top, left) — sharp không hỗ trợ gravity "top".
          const compositeEntry = blendMode
            ? { input: processedBuffer, blend: blendMode, top: layer.y ?? 0, left: layer.x ?? 0 }
            : { input: processedBuffer, top: layer.y ?? 0, left: layer.x ?? 0 };

          composite = sharp(baseBuffer).composite([compositeEntry]).png();
        } catch (err) {
          console.warn(`[finalize] Skip layer ${layer._id} (blend=${layer.blend_mode}) due to error:`, err.message);
          continue;
        }
      }

      finalImageBuffer = await composite.png().toBuffer();
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
        if (err) {
          console.error("[finalize] Cloudinary upload failed:", err);
          return next(new AppError("Upload to Cloudinary failed: " + err.message, 500));
        }

        // Cập nhật page.result_image_url
        Page.findByIdAndUpdate(pageId, { result_image_url: result.secure_url }).catch((e) =>
          console.warn("[finalize] Failed to update page result_image_url:", e.message)
        );

        return res.status(200).json({
          success: true,
          final_image_url: result.secure_url,
          final_composed_at: new Date().toISOString(),
          page_id: pageId,
        });
      }
    );

    uploadStream.end(finalImageBuffer);
  } catch (err) {
    console.error("[finalize] Unexpected error:", err);
    next(err);
  }
});

/**
 * @swagger
 * /chapters/pages/{pageId}/download/{type}:
 *   get:
 *     summary: Tải ảnh gốc hoặc ảnh gộp của page
 *     tags: [Pages]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: pageId
 *         required: true
 *         schema:
 *           type: string
 *         description: Page ID
 *       - in: path
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [original, merged]
 *         description: Loai anh can tai (original = anh goc, merged = anh gop sau finalize)
 *     responses:
 *       200:
 *         description: "Stream anh binary voi Content-Disposition attachment"
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Loai download khong hop le
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Khong co quyen truy cap chapter
 *       404:
 *         description: Page khong ton tai hoac anh chua co
 */
// GET /chapters/pages/:pageId/download/:type
// Tai anh goc (original) hoac anh gop (merged) cua page.
// Proxy stream qua BE de kiem soat quyen + header download, khong buffer full file vao memory.
router.get("/pages/:pageId/download/:type", authMiddleware, requireMangakaOrAssistant, async (req, res, next) => {
  try {
    const { pageId, type } = req.params;

    if (!["original", "merged"].includes(type)) {
      return next(new AppError("Loai download khong hop le, chi cho phep original hoac merged", 400));
    }

    const { page } = await checkChapterAccess(req.user.nameid, pageId);

    const url = type === "original" ? page.original_image_url : page.result_image_url;
    if (!url) {
      return next(new AppError(type === "original" ? "Page chua co anh goc" : "Page chua co anh gop", 404));
    }

    // Build filename tu URL de nguoi dung biet dang download gi
    const pathname = url.split("?")[0];
    const base = pathname.split("/").pop() || `page-${pageId}`;
    const filename = `${type === "original" ? "original" : "merged"}-${base}`;

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Cache-Control", "no-cache");

    let handled = false;
    const done = (err) => {
      if (handled) return;
      handled = true;
      if (!res.writableEnded) res.end();
      if (err) next(err);
    };

    const follow = (current) => {
      const protocol = current.startsWith("https") ? https : require("http");
      const request = protocol.get(current, { headers: { "User-Agent": "WDP-BE/1.0" } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          return follow(response.headers.location);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          if (!res.headersSent) {
            res.status(response.statusCode).json({ success: false, message: "Khong the tai anh tu Cloudinary" });
          }
          done();
          return;
        }
        response.pipe(res);
        response.on("error", done);
        response.on("end", done);
      });

      request.on("error", done);
      request.setTimeout(30000, () => {
        request.destroy();
        done(new AppError("Download timeout", 504));
      });
    };

    follow(url);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
