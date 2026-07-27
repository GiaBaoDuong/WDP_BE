require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
  quiet: true,
});

const mongoose = require("mongoose");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const SeriesEndRequest = require("../models/SeriesEndRequest");
const {
  completeSeriesIfTargetChapterPublished,
  toPositiveInteger,
} = require("../services/seriesEndService");
const { SERIES_STATUS } = require("../utils/constants");

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const NOTIFY = args.has("--notify");
const CANCEL_INVALID = args.has("--cancel-invalid");

const usage = `
Usage:
  node scripts/migrate-series-end-requests.js
  node scripts/migrate-series-end-requests.js --apply

Options:
  --apply           Write changes to MongoDB Atlas. Without this, dry-run only.
  --notify          When completing a series, send normal completion notifications.
  --cancel-invalid  Cancel pending/approved end requests that do not have a valid planned_final_chapter_number.

This migration:
  1. Finds pending/approved SeriesEndRequest docs missing a valid planned_final_chapter_number.
  2. For approved valid requests, unschedules chapters after the requested final chapter.
  3. Completes the series only if the requested final chapter is already published.
  4. Cleans old accidental publication_status="awaiting_final_chapter" values if they exist.
`;

const log = (...parts) => console.log("[SeriesEndMigration]", ...parts);

const requireMongoUri = () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in .env");
  }
};

const updateIfApply = async (description, callback) => {
  if (!APPLY) {
    log("dry-run:", description);
    return null;
  }
  log("apply:", description);
  return callback();
};

const cancelInvalidRequests = async (invalidRequests) => {
  if (!invalidRequests.length) return 0;
  if (!CANCEL_INVALID) {
    log(
      `${invalidRequests.length} invalid pending/approved request(s) found. ` +
        "They cannot be auto-fixed because the final chapter number is unknown."
    );
    invalidRequests.slice(0, 20).forEach((request) => {
      log(
        `invalid request id=${request._id} series=${request.series_id} status=${request.status}`
      );
    });
    if (invalidRequests.length > 20) {
      log(`...and ${invalidRequests.length - 20} more invalid request(s).`);
    }
    log("Use --apply --cancel-invalid to mark these invalid requests as cancelled.");
    return 0;
  }

  await updateIfApply(
    `cancel ${invalidRequests.length} invalid pending/approved end request(s)`,
    () =>
      SeriesEndRequest.updateMany(
        { _id: { $in: invalidRequests.map((request) => request._id) } },
        {
          $set: {
            status: "cancelled",
            admin_note:
              "Cancelled by migration: missing valid planned_final_chapter_number.",
          },
        }
      )
  );
  return invalidRequests.length;
};

const completeWithoutNotifications = async (seriesId) => {
  return Series.findOneAndUpdate(
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
};

const migrateApprovedRequest = async (request) => {
  const finalChapterNumber = toPositiveInteger(
    request.planned_final_chapter_number
  );
  if (!finalChapterNumber) {
    return { invalid: true };
  }

  const finalChapter = await Chapter.findOne({
    series_id: request.series_id,
    chapter_number: finalChapterNumber,
  }).lean();

  const scheduledAfterFinalCount = await Chapter.countDocuments({
    series_id: request.series_id,
    chapter_number: { $gt: finalChapterNumber },
    is_published: { $ne: true },
    is_scheduled: true,
  });

  if (scheduledAfterFinalCount > 0) {
    await updateIfApply(
      `unschedule ${scheduledAfterFinalCount} chapter(s) after final chapter #${finalChapterNumber} for series=${request.series_id}`,
      () =>
        Chapter.updateMany(
          {
            series_id: request.series_id,
            chapter_number: { $gt: finalChapterNumber },
            is_published: { $ne: true },
            is_scheduled: true,
          },
          {
            $set: {
              scheduled_publish_at: null,
              is_scheduled: false,
            },
          }
        )
    );
  }

  const finalChapterPublished = Boolean(finalChapter?.is_published);
  if (!finalChapterPublished) {
    log(
      `series=${request.series_id} approved request waits for chapter #${finalChapterNumber} to publish`
    );
    return {
      finalChapterNumber,
      finalChapterPublished,
      completed: false,
      scheduledAfterFinalCount,
    };
  }

  if (NOTIFY) {
    await updateIfApply(
      `complete series=${request.series_id} with notifications because chapter #${finalChapterNumber} is published`,
      () => completeSeriesIfTargetChapterPublished(finalChapter)
    );
  } else {
    await updateIfApply(
      `complete series=${request.series_id} without notifications because chapter #${finalChapterNumber} is published`,
      () => completeWithoutNotifications(request.series_id)
    );
  }

  return {
    finalChapterNumber,
    finalChapterPublished,
    completed: true,
    scheduledAfterFinalCount,
  };
};

const normalizeAwaitingFinalStatus = async () => {
  const seriesList = await Series.find({
    publication_status: "awaiting_final_chapter",
  })
    .select("_id status publication_status")
    .lean();

  if (!seriesList.length) return 0;

  log(
    `${seriesList.length} series document(s) have old publication_status="awaiting_final_chapter".`
  );

  let normalized = 0;
  for (const series of seriesList) {
    const request = await SeriesEndRequest.findOne({
      series_id: series._id,
      status: "approved",
    })
      .sort({ decided_at: -1, createdAt: -1 })
      .lean();

    const finalChapterNumber = toPositiveInteger(
      request?.planned_final_chapter_number
    );

    let newPublicationStatus =
      series.status === SERIES_STATUS.PUBLISHED ? "ongoing" : "upcoming";

    if (finalChapterNumber) {
      const finalChapter = await Chapter.findOne({
        series_id: series._id,
        chapter_number: finalChapterNumber,
        is_published: true,
      }).lean();

      if (finalChapter) {
        newPublicationStatus = "completed";
      }
    }

    await updateIfApply(
      `normalize series=${series._id} publication_status awaiting_final_chapter -> ${newPublicationStatus}`,
      () =>
        Series.findByIdAndUpdate(series._id, {
          publication_status: newPublicationStatus,
        })
    );
    normalized += 1;
  }

  return normalized;
};

const main = async () => {
  if (args.has("--help") || args.has("-h")) {
    console.log(usage.trim());
    return;
  }

  requireMongoUri();

  log(APPLY ? "mode=apply" : "mode=dry-run");
  log(NOTIFY ? "completion notifications enabled" : "completion notifications disabled");

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  log("connected to MongoDB Atlas");

  const activeRequests = await SeriesEndRequest.find({
    status: { $in: ["pending", "approved"] },
  }).lean();

  const invalidRequests = activeRequests.filter(
    (request) => !toPositiveInteger(request.planned_final_chapter_number)
  );
  const cancelledInvalid = await cancelInvalidRequests(invalidRequests);

  const approvedRequests = activeRequests.filter(
    (request) =>
      request.status === "approved" &&
      toPositiveInteger(request.planned_final_chapter_number)
  );

  const summary = {
    activeRequests: activeRequests.length,
    invalidRequests: invalidRequests.length,
    cancelledInvalid,
    approvedRequests: approvedRequests.length,
    completedSeries: 0,
    waitingForFinalChapter: 0,
    scheduledAfterFinalFixed: 0,
    normalizedAwaitingFinalStatus: 0,
  };

  for (const request of approvedRequests) {
    const result = await migrateApprovedRequest(request);
    if (result.completed) summary.completedSeries += 1;
    if (result.completed === false) summary.waitingForFinalChapter += 1;
    summary.scheduledAfterFinalFixed += result.scheduledAfterFinalCount || 0;
  }

  summary.normalizedAwaitingFinalStatus = await normalizeAwaitingFinalStatus();

  log("summary", JSON.stringify(summary, null, 2));
  if (!APPLY) {
    log("No data was changed. Re-run with --apply to write these changes.");
  }
};

main()
  .catch((err) => {
    console.error("[SeriesEndMigration] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
