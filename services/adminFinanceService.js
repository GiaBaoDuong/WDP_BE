/**
 * Admin Finance Service - Aggregation logic cho dashboard tài chính Admin.
 *
 * Tất cả monetary values là raw integer CoinUnit (100 CoinUnit = 1 Coin).
 */
const mongoose = require("mongoose");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const Revenue = require("../models/Revenue");
const Series = require("../models/Series");
const Withdrawal = require("../models/Withdrawal");
const config = require("../config/payment");
const { unitsToVnd } = require("../utils/coinUnit");

const PERIOD_TIMEZONE = "Asia/Ho_Chi_Minh";
const VALID_PERIODS = ["month", "quarter", "year"];

// ─── Limit contract (thống nhất cho /revenue-analytics và user top-series) ───
// - Mặc định: 10.
// - Tối thiểu: 1.
// - Tối đa: 50.
// - Giá trị không hợp lệ (không phải số nguyên dương) → dùng default 10.
const DEFAULT_ANALYTICS_LIMIT = 10;
const MIN_ANALYTICS_LIMIT = 1;
const MAX_ANALYTICS_LIMIT = 50;

function resolveAnalyticsLimit(rawLimit) {
  const n = Number(rawLimit);
  if (!Number.isInteger(n) || n < MIN_ANALYTICS_LIMIT) {
    return DEFAULT_ANALYTICS_LIMIT;
  }
  return Math.min(MAX_ANALYTICS_LIMIT, n);
}

// ─── Helper: date utilities ─────────────────────────────────────────────────

const toHCMDate = (date) => {
  return new Date(date.toLocaleString("en-US", { timeZone: PERIOD_TIMEZONE }));
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

/**
 * Lấy "bây giờ" theo timezone Asia/Ho_Chi_Minh dạng các thành phần year/month/day/hour.
 * Trả về object { year, month (1-12), day, hour } dựa trên wall clock Asia/Ho_Chi_Minh.
 */
const getHCMNowParts = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PERIOD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const lookup = {};
  for (const p of parts) lookup[p.type] = p.value;
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
  };
};

/**
 * Helper trả về số ngày trong 1 tháng (1-12) của 1 năm (theo lịch Gregorian).
 */
const daysInMonth = (year, month) => {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};

/**
 * Parse + validate period/year/month/quarter từ query string.
 *
 * @param {Object} query
 * @returns {{ period: string, year: number, month?: number, quarter?: number }}
 * @throws {Error} với message rõ ràng cho HTTP 400.
 *
 * Quy tắc:
 *  - period=month: bắt buộc year, month (1-12). Default nếu thiếu = tháng hiện tại (HCM).
 *  - period=quarter: bắt buộc year, quarter (1-4). Default nếu thiếu = quý hiện tại (HCM).
 *  - period=year: bắt buộc year. Default nếu thiếu = năm hiện tại (HCM).
 *  - Không truyền period → mặc định "month" với tháng hiện tại (HCM).
 */
function parsePeriodFilter(query = {}) {
  const nowParts = getHCMNowParts();

  let period = (query.period || "month").toString().toLowerCase();
  if (!VALID_PERIODS.includes(period)) {
    throw new Error(
      `Invalid period. Allowed values: ${VALID_PERIODS.join(", ")}`
    );
  }

  const parseYear = (raw) => {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1970 || n > 9999) return NaN;
    return n;
  };
  const parseInt1to12 = (raw) => {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 12) return NaN;
    return n;
  };
  const parseQuarter = (raw) => {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 4) return NaN;
    return n;
  };

  if (period === "month") {
    const year =
      parseYear(query.year) ?? nowParts.year;
    const month = query.month === undefined || query.month === ""
      ? nowParts.month
      : parseInt1to12(query.month);
    if (Number.isNaN(year)) {
      throw new Error("Invalid year. Must be integer between 1970 and 9999");
    }
    if (Number.isNaN(month)) {
      throw new Error("Invalid month. Must be integer between 1 and 12");
    }
    return { period, year, month };
  }

  if (period === "quarter") {
    const year =
      parseYear(query.year) ?? nowParts.year;
    const quarter = query.quarter === undefined || query.quarter === ""
      ? Math.ceil(nowParts.month / 3)
      : parseQuarter(query.quarter);
    if (Number.isNaN(year)) {
      throw new Error("Invalid year. Must be integer between 1970 and 9999");
    }
    if (Number.isNaN(quarter)) {
      throw new Error("Invalid quarter. Must be integer between 1 and 4");
    }
    return { period, year, quarter };
  }

  // period === "year"
  const year =
    parseYear(query.year) ?? nowParts.year;
  if (Number.isNaN(year)) {
    throw new Error("Invalid year. Must be integer between 1970 and 9999");
  }
  return { period, year };
}

/**
 * Tính khoảng [from, to) theo timezone Asia/Ho_Chi_Minh, dùng Date trực tiếp.
 * `from` inclusive, `to` exclusive (00:00:00.000 của ngày kết thúc).
 *
 * @param {{ period, year, month?, quarter? }} filter
 * @returns {{ from: Date, to: Date }}
 */
function computeRangeFromTo(filter) {
  if (filter.period === "month") {
    const { year, month } = filter;
    // 00:00 ngày 1 tháng `month` (HCM) tương ứng với 17:00 UTC ngày cuối tháng trước.
    const fromUTC = Date.UTC(year, month - 1, 1) - 7 * 60 * 60 * 1000;
    const toUTC = Date.UTC(year, month, 1) - 7 * 60 * 60 * 1000;
    return { from: new Date(fromUTC), to: new Date(toUTC) };
  }
  if (filter.period === "quarter") {
    const { year, quarter } = filter;
    const startMonth = (quarter - 1) * 3 + 1; // 1, 4, 7, 10
    const fromUTC = Date.UTC(year, startMonth - 1, 1) - 7 * 60 * 60 * 1000;
    const toUTC =
      Date.UTC(year, startMonth - 1 + 3, 1) - 7 * 60 * 60 * 1000;
    return { from: new Date(fromUTC), to: new Date(toUTC) };
  }
  // period === "year"
  const { year } = filter;
  const fromUTC = Date.UTC(year, 0, 1) - 7 * 60 * 60 * 1000;
  const toUTC = Date.UTC(year + 1, 0, 1) - 7 * 60 * 60 * 1000;
  return { from: new Date(fromUTC), to: new Date(toUTC) };
}

/**
 * Sinh danh sách các "point key/label" cho chart theo filter.
 *
 *  - period=month  → group theo ngày (YYYY-MM-DD), `daysInMonth` phần tử.
 *  - period=quarter→ group theo tháng (YYYY-MM), 3 phần tử.
 *  - period=year   → group theo tháng (YYYY-MM), 12 phần tử.
 *
 * Trả về Array<{ key, label }> theo thứ tự thời gian tăng dần.
 */
function buildChartPoints(filter) {
  const out = [];
  if (filter.period === "month") {
    const { year, month } = filter;
    const dim = daysInMonth(year, month);
    for (let d = 1; d <= dim; d++) {
      const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      out.push({ key, label: key });
    }
    return out;
  }
  if (filter.period === "quarter") {
    const { year, quarter } = filter;
    const startMonth = (quarter - 1) * 3 + 1;
    for (let i = 0; i < 3; i++) {
      const m = startMonth + i;
      const key = `${year}-${String(m).padStart(2, "0")}`;
      out.push({ key, label: key });
    }
    return out;
  }
  // year
  const { year } = filter;
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    out.push({ key, label: key });
  }
  return out;
}

/**
 * Trộn points aggregate vào skeleton keys. Các key không có dữ liệu
 * được giữ lại trong output với mọi metric = 0.
 */
function mergeWithSkeleton(skeletonKeys, aggMap, buildPoint) {
  return skeletonKeys.map((p) => {
    const data = aggMap[p.key] || {};
    return buildPoint(p, data);
  });
}

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
        // current_balance cho creator = pending_balance + available_balance
        // (theo chuẩn hoá v2). Reader không có wallet thì giá trị = 0.
        current_balance_coin: {
          $sum: {
            $add: [
              { $ifNull: ["$wallet.pending_balance", 0] },
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

  // Tổng circulation bao gồm TẤT CẢ role.
  // Với creator: current_balance = pending + available (chuẩn hoá v2).
  // Với reader: balance được tính qua current_balance ở role lookup khác.
  // Để match summary (balance + pending + available cho MỌI role),
  // ta cộng thêm balance cho mỗi user từ aggregation phụ.
  const balanceAgg = await Wallet.aggregate([
    {
      $group: {
        _id: null,
        total_balance: {
          $sum: {
            $add: [
              { $ifNull: ["$balance", 0] },
              { $ifNull: ["$pending_balance", 0] },
              { $ifNull: ["$available_balance", 0] },
            ],
          },
        },
      },
    },
  ]);
  const totalCirculation = balanceAgg[0]?.total_balance || 0;

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
        // current_balance cho creator = pending_balance + available_balance
        // (theo chuẩn hoá v2 — see withdrawalService).
        current_balance_coin: {
          $add: [
            { $ifNull: ["$wallet.pending_balance", 0] },
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

// ─── 5. REVENUE ANALYTICS (month / quarter / year) ──────────────────────────

/**
 * Chuẩn hoá filter query thành object period/year/month/quarter/from/to.
 * Throw Error với message phù hợp để route trả HTTP 400.
 */
function resolveAnalyticsFilter(query) {
  const filter = parsePeriodFilter(query);
  const range = computeRangeFromTo(filter);
  return {
    ...filter,
    from: range.from,
    to: range.to,
    timezone: PERIOD_TIMEZONE,
  };
}

/**
 * Aggregation "chart points" cho analytics:
 *   - Input: match theo khoảng [from, to).
 *   - Stage 1: group theo purchase trước để gross_coin không bị nhân N.
 *              platform_fee_coin SUM per-record (đúng = fee của purchase).
 *              gross_coin_amount $first (mọi record cùng purchase lưu full price).
 *              creator_coin = SUM coin_amount (mỗi record thuộc về 1 user duy nhất).
 *              mangaka_coin / assistant_coin = SUM coin_amount theo user_role.
 *   - Stage 2: group theo chart key (YYYY-MM-DD hoặc YYYY-MM theo filter.period).
 */
async function aggregateRevenueByChartKey(filter) {
  const formatStr = filter.period === "month" ? "%Y-%m-%d" : "%Y-%m";
  return Revenue.aggregate([
    { $match: { createdAt: { $gte: filter.from, $lt: filter.to } } },
    // Stage 1: per-purchase
    {
      $group: {
        _id: "$purchased_chapter_id",
        gross_coin: { $first: "$gross_coin_amount" },
        platform_fee_coin: { $sum: "$platform_fee_coin" },
        mangaka_coin: {
          $sum: {
            $cond: [{ $eq: ["$user_role", "Mangaka"] }, "$coin_amount", 0],
          },
        },
        assistant_coin: {
          $sum: {
            $cond: [{ $eq: ["$user_role", "Assistant"] }, "$coin_amount", 0],
          },
        },
        creator_coin: { $sum: "$coin_amount" },
        // Lấy createdAt đầu tiên để group theo chart key (mọi record
        // của cùng purchase cùng createdAt vì Revenue được insert cùng lúc).
        createdAt: { $first: "$createdAt" },
      },
    },
    // Stage 2: per-chart-key
    {
      $group: {
        _id: {
          $dateToString: {
            format: formatStr,
            date: "$createdAt",
            timezone: PERIOD_TIMEZONE,
          },
        },
        gross_revenue_coin: { $sum: "$gross_coin" },
        platform_fee_coin: { $sum: "$platform_fee_coin" },
        mangaka_revenue_coin: { $sum: "$mangaka_coin" },
        assistant_revenue_coin: { $sum: "$assistant_coin" },
        creator_revenue_coin: { $sum: "$creator_coin" },
        chapters_sold: { $sum: 1 },
      },
    },
  ]);
}

/**
 * Top series theo gross_revenue_coin trong khoảng filter.
 * Trả về series aggregate ở cấp purchase (chống nhân đôi).
 */
async function aggregateTopSeriesByGrossRevenue(filter, limit) {
  return Revenue.aggregate([
    { $match: { createdAt: { $gte: filter.from, $lt: filter.to } } },
    // Stage 1: per-purchase per-series
    {
      $group: {
        _id: {
          series_id: "$series_id",
          purchased_chapter_id: "$purchased_chapter_id",
        },
        gross_coin: { $first: "$gross_coin_amount" },
        platform_fee_coin: { $sum: "$platform_fee_coin" },
        creator_coin: { $sum: "$coin_amount" },
      },
    },
    // Stage 2: per-series
    {
      $group: {
        _id: "$_id.series_id",
        gross_revenue_coin: { $sum: "$gross_coin" },
        platform_fee_coin: { $sum: "$platform_fee_coin" },
        creator_revenue_coin: { $sum: "$creator_coin" },
        chapters_sold: { $sum: 1 },
      },
    },
    { $sort: { gross_revenue_coin: -1 } },
    { $limit: limit },
  ]);
}

/**
 * Top series cho MỘT user cụ thể trong khoảng filter. Sắp xếp theo
 * creator_revenue_coin của user đó giảm dần.
 *
 * Chống nhân đôi:
 *  - filter user_id = user → mỗi purchase chỉ còn 0 hoặc 1 row cho user đó.
 *  - gross_coin_amount dùng $first ở cấp purchase (mọi record cùng
 *    purchased_chapter_id có cùng gross_coin_amount).
 *  - creator_revenue_coin = SUM coin_amount (mỗi record thuộc về user này).
 *  - chapters_sold = số purchase có revenue cho user.
 */
async function aggregateUserTopSeries(filter, userId, limit) {
  return Revenue.aggregate([
    { $match: { user_id: userId, createdAt: { $gte: filter.from, $lt: filter.to } } },
    {
      $group: {
        _id: {
          series_id: "$series_id",
          purchased_chapter_id: "$purchased_chapter_id",
        },
        gross_coin: { $first: "$gross_coin_amount" },
        creator_coin: { $sum: "$coin_amount" },
      },
    },
    {
      $group: {
        _id: "$_id.series_id",
        gross_revenue_coin: { $sum: "$gross_coin" },
        creator_revenue_coin: { $sum: "$creator_coin" },
        chapters_sold: { $sum: 1 },
      },
    },
    { $sort: { creator_revenue_coin: -1 } },
    { $limit: limit },
  ]);
}

/**
 * GET /admin/finance/revenue-analytics
 *
 * Aggregate theo period (month | quarter | year) với chart group theo
 * ngày (month) hoặc theo tháng (quarter/year). Điền các bucket trống = 0.
 *
 * Không sửa models. Không migrate. Chỉ aggregate từ field hiện có
 * (gross_coin_amount, platform_fee_coin, coin_amount, purchased_chapter_id,
 * user_role, createdAt).
 *
 * @param {Object} query - req.query: period, year, month, quarter, limit
 * @returns {{
 *   filter: Object,
 *   config: { platform_fee_percent, coin_to_vnd_rate },
 *   summary: Object,
 *   points: Array,
 *   top_series: Array
 * }}
 */
async function getRevenueAnalytics(query = {}) {
  const filter = resolveAnalyticsFilter(query);
  const limit = resolveAnalyticsLimit(query.limit);
  const coinToVnd = config.monetization.coinToVndRate;

  const [byKeyAgg, topSeriesAgg] = await Promise.all([
    aggregateRevenueByChartKey(filter),
    aggregateTopSeriesByGrossRevenue(filter, limit),
  ]);

  // Map byKeyAgg → chart key map
  const byKeyMap = {};
  for (const row of byKeyAgg) {
    byKeyMap[row._id] = row;
  }

  // Skeleton + merge
  const skeleton = buildChartPoints(filter);

  const points = mergeWithSkeleton(
    skeleton,
    byKeyMap,
    (skel, row) => {
      const gross = row.gross_revenue_coin || 0;
      const platformFee = row.platform_fee_coin || 0;
      const mangaka = row.mangaka_revenue_coin || 0;
      const assistant = row.assistant_revenue_coin || 0;
      const chaptersSold = row.chapters_sold || 0;
      return {
        key: skel.key,
        label: skel.label,
        gross_revenue_coin: gross,
        mangaka_revenue_coin: mangaka,
        assistant_revenue_coin: assistant,
        platform_fee_coin: platformFee,
        // Phí nền tảng quy đổi VND theo config.coin_to_vnd_rate.
        // Tính trực tiếp từ platform_fee_coin snapshot — không tính lại
        // từ gross × tỷ lệ, không làm tròn nhiều lần.
        platform_fee_vnd: unitsToVnd(platformFee, coinToVnd),
        chapters_sold: chaptersSold,
      };
    }
  );

  // Summary = tổng các point
  let grossSum = 0;
  let platformFeeSum = 0;
  let mangakaSum = 0;
  let assistantSum = 0;
  let chaptersSum = 0;
  for (const p of points) {
    grossSum += p.gross_revenue_coin;
    platformFeeSum += p.platform_fee_coin;
    mangakaSum += p.mangaka_revenue_coin;
    assistantSum += p.assistant_revenue_coin;
    chaptersSum += p.chapters_sold;
  }
  const creatorSum = mangakaSum + assistantSum;

  // Populate series cho top_series
  const seriesIds = topSeriesAgg.map((r) => r._id).filter(Boolean);
  let seriesMap = {};
  if (seriesIds.length > 0) {
    const seriesDocs = await Series.find({ _id: { $in: seriesIds } })
      .select("_id name cover_image_url author_id")
      .populate("author_id", "username full_name")
      .lean();
    seriesMap = new Map(seriesDocs.map((s) => [String(s._id), s]));
  }

  const topSeries = topSeriesAgg.map((row) => {
    const s = seriesMap.get(String(row._id));
    const author = s && s.author_id ? s.author_id : null;
    const platformFee = row.platform_fee_coin || 0;
    return {
      series_id: row._id,
      series_name: s ? s.name : "(đã xoá)",
      cover_image_url: s ? s.cover_image_url || "" : "",
      author: author
        ? {
            user_id: author._id,
            username: author.username || null,
            full_name: author.full_name || null,
          }
        : null,
      gross_revenue_coin: row.gross_revenue_coin || 0,
      creator_revenue_coin: row.creator_revenue_coin || 0,
      platform_fee_coin: platformFee,
      // Phí nền tảng quy đổi VND cho từng series.
      platform_fee_vnd: unitsToVnd(platformFee, coinToVnd),
      chapters_sold: row.chapters_sold || 0,
    };
  });

  return {
    filter: {
      period: filter.period,
      year: filter.year,
      ...(filter.month !== undefined && { month: filter.month }),
      ...(filter.quarter !== undefined && { quarter: filter.quarter }),
      from: filter.from.toISOString(),
      to: filter.to.toISOString(),
      timezone: filter.timezone,
    },
    config: {
      platform_fee_percent: config.monetization.platformFeePercent,
      coin_to_vnd_rate: coinToVnd,
    },
    summary: {
      gross_revenue_coin: grossSum,
      creator_revenue_coin: creatorSum,
      mangaka_revenue_coin: mangakaSum,
      assistant_revenue_coin: assistantSum,
      platform_fee_coin: platformFeeSum,
      // Phí nền tảng quy đổi VND ở cấp summary.
      platform_fee_vnd: unitsToVnd(platformFeeSum, coinToVnd),
      chapters_sold: chaptersSum,
    },
    points,
    top_series: topSeries,
  };
}

/**
 * GET /admin/users/:id/financials/top-series
 *
 * Top series cho MỘT user (Mangaka hoặc Assistant) trong khoảng filter.
 * Sắp xếp theo creator_revenue_coin của user đó.
 *
 * @param {string|ObjectId} userId
 * @param {Object} query - req.query: period, year, month, quarter, limit
 * @returns {{
 *   user: Object,
 *   filter: Object,
 *   summary: Object,
 *   top_series: Array
 * }}
 */
async function getUserTopSeries(userId, query = {}) {
  const filter = resolveAnalyticsFilter(query);
  const limit = resolveAnalyticsLimit(query.limit);

  const user = await User.findById(userId)
    .select("_id username full_name role")
    .lean();
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  const role = user.role;
  if (role !== "Mangaka" && role !== "Assistant") {
    const err = new Error(
      `Top-series chỉ áp dụng cho role Mangaka hoặc Assistant (hiện tại: ${role})`
    );
    err.statusCode = 400;
    throw err;
  }

  const [agg, totalAgg] = await Promise.all([
    aggregateUserTopSeries(filter, user._id, limit),
    // Summary = tổng trên TẤT CẢ series có Revenue của user (không phụ
    // thuộc limit). Group theo purchased_chapter_id trước để chapters_sold
    // đếm đúng, rồi group lần 2 để đếm series_count duy nhất.
    Revenue.aggregate([
      { $match: { user_id: user._id, createdAt: { $gte: filter.from, $lt: filter.to } } },
      {
        $group: {
          _id: "$purchased_chapter_id",
          creator_coin: { $sum: "$coin_amount" },
          series_id: { $first: "$series_id" },
        },
      },
      {
        $group: {
          _id: null,
          creator_revenue_coin: { $sum: "$creator_coin" },
          chapters_sold: { $sum: 1 },
          series_ids: { $addToSet: "$series_id" },
        },
      },
      {
        $project: {
          _id: 0,
          creator_revenue_coin: 1,
          chapters_sold: 1,
          series_count: { $size: "$series_ids" },
        },
      },
    ]),
  ]);

  const seriesIds = agg.map((r) => r._id).filter(Boolean);
  let seriesMap = {};
  if (seriesIds.length > 0) {
    const seriesDocs = await Series.find({ _id: { $in: seriesIds } })
      .select("_id name cover_image_url")
      .lean();
    seriesMap = new Map(seriesDocs.map((s) => [String(s._id), s]));
  }

  const topSeries = agg.map((row) => {
    const s = seriesMap.get(String(row._id));
    return {
      series_id: row._id,
      series_name: s ? s.name : "(đã xoá)",
      cover_image_url: s ? s.cover_image_url || "" : "",
      gross_revenue_coin: row.gross_revenue_coin || 0,
      creator_revenue_coin: row.creator_revenue_coin || 0,
      chapters_sold: row.chapters_sold || 0,
    };
  });

  const total = totalAgg[0] || { creator_revenue_coin: 0, chapters_sold: 0, series_count: 0 };

  return {
    user: {
      _id: user._id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
    },
    filter: {
      period: filter.period,
      year: filter.year,
      ...(filter.month !== undefined && { month: filter.month }),
      ...(filter.quarter !== undefined && { quarter: filter.quarter }),
      from: filter.from.toISOString(),
      to: filter.to.toISOString(),
      timezone: filter.timezone,
    },
    summary: {
      creator_revenue_coin: total.creator_revenue_coin || 0,
      chapters_sold: total.chapters_sold || 0,
      series_count: total.series_count || 0,
    },
    top_series: topSeries,
  };
}

// ─── EXPORTS ───────────────────────────────────────────────────────────────

module.exports = {
  getFinanceSummary,
  getRevenueByRole,
  getRevenueTimeline,
  getTopEarners,
  getRevenueAnalytics,
  getUserTopSeries,
  // Export helper parsePeriodFilter cho test và (nếu cần) cho caller khác.
  parsePeriodFilter,
  computeRangeFromTo,
  buildChartPoints,
  resolveAnalyticsLimit,
  DEFAULT_ANALYTICS_LIMIT,
  MIN_ANALYTICS_LIMIT,
  MAX_ANALYTICS_LIMIT,
};
