const mongoose = require("mongoose");

const GENRES = [
  "Anime", "Drama", "Josei", "Manhwa", "One Shot", "Shounen", "Webtoons", "Shoujo",
  "Harem", "Ecchi", "Mature", "Slice of life", "Isekai", "Manga", "Manhua",
  "Hành Động", "Phiêu Lưu", "Hài Hước", "Võ Thuật", "Huyền Bí", "Lãng Mạn",
  "Thể Thao", "Học Đường", "Lịch Sử", "Kinh Dị", "Siêu Nhiên", "Bi Kịch",
  "Trùng Sinh", "Game", "Viễn Tưởng", "Khoa Học", "Truyện Màu", "Người Lớn",
  "Boylove", "Hầm Ngục", "Săn Bắn", "Ngôn Từ Nhạy Cảm", "Doujinshi", "Bạo Lực",
  "Ngôn Tình", "Nữ Cường", "Gender Bender", "Murim", "Leo Tháp", "Nấu Ăn",
  "Trinh Thám", "Kinh Dị-Tâm Lý", "Xuyên Không",
];

const seriesSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Series name is required"],
      trim: true,
      maxlength: 200,
    },
    description: { type: String, default: "" },
    genre: {
      type: [String],
      default: [],
      validate: {
        validator: function (v) {
          return v.every((g) => GENRES.includes(g));
        },
        message: (props) => `${props.value} is not a valid genre.`,
      },
    },
    target_audience: { type: String, default: "" },
    synopsis: { type: String, default: "" },
    author_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["draft", "submitted", "approved", "approved_by_EB", "rejected", "revision", "published", "cancelled"],
      default: "draft",
    },
    publication_schedule: {
      type: String,
      enum: ["weekly", "monthly", null],
      default: null,
    },
    scheduled_publish_at: { type: Date, default: null },
    is_public: { type: Boolean, default: false },
    average_score: { type: Number, default: 0, min: 0, max: 5 },
    total_votes: { type: Number, default: 0 },
    views_count: { type: Number, default: 0 },
    cover_image_url: { type: String, default: "" },
    category: { type: String, default: "" },
    tags: { type: [String], default: [] },
    last_chapter_published_at: { type: Date, default: null },
    age_rating: {
      type: String,
      enum: ["All ages", "Teens 13+", "Mature 17+", "Adults Only 18+", null],
      default: "All ages",
    },
    eb_evaluation_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EBEvaluation",
      default: null,
    },
    publication_status: {
      type: String,
      enum: ["upcoming", "ongoing", "hiatus", "completed", "dropped", null],
      default: null,
    },
    deleted_at: { type: Date, default: null },
  },
  { timestamps: true }
);

seriesSchema.index({ author_id: 1, status: 1 });
seriesSchema.index({ is_public: 1, status: 1 });
seriesSchema.index({ average_score: -1 });
seriesSchema.index({ is_public: 1, status: 1, last_chapter_published_at: -1 });
seriesSchema.index({ deleted_at: 1 });

const Series = mongoose.model("Series", seriesSchema);
module.exports = Series;
module.exports.GENRES = GENRES;
