/**
 * Publication schedule helpers.
 *
 * - weekly  → 7 days interval
 * - monthly → 30 days interval
 */
const { PUBLICATION_SCHEDULE } = require("../utils/constants");

const SCHEDULE_INTERVAL_DAYS = {
  [PUBLICATION_SCHEDULE.WEEKLY]: 7,
  [PUBLICATION_SCHEDULE.MONTHLY]: 30,
};

const isValidSchedule = (schedule) =>
  schedule === PUBLICATION_SCHEDULE.WEEKLY || schedule === PUBLICATION_SCHEDULE.MONTHLY;

/**
 * Compute next chapter publish date from previous one + cadence.
 * Returns null if schedule is invalid.
 */
const addInterval = (fromDate, schedule) => {
  if (!fromDate || !isValidSchedule(schedule)) return null;
  const days = SCHEDULE_INTERVAL_DAYS[schedule];
  const result = new Date(fromDate);
  result.setDate(result.getDate() + days);
  return result;
};

/**
 * Find the most recently published chapter for a series (by published_at desc).
 * Returns null if none.
 */
const getLastPublishedChapter = async (Chapter, seriesId) => {
  return Chapter.findOne({ series_id: seriesId, is_published: true })
    .sort({ published_at: -1 })
    .select("_id chapter_number published_at scheduled_publish_at")
    .lean();
};

/**
 * Compute the expected scheduled_publish_at for a new chapter given:
 * - the previous chapter's published_at (or scheduled_publish_at if not yet published)
 * - the series' publication_schedule
 *
 * Returns Date or null if no previous anchor or invalid schedule.
 */
const computeNextChapterSchedule = (previousChapter, schedule) => {
  if (!previousChapter || !isValidSchedule(schedule)) return null;
  const anchor =
    previousChapter.published_at ||
    previousChapter.scheduled_publish_at ||
    null;
  if (!anchor) return null;
  return addInterval(new Date(anchor), schedule);
};

/**
 * Count chapters of a series that have been TE-approved (status = approved_by_EB)
 * but not yet published. Used to enforce the "buffer" rule:
 *   - At least 2 approved-but-unpublished chapters must exist before a chapter
 *     is allowed to publish, so the weekly/monthly cadence is sustainable.
 *   - Final chapter exception: if the series is marked "completed", the final
 *     chapter can be published even with only 1 approved-but-unpublished chapter.
 */
const countApprovedUnpublishedChapters = async (Chapter, seriesId) => {
  return Chapter.countDocuments({
    series_id: seriesId,
    status: "approved_by_EB",
    is_published: { $ne: true },
  });
};

/**
 * Determine whether the given chapter is the final chapter of its series.
 *
 * "Final" = there is no other chapter with a strictly greater chapter_number
 * (regardless of status). This means no later chapter has been created yet,
 * so allowing this chapter to publish without the 2-chapter buffer is safe.
 */
const isFinalChapterOfSeries = async (Chapter, seriesId, chapterNumber) => {
  if (chapterNumber === undefined || chapterNumber === null) return false;
  const laterChapter = await Chapter.findOne({
    series_id: seriesId,
    chapter_number: { $gt: chapterNumber },
  })
    .select("_id")
    .lean();
  return !laterChapter;
};

module.exports = {
  PUBLICATION_SCHEDULE: require("../utils/constants").PUBLICATION_SCHEDULE,
  SCHEDULE_INTERVAL_DAYS,
  isValidSchedule,
  addInterval,
  getLastPublishedChapter,
  computeNextChapterSchedule,
  countApprovedUnpublishedChapters,
  isFinalChapterOfSeries,
};