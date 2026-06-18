const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { requireMangaka, requireAssistant } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const CooperationRequest = require("../models/CooperationRequest");
const Cooperation = require("../models/Cooperation");
const Notification = require("../models/Notification");
const User = require("../models/User");
const {
  notifyCoopInvite,
  notifyAssistantResponse,
} = require("../services/notificationService");

// ─── POST /cooperation-requests ──────────────────────────────────────────────
// Mangaka gửi yêu cầu hợp tác đến Assistant
/**
 * @swagger
 * /cooperation-requests/requests:
 *   post:
 *     summary: Gửi yêu cầu hợp tác
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - assistant_id
 *             properties:
 *               assistant_id:
 *                 type: string
 *                 description: ID của Assistant
 *               series_id:
 *                 type: string
 *                 description: ID của Series (tùy chọn)
 *               message:
 *                 type: string
 *                 description: Tin nhắn đính kèm (tùy chọn)
 *     responses:
 *       201:
 *         description: Yêu cầu hợp tác đã được gửi
 *       400:
 *         description: Thiếu assistant_id
 *       404:
 *         description: Assistant không tìm thấy
 *       409:
 *         description: Yêu cầu đang chờ xử lý
 */
router.post("/requests", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { assistant_id, series_id, message } = req.body;

    if (!assistant_id) {
      return next(new AppError("assistant_id is required", 400));
    }

    const assistant = await User.findOne({ _id: assistant_id, role: "Assistant" });
    if (!assistant) {
      return next(new AppError("Assistant not found", 404));
    }

    // Kiểm tra request đang pending chưa
    const existing = await CooperationRequest.findOne({
      mangaka_id: req.user.nameid,
      assistant_id,
      status: "pending",
    });
    if (existing) {
      return next(new AppError("Request already pending", 409));
    }

    const request = await CooperationRequest.create({
      mangaka_id: req.user.nameid,
      assistant_id,
      series_id: series_id || null,
      message: message || "",
      status: "pending",
    });

    await notifyCoopInvite(Notification, req.user.userId, assistant_id, request);

    return res.status(201).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
});

// ─── GET /cooperation-requests/assistants ────────────────────────────────────
// Mangaka xem danh sách tất cả Assistant để gửi lời mời hợp tác
/**
 * @swagger
 * /cooperation-requests/assistants:
 *   get:
 *     summary: Lấy danh sách tất cả Assistant
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Tìm kiếm theo username hoặc full_name
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
 *     responses:
 *       200:
 *         description: Danh sách Assistant
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
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       username:
 *                         type: string
 *                       full_name:
 *                         type: string
 *                       email:
 *                         type: string
 */
router.get("/assistants", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { role: "Assistant" };
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: "i" } },
        { full_name: { $regex: search, $options: "i" } },
      ];
    }

    const [assistants, total] = await Promise.all([
      User.find(filter)
        .select("username full_name email")
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      User.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: assistants,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /cooperation-requests/mine ─────────────────────────────────────────
// Mangaka xem danh sách request đã gửi
/**
 * @swagger
 * /cooperation-requests/requests/mine:
 *   get:
 *     summary: Lấy danh sách yêu cầu hợp tác đã gửi
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách yêu cầu hợp tác
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
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       assistant_id:
 *                         type: object
 *                       series_id:
 *                         type: object
 *                       status:
 *                         type: string
 *                       message:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 */
router.get("/requests/mine", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const requests = await CooperationRequest.find({ mangaka_id: req.user.nameid })
      .populate("assistant_id", "username full_name email phoneNumber")
      .populate("series_id", "name")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: requests });
  } catch (error) {
    next(error);
  }
});

// ─── GET /cooperation-requests/incoming ─────────────────────────────────────
// Assistant xem danh sách request nhận được
/**
 * @swagger
 * /cooperation-requests/requests/incoming:
 *   get:
 *     summary: Lấy danh sách yêu cầu hợp tác nhận được
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách yêu cầu nhận được
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
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       mangaka_id:
 *                         type: object
 *                       series_id:
 *                         type: object
 *                       status:
 *                         type: string
 *                       message:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 */
router.get("/requests/incoming", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const requests = await CooperationRequest.find({ assistant_id: req.user.nameid })
      .populate("mangaka_id", "username full_name email phoneNumber")
      .populate("series_id", "name")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, data: requests });
  } catch (error) {
    next(error);
  }
});

// ─── POST /cooperation-requests/:id/accept-meet ──────────────────────────────
// Assistant đồng ý gặp mặt
/**
 * @swagger
 * /cooperation-requests/requests/{id}/accept-meet:
 *   post:
 *     summary: Đồng ý gặp mặt với Mangaka
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của yêu cầu hợp tác
 *     responses:
 *       200:
 *         description: Đã đồng ý gặp mặt
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       404:
 *         description: Yêu cầu không tìm thấy
 */
router.post("/requests/:id/accept-meet", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const request = await CooperationRequest.findOne({
      _id: req.params.id,
      assistant_id: req.user.nameid,
      status: "pending",
    });
    if (!request) return next(new AppError("Request not found", 404));

    request.status = "accepted_meet";
    request.responded_at = new Date();
    await request.save();

    const mangaka = await User.findById(request.mangaka_id).lean();
    await notifyAssistantResponse(Notification, request.mangaka_id, "accepted_meet", mangaka.full_name);

    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
});

// ─── POST /cooperation-requests/:id/reject ───────────────────────────────────
// Assistant từ chối
/**
 * @swagger
 * /cooperation-requests/requests/{id}/reject:
 *   post:
 *     summary: Từ chối yêu cầu hợp tác
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của yêu cầu hợp tác
 *     responses:
 *       200:
 *         description: Đã từ chối yêu cầu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       404:
 *         description: Yêu cầu không tìm thấy
 */
router.post("/requests/:id/reject", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const request = await CooperationRequest.findOne({
      _id: req.params.id,
      assistant_id: req.user.nameid,
      status: { $in: ["pending", "accepted_meet"] },
    });
    if (!request) return next(new AppError("Request not found", 404));

    request.status = "rejected";
    request.responded_at = new Date();
    await request.save();

    const mangaka = await User.findById(request.mangaka_id).lean();
    const assistant = await User.findById(req.user.nameid).lean();
    await notifyAssistantResponse(Notification, request.mangaka_id, "rejected", assistant.full_name);

    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
});

// ─── POST /cooperation-requests/:id/accept-cooperation ─────────────────────
// Assistant đồng ý hợp tác SAU khi gặp mặt
/**
 * @swagger
 * /cooperation-requests/requests/{id}/accept-cooperation:
 *   post:
 *     summary: Chấp nhận hợp tác sau khi gặp mặt
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của yêu cầu hợp tác
 *     responses:
 *       200:
 *         description: Đã chấp nhận hợp tác
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     request:
 *                       type: object
 *                     cooperation:
 *                       type: object
 *       404:
 *         description: Yêu cầu không tìm thấy hoặc chưa ở trạng thái gặp mặt
 */
router.post("/requests/:id/accept-cooperation", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const request = await CooperationRequest.findOne({
      _id: req.params.id,
      assistant_id: req.user.nameid,
      status: "accepted_meet",
    });
    if (!request) return next(new AppError("Request not found or not in meeting state", 404));

    request.status = "accepted";
    request.responded_at = new Date();
    await request.save();

    // Tạo quan hệ hợp tác
    const cooperation = await Cooperation.create({
      mangaka_id: request.mangaka_id,
      assistant_id: req.user.nameid,
      series_id: request.series_id,
      agreed_at: new Date(),
    });

    const mangaka = await User.findById(request.mangaka_id).lean();
    await notifyAssistantResponse(Notification, request.mangaka_id, "accepted", mangaka.full_name);

    return res.status(200).json({ success: true, data: { request, cooperation } });
  } catch (error) {
    next(error);
  }
});

// ─── POST /cooperation-requests/:id/decline-cooperation ───────────────────────
// Assistant không hợp tác sau khi gặp
/**
 * @swagger
 * /cooperation-requests/requests/{id}/decline-cooperation:
 *   post:
 *     summary: Từ chối hợp tác sau khi gặp mặt
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID của yêu cầu hợp tác
 *     responses:
 *       200:
 *         description: Đã từ chối hợp tác
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       404:
 *         description: Yêu cầu không tìm thấy hoặc chưa ở trạng thái gặp mặt
 */
router.post("/requests/:id/decline-cooperation", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const request = await CooperationRequest.findOne({
      _id: req.params.id,
      assistant_id: req.user.nameid,
      status: "accepted_meet",
    });
    if (!request) return next(new AppError("Request not found or not in meeting state", 404));

    request.status = "declined";
    request.responded_at = new Date();
    await request.save();

    const mangaka = await User.findById(request.mangaka_id).lean();
    const assistant = await User.findById(req.user.nameid).lean();
    await notifyAssistantResponse(Notification, request.mangaka_id, "declined", assistant.full_name);

    return res.status(200).json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
});

// ─── GET /cooperation-requests/mine ──────────────────────────────────────────
// Mangaka xem danh sách hợp đồng của mình
/**
 * @swagger
 * /cooperation-requests/mine:
 *   get:
 *     summary: Lấy danh sách hợp tác của Mangaka
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách hợp tác
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
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       assistant_id:
 *                         type: object
 *                       series_id:
 *                         type: object
 *                       agreed_at:
 *                         type: string
 *                         format: date-time
 */
router.get("/mine", authMiddleware, requireMangaka, async (req, res, next) => {
  try {
    const cooperations = await Cooperation.find({ mangaka_id: req.user.nameid })
      .populate("assistant_id", "username full_name email phoneNumber")
      .populate("series_id", "name")
      .lean();

    return res.status(200).json({ success: true, data: cooperations });
  } catch (error) {
    next(error);
  }
});

// ─── GET /cooperation-requests/assistant/mine ──────────────────────────────────
// Assistant xem hợp đồng của mình
/**
 * @swagger
 * /cooperation-requests/assistant/mine:
 *   get:
 *     summary: Lấy danh sách hợp tác của Assistant
 *     tags: [Cooperations]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách hợp tác
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
 *                     type: object
 *                     properties:
 *                       _id:
 *                         type: string
 *                       mangaka_id:
 *                         type: object
 *                       series_id:
 *                         type: object
 *                       agreed_at:
 *                         type: string
 *                         format: date-time
 */
router.get("/assistant/mine", authMiddleware, requireAssistant, async (req, res, next) => {
  try {
    const cooperations = await Cooperation.find({ assistant_id: req.user.nameid })
      .populate("mangaka_id", "username full_name email phoneNumber")
      .populate("series_id", "name")
      .lean();

    return res.status(200).json({ success: true, data: cooperations });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
