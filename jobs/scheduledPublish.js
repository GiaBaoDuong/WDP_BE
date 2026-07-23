/**
 * Scheduled Publish Job
 * Chạy mỗi phút:
 *  1. Auto set Series.status = "published" theo Series.scheduled_publish_at (kể cả khi Series chưa có chapter nào publish).
 *  2. KHÔNG auto-publish chapter nữa — chapter sẽ được TE publish thủ công qua POST /te-reviews/chapter/:id/publish.
 *     (Giữ job này để tương thích ngược với những chapter cũ đã được schedule trước đó.)
 *  3. (Risk B) Sau khi series chuyển sang "published" → notify tất cả follower của author.
 */
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const Notification = require("../models/Notification");
const { SERIES_STATUS, CHAPTER_STATUS } = require("../utils/constants");
const { notifyFollowersAuthorNewSeries } = require("../services/notificationService");

let intervalHandle = null;

const processScheduledPublish = async () => {
  try {
    const now = new Date();

    // 1. Auto set Series.status = "published" khi đến scheduled_publish_at
    //    Áp dụng cho Series đang ở APPROVED_BY_EB — Reader sẽ thấy Series kể cả khi chưa có chapter nào publish.
    //    Query full doc (kèm name + author_id) để dùng cho notify hook sau khi update.
    const dueSeries = await Series.find({
      status: SERIES_STATUS.APPROVED_BY_EB,
      scheduled_publish_at: { $lte: now, $ne: null },
    })
      .select("_id name author_id")
      .lean();

    if (dueSeries.length > 0) {
      console.log(`[ScheduledPublish] Auto-publishing ${dueSeries.length} series...`);
      await Series.updateMany(
        { _id: { $in: dueSeries.map((s) => s._id) } },
        { status: SERIES_STATUS.PUBLISHED, publication_status: "ongoing" }
      );

      // (Risk B) Notify follower của author khi series chính thức public.
      // Lỗi hook không làm fail job (đã wrap try/catch bên trong service).
      for (const series of dueSeries) {
        try {
          const populated = await Series.findById(series._id)
            .populate("author_id", "username full_name")
            .lean();
          if (!populated) continue;
          populated.author_name =
            populated.author_id?.full_name || populated.author_id?.username || "Tác giả";
          await notifyFollowersAuthorNewSeries(Notification, populated);
        } catch (err) {
          console.error(
            `[ScheduledPublish] notify hook error for series ${series._id}:`,
            err.message
          );
        }
      }
    }

    // 2. Auto-publish chapter cũ (tương thích ngược) — chỉ áp dụng khi chapter đã is_scheduled = true
    //    và Series đang ở "published" (không phải APPROVED_BY_EB).
    //    Chapter mới sau khi sửa confirm-publish sẽ KHÔNG có is_scheduled = true.
    const pendingChapters = await Chapter.find({
      is_scheduled: true,
      scheduled_publish_at: { $lte: now },
      status: CHAPTER_STATUS.APPROVED_BY_EB,
    }).lean();

    if (pendingChapters.length === 0) return;

    const publishableChapters = [];
    for (const ch of pendingChapters) {
      const series = await Series.findById(ch.series_id).select("status").lean();
      // Bỏ qua chapter thuộc Series đang APPROVED_BY_EB — chờ TE publish thủ công
      if (!series || series.status === SERIES_STATUS.APPROVED_BY_EB) continue;
      publishableChapters.push(ch);
    }

    if (publishableChapters.length === 0) return;

    console.log(`[ScheduledPublish] Processing ${publishableChapters.length} scheduled chapter(s)...`);

    for (const chapter of publishableChapters) {
      try {
        await Chapter.findByIdAndUpdate(chapter._id, {
          status: CHAPTER_STATUS.PUBLISHED,
          is_published: true,
          published_at: now,
          is_scheduled: false,
          revision_notes: "",
          revision_annotations: [],
          revision_source: "",
        });
        await Series.findByIdAndUpdate(chapter.series_id, {
          $set: { last_chapter_published_at: now },
        });
        console.log(
          `[ScheduledPublish] Chapter ${chapter._id} (${chapter.chapter_number}) published successfully.`
        );
      } catch (err) {
        console.error(`[ScheduledPublish] Error publishing chapter ${chapter._id}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[ScheduledPublish] Job error:", err.message);
  }
};

const startScheduledPublishJob = () => {
  if (intervalHandle) return;
  intervalHandle = setInterval(processScheduledPublish, 60 * 1000);
  console.log("[ScheduledPublish] Job started — checking every 60 seconds.");
};

const stopScheduledPublishJob = () => {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[ScheduledPublish] Job stopped.");
  }
};

module.exports = { startScheduledPublishJob, stopScheduledPublishJob, processScheduledPublish }; 