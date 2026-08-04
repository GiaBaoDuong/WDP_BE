/**
 * Admin Finance Service - Aggregation logic cho dashboard tài chính Admin.
 *
 * Tất cả monetary values là raw integer CoinUnit (100 CoinUnit = 1 Coin).
 */
const mongoose = require("mongoose");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const Revenue = require("../models/Revenue");
const Withdrawal = require("../models/Withdrawal");
const config = require("../config/payment");

// ─── Helper: date utilities ─────────────────────────────────────────────────

const toHCMDate = (date) => {
  return new Date(date.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
};

const startOfHCMDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const getDaysAgo = (days) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
};

const formatHCMDate = (date) => {
  const d = toHCMDate(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

// ─── 1. SUMMARY ─────────────────────────────────────────────────────────────

/**
 * Lấy tổng quan tài chính hệ thống.
 *
 * A. total_circulation_coin = SUM(balance + pending_balance + available_balance) từ Wallet
 * B. total_revenue_all_time_coin = SUM(Revenue.coin_amount)
 * C. total_withdrawn_vnd = SUM(Withdrawal.vnd_amount WHERE status = "completed")
 * D. total_platform_coin = 0 (không có system wallet)
 * E. pending_withdrawals = COUNT/SUM WHERE status = "pending"
 * F. total_users_with_balance = COUNT(Wallet WHERE balance+pending+available > 0)
 */
async function getFinanceSummary() {
  const coinToVndRate = config.monetization.coinToVndRate;

  const [
    circulationAgg,
    revenueAgg,
    withdrawnAgg,
    pendingWithdrawalAgg,
    usersWithBalanceAgg,
  ] = await Promise.all([
    // A. total_circulation_coin: SUM(balance + pending_balance + available_balance)
    Wallet.aggregate([
      {
        $project: {
          total_balance: {
            $add: [
              { $ifNull: ["$balance", 0] },
              { $ifNull: ["$pending_balance", 0] },
              { $ifNull: ["$available_balance", 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          total_circulation_coin: { $sum: "$total_balance" },
        },
      },
    ]),

    // B. total_revenue_all_time_coin: SUM(Revenue.coin_amount)
    Revenue.aggregate([
      {
        $group: {
          _id: null,
          total_revenue_all_time_coin: { $sum: "$coin_amount" },
        },
      },
    ]),

    // C. total_withdrawn_vnd: SUM(Withdrawal.vnd_amount WHERE status = "completed")
    Withdrawal.aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: null,
          total_withdrawn_vnd: { $sum: "$vnd_amount" },
        },
      },
    ]),

    // E. pending_withdrawals: COUNT/SUM WHERE status = "pending"
    Withdrawal.aggregate([
      { $match: { status: "pending" } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          coin: { $sum: "$coin_amount" },
        },
      },
    ]),

    // F. total_users_with_balance: COUNT WHERE total_balance > 0
    Wallet.aggregate([
      {
        $project: {
          total_balance: {
            $add: [
              { $ifNull: ["$balance", 0] },
              { $ifNull: ["$pending_balance", 0] },
              { $ifNull: ["$available_balance", 0] },
            ],
          },
        },
      },
      {
        $match: {
          total_balance: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          total_users_with_balance: { $sum: 1 },
        },
      },
    ]),
  ]);

  const circulation = circulationAgg[0]?.total_circulation_coin || 0;
  const revenue = revenueAgg[0]?.total_revenue_all_time_coin || 0;
  const withdrawnVnd = withdrawnAgg[0]?.total_withdrawn_vnd || 0;
  const pendingCount = pendingWithdrawalAgg[0]?.count || 0;
  const pendingCoin = pendingWithdrawalAgg[0]?.coin || 0;
  const usersWithBalance = usersWithBalanceAgg[0]?.total_users_with_balance || 0;

  return {
    total_circulation_coin: circulation,
    total_revenue_all_time_coin: revenue,
    total_withdrawn_vnd: withdrawnVnd,
    total_platform_coin: 0, // Project không có system/platform wallet
    pending_withdrawals: {
      count: pendingCount,
      coin: pendingCoin,
    },
    total_users_with_balance: usersWithBalance,
    coin_to_vnd_rate: coinToVndRate,
  };
}

// ─── 2. REVENUE BY ROLE ─────────────────────────────────────────────────────

/**
 * Dữ liệu phân bố tài chính theo role.
 *
 * Aggregation bắt đầu từ User để các role không có Wallet vẫn xuất hiện.
 * $lookup sang Wallet, sau đó group theo role.
 *
 * Công thức:
 * - user_count: Số User thuộc role đó
 * - total_earnings_coin: SUM(wallet.total_revenue)
 * - total_withdrawn_coin: SUM(wallet.total_withdrawn)
 * - current_balance_coin: SUM(wallet.balance + wallet.available_balance)
 * - pending_balance_coin: SUM(wallet.pending_balance)
 */
async function getRevenueByRole() {
  const roleOrder = ["Admin", "Mangaka", "Assistant", "Editor", "EB", "Reader"];

  // Lấy tất cả user có role
  const usersWithWallets = await User.aggregate([
    {
      $lookup: {
        from: "wallets",
        localField: "_id",
        foreignField: "user_id",
        as: "wallet",
      },
    },
    {
      $unwind: {
        path: "$wallet",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $group: {
        _id: "$role",
        user_count: { $sum: 1 },
        total_earnings_coin: {
          $sum: { $ifNull: ["$wallet.total_revenue", 0] },
        },
        total_withdrawn_coin: {
          $sum: { $ifNull: ["$wallet.total_withdrawn", 0] },
        },
        current_balance_coin: {
          $sum: {
            $add: [
              { $ifNull: ["$wallet.balance", 0] },
              { $ifNull: ["$wallet.available_balance", 0] },
            ],
          },
        },
        pending_balance_coin: {
          $sum: { $ifNull: ["$wallet.pending_balance", 0] },
        },
      },
    },
  ]);

  // Chuyển thành map để tiện xử lý
  const roleMap = {};
  usersWithWallets.forEach((r) => {
    roleMap[r._id] = r;
  });

  // Build response với tất cả role (role không có user thì các số = 0)
  const roles = roleOrder
    .filter((r) => roleMap[r]) // Chỉ lấy role có trong database
    .map((role) => {
      const data = roleMap[role];
      return {
        role,
        user_count: data.user_count,
        total_earnings_coin: data.total_earnings_coin,
        total_withdrawn_coin: data.total_withdrawn_coin,
        current_balance_coin: data.current_balance_coin,
        pending_balance_coin: data.pending_balance_coin,
      };
    });

  // Nếu không có role nào, trả mảng rỗng
  if (roles.length === 0) {
    return {
      roles: [],
      total_circulation_coin: 0,
    };
  }

  // Tổng circulation = tổng current_balance + pending_balance của tất cả role
  const totalCirculation = roles.reduce(
    (sum, r) => sum + r.current_balance_coin + r.pending_balance_coin,
    0
  );

  return {
    roles,
    total_circulation_coin: totalCirculation,
  };
}

// ─── 3. REVENUE TIMELINE ────────────────────────────────────────────────────

/**
 * Timeline doanh thu theo ngày.
 *
 * @param {string} period - "7d" | "30d" | "90d" | "all"
 *
 * Timeline data:
 * - Revenue: GROUP BY Revenue.createdAt
 * - Withdrawal: GROUP BY Withdrawal.processed_at (status = "completed")
 * - New users: GROUP BY User.created_at
 */
async function getRevenueTimeline(period = "30d") {
  const now = new Date();
  let startDate;
  let days;

  switch (period) {
    case "7d":
      startDate = getDaysAgo(6);
      days = 7;
      break;
    case "30d":
      startDate = getDaysAgo(29);
      days = 30;
      break;
    case "90d":
      startDate = getDaysAgo(89);
      days = 90;
      break;
    case "all":
      startDate = null;
      days = null;
      break;
    default:
      throw new Error("Invalid period");
  }

  // Run aggregations in parallel
  const [
    revenueByDayAgg,
    withdrawalByDayAgg,
    newUsersByDayAgg,
  ] = await Promise.all([
    // Revenue theo ngày (group by createdAt)
    startDate
      ? Revenue.aggregate([
          { $match: { createdAt: { $gte: startDate } } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "Asia/Ho_Chi_Minh",
                },
              },
              revenue_coin: { $sum: "$coin_amount" },
            },
          },
          { $sort: { _id: 1 } },
        ])
      : Revenue.aggregate([
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "Asia/Ho_Chi_Minh",
                },
              },
              revenue_coin: { $sum: "$coin_amount" },
            },
          },
          { $sort: { _id: 1 } },
        ]),

    // Withdrawal completed theo ngày (group by processed_at)
    // Bỏ qua record không có processed_at
    startDate
      ? Withdrawal.aggregate([
          {
            $match: {
              status: "completed",
              processed_at: { $ne: null, $gte: startDate },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$processed_at",
                  timezone: "Asia/Ho_Chi_Minh",
                },
              },
              withdrawal_coin: { $sum: "$coin_amount" },
            },
          },
          { $sort: { _id: 1 } },
        ])
      : Withdrawal.aggregate([
          {
            $match: {
              status: "completed",
              processed_at: { $ne: null },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$processed_at",
                  timezone: "Asia/Ho_Chi_Minh",
                },
              },
              withdrawal_coin: { $sum: "$coin_amount" },
            },
          },
          { $sort: { _id: 1 } },
        ]),

    // New users theo ngày (group by created_at)
    startDate
      ? User.aggregate([
          { $match: { created_at: { $gte: startDate } } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$created_at",
                  timezone: "Asia/Ho_Chi_Minh",
                },
              },
              new_users: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
      : User.aggregate([
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$created_at",
                  timezone: "Asia/Ho_Chi_Minh",
                },
              },
              new_users: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),
  ]);

  // Build map cho từng loại
  const revenueMap = {};
  revenueByDayAgg.forEach((r) => {
    revenueMap[r._id] = r.revenue_coin;
  });

  const withdrawalMap = {};
  withdrawalByDayAgg.forEach((r) => {
    withdrawalMap[r._id] = r.withdrawal_coin;
  });

  const usersMap = {};
  newUsersByDayAgg.forEach((r) => {
    usersMap[r._id] = r.new_users;
  });

  // Tạo danh sách ngày
  let dates = [];
  if (period === "all") {
    // Lấy tất cả ngày có dữ liệu
    const allDates = new Set([
      ...Object.keys(revenueMap),
      ...Object.keys(withdrawalMap),
      ...Object.keys(usersMap),
    ]);
    dates = Array.from(allDates).sort();
  } else {
    // Tạo danh sách ngày từ startDate đến hôm nay
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      dates.push(formatHCMDate(d));
    }
  }

  // Build points
  const points = dates.map((date) => ({
    date,
    revenue_coin: revenueMap[date] || 0,
    withdrawal_coin: withdrawalMap[date] || 0,
    new_users: usersMap[date] || 0,
  }));

  // Summary
  const summary = points.reduce(
    (acc, p) => ({
      total_revenue_coin: acc.total_revenue_coin + p.revenue_coin,
      total_withdrawal_coin: acc.total_withdrawal_coin + p.withdrawal_coin,
      net_flow_coin:
        acc.total_revenue_coin +
        p.revenue_coin -
        (acc.total_withdrawal_coin + p.withdrawal_coin),
    }),
    { total_revenue_coin: 0, total_withdrawal_coin: 0, net_flow_coin: 0 }
  );

  // Recalculate net_flow_coin properly
  summary.net_flow_coin =
    summary.total_revenue_coin - summary.total_withdrawal_coin;

  return {
    period,
    points,
    summary: {
      total_revenue_coin: summary.total_revenue_coin,
      total_withdrawal_coin: summary.total_withdrawal_coin,
      net_flow_coin: summary.net_flow_coin,
    },
  };
}

// ─── 4. TOP EARNERS ────────────────────────────────────────────────────────

/**
 * Top earners - người có doanh thu cao nhất.
 *
 * @param {Object} options
 * @param {number} options.limit - Số lượng kết quả (1-50, mặc định 10)
 * @param {string} options.role - "Mangaka" | "Assistant" | undefined (cả hai)
 */
async function getTopEarners({ limit = 10, role } = {}) {
  const validRoles = ["Mangaka", "Assistant"];
  if (role && !validRoles.includes(role)) {
    throw new Error("Invalid role");
  }

  // Validate limit
  const safeLimit = Math.max(1, Math.min(50, parseInt(limit) || 10));

  // Match stage
  const matchStage = role ? { user_role: role } : {};

  // Aggregation pipeline
  const pipeline = [
    // 1. Match theo role nếu có
    { $match: matchStage },

    // 2. Group theo user_id, tính các metrics
    {
      $group: {
        _id: "$user_id",
        total_earnings_coin: { $sum: "$coin_amount" },
        series_ids: { $addToSet: "$series_id" },
        first_revenue_date: { $min: "$createdAt" },
        months: { $addToSet: { $dateToString: { format: "%Y-%m", date: "$createdAt" } } },
      },
    },

    // 3. Lookup User
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },

    // 4. Lookup Wallet
    {
      $lookup: {
        from: "wallets",
        localField: "_id",
        foreignField: "user_id",
        as: "wallet",
      },
    },
    { $unwind: { path: "$wallet", preserveNullAndEmptyArrays: true } },

    // 5. Lookup Withdrawal completed
    {
      $lookup: {
        from: "withdrawals",
        let: { userId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$user_id", "$$userId"] },
              status: "completed",
            },
          },
          {
            $group: {
              _id: null,
              total_withdrawn_coin: { $sum: "$coin_amount" },
            },
          },
        ],
        as: "withdrawals",
      },
    },
    {
      $unwind: { path: "$withdrawals", preserveNullAndEmptyArrays: true },
    },

    // 6. Sort và limit
    { $sort: { total_earnings_coin: -1 } },
    { $limit: safeLimit },

    // 7. Project final shape
    {
      $project: {
        _id: 0,
        user_id: { $toString: "$_id" },
        username: { $ifNull: ["$user.username", null] },
        full_name: { $ifNull: ["$user.full_name", null] },
        avatar_url: { $ifNull: ["$user.avatar_url", ""] },
        role: { $ifNull: ["$user.role", { $literal: "Mangaka" }] },
        total_earnings_coin: 1,
        current_balance_coin: {
          $add: [
            { $ifNull: ["$wallet.balance", 0] },
            { $ifNull: ["$wallet.available_balance", 0] },
          ],
        },
        pending_balance_coin: { $ifNull: ["$wallet.pending_balance", 0] },
        total_withdrawn_coin: {
          $ifNull: ["$withdrawals.total_withdrawn_coin", 0],
        },
        series_count: { $size: { $ifNull: ["$series_ids", []] } },
        avg_monthly_revenue_coin: {
          $let: {
            vars: {
              monthCount: {
                $size: { $ifNull: ["$months", []] },
              },
            },
            in: {
              $cond: {
                if: { $gt: ["$$monthCount", 0] },
                then: {
                  $round: [
                    { $divide: ["$total_earnings_coin", "$$monthCount"] },
                    0,
                  ],
                },
                else: 0,
              },
            },
          },
        },
      },
    },
  ];

  const earners = await Revenue.aggregate(pipeline);

  return { earners };
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────

module.exports = {
  getFinanceSummary,
  getRevenueByRole,
  getRevenueTimeline,
  getTopEarners,
};
