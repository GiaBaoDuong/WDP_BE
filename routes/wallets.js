/**
 * Wallet routes - Lấy thông tin ví + lịch sử giao dịch.
 *
 *  GET /wallet                  - Lấy wallet của current user (balance + pending/available)
 *  GET /wallet/transactions     - Lịch sử WalletTransaction
 *  GET /wallet/purchases        - Lịch sử chapter đã mua
 *  GET /wallet/revenues         - (Mangaka/Assistant) Lịch sử Revenue
 */
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { AppError } = require("../middleware/errorHandler");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const PurchasedChapter = require("../models/PurchasedChapter");
const Revenue = require("../models/Revenue");
const { getOrCreateWallet } = require("../services/walletService");
const config = require("../config/payment");
const {
  withCreatorVndBalances,
  withWalletCoinDisplayFields,
} = require("../utils/coinUnit");

// ─── GET /wallet ──────────────────────────────────────────────────────────────
/**
 * @swagger
 * /wallet:
 *   get:
 *     summary: Lấy thông tin ví của current user
 *     tags: [Wallet]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: |
 *           Wallet info. Có đủ 7 field *_coin_display theo FE contract:
 *           balance_coin_display, available_balance_coin_display, pending_balance_coin_display,
 *           total_revenue_coin_display, total_withdrawn_coin_display, total_deposited_coin_display,
 *           total_spent_coin_display. Các field balance_coin, pending_balance_coin vẫn giữ nguyên
 *           để tương thích ngược.
 */
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const wallet = await getOrCreateWallet(req.user.nameid);
    const walletData = ["Mangaka", "Assistant"].includes(req.user.role)
      ? withCreatorVndBalances(wallet, config.monetization.coinToVndRate)
      : wallet.toObject();

    const walletWithDisplay = withWalletCoinDisplayFields(walletData);

    return res.json({
      success: true,
      data: {
        ...walletWithDisplay,
        config: {
          coin_to_vnd_rate: config.monetization.coinToVndRate,
          platform_fee_percent: config.monetization.platformFeePercent,
          revenue_pending_hours: config.revenue.pendingHours,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /wallet/transactions ─────────────────────────────────────────────────
/**
 * @swagger
 * /wallet/transactions:
 *   get:
 *     summary: Lịch sử giao dịch ví
 *     tags: [Wallet]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [Deposit, Purchase, Revenue, Withdrawal, Refund] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách transaction }
 */
router.get("/transactions", authMiddleware, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const filter = { user_id: req.user.nameid };
    if (req.query.type) filter.type = req.query.type;

    const [items, total] = await Promise.all([
      WalletTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("chapter_id", "chapter_number title")
        .populate("payment_id", "order_code amount_vnd status")
        .lean(),
      WalletTransaction.countDocuments(filter),
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

// ─── GET /wallet/purchases ────────────────────────────────────────────────────
/**
 * @swagger
 * /wallet/purchases:
 *   get:
 *     summary: Danh sách chapter đã mua
 *     tags: [Wallet]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách PurchasedChapter }
 */
router.get("/purchases", authMiddleware, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      PurchasedChapter.find({ reader_id: req.user.nameid })
        .sort({ purchased_at: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path: "chapter_id",
          select: "chapter_number title series_id",
          populate: { path: "series_id", select: "name cover_image_url" },
        })
        .lean(),
      PurchasedChapter.countDocuments({ reader_id: req.user.nameid }),
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

// ─── GET /wallet/revenues ─────────────────────────────────────────────────────
/**
 * @swagger
 * /wallet/revenues:
 *   get:
 *     summary: (Mangaka/Assistant) Lịch sử Revenue
 *     tags: [Wallet]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, available, withdrawn] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Danh sách Revenue }
 */
router.get("/revenues", authMiddleware, async (req, res, next) => {
  try {
    const role = req.user.role;
    if (!["Mangaka", "Assistant"].includes(role)) {
      return next(
        new AppError("Chỉ Mangaka/Assistant mới có Revenue", 403)
      );
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;
    const filter = { user_id: req.user.nameid };
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      Revenue.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("series_id", "name")
        .populate("chapter_id", "chapter_number title")
        .lean(),
      Revenue.countDocuments(filter),
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

module.exports = router;
