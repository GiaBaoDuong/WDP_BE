const { getIO } = require("../config/socket");

const sendToUser = (userId, event, data) => {
  try {
    const io = getIO();
    io.to(`user_${userId}`).emit(event, data);
  } catch (e) {
    // Socket chưa init, bỏ qua
  }
};

const notifyUser = async (Notification, userId, notifData) => {
  const notif = await Notification.create({
    user_id: userId,
    ...notifData,
  });
  sendToUser(userId, "notification", notif);
  return notif;
};

const notifyCoopInvite = async (Notification, mangaka, assistant) => {
  const mangakaUser = typeof mangaka === "object" ? mangaka : null;
  const mangakaId = mangakaUser ? mangakaUser._id : mangaka;
  const assistantId = typeof assistant === "object" ? assistant._id : assistant;

  const mangakaName = mangakaUser ? mangakaUser.full_name : "";
  await notifyUser(Notification, assistantId, {
    type: "coop_invite",
    title: "Yêu cầu hợp tác",
    message: `Mangaka ${mangakaName} muốn hợp tác với bạn.`,
    meta: { mangaka_id: mangakaId },
  });
};

const notifyTaskAssigned = async (Notification, assistantId, task, page) => {
  await notifyUser(Notification, assistantId, {
    type: "task_assigned",
    title: "Bạn có công việc mới",
    message: `Mangaka giao cho bạn 1 task: ${task.work_type} trên trang ${page.page_number}`,
    meta: { task_id: task._id, page_id: page._id, chapter_id: task.chapter_id },
  });
};

const notifyTaskSubmitted = async (Notification, mangakaId, task) => {
  // task có thể là:
  //   - Task object (có _id, work_type, chapter_id) — dùng cho /tasks/:id/submit
  //   - Submission object (có chapter_id, page_count, new_uploads, reused) — dùng cho /chapters/:id/submit-all
  const workType = task.work_type || `${task.page_count || 0} trang`;
  const message = task.work_type
    ? `Task ${task.work_type} đã hoàn thành, cần kiểm duyệt.`
    : `Assistant đã nộp chapter (${workType}). Có ${task.new_uploads || 0} ảnh mới, ${task.reused || 0} ảnh dùng lại.`;

  await notifyUser(Notification, mangakaId, {
    type: "task_submitted",
    title: task.work_type ? "Assistant đã nộp task" : "Assistant đã nộp kết quả",
    message,
    meta: {
      task_id: task._id,
      chapter_id: task.chapter_id,
      page_count: task.page_count,
      new_uploads: task.new_uploads,
      reused: task.reused,
    },
  });
};

const notifyTaskRevision = async (Notification, assistantId, task, note) => {
  await notifyUser(Notification, assistantId, {
    type: "task_revision",
    title: "Yêu cầu chỉnh sửa",
    message: `Mangaka yêu cầu chỉnh sửa: ${note || "xem chi tiết"}`,
    meta: { task_id: task._id, chapter_id: task.chapter_id },
  });
};

const notifyTaskApproved = async (Notification, assistantId, task) => {
  await notifyUser(Notification, assistantId, {
    type: "task_approved",
    title: "Task được duyệt",
    message: `Mangaka đã duyệt task ${task.work_type} trên trang.`,
    meta: { task_id: task._id, chapter_id: task.chapter_id },
  });
};

const notifyTaskAcknowledged = async (Notification, assistantId, task) => {
  await notifyUser(Notification, assistantId, {
    type: "task_acknowledged",
    title: "Mangaka đã nhận task",
    message: `Mangaka đã nhận task ${task.work_type} của bạn và đang kiểm duyệt.`,
    meta: { task_id: task._id, chapter_id: task.chapter_id },
  });
};

const notifyChapterAssistantWorkComplete = async (Notification, mangakaId, chapter, seriesName) => {
  await notifyUser(Notification, mangakaId, {
    type: "chapter_assistant_work_complete",
    title: "Assistant đã hoàn thành công việc",
    message: `Chapter #${chapter.chapter_number} - "${chapter.title}" của series "${seriesName}" đã sẵn sàng gửi lên TE.`,
    meta: { chapter_id: chapter._id, series_id: chapter.series_id },
  });
};

const notifyChapterAllTasksApproved = async (Notification, mangakaId, chapter, seriesName, totalTasks) => {
  await notifyUser(Notification, mangakaId, {
    type: "chapter_all_tasks_approved",
    title: "Tất cả tasks đã được duyệt",
    message: `Chapter #${chapter.chapter_number} - "${chapter.title}" đã hoàn thành tất cả ${totalTasks} task(s). Hãy gửi lên TE.`,
    meta: { chapter_id: chapter._id, series_id: chapter.series_id },
  });
};

const notifyChapterTERevision = async (Notification, mangakaId, chapter, seriesName, annotations = []) => {
  await notifyUser(Notification, mangakaId, {
    type: "chapter_TE_revision",
    title: "TE yêu cầu chỉnh sửa",
    message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) cần chỉnh sửa theo góp ý của TE.`,
    meta: {
      chapter_id: chapter._id,
      series_id: chapter.series_id,
      annotation_count: annotations.length,
    },
  });
};

const notifyChapterTERejected = async (Notification, mangakaId, chapter, seriesName) => {
  await notifyUser(Notification, mangakaId, {
    type: "chapter_TE_rejected",
    title: "TE từ chối chapter",
    message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) của series "${seriesName}" đã bị TE từ chối.`,
    meta: { chapter_id: chapter._id, series_id: chapter.series_id },
  });
};

const notifyChapterTEPublished = async (Notification, mangakaId, chapter, seriesName) => {
  await notifyUser(Notification, mangakaId, {
    type: "chapter_TE_published",
    title: "Chapter đã xuất bản",
    message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) của series "${seriesName}" đã được TE duyệt và xuất bản.`,
    meta: { chapter_id: chapter._id, series_id: chapter.series_id },
  });
};

const notifyChapterEBRevision = async (Notification, mangakaId, chapter, seriesName, notes = "") => {
  await notifyUser(Notification, mangakaId, {
    type: "chapter_EB_revision",
    title: "EB yêu cầu chỉnh sửa",
    message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) bị EB yêu cầu chỉnh sửa.`,
    meta: { chapter_id: chapter._id, series_id: chapter.series_id, notes },
  });
};

const notifyChapterToTE = async (Notification, teId, chapter, seriesName) => {
  await notifyUser(Notification, teId, {
    type: "chapter_to_TE",
    title: "Chapter mới cần duyệt",
    message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) của series "${seriesName}" cần TE duyệt.`,
    meta: { chapter_id: chapter._id, series_id: chapter.series_id },
  });
};

const notifyChapterToEB = async (Notification, ebId, chapter, seriesName) => {
  await notifyUser(Notification, ebId, {
    type: "chapter_to_EB",
    title: "Chapter mới cần EB duyệt",
    message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) của series "${seriesName}" cần EB duyệt.`,
    meta: { chapter_id: chapter._id, series_id: chapter.series_id },
  });
};

const notifySeriesApproved = async (Notification, mangakaId, seriesName, schedule) => {
  await notifyUser(Notification, mangakaId, {
    type: "series_approved",
    title: "Series được xuất bản",
    message: `Series "${seriesName}" đã được duyệt xuất bản. Lịch: ${schedule}.`,
    meta: {},
  });
};

const notifyRankingWarning = async (Notification, mangakaId, seriesName, rank) => {
  await notifyUser(Notification, mangakaId, {
    type: "ranking_warning",
    title: "Cảnh báo thứ hạng",
    message: `Series "${seriesName}" đang ở vị trí #${rank}, có nguy cơ bị hủy.`,
    meta: {},
  });
};

const notifySeriesRevision = async (Notification, mangakaId, series, feedback) => {
  await notifyUser(Notification, mangakaId, {
    type: "series_TE_revision",
    title: "Series cần chỉnh sửa",
    message: `Series "${series.name}" cần chỉnh sửa theo góp ý của TE.`,
    meta: { series_id: series._id, feedback },
  });
};

const notifySeriesPublished = async (Notification, mangakaId, series, schedule) => {
  await notifyUser(Notification, mangakaId, {
    type: "series_published",
    title: "Series đã xuất bản",
    message: `Series "${series.name}" đã được xác nhận xuất bản. Lịch: ${schedule || "N/A"}.`,
    meta: { series_id: series._id },
  });
};

const notifyAssistantResponse = async (Notification, mangakaId, type, assistantName) => {
  const messages = {
    rejected: `${assistantName} đã từ chối gặp mặt.`,
    accepted_meet: `${assistantName} đồng ý gặp mặt.`,
    accepted: `${assistantName} đã đồng ý hợp tác.`,
    declined: `${assistantName} không hợp tác sau buổi gặp.`,
  };
  await notifyUser(Notification, mangakaId, {
    type,
    title: "Phản hồi từ Assistant",
    message: messages[type] || "",
    meta: {},
  });
};

const notifyChapterAssigned = async (Notification, assistantId, chapter, seriesName) => {
  await notifyUser(Notification, assistantId, {
    type: "chapter_assigned",
    title: "Bạn được giao chapter mới",
    message: `Mangaka giao cho bạn chapter #${chapter.chapter_number} - "${chapter.title}" của series "${seriesName}".`,
    meta: { chapter_id: chapter._id, series_id: chapter.series_id },
  });
};

const notifyChapterScheduledPublish = async (Notification, mangakaId, chapter, seriesName, scheduledDate, schedule, durationDays) => {
  const dateStr = new Date(scheduledDate).toLocaleDateString("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
  await notifyUser(Notification, mangakaId, {
    type: "chapter_scheduled_publish",
    title: "Chapter được hẹn xuất bản",
    message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) của series "${seriesName}" đã được EB duyệt. Xuất bản ngày ${dateStr}, lịch ${schedule} (${durationDays} ngày).`,
    meta: {
      chapter_id: chapter._id,
      series_id: chapter.series_id,
      scheduled_date: scheduledDate,
      schedule,
      duration_days: durationDays,
    },
  });
};

const notifyChapterPublishConfirmed = async (Notification, mangakaId, chapter, seriesName, schedule, durationDays) => {
  await notifyUser(Notification, mangakaId, {
    type: "chapter_publish_confirmed",
    title: "Chapter đã xuất bản",
    message: `Chapter "${chapter.title}" (#${chapter.chapter_number}) của series "${seriesName}" đã được xuất bản. Lịch ${schedule}, hiển thị ${durationDays} ngày.`,
    meta: {
      chapter_id: chapter._id,
      series_id: chapter.series_id,
      schedule,
      duration_days: durationDays,
    },
  });
};

/**
 * Notify tất cả reader đã subscribe 1 series khi có chapter mới được publish.
 *
 * Defensive load: nếu caller truyền series thiếu `name` hoặc `author_id`,
 * service tự query lại từ DB để tránh notification bị content hỏng.
 *
 * KHÔNG notify cho chính tác giả (dù author có subscribe).
 * Hook fail cũng không làm fail request chính (đã wrap try/catch).
 */
const notifyFollowersNewChapter = async (Notification, chapter, seriesOpt) => {
  try {
    const NotificationSubscription = require("../models/NotificationSubscription");
    const Series = require("../models/Series");

    let series = seriesOpt;
    if (!series || !series.name || !series.author_id) {
      series = await Series.findById(chapter.series_id)
        .select("_id name author_id")
        .lean();
    }
    if (!series) return [];

    const subs = await NotificationSubscription.find({
      series_id: series._id,
      notify_new_chapter: true,
      reader_id: { $ne: series.author_id },
    }).lean();

    if (subs.length === 0) return [];

    const docs = subs.map((s) => ({
      user_id: s.reader_id,
      type: "new_chapter_published",
      title: `Chapter mới: ${series.name}`,
      message: `Chapter #${chapter.chapter_number}${
        chapter.title ? ` - "${chapter.title}"` : ""
      } vừa được xuất bản.`,
      related_entity_type: "chapter",
      related_entity_id: chapter._id,
      meta: {
        series_id: series._id,
        series_name: series.name,
        chapter_id: chapter._id,
        chapter_number: chapter.chapter_number,
      },
    }));

    const created = await Notification.insertMany(docs, { ordered: false });
    for (const notif of created) {
      sendToUser(notif.user_id, "notification", notif);
    }
    return created;
  } catch (e) {
    console.error("[notifyFollowersNewChapter] error:", e.message);
    return [];
  }
};

/**
 * Notify tất cả follower của author khi author ra series mới.
 *
 * Được gọi từ jobs/scheduledPublish.js khi series chuyển sang status="published",
 * đảm bảo notify đúng lúc Reader bắt đầu thấy series.
 *
 * KHÔNG notify cho chính tác giả.
 */
const notifyFollowersAuthorNewSeries = async (Notification, series) => {
  try {
    const FollowAuthor = require("../models/FollowAuthor");

    if (!series || !series._id || !series.author_id) return [];

    const followers = await FollowAuthor.find({
      author_id: series.author_id,
      reader_id: { $ne: series.author_id },
    }).lean();

    if (followers.length === 0) return [];

    const docs = followers.map((f) => ({
      user_id: f.reader_id,
      type: "new_series_from_author",
      title: `Tác giả ra series mới`,
      message: `${series.author_name || "Tác giả"} vừa cho ra series "${
        series.name
      }".`,
      related_entity_type: "series",
      related_entity_id: series._id,
      meta: {
        series_id: series._id,
        series_name: series.name,
        author_id: series.author_id,
      },
    }));

    const created = await Notification.insertMany(docs, { ordered: false });
    for (const notif of created) {
      sendToUser(notif.user_id, "notification", notif);
    }
    return created;
  } catch (e) {
    console.error("[notifyFollowersAuthorNewSeries] error:", e.message);
    return [];
  }
};

/**
 * Đếm số subscriber thực sự nhận notify cho 1 series (FE dùng để hiển thị badge).
 */
const getFollowerCount = async (NotificationSubscription, seriesId) => {
  return await NotificationSubscription.countDocuments({
    series_id: seriesId,
    notify_new_chapter: true,
  });
};

module.exports = {
  sendToUser,
  notifyUser,
  notifyCoopInvite,
  notifyTaskAssigned,
  notifyTaskSubmitted,
  notifyTaskRevision,
  notifyTaskApproved,
  notifyTaskAcknowledged,
  notifyChapterAssistantWorkComplete,
  notifyChapterAllTasksApproved,
  notifyChapterTERevision,
  notifyChapterTERejected,
  notifyChapterTEPublished,
  notifyChapterEBRevision,
  notifyChapterToTE,
  notifyChapterToEB,
  notifySeriesApproved,
  notifyRankingWarning,
  notifySeriesRevision,
  notifySeriesPublished,
  notifyAssistantResponse,
  notifyChapterAssigned,
  notifyChapterScheduledPublish,
  notifyChapterPublishConfirmed,
  notifyFollowersNewChapter,
  notifyFollowersAuthorNewSeries,
  getFollowerCount,
};
