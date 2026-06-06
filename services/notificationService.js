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
  await notifyUser(Notification, mangakaId, {
    type: "task_submitted",
    title: "Assistant đã nộp kết quả",
    message: `Task ${task.work_type} đã hoàn thành, cần kiểm duyệt.`,
    meta: { task_id: task._id, chapter_id: task.chapter_id },
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

module.exports = {
  sendToUser,
  notifyUser,
  notifyCoopInvite,
  notifyTaskAssigned,
  notifyTaskSubmitted,
  notifyTaskRevision,
  notifyChapterToTE,
  notifyChapterToEB,
  notifySeriesApproved,
  notifyRankingWarning,
  notifyAssistantResponse,
  notifyChapterAssigned,
};
