/**
 * Scheduled Publish Job
 * Chạy mỗi phút: tìm các chapter đang chờ hẹn giờ (is_scheduled=true, scheduled_publish_at <= now)
 * và tự động xuất bản chúng.
 */
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const Notification = require("../models/Notification");
const { notifyChapterPublishConfirmed } = require("../services/notificationService");

let intervalHandle = null;

const processScheduledPublish = async () => {
  try {
    const now = new Date();
    const pendingChapters = await Chapter.find({
      is_scheduled: true,
      scheduled_publish_at: { $lte: now },
      status: "pending_EB",
    }).lean();

    if (pendingChapters.length === 0) return;

    console.log(`[ScheduledPublish] Processing ${pendingChapters.length} scheduled chapter(s)...`);

    await Promise.all(
      pendingChapters.map(async (chapter) => {
        try {
          chapter.status = "published";
          chapter.is_published = true;
          chapter.published_at = now;
          chapter.is_scheduled = false;
          chapter.revision_notes = "";
          chapter.revision_annotations = [];
          chapter.revision_source = "";
          await Chapter.findByIdAndUpdate(chapter._id, {
            status: "published",
            is_published: true,
            published_at: now,
            is_scheduled: false,
            revision_notes: "",
            revision_annotations: [],
            revision_source: "",
          });

          const series = await Series.findById(chapter.series_id).lean();
          if (series) {
            const unpublished = await Chapter.countDocuments({
              series_id: chapter.series_id,
              is_published: false,
            });
            if (unpublished === 0) {
              await Series.findByIdAndUpdate(series._id, { status: "published" });
            }
          }

          await notifyChapterPublishConfirmed(
            Notification,
            chapter.submitted_by,
            chapter,
            series?.name || "",
            chapter.publication_schedule,
            chapter.publication_duration_days
          );

          console.log(
            `[ScheduledPublish] Chapter ${chapter._id} (${chapter.chapter_number}) published successfully.`
          );
        } catch (err) {
          console.error(`[ScheduledPublish] Error publishing chapter ${chapter._id}:`, err.message);
        }
      })
    );
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
