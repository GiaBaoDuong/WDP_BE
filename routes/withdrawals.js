/**
 * Withdrawals routes - Yêu cầu rút tiền cho Mangaka/Assistant + Admin duyệt.
 *
 * User routes:
 *  POST /withdrawals              - Tạo yêu cầu
 *  GET  /withdrawals/mine         - Lịch sử của current user
 *  GET  /withdrawals/mine/:id     - Chi tiết 1 yêu cầu của mình
 *
 * Admin routes (requireAdmin):
 *  GET    /withdrawals            - Tất cả yêu cầu
 *  GET    /withdrawals/:id        - Chi tiết (kèm bank info đầy đủ)
 *  PATCH  /withdrawals/:id/approve
 *  PATCH  /withdrawals/:id/reject
 *  PATCH  /withdrawals/:id/complete
 */
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const Withdrawal = require("../models/Withdrawal");
const User = require("../models/User");
const withdrawalService = require("../services/withdrawalService");
const { WITHDRAWAL_STATUS } = require("../models/Withdrawal");
const config = require("../config/payment");

const maskAccountNumber = (acc) => {
  if (!acc) return "";
  if (acc.length <= 4) return "********";
  return "********" + acc.slice(-4);
};

const shapeForOwner = (w) => {
  // Owner thấy đầy đủ bank info của chính mình
  return {
    ...w,
    bank_snapshot: w.bank_snapshot
      ? {
          bank_name: w.bank_snapshot.bank_name,
          account_holder: w.bank_snapshot.account_holder,
          account_number_masked: maskAccountNumber(
            w.bank_snapshot.account_number
          ),
          // Chỉ trả full account_number cho owner khi status = pending (xác nhận lại)
          account_number:
            w.status === "pending" ? w.bank_snapshot.account_number : undefined,
        }
      : null,
  };
};

const shapeForAdmin = (w) => {
  // Admin thấy đầy đủ để xử lý
  return w;
};

const shapeForPublic = (w) => {
  // Mask tất cả
  return {
    ...w,
    bank_snapshot: w.bank_snapshot
      ? {
          bank_name: w.bank_snapshot.bank_name,
          account_holder: w.bank_snapshot.account_holder,
          account_number_masked: maskAccountNumber(
            w.bank_snapshot.account_number
          ),
        }
      : null,
  };
};

// ─── POST /withdrawals ────────────────────────────────────────────────────────
/**
 * @swagger
 * /withdrawals:
 *   post:
 *     summary: (Mangaka/Assistant) Tạo yêu cầu rút TOÀN BỘ số dư khả dụng
 *     description: |
 *       User chỉ được rút **toàn bộ `available_balance`**, không rút một phần.
 *       Số coin và VND sẽ tự động lấy từ ví của user tại thời điểm tạo yêu cầu.
 *       Body không cần truyền coin_amount/vnd_amount (sẽ bị bỏ qua nếu truyền).
 *     tags: [Withdrawals]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note: { type: string, description: "Ghi chú kèm yêu cầu" }
 *     responses:
 *       201: { description: Tạo thành công }
 *       400: { description: Thiếu thông tin ngân hàng, số dư không hợp lệ, dưới mức tối thiểu, hoặc đã có yêu cầu đang xử lý }
 */
router.post("/", authMiddleware, async (req, res, next) => {
  try {
    const w = await withdrawalService.createWithdrawalRequest(
      req.user.nameid,
      req.body
    );
    return res.status(201).json({
      success: true,
      message: "Tạo yêu cầu rút tiền thành công. Vui lòng chờ Admin duyệt.",
      data: shapeForOwner(w.toObject()),
    });
  } catch (error) {
    if (error instanceof withdrawalService.WithdrawalError) {
      return next(
        new AppError(error.message, error.statusCode, { code: error.code })
      );
    }
    next(error);
  }
});

// ─── GET /withdrawals/mine ────────────────────────────────────────────────────
/**
 * @swagger
 * /withdrawals/mine:
 *   get:
 *     summary: Lịch sử yêu cầu rút tiền của current user
 *     tags: [Withdrawals]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Danh sách }
 */
router.get("/mine", authMiddleware, async (req, res, next) => {
  try {
    const items = await Withdrawal.find({ user_id: req.user.nameid })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({
      success: true,
      data: items.map(shapeForOwner),
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /withdrawals/mine/:id ─────────────────────────────────────────────────
router.get("/mine/:id", authMiddleware, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid id", 400));
    }
    const w = await Withdrawal.findOne({
      _id: req.params.id,
      user_id: req.user.nameid,
    }).lean();
    if (!w) return next(new AppError("Withdrawal not found", 404));
    return res.json({ success: true, data: shapeForOwner(w) });
  } catch (error) {
    next(error);
  }
});

// ─── Admin: GET /withdrawals ──────────────────────────────────────────────────
/**
 * @swagger
 * /withdrawals/admin/all:
 *   get:
 *     summary: (Admin) Danh sách tất cả yêu cầu rút tiền
 *     tags: [Withdrawals - Admin]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, completed, rejected, cancelled] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách }
 */
router.get("/admin/all", authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      Withdrawal.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user_id", "username full_name email role")
        .populate("processed_by", "username full_name")
        .lean(),
      Withdrawal.countDocuments(filter),
    ]);
    return res.json({
      success: true,
      data: items.map(shapeForAdmin),
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── Admin: GET /withdrawals/admin/:id ────────────────────────────────────────
router.get("/admin/:id", authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid id", 400));
    }
    const w = await Withdrawal.findById(req.params.id)
      .populate("user_id", "username full_name email role bank_name account_holder bank_account_number")
      .populate("processed_by", "username full_name")
      .lean();
    if (!w) return next(new AppError("Withdrawal not found", 404));
    return res.json({ success: true, data: shapeForAdmin(w) });
  } catch (error) {
    next(error);
  }
});

// ─── Admin: PATCH /withdrawals/admin/:id/approve ──────────────────────────────
/**
 * @swagger
 * /withdrawals/admin/{id}/approve:
 *   patch:
 *     summary: (Admin) Duyệt yêu cầu rút tiền
 *     description: |
 *       Chuyển trạng thái withdrawal từ `pending` → `approved`.
 *
 *       **Tác động số dư:** KHÔNG động vào ví. Khi user tạo yêu cầu
 *       (POST /withdrawals), hệ thống đã `debitWithdrawal` trừ coin khỏi
 *       `available_balance` để giữ chỗ. Approve chỉ là xác nhận "đồng ý
 *       chuyển khoản", tiền đã được khoá từ trước.
 *
 *       State transition: `pending → approved`. Chỉ approve được khi đang `pending`.
 *     tags: [Withdrawals - Admin]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               admin_note: { type: string }
 *     responses:
 *       200: { description: Duyệt thành công, status → approved }
 *       400: { description: Invalid state (không phải pending) }
 *       404: { description: Withdrawal not found }
 */
router.patch(
  "/admin/:id/approve",
  authMiddleware,
  requireAdmin,
  async (req, res, next) => {
    try {
      const w = await withdrawalService.approveWithdrawal(
        req.user.nameid,
        req.params.id,
        req.body.admin_note || ""
      );
      return res.json({
        success: true,
        message: "Đã duyệt yêu cầu rút tiền",
        data: w,
      });
    } catch (error) {
      if (error instanceof withdrawalService.WithdrawalError) {
        return next(new AppError(error.message, error.statusCode));
      }
      next(error);
    }
  }
);

// ─── Admin: PATCH /withdrawals/admin/:id/reject ───────────────────────────────
/**
 * @swagger
 * /withdrawals/admin/{id}/reject:
 *   patch:
 *     summary: (Admin) Từ chối yêu cầu rút tiền
 *     description: |
 *       Chuyển trạng thái withdrawal sang `rejected` và **hoàn tiền về ví user**.
 *
 *       **Tác động số dư: CÓ** — refund coin vào `available_balance` qua
 *       `walletService.refundWithdrawal`. Đây là business logic rollback
 *       khi admin từ chối, KHÔNG phải admin tự ý sửa ví thủ công.
 *
 *       State transition: `pending → rejected` HOẶC `approved → rejected`.
 *       Có thể reject ở cả 2 trạng thái pending và approved. Sau khi rejected,
 *       user được tạo yêu cầu rút mới.
 *     tags: [Withdrawals - Admin]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               admin_note: { type: string }
 *     responses:
 *       200: { description: Từ chối thành công, đã hoàn tiền về ví user }
 *       400: { description: Invalid state }
 *       404: { description: Withdrawal not found }
 */
router.patch(
  "/admin/:id/reject",
  authMiddleware,
  requireAdmin,
  async (req, res, next) => {
    try {
      const w = await withdrawalService.rejectWithdrawal(
        req.user.nameid,
        req.params.id,
        req.body.admin_note || ""
      );
      return res.json({
        success: true,
        message: "Đã từ chối và hoàn tiền về ví người dùng",
        data: w,
      });
    } catch (error) {
      if (error instanceof withdrawalService.WithdrawalError) {
        return next(new AppError(error.message, error.statusCode));
      }
      next(error);
    }
  }
);

// ─── Admin: PATCH /withdrawals/admin/:id/complete ─────────────────────────────
/**
 * @swagger
 * /withdrawals/admin/{id}/complete:
 *   patch:
 *     summary: (Admin) Hoàn tất chuyển khoản
 *     description: |
 *       Chuyển trạng thái withdrawal từ `approved` → `completed`.
 *
 *       **Tác động số dư:** KHÔNG động vào ví. Việc "trừ tiền thật" đã xảy
 *       ra từ lúc user tạo yêu cầu (`createWithdrawalRequest` đã gọi
 *       `debitWithdrawal`). Complete chỉ là xác nhận "tiền đã chuyển khoản
 *       ra ngoài thành công".
 *
 *       State transition: `approved → completed`. Chỉ complete được khi
 *       đang `approved`. Sau khi completed, user có thể tạo yêu cầu rút mới.
 *     tags: [Withdrawals - Admin]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               admin_note: { type: string }
 *     responses:
 *       200: { description: Hoàn tất thành công, status → completed }
 *       400: { description: Invalid state (chưa approved) }
 *       404: { description: Withdrawal not found }
 */
router.patch(
  "/admin/:id/complete",
  authMiddleware,
  requireAdmin,
  async (req, res, next) => {
    try {
      const w = await withdrawalService.completeWithdrawal(
        req.user.nameid,
        req.params.id,
        req.body.admin_note || ""
      );
      return res.json({
        success: true,
        message: "Đã hoàn tất chuyển khoản",
        data: w,
      });
    } catch (error) {
      if (error instanceof withdrawalService.WithdrawalError) {
        return next(new AppError(error.message, error.statusCode));
      }
      next(error);
    }
  }
);

// Backward-compat alias: /withdrawals/:id (dành cho Admin xem chi tiết 1 record)
/**
 * @swagger
 * /withdrawals/{id}:
 *   get:
 *     summary: (Admin) Chi tiết withdrawal
 *     tags: [Withdrawals - Admin]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 */
router.get("/:id", authMiddleware, requireAdmin, async (req, res, next) => {
  // Đã có route /:id cho admin (chỉ admin mới xem chi tiết 1 withdrawal)
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new AppError("Invalid id", 400));
  }
  const w = await Withdrawal.findById(req.params.id)
    .populate(
      "user_id",
      "username full_name email role bank_name account_holder bank_account_number"
    )
    .populate("processed_by", "username full_name")
    .lean();
  if (!w) return next(new AppError("Withdrawal not found", 404));
  return res.json({ success: true, data: w });
});

module.exports = router;
