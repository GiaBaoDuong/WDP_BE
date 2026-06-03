const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

const DRAFTS_DIR = path.join(__dirname, "../../uploads/drafts");
const CHAPTERS_DIR = path.join(__dirname, "../../uploads/chapters");

// Ensure directories exist
[DRAFTS_DIR, CHAPTERS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

// ─── Local disk storage ───────────────────────────────────────────────────────
const diskStorage = (destDir) =>
  multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, destDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const uniqueName = `${uuidv4()}${ext}`;
      cb(null, uniqueName);
    },
  });

// ─── Cloudinary storage ────────────────────────────────────────────────────────
let cloudinaryInstance = null;
let cloudinaryUploader = null;

const getCloudinary = () => {
  if (!cloudinaryInstance && process.env.CLOUDINARY_CLOUD_NAME) {
    const { v2: cloudinary } = require("cloudinary");
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    cloudinaryInstance = cloudinary;
    cloudinaryUploader = cloudinary.uploader;
  }
  return { cloudinary: cloudinaryInstance, uploader: cloudinaryUploader };
};

const cloudinaryStorage = multer.diskStorage({
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Invalid file type. Only ${ALLOWED_MIME_TYPES.join(", ")} are allowed.`
      ),
      false
    );
  }
};

// Determine which storage to use based on env
const useCloudinary = () =>
  !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY);

const uploadDraft = multer({
  storage: useCloudinary() ? cloudinaryStorage : diskStorage(DRAFTS_DIR),
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

const uploadChapter = multer({
  storage: useCloudinary() ? cloudinaryStorage : diskStorage(CHAPTERS_DIR),
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

/**
 * Upload file to Cloudinary and return URL + dimensions.
 * Falls back to local URL if Cloudinary is not configured.
 */
const uploadToCloudinary = async (file, folder = "uploads") => {
  const { uploader } = getCloudinary();
  if (!uploader) {
    const localPath = file.path || file.filename;
    return {
      url: localPath.startsWith("/") ? localPath : `/${localPath}`,
      width: null,
      height: null,
    };
  }

  try {
    const result = await uploader.upload(file.path, {
      folder,
      resource_type: "image",
    });
    return {
      url: result.secure_url,
      width: result.width,
      height: result.height,
      public_id: result.public_id,
    };
  } catch (error) {
    console.error("Cloudinary upload error:", error.message);
    return {
      url: file.path,
      width: null,
      height: null,
    };
  }
};

module.exports = {
  uploadDraft,
  uploadChapter,
  ALLOWED_MIME_TYPES,
  DRAFTS_DIR,
  CHAPTERS_DIR,
  uploadToCloudinary,
  useCloudinary,
};
