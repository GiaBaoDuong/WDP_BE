/**
 * Scheduled Publish Job
 * Chạy mỗi phút:
 *  1. Auto set Series.status = "published" theo Series.scheduled_publish_at
 *     (kể cả khi Series chưa có chapter nào publish).
 *     SKIP nếu Series.publication_status ∈ {"hiatus", "dropped"} (admin đã đánh dấu ngưng).
 *  2. Auto-publish các chapter đã được TE schedule:
 *     - status = "approved_by_EB", is_scheduled = true, scheduled_publish_at <= now.
 *     - SKIP nếu Series.publication_status ∈ {"hiatus", "dropped"} — giữ nguyên scheduled_publish_at
 *       để khi admin bỏ hiatus thì job sẽ publish tiếp.
 *     - Sort by chapter_number ASC để chapter nhỏ publish trước.
 *     - BUFFER CHECK: mặc định phải có >= 2 chapter approved_by_EB chưa publish.
 *       Ngoại lệ 1: chapter đầu tiên của Series (chưa có chapter nào publish) → cho publish.
 *       Ngoại lệ 2: nếu Series.publication_status === "completed" và chapter hiện tại
 *         là chapter cuối (không có chapter nào có chapter_number lớn hơn) → cho phép publish.
 *       Nếu buffer không đủ → KHÔNG publish, áp dụng Policy B:
 *         Recompute scheduled_publish_at = (last published chapter + cadence) về tương lai,
 *         giữ cadence ổn định tính từ chapter vừa publish.
 *     - Snapshot final_image_url cho pages.
 *     - Set TEReview.decision = "approved_publish".
 *     - Set Series.last_chapter_published_at.
 *  3. Sau khi publish 1 chapter → tự động set lịch cho chapter kế tiếp (theo chapter_number) nếu có:
 *     - scheduled_publish_at = just_published.published_at + cadence (weekly=+7d, monthly=+30d).
 *     - Áp dụng kể cả khi chapter kế tiếp chưa được TE-approve (để giữ cadence).
 *     - Khi tới hạn, job sẽ kiểm tra buffer lại (theo rule trên).
 *  4. Nếu Series vẫn ở "approved_by_EB" khi chapter đầu tiên publish → set Series = "published"
 *     (fallback cho trường hợp Series.scheduled_publish_at không khớp hoặc job Series chạy sau).
 *  5. Notify Mangaka + followers khi chapter publish.
 *  6. (Risk B) Sau khi series chuyển sang "published" → notify tất cả follower của author.
 *  7. isRunning guard: chống overlap nếu job phía trước chạy quá 60s.
 */
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const Page = require("../models/Page");
const TEReview = require("../models/TEReview");
const Notification = require("../models/Notification");
const { SERIES_STATUS, CHAPTER_STATUS, TE_DECISION } = require("../utils/constants");
const {
  notifyChapterTEPublished,
  notifyFollowersNewChapter,
  notifyFollowersAuthorNewSeries,
  hasNotifiedFollowersAuthorNewSeries,
} = require("../services/notificationService");
const {
  addInterval,
  isValidSchedule,
  getLastPublishedChapter,
  countApprovedUnpublishedChapters,
  isFinalChapterOfSeries,
} = require("../utils/publicationSchedule");

let intervalHandle = null;
let isRunning = false;

const MIN_BUFFER = 2;

/**
 * Notify follower của author khi series chính thức chuyển sang "published".
 *
 * Idempotent: dùng `hasNotifiedFollowersAuthorNewSeries` để check notification
 * đã từng gửi cho series này chưa (tránh spam khi có nhiều nhánh cùng publish
 * series — nhánh Series job + nhánh chapter fallback).
 *
 * Populate author_id một lần để lấy tên hiển thị (full_name), rồi truyền
 * sang `notifyFollowersAuthorNewSeries` (service này tự chuẩn hóa về ObjectId).
 */
const notifyFollowersForPublishedSeries = async (series) => {
  try {
    const alreadySent = await hasNotifiedFollowersAuthorNewSeries(
      Notification,
      series._id
    );
    if (alreadySent) {
      return [];
    }

    const populated = await Series.findById(series._id)
      .populate("author_id", "username full_name")
      .lean();
    if (!populated) return [];

    populated.author_name =
      populated.author_id?.full_name ||
      populated.author_id?.username ||
      "Tác giả";

    return await notifyFollowersAuthorNewSeries(Notification, populated);
  } catch (err) {
    console.error(
      `[ScheduledPublish] notify hook error for series ${series._id}:`,
      err.message
    );
    return [];
  }
};

/**
 * Tìm chapter kế tiếp trong Series (theo chapter_number) chưa publish.
 */
const findNextUnpublishedChapter = async (seriesId, currentChapterNumber) => {
  return Chapter.findOne({
    series_id: seriesId,
    is_published: { $ne: true },
    chapter_number: { $gt: currentChapterNumber },
  })
    .sort({ chapter_number: 1 })
    .select("_id chapter_number status")
    .lean();
};

/**
 * Recompute scheduled_publish_at cho chapter đang xét theo Policy B:
 *   scheduled_publish_at = (last published chapter.published_at + cadence)
 *   nhưng không được < now (đảm bảo tương lai).
 *
 * Trả về Date mới, hoặc null nếu không có anchor hợp lệ.
 */
const recomputePolicyB = async (series, currentChapter) => {
  const last = await getLastPublishedChapter(Chapter, series._id);
  if (!last) {
    // Series chưa có chapter nào publish → không thể tính anchor.
    // Vẫn giữ lịch cũ (job lần sau sẽ skip lại nếu buffer chưa đủ).
    return null;
  }
  const candidate = addInterval(last.published_at, series.publication_schedule);
  if (!candidate) return null;
  const now = new Date();
  if (candidate < now) {
    // Lịch đã qua → dời về tương lai, vẫn giữ cadence tính từ chapter vừa publish.
    return now;
  }
  return candidate;
};

/**
 * Publish 1 chapter (do job tới hạn).
 */
const publishChapter = async (chapter, series) => {
  const publishedAt = chapter.scheduled_publish_at || new Date();

  await Chapter.findByIdAndUpdate(chapter._id, {
    status: CHAPTER_STATUS.PUBLISHED,
    is_published: true,
    published_at: publishedAt,
    is_scheduled: false,
    revision_notes: "",
    revision_annotations: [],
    revision_source: "",
  });

  // Snapshot final_image_url cho pages (ưu tiên result_image_url, fallback original_image_url)
  await Page.updateMany(
    { chapter_id: chapter._id },
    [
      {
        $set: {
          final_image_url: {
            $ifNull: ["$result_image_url", "$original_image_url"],
          },
        },
      },
    ],
    { updatePipeline: true }
  ).catch((err) =>
    console.warn(
      `[ScheduledPublish] snapshot final_image_url failed for chapter ${chapter._id}:`,
      err.message
    )
  );

  // Update TEReview.decision
  const review = await TEReview.findOne({ chapter_id: chapter._id });
  if (review) {
    review.decision = TE_DECISION.APPROVED_PUBLISH;
    await review.save();
  }

  await Series.findByIdAndUpdate(chapter.series_id, {
    $set: { last_chapter_published_at: publishedAt },
  });

  // Notify Mangaka + followers (lỗi hook không làm fail job)
  try {
    await notifyChapterTEPublished(
      Notification,
      chapter.submitted_by,
      { ...chapter, published_at: publishedAt },
      series.name
    );
  } catch (err) {
    console.error(
      `[ScheduledPublish] notify mangaka failed for chapter ${chapter._id}:`,
      err.message
    );
  }

  try {
    const updatedChapter = { ...chapter, published_at: publishedAt };
    await notifyFollowersNewChapter(Notification, updatedChapter, series);
  } catch (err) {
    console.error(
      `[ScheduledPublish] notify followers failed for chapter ${chapter._id}:`,
      err.message
    );
  }

  return publishedAt;
};

/**
 * Sau khi publish 1 chapter → tự lên lịch chapter kế tiếp theo cadence.
 *
 * Quy tắc:
 * - Bất kỳ chapter nào vừa publish, đều tự schedule chapter tiếp theo (chưa publish) theo cadence.
 * - Chapter kế tiếp có thể chưa được TE-approve. Ta vẫn set lịch trước, để giữ cadence.
 * - Khi tới hạn, job sẽ kiểm buffer nếu đủ thì publish.
 */
const scheduleNextChapterIfNeeded = async (series, justPublishedChapter) => {
  if (!isValidSchedule(series.publication_schedule)) return null;

  const nextChapter = await findNextUnpublishedChapter(
    series._id,
    justPublishedChapter.chapter_number
  );
  if (!nextChapter) return null;

  const nextSchedule = addInterval(justPublishedChapter.published_at, series.publication_schedule);
  if (!nextSchedule) return null;

  await Chapter.findByIdAndUpdate(nextChapter._id, {
    scheduled_publish_at: nextSchedule,
    publication_schedule: series.publication_schedule,
    publication_duration_days: series.publication_schedule === "weekly" ? 7 : 30,
    is_scheduled: true,
  });

  console.log(
    `[ScheduledPublish] Auto-scheduled chapter ${nextChapter._id} (${nextChapter.chapter_number}) ` +
    `for ${nextSchedule.toISOString()} (cadence=${series.publication_schedule}, status=${nextChapter.status})`
  );
  return nextChapter;
};

/**
 * Kiểm tra điều kiện buffer trước khi publish:
 *  - Cần >= MIN_BUFFER (2) chapter approved_by_EB chưa publish.
 *  - Ngoại lệ 1: Chapter đầu tiên của Series (chưa có chapter nào publish).
 *    Cho phép publish chapter 1 dù chỉ có 1 chapter approved (vì chưa có gì để buffer).
 *    Nếu series.ongoing/hiatus/upcoming và chapter 2 chưa tồn tại → vẫn cho publish.
 *  - Ngoại lệ 2: Series.publication_status === "completed" và chapter là final → bypass.
 *
 * Trả về { allowed, reason, approvedCount, isFinal, isFirstChapter }.
 */
const checkBuffer = async (series, chapter) => {
  const approvedCount = await countApprovedUnpublishedChapters(Chapter, series._id);
  const isFinal = await isFinalChapterOfSeries(
    Chapter,
    series._id,
    chapter.chapter_number
  );

  // Xác định chapter đầu tiên của Series (chưa có chapter nào publish):
  // last.published_at < chapter.scheduled_publish_at hoặc không có last published.
  const last = await getLastPublishedChapter(Chapter, series._id);
  const isFirstChapter = !last;

  const isCompletedSeries = series.publication_status === "completed";

  // Ngoại lệ 1: chapter đầu tiên của Series (chưa từng publish) → cho phép publish.
  // Đảm bảo series ongoing vẫn có thể ra chapter 1 dù chưa có chapter 2.
  if (isFirstChapter) {
    return { allowed: true, reason: "first_chapter", approvedCount, isFinal, isFirstChapter };
  }
  if (approvedCount >= MIN_BUFFER) {
    return { allowed: true, reason: "buffer_ok", approvedCount, isFinal, isFirstChapter };
  }
  if (isCompletedSeries && isFinal) {
    return { allowed: true, reason: "final_chapter_completed_series", approvedCount, isFinal, isFirstChapter };
  }
  return { allowed: false, reason: "buffer_not_met", approvedCount, isFinal, isFirstChapter };
};

const processScheduledPublish = async () => {
  // Guard chống overlap: nếu job trước chưa xong (chạy > 60s do query chậm, network, ...),
  // bỏ qua lần chạy này để tránh 2 instance cùng publish 1 chapter.
  if (isRunning) {
    console.warn("[ScheduledPublish] Previous run still in progress, skipping this tick.");
    return;
  }
  isRunning = true;
  try {
    const now = new Date();

    // 1. Auto set Series.status = "published" theo Series.scheduled_publish_at
    //    SKIP nếu publication_status ∈ {hiatus, dropped} — admin đã đánh dấu ngưng/đã hủy,
    //    không nên force publish dù đã tới hạn.
    const dueSeries = await Series.find({
      status: SERIES_STATUS.APPROVED_BY_EB,
      scheduled_publish_at: { $lte: now, $ne: null },
      publication_status: { $nin: ["hiatus", "dropped"] },
    })
      .select("_id name author_id publication_schedule")
      .lean();

    if (dueSeries.length > 0) {
      console.log(`[ScheduledPublish] Auto-publishing ${dueSeries.length} series...`);
      await Series.updateMany(
        { _id: { $in: dueSeries.map((s) => s._id) } },
        { status: SERIES_STATUS.PUBLISHED, publication_status: "ongoing" }
      );

      // (Risk B) Notify follower của author khi series chính thức public.
      // Helper này đã dedup: nếu notification đã từng gửi (kể cả từ nhánh chapter fallback
      // ở tick trước) → skip, không spam follower.
      for (const series of dueSeries) {
        await notifyFollowersForPublishedSeries(series);
      }
    }

    // 2. Auto-publish chapter đã tới hạn
    // Sort theo chapter_number ASC để chapter nhỏ hơn publish trước,
    // tránh trường hợp chapter 2 vô tình có scheduled_publish_at < chapter 1
    // (vd chapter 2 được auto-schedule từ job trước đó, hoặc TE publish thủ công).
    const pendingChapters = await Chapter.find({
      is_scheduled: true,
      scheduled_publish_at: { $lte: now, $ne: null },
      status: CHAPTER_STATUS.APPROVED_BY_EB,
    })
      .sort({ chapter_number: 1 })
      .lean();

    if (pendingChapters.length === 0) return;

    console.log(
      `[ScheduledPublish] Processing ${pendingChapters.length} scheduled chapter(s)...`
    );

    for (const chapter of pendingChapters) {
      try {
        const series = await Series.findById(chapter.series_id).lean();
        if (!series) {
          console.warn(
            `[ScheduledPublish] Skip chapter ${chapter._id}: series not found`
          );
          continue;
        }

        // Sanity check: chưa tới ngày publish Series (chờ job Series publish trước)
        if (
          series.status === SERIES_STATUS.APPROVED_BY_EB &&
          series.scheduled_publish_at &&
          chapter.scheduled_publish_at < new Date(series.scheduled_publish_at)
        ) {
          console.warn(
            `[ScheduledPublish] Skip chapter ${chapter._id}: scheduled time ` +
            `< series scheduled_publish_at (sanity check)`
          );
          continue;
        }

        // ─── HIATUS / DROPPED guard ─────────────────────────────────────────
        // Nếu admin đã đánh dấu series tạm hoãn / bỏ, KHÔNG publish chapter này.
        // Giữ nguyên scheduled_publish_at để khi admin đổi lại publication_status,
        // job lần sau sẽ publish tiếp tục. Không recompute để tránh nhảy lịch.
        if (["hiatus", "dropped"].includes(series.publication_status)) {
          console.log(
            `[ScheduledPublish] Skip chapter ${chapter._id} (${chapter.chapter_number}): ` +
            `series is ${series.publication_status}. Hold scheduled_publish_at=`
            + `${chapter.scheduled_publish_at?.toISOString() ?? "null"} until admin unblocks.`
          );
          continue;
        }

        // ─── BUFFER CHECK: >= 2 chapter approved_by_EB chưa publish ───
        const buffer = await checkBuffer(series, chapter);
        if (!buffer.allowed) {
          // Áp dụng Policy B: dời lịch về tương lai, giữ cadence từ chapter vừa publish.
          const next = await recomputePolicyB(series, chapter);
          if (next) {
            await Chapter.findByIdAndUpdate(chapter._id, {
              scheduled_publish_at: next,
            });
            console.log(
              `[ScheduledPublish] Buffer not met (approved=${buffer.approvedCount}, ` +
              `final=${buffer.isFinal}) for chapter ${chapter._id} (${chapter.chapter_number}). ` +
              `Rescheduled to ${next.toISOString()} (Policy B).`
            );
          } else {
            console.log(
              `[ScheduledPublish] Buffer not met for chapter ${chapter._id} (${chapter.chapter_number}). ` +
              `No reschedule possible (no previous published chapter).`
            );
          }
          continue;
        }

        const publishedAt = await publishChapter(chapter, series);

        // Nếu Series vẫn đang "approved_by_EB" → set Series = "published"
        // (fallback cho trường hợp Series.scheduled_publish_at không khớp hoặc job Series chạy sau).
        if (series.status === SERIES_STATUS.APPROVED_BY_EB) {
          await Series.findByIdAndUpdate(series._id, {
            status: SERIES_STATUS.PUBLISHED,
            publication_status: series.publication_status || "ongoing",
          });
          // (Risk B) Cũng notify followers — nếu nhánh này là nhánh đầu tiên
          // set series → published (khi Series.scheduled_publish_at không kịp chạy),
          // tránh miss thông báo new_series_from_author.
          // Helper đã dedup: nếu nhánh Series job đã gửi ở tick trước → skip.
          await notifyFollowersForPublishedSeries({ _id: series._id });
        }

        // Tự lên lịch chapter kế tiếp theo cadence
        await scheduleNextChapterIfNeeded(
          series,
          { ...chapter, published_at: publishedAt }
        );

        console.log(
          `[ScheduledPublish] Chapter ${chapter._id} (${chapter.chapter_number}) published at ${publishedAt.toISOString()} ` +
          `(buffer=${buffer.reason}, approvedRemaining=${buffer.approvedCount - 1})`
        );
      } catch (err) {
        console.error(
          `[ScheduledPublish] Error publishing chapter ${chapter._id}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error("[ScheduledPublish] Job error:", err.message);
  } finally {
    isRunning = false;
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

module.exports = {
  startScheduledPublishJob,
  stopScheduledPublishJob,
  processScheduledPublish,
  // Exported for testing
  MIN_BUFFER,
};