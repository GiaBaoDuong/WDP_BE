const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const SeriesEndRequest = require("../models/SeriesEndRequest");
const Notification = require("../models/Notification");
const NotificationSubscription = require("../models/NotificationSubscription");
const Cooperation = require("../models/Cooperation");
const { SERIES_STATUS, NOTIF_TYPES } = require("../utils/constants");

const toPositiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const getApprovedEndRequestForSeries = async (seriesId) => {
  return SeriesEndRequest.findOne({
    series_id: seriesId,
    status: "approved",
  })
    .sort({ decided_at: -1, createdAt: -1 })
    .lean();
};

const cancelScheduledChaptersAfterFinalChapter = async (
  seriesId,
  finalChapterNumber
) => {
  const normalizedFinalChapterNumber = toPositiveInteger(finalChapterNumber);
  if (!seriesId || !normalizedFinalChapterNumber) return null;

  return Chapter.updateMany(
    {
      series_id: seriesId,
      chapter_number: { $gt: normalizedFinalChapterNumber },
      is_published: { $ne: true },
      is_scheduled: true,
    },
    {
      $set: {
        scheduled_publish_at: null,
        is_scheduled: false,
      },
    }
  );
};

const notifySeriesCompleted = async ({
  series,
  endRequest,
  finalChapterNumber,
  notifyRequester,
}) => {
  if (notifyRequester) {
    await Notification.create({
      user_id: endRequest.requested_by,
      type: NOTIF_TYPES.SERIES_END_APPROVED,
      title: "Series đã hoàn thành",
      message:
        `Chapter #${finalChapterNumber} của truyện "${series.name}" đã được publish. ` +
        "Series đã chính thức hoàn thành.",
      is_read: false,
      related_entity_type: "series_end_request",
      related_entity_id: endRequest._id,
    }).catch((err) =>
      console.warn("[SeriesEnd] notify requester failed:", err.message)
    );
  }

  const subscribers = await NotificationSubscription.find({
    series_id: series._id,
  })
    .select("reader_id")
    .lean();

  if (subscribers.length > 0) {
    await Notification.insertMany(
      subscribers.map((subscriber) => ({
        user_id: subscriber.reader_id,
        type: NOTIF_TYPES.SERIES_END_NOTIFY_READERS,
        title: "Truyện đã kết thúc",
        message:
          `Truyện "${series.name}" mà bạn đang theo dõi đã kết thúc. ` +
          "Cảm ơn bạn đã đồng hành cùng tác phẩm!",
        is_read: false,
        related_entity_type: "series",
        related_entity_id: series._id,
      }))
    ).catch((err) =>
      console.warn("[SeriesEnd] notify readers failed:", err.message)
    );
  }

  const activeCooperation = await Cooperation.findOne({
    series_id: series._id,
    agreed_at: { $ne: null },
  })
    .select("assistant_id")
    .lean();

  if (activeCooperation) {
    await Notification.create({
      user_id: activeCooperation.assistant_id,
      type: NOTIF_TYPES.SERIES_END_NOTIFY_ASSISTANT,
      title: "Truyện đang hợp tác đã kết thúc",
      message:
        `Series "${series.name}" mà bạn đang hỗ trợ đã hoàn thành. ` +
        "Cảm ơn bạn đã đồng hành!",
      is_read: false,
      related_entity_type: "series_end_request",
      related_entity_id: endRequest._id,
    }).catch((err) =>
      console.warn("[SeriesEnd] notify assistant failed:", err.message)
    );
  }
};

const completeSeriesIfTargetChapterPublished = async (
  chapter,
  { notifyRequester = true } = {}
) => {
  const seriesId = chapter?.series_id?._id || chapter?.series_id;
  const chapterNumber = toPositiveInteger(chapter?.chapter_number);

  if (!seriesId || !chapterNumber || !chapter?.is_published) {
    return null;
  }

  const endRequest = await SeriesEndRequest.findOne({
    series_id: seriesId,
    status: "approved",
    planned_final_chapter_number: chapterNumber,
  })
    .sort({ decided_at: -1, createdAt: -1 })
    .lean();

  if (!endRequest) return null;

  const series = await Series.findOneAndUpdate(
    {
      _id: seriesId,
      publication_status: { $ne: "completed" },
    },
    {
      $set: {
        status: SERIES_STATUS.PUBLISHED,
        publication_status: "completed",
        publication_schedule: null,
        scheduled_publish_at: null,
      },
    },
    { new: true }
  ).lean();

  if (!series) return null;

  await cancelScheduledChaptersAfterFinalChapter(seriesId, chapterNumber).catch(
    (err) =>
      console.warn(
        "[SeriesEnd] cancel scheduled chapters after final failed:",
        err.message
      )
  );

  await notifySeriesCompleted({
    series,
    endRequest,
    finalChapterNumber: chapterNumber,
    notifyRequester,
  }).catch((err) =>
    console.warn("[SeriesEnd] completion notification failed:", err.message)
  );

  return { series, endRequest, finalChapterNumber: chapterNumber };
};

module.exports = {
  cancelScheduledChaptersAfterFinalChapter,
  completeSeriesIfTargetChapterPublished,
  getApprovedEndRequestForSeries,
  toPositiveInteger,
};
