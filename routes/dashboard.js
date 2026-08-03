/**
 * Dashboard routes - Thống kê doanh thu cho Mangaka/Assistant + Reader overview.
 *
 *  GET /dashboard/me                 - Dashboard cho user hiện tại (Reader/Mangaka/Assistant)
 *  GET /dashboard/revenue            - (Mangaka/Assistant) Doanh thu theo series
 *  GET /dashboard/purchases          - (Mangaka) Lượt mua chapter + doanh thu theo series
 */
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { AppError } = require("../middleware/errorHandler");
const Wallet = require("../models/Wallet");
const Revenue = require("../models/Revenue");
const PurchasedChapter = require("../models/PurchasedChapter");
const Withdrawal = require("../models/Withdrawal");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const config = require("../config/payment");
const { withCreatorVndBalances } = require("../utils/coinUnit");

// ─── GET /dashboard/me ────────────────────────────────────────────────────────
/**
 * @swagger
 * /dashboard/me:
 *   get:
 *     summary: Dashboard cho user hiện tại (tự động theo role)
 *     tags: [Dashboard]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 */
router.get("/me", authMiddleware, async (req, res, next) => {
  try {
    const role = req.user.role;
    const userId = req.user.nameid;

    // Wallet
    let wallet = await Wallet.findOne({ user_id: userId }).lean();
    if (!wallet) wallet = await Wallet.create({ user_id: userId });
    if (["Mangaka", "Assistant"].includes(role)) {
      wallet = withCreatorVndBalances(wallet, config.monetization.coinToVndRate);
    }

    // Mặc định cho Reader
    let data = {
      role,
      wallet,
      config: {
        coin_to_vnd_rate: config.monetization.coinToVndRate,
        platform_fee_percent: config.monetization.platformFeePercent,
        revenue_pending_hours: config.revenue.pendingHours,
        min_withdrawal_vnd: config.monetization.minWithdrawalVnd,
      },
    };

    if (role === "Reader") {
      // Lịch sử nạp (5 mới nhất) + lịch sử mua (5 mới nhất)
      const Payment = require("../models/Payment");
      const [recentPayments, recentPurchases, totalDeposits, totalPurchases] = await Promise.all([
        Payment.find({ user_id: userId, status: "paid" })
          .sort({ paid_at: -1 })
          .limit(5)
          .lean(),
        PurchasedChapter.find({ reader_id: userId })
          .sort({ purchased_at: -1 })
          .limit(5)
          .populate({
            path: "chapter_id",
            select: "chapter_number title series_id",
            populate: { path: "series_id", select: "name cover_image_url" },
          })
          .lean(),
        Payment.aggregate([
          { $match: { user_id: new mongoose.Types.ObjectId(userId), status: "paid" } },
          { $group: { _id: null, total: { $sum: "$amount_vnd" } } },
        ]),
        PurchasedChapter.countDocuments({ reader_id: userId }),
      ]);
      data.reader = {
        total_deposited_vnd: totalDeposits[0]?.total || 0,
        total_purchases: totalPurchases,
        recent_payments: recentPayments,
        recent_purchases: recentPurchases,
      };
    } else if (role === "Mangaka" || role === "Assistant") {
      // Tổng doanh thu
      const [revenueAgg, totalPurchasesForMySeries, withdrawals] = await Promise.all([
        Revenue.aggregate([
          { $match: { user_id: new mongoose.Types.ObjectId(userId) } },
          {
            $group: {
              _id: "$status",
              total_coin: { $sum: "$coin_amount" },
              total_vnd: { $sum: "$vnd_amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        // Số chapter purchases của các series do user này làm Mangaka (chỉ cho Mangaka)
        role === "Mangaka"
          ? PurchasedChapter.aggregate([
              {
                $lookup: {
                  from: "series",
                  localField: "series_id",
                  foreignField: "_id",
                  as: "series",
                },
              },
              { $unwind: "$series" },
              { $match: { "series.author_id": new mongoose.Types.ObjectId(userId) } },
              { $count: "count" },
            ])
          : Promise.resolve([{ count: 0 }]),
        Withdrawal.find({ user_id: userId })
          .sort({ createdAt: -1 })
          .limit(5)
          .lean(),
      ]);

      data.mangaka_or_assistant = {
        revenue_by_status: revenueAgg,
        total_purchases_of_my_series: totalPurchasesForMySeries[0]?.count || 0,
        recent_withdrawals: withdrawals,
      };
    }

    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ─── GET /dashboard/revenue ───────────────────────────────────────────────────
/**
 * @swagger
 * /dashboard/revenue:
 *   get:
 *     summary: (Mangaka/Assistant) Doanh thu theo series
 *     tags: [Dashboard]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 */
router.get("/revenue", authMiddleware, async (req, res, next) => {
  try {
    const role = req.user.role;
    if (!["Mangaka", "Assistant"].includes(role)) {
      return next(
        new AppError("Chỉ Mangaka/Assistant mới xem được dashboard này", 403)
      );
    }

    const bySeries = await Revenue.aggregate([
      { $match: { user_id: new mongoose.Types.ObjectId(req.user.nameid) } },
      {
        $group: {
          _id: "$series_id",
          total_coin: { $sum: "$coin_amount" },
          total_vnd: { $sum: "$vnd_amount" },
          purchases: { $sum: 1 },
          pending_coin: {
            $sum: {
              $cond: [{ $eq: ["$status", "pending"] }, "$coin_amount", 0],
            },
          },
          available_coin: {
            $sum: {
              $cond: [{ $eq: ["$status", "available"] }, "$coin_amount", 0],
            },
          },
        },
      },
      { $sort: { total_coin: -1 } },
      {
        $lookup: {
          from: "series",
          localField: "_id",
          foreignField: "_id",
          as: "series",
        },
      },
      { $unwind: "$series" },
      {
        $project: {
          series_id: "$_id",
          series_name: "$series.name",
          cover_image_url: "$series.cover_image_url",
          total_coin: 1,
          total_vnd: 1,
          purchases: 1,
          pending_coin: 1,
          available_coin: 1,
        },
      },
    ]);

    return res.json({ success: true, data: bySeries });
  } catch (error) {
    next(error);
  }
});

// ─── GET /dashboard/purchases ─────────────────────────────────────────────────
/**
 * @swagger
 * /dashboard/purchases:
 *   get:
 *     summary: (Mangaka) Lượt mua chapter của các series do mình quản lý
 *     tags: [Dashboard]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: OK }
 */
router.get("/purchases", authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== "Mangaka") {
      return next(
        new AppError("Chỉ Mangaka mới xem được thống kê này", 403)
      );
    }

    const seriesIds = await Series.find({ author_id: req.user.nameid })
      .select("_id name")
      .lean();

    const byChapter = await PurchasedChapter.aggregate([
      { $match: { series_id: { $in: seriesIds.map((s) => s._id) } } },
      {
        $group: {
          _id: "$chapter_id",
          series_id: { $first: "$series_id" },
          purchases: { $sum: 1 },
          total_coin: { $sum: "$price" },
        },
      },
      {
        $lookup: {
          from: "chapters",
          localField: "_id",
          foreignField: "_id",
          as: "chapter",
        },
      },
      { $unwind: "$chapter" },
      {
        $lookup: {
          from: "series",
          localField: "series_id",
          foreignField: "_id",
          as: "series",
        },
      },
      { $unwind: "$series" },
      {
        $project: {
          chapter_id: "$_id",
          chapter_number: "$chapter.chapter_number",
          chapter_title: "$chapter.title",
          series_id: 1,
          series_name: "$series.name",
          purchases: 1,
          total_coin: 1,
          total_vnd: {
            $floor: {
              $divide: [
                { $multiply: ["$total_coin", config.monetization.coinToVndRate] },
                100,
              ],
            },
          },
        },
      },
      { $sort: { total_coin: -1 } },
      { $limit: 100 },
    ]);

    return res.json({ success: true, data: byChapter });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
