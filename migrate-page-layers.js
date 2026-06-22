require("dotenv").config();
const mongoose = require("mongoose");
const sharp = require("sharp");
const cloudinary = require("./config/cloudinary");
const Page = require("./models/Page");
const path = require("path");
const fs = require("fs");

async function getImageDimensions(url) {
  if (!url) return { width: 0, height: 0, reason: "empty url" };
  try {
    // 1. Cloudinary — dùng Admin API lấy kích thước gốc (bỏ transformation)
    if (url.includes("cloudinary.com")) {
      const publicIdMatch = url.match(/\/upload\/(.+?)\.(jpg|jpeg|png|webp)/i);
      if (publicIdMatch) {
        try {
          const resource = await new Promise((resolve, reject) => {
            cloudinary.api.resource(publicIdMatch[1], { resource_type: "image" }, (err, res) => {
              if (err) reject(err);
              else resolve(res);
            });
          });
          return { width: resource.width, height: resource.height };
        } catch {}
      }
    }
    // 2. Local path — đọc trực tiếp từ filesystem
    if (url.startsWith("/uploads/")) {
      const localPath = path.join(__dirname, "public", url);
      if (!fs.existsSync(localPath)) {
        return { width: 0, height: 0, reason: "file not found on disk" };
      }
      const buf = await sharp(localPath).metadata();
      return { width: buf.width || 0, height: buf.height || 0 };
    }
    // 3. Fallback — fetch trực tiếp URL
    const resp = await fetch(url);
    const arr = await resp.arrayBuffer();
    const { width, height } = await sharp(Buffer.from(arr)).metadata();
    return { width: width || 0, height: height || 0 };
  } catch {
    return { width: 0, height: 0, reason: "error" };
  }
}

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const result = await Page.updateMany(
      {
        $or: [
          { current_version: { $exists: false } },
          { is_locked: { $exists: false } },
          { snapshots: { $exists: false } },
        ],
      },
      {
        $set: {
          current_version: 0,
          is_locked: false,
          snapshots: [],
        },
      }
    );

    console.log("Page schema migration completed");
    console.log("Matched:", result.matchedCount);
    console.log("Modified:", result.modifiedCount);

    // Backfill width/height cho pages cũ chưa có (cả 2 đều thiếu hoặc = 0)
    const pagesToUpdate = await Page.find({
      $and: [
        { $or: [{ width: { $exists: false } }, { width: 0 }] },
        { $or: [{ height: { $exists: false } }, { height: 0 }] },
      ],
      original_image_url: { $ne: "" },
    }).lean();

    console.log(`\nPages cần extract width/height: ${pagesToUpdate.length}`);

    let updated = 0;
    let skipped = 0;
    for (const page of pagesToUpdate) {
      const dims = await getImageDimensions(page.original_image_url);
      // Bỏ qua nếu là 1x1 (ảnh placeholder/transformation lỗi)
      if (dims.width && dims.height && dims.width > 1 && dims.height > 1) {
        await Page.findByIdAndUpdate(page._id, {
          width: dims.width,
          height: dims.height,
        });
        updated++;
        console.log(`  Page ${page._id}: ${dims.width}x${dims.height}`);
      } else {
        skipped++;
        console.log(`  Page ${page._id}: skip (${dims.width}x${dims.height}) — ${dims.reason || ""}`);
      }
    }

    console.log(`\nWidth/height backfill: ${updated} updated, ${skipped} skipped (1x1/placeholder)`);
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await mongoose.disconnect();
  }
}

migrate();
