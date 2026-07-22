const mongoose = require("mongoose");

/**
 * FollowAuthor - Reader theo dõi một Mangaka (author_id có role="Mangaka").
 *
 * Khi author này ra series mới (status chuyển sang "published" + is_public=true,
 * được xử lý bởi jobs/scheduledPublish.js), tất cả follower nhận notification
 * "new_series_from_author" qua socket và DB notifications.
 */
const followAuthorSchema = new mongoose.Schema(
  {
    reader_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    author_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    created_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// 1 reader chỉ follow 1 author 1 lần
followAuthorSchema.index(
  { reader_id: 1, author_id: 1 },
  { unique: true }
);

// Query broadcast khi author ra series mới
followAuthorSchema.index({ author_id: 1 });

module.exports = mongoose.model("FollowAuthor", followAuthorSchema);
