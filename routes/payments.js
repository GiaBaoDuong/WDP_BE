/**
 * Payments routes - PayOS integration cho Reader nạp Coin.
 *
 *  GET  /payments/packages             - Danh sách gói Coin active
 *  POST /payments/create               - Tạo payment link PayOS (body: package_id)
 *  GET  /payments/mine                 - Lịch sử nạp Coin của current user
 *  GET  /payments/:id                  - Chi tiết payment
 *
 *  POST /payments/payos/webhook        - Webhook từ PayOS (raw body)
 *  POST /payments/mock-complete        - (chỉ PAYOS_MOCK=true) Test simulate webhook success
 */
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { requireReader } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const CoinPackage = require("../models/CoinPackage");
const Payment = require("../models/Payment");
const { PAYMENT_STATUS } = require("../models/Payment");
const WalletTransaction = require("../models/WalletTransaction");
const { creditCoin } = require("../services/walletService");
const payos = require("../services/payosService");
const config = require("../config/payment");
const { unitsToCoinString } = require("../utils/coinUnit");

async function expireOverduePayments(filter = {}) {
  const now = new Date();
  await Payment.updateMany(
    {
      ...filter,
      status: PAYMENT_STATUS.PENDING,
      expires_at: { $ne: null, $lte: now },
    },
    { $set: { status: PAYMENT_STATUS.EXPIRED, expired_at: now } }
  );
}

// ─── GET /payments/packages ───────────────────────────────────────────────────
/**
 * @swagger
 * /payments/packages:
 *   get:
 *     summary: Danh sách gói Coin đang active
 *     tags: [Payments]
 *     responses:
 *       200: { description: Danh sách gói }
 */
router.get("/packages", async (req, res, next) => {
  try {
    const packages = await CoinPackage.find({ is_active: true })
      .sort({ sort_order: 1, price_vnd: 1 })
      .lean();
    return res.json({ success: true, data: packages });
  } catch (error) {
    next(error);
  }
});

// ─── POST /payments/create ────────────────────────────────────────────────────
/**
 * @swagger
 * /payments/create:
 *   post:
 *     summary: Tạo payment link để nạp Coin (Reader)
 *     tags: [Payments]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [package_id]
 *             properties:
 *               package_id: { type: string }
 *     responses:
 *       200: { description: Trả về checkout_url + payment info }
 */
router.post("/create", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const { package_id } = req.body;
    if (!package_id || !mongoose.Types.ObjectId.isValid(package_id)) {
      return next(new AppError("package_id không hợp lệ", 400));
    }
    const pkg = await CoinPackage.findById(package_id).lean();
    if (!pkg || !pkg.is_active) {
      return next(new AppError("Gói Coin không khả dụng", 404));
    }

    const orderCode = payos.generateOrderCode();
    const description = `WDPManga nap ${unitsToCoinString(pkg.total_coin)} Coin`;
    const expiresAt = new Date(
      Date.now() + config.payos.paymentTimeoutSeconds * 1000
    );

    // Tạo payment record pending
    const payment = await Payment.create({
      user_id: req.user.nameid,
      coin_package_id: pkg._id,
      order_code: orderCode,
      amount_vnd: pkg.price_vnd,
      coin_amount: pkg.total_coin,
      status: PAYMENT_STATUS.PENDING,
      description,
      expires_at: expiresAt,
    });

    // Tạo link PayOS
    const link = await payos.createPaymentLink({
      orderCode,
      amount: pkg.price_vnd,
      description,
      items: [
        {
          name: pkg.name,
          quantity: 1,
          price: pkg.price_vnd,
        },
      ],
      expiredAt: Math.floor(expiresAt.getTime() / 1000),
    });

    payment.checkout_url = link.checkoutUrl;
    payment.payos_payment_link_id = link.paymentLinkId || "";
    await payment.save();

    return res.json({
      success: true,
      data: {
        payment_id: payment._id,
        order_code: payment.order_code,
        amount_vnd: payment.amount_vnd,
        coin_amount: payment.coin_amount,
        checkout_url: payment.checkout_url,
        expires_at: payment.expires_at,
        mock: !!link.mock,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /payments/payos/webhook ────────────────────────────────────────────
/**
 * @swagger
 * /payments/payos/webhook:
 *   post:
 *     summary: Webhook từ PayOS (internal)
 *     tags: [Payments]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: OK }
 */
router.post("/payos/webhook", async (req, res) => {
  try {
    const body = req.body || {};
    let data;
    try {
      data = await payos.verifyWebhookData(body);
    } catch (error) {
      console.warn("[PayOS Webhook] Invalid signature:", error.message);
      return res.status(400).json({ success: false, message: "Invalid signature" });
    }
    if (!data) {
      return res.status(400).json({ success: false, message: "Invalid webhook data" });
    }
    const orderCode = Number(data.orderCode);
    const code = String(data.code || "").toUpperCase();

    if (!Number.isSafeInteger(orderCode) || orderCode <= 0) {
      console.warn("[PayOS Webhook] Invalid orderCode:", data.orderCode);
      return res.status(400).json({
        success: false,
        message: "Invalid orderCode",
      });
    }

    const payment = await Payment.findOne({ order_code: orderCode });
    if (!payment) {
      console.warn(`[PayOS Webhook] Unknown orderCode: ${orderCode}`);
      return res.json({ success: true }); // PayOS yêu cầu luôn trả 200
    }

    // Idempotent: nếu đã paid rồi thì bỏ qua
    if (payment.status === PAYMENT_STATUS.PAID) {
      return res.json({ success: true, message: "Already processed" });
    }

    if (code === "00" || code === "SUCCESS" || code === "PAID") {
      const paidAmount = Number(data.amount);
      if (!Number.isSafeInteger(paidAmount) || paidAmount !== payment.amount_vnd) {
        console.warn(
          `[PayOS Webhook] Amount mismatch orderCode=${orderCode}: expected=${payment.amount_vnd}, received=${data.amount}`
        );
        return res.status(400).json({ success: false, message: "Amount mismatch" });
      }
      // Commit Payment + Wallet + WalletTransaction trong cùng một MongoDB
      // transaction. Webhook gửi lặp/đồng thời sẽ không thể cộng Coin hai lần.
      const session = await mongoose.startSession();
      let credited = false;
      try {
        await session.withTransaction(async () => {
          const current = await Payment.findById(payment._id).session(session);
          if (!current || current.status === PAYMENT_STATUS.PAID) return;

          const existingDeposit = await WalletTransaction.findOne({
            payment_id: current._id,
          }).session(session);

          if (!existingDeposit) {
            await creditCoin(
              current.user_id,
              current.coin_amount,
              current.amount_vnd,
              {
                description: `Nạp ${unitsToCoinString(current.coin_amount)} Coin qua PayOS`,
                payment_id: current._id,
                session,
              }
            );
            credited = true;
          }

          current.status = PAYMENT_STATUS.PAID;
          current.paid_at = new Date();
          current.cancelled_at = null;
          current.expired_at = null;
          current.payos_raw_payload = body;
          await current.save({ session });
        });
      } finally {
        await session.endSession();
      }

      console.log(
        `[PayOS Webhook] Paid orderCode=${orderCode}, credited=${credited}, +${unitsToCoinString(payment.coin_amount)} Coin for user ${payment.user_id}`
      );
    } else if (code === "CANCELLED" || code === "CANCEL") {
      await Payment.updateOne(
        { _id: payment._id, status: { $ne: PAYMENT_STATUS.PAID } },
        {
          $set: {
            status: PAYMENT_STATUS.CANCELLED,
            cancelled_at: new Date(),
            payos_raw_payload: body,
          },
        }
      );
    } else if (code === "EXPIRED") {
      await Payment.updateOne(
        { _id: payment._id, status: { $ne: PAYMENT_STATUS.PAID } },
        {
          $set: {
            status: PAYMENT_STATUS.EXPIRED,
            expired_at: new Date(),
            payos_raw_payload: body,
          },
        }
      );
    } else {
      await Payment.updateOne(
        { _id: payment._id, status: { $ne: PAYMENT_STATUS.PAID } },
        {
          $set: {
            status: PAYMENT_STATUS.FAILED,
            payos_raw_payload: body,
          },
        }
      );
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("[PayOS Webhook] Error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ─── POST /payments/mock-complete (chỉ dùng khi PAYOS_MOCK=true) ─────────────
/**
 * @swagger
 * /payments/mock-complete:
 *   post:
 *     summary: (DEV ONLY) Simulate webhook success - chỉ hoạt động khi PAYOS_MOCK=true
 *     tags: [Payments]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order_code]
 *             properties:
 *               order_code: { type: number }
 *               code: { type: string, default: "00", description: "00 = success" }
 *     responses:
 *       200: { description: OK }
 */
router.post("/mock-complete", authMiddleware, requireReader, async (req, res, next) => {
  try {
    if (!config.payos.mock) {
      return next(
        new AppError("Mock endpoint chỉ khả dụng khi PAYOS_MOCK=true", 403)
      );
    }
    const { order_code, code = "00" } = req.body;
    const orderCodeNum = Number(order_code);
    if (!orderCodeNum) {
      return next(new AppError("order_code không hợp lệ", 400));
    }
    const payment = await Payment.findOne({ order_code: orderCodeNum });
    if (!payment) return next(new AppError("Payment not found", 404));
    if (String(payment.user_id) !== String(req.user.nameid)) {
      return next(new AppError("Không có quyền truy cập payment này", 403));
    }

    // Gọi đúng logic như webhook thật
    const fakeWebhookBody = {
      code: 0,
      desc: "OK",
      data: {
        orderCode: orderCodeNum,
        amount: payment.amount_vnd,
        description: payment.description,
        code,
      },
      signature: "mock",
    };
    // Re-use webhook handler
    req.body = fakeWebhookBody;
    return router.handle({ ...req, url: "/payos/webhook", method: "POST" }, res, next);
  } catch (error) {
    next(error);
  }
});

// ─── GET /payments/mine ───────────────────────────────────────────────────────
/**
 * @swagger
 * /payments/mine:
 *   get:
 *     summary: Lịch sử nạp Coin của current user
 *     tags: [Payments]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách payment }
 */
router.get("/mine", authMiddleware, requireReader, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    await expireOverduePayments({ user_id: req.user.nameid });

    const [items, total] = await Promise.all([
      Payment.find({ user_id: req.user.nameid })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("coin_package_id", "name price_vnd coin_amount bonus_coin")
        .lean(),
      Payment.countDocuments({ user_id: req.user.nameid }),
    ]);

    return res.json({
      success: true,
      data: items,
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

// ─── GET /payments/:id ────────────────────────────────────────────────────────
router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new AppError("Invalid payment id", 400));
    }
    await expireOverduePayments({ _id: req.params.id });
    const payment = await Payment.findById(req.params.id)
      .populate("coin_package_id", "name price_vnd coin_amount bonus_coin")
      .lean();
    if (!payment) return next(new AppError("Payment not found", 404));

    // Chỉ chủ payment hoặc Admin mới xem được
    const isOwner = String(payment.user_id) === String(req.user.nameid);
    const isAdmin = req.user.role === "Admin";
    if (!isOwner && !isAdmin) {
      return next(new AppError("Không có quyền xem payment này", 403));
    }

    return res.json({ success: true, data: payment });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
