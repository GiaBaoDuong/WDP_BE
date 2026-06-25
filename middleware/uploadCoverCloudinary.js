const multer = require("multer");
const cloudinary = require("../config/cloudinary");

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const extname = allowed.test(file.originalname.toLowerCase());
  const mimetype = allowed.test(file.mimetype);
  if (extname && mimetype) cb(null, true);
  else cb(new Error("Only image files (jpeg, jpg, png, webp) are allowed"));
};

// Upload thẳng lên Cloudinary (memoryStorage)
const uploadCover = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

async function uploadToCloudinary(file, folder = "wdp/series/covers", publicIdPrefix = "cover") {
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        allowed_formats: ["jpg", "jpeg", "png", "webp"],
        public_id: `${publicIdPrefix}-${stamp}-${rand}`,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    stream.end(file.buffer);
  });
}

module.exports = { uploadCover, uploadToCloudinary };
