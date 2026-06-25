const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("../config/cloudinary");

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "wdp/chapters/pages",
    resource_type: "image",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    public_id: (req, file) => {
      const chapterId = req.params.id || "chapter";
      const pageNumber = req.body.page_number || "page";
      const stamp = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      return `${chapterId}-${pageNumber}-${stamp}-${rand}`;
    },
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const extname = allowed.test(file.originalname.toLowerCase());
  const mimetype = allowed.test(file.mimetype);
  if (extname && mimetype) cb(null, true);
  else cb(new Error("Only image files (jpeg, jpg, png, webp) are allowed"));
};

const uploadChapterPage = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

module.exports = { uploadChapterPage, cloudinary };
