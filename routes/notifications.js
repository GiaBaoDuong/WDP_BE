const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireReader } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Notification = require("../models/Notification");

/**
 * @swagger
 * /notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: Get notifications for the authenticated user
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: is_read
 *         schema:
 *           type: string
 *           enum: [true, false]
 *     responses:
 *       200:
 *         description: Notifications list with pagination
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Notification'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     pages:
 *                       type: integer
 *                 unreadCount:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 */
// Lấy danh sách notification của user đang login
// GET /notifications
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, is_read } = req.query;
    const filter = { user_id: req.user.nameid };
    if (is_read !== undefined) {
      filter.is_read = is_read === "true";
    }

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const total = await Notification.countDocuments(filter);
    const unread = await Notification.countDocuments({ user_id: req.user.nameid, is_read: false });

    return res.status(200).json({
      success: true,
      data: notifications,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit),
      },
      unreadCount: unread,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark a notification as read
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Notification'
 *       404:
 *         description: Notification not found
 */
// Đánh dấu 1 notification đã đọc
// PATCH /notifications/:id/read
router.patch("/:id/read", authMiddleware, async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.nameid },
      { is_read: true },
      { returnDocument: "after" }
    );
    if (!notif) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.status(200).json({ success: true, data: notif });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /notifications/read-all:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark all notifications as read
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized
 */
// Đánh dấu TẤT CẢ notification của user đã đọc
// PATCH /notifications/read-all
router.patch("/read-all", authMiddleware, async (req, res) => {
  try {
    await Notification.updateMany(
      { user_id: req.user.nameid, is_read: false },
      { is_read: true }
    );
    return res.status(200).json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /notifications/{id}:
 *   delete:
 *     tags: [Notifications]
 *     summary: Delete a notification
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       404:
 *         description: Notification not found
 */
// Xóa notification
// DELETE /notifications/:id
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const notif = await Notification.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user.nameid,
    });
    if (!notif) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SUBSCRIBE / UNSUBSCRIBE NOTIFICATION CHO 1 SERIES
// (Chỉ Reader mới được subscribe - Risk E)
// Cho phép subscribe cả series ở "approved_by_EB" (đã được EB duyệt, chờ publish theo lịch)
// lẫn "published" (đã public) để Reader bấm được nút khi được bạn bè share link sớm (Risk A)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /notifications/{seriesId}/status:
 *   get:
 *     tags: [Notifications]
 *     summary: Check whether the current user has subscribed to notifications for a series
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Trả về isSubscribed
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Reader only
 */
router.get(
  "/:seriesId/status",
  authMiddleware,
  requireReader,
  async (req, res, next) => {
    try {
      const NotificationSubscription = require("../models/NotificationSubscription");
      const sub = await NotificationSubscription.findOne({
        reader_id: req.user.nameid,
        series_id: req.params.seriesId,
      }).lean();
      return res.status(200).json({
        success: true,
        isSubscribed: !!(sub && sub.notify_new_chapter),
        data: sub,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /notifications/{seriesId}/subscribe:
 *   post:
 *     tags: [Notifications]
 *     summary: Subscribe to new-chapter notifications for a series
 *     description: |
 *       Bật notify khi có chapter mới. Upsert theo (reader, series).
 *       Chỉ cho phép với series đã is_public=true và ở status
 *       "approved_by_EB" (đã EB duyệt, chờ publish theo lịch) hoặc
 *       "published" (đã public).
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Đã bật thông báo cho series
 *       404:
 *         description: Series not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Reader only
 */
router.post(
  "/:seriesId/subscribe",
  authMiddleware,
  requireReader,
  async (req, res, next) => {
    try {
      const NotificationSubscription = require("../models/NotificationSubscription");
      const Series = require("../models/Series");
      const series = await Series.findOne({
        _id: req.params.seriesId,
        is_public: true,
        status: { $in: ["approved_by_EB", "published"] },
      })
        .select("_id name author_id")
        .lean();
      if (!series) return next(new AppError("Series not found", 404));

      const sub = await NotificationSubscription.findOneAndUpdate(
        { reader_id: req.user.nameid, series_id: series._id },
        {
          $set: { notify_new_chapter: true, notify_series_update: false },
          $setOnInsert: { created_at: new Date() },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      );
      return res.status(200).json({
        success: true,
        message: "Đã bật thông báo cho series",
        data: sub,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /notifications/{seriesId}/subscribe:
 *   delete:
 *     tags: [Notifications]
 *     summary: Unsubscribe from notifications for a series
 *     description: Tắt notify_new_chapter nhưng giữ record (để hiển thị "đã từng subscribe")
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: seriesId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Đã tắt thông báo cho series
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Reader only
 */
router.delete(
  "/:seriesId/subscribe",
  authMiddleware,
  requireReader,
  async (req, res, next) => {
    try {
      const NotificationSubscription = require("../models/NotificationSubscription");
      await NotificationSubscription.updateOne(
        { reader_id: req.user.nameid, series_id: req.params.seriesId },
        { $set: { notify_new_chapter: false } }
      );
      return res.status(200).json({
        success: true,
        message: "Đã tắt thông báo cho series",
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;
