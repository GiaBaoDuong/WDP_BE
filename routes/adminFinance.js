/**
 * Admin Finance Routes - Dashboard tài chính Admin.
 *
 * Mount: /admin/finance
 *
 * Endpoints:
 *  GET /admin/finance/summary          - Tổng quan tài chính
 *  GET /admin/finance/revenue-by-role  - Phân bố theo role
 *  GET /admin/finance/revenue-timeline - Timeline doanh thu
 *  GET /admin/finance/top-earners      - Top earners
 *
 * All monetary values are raw integer CoinUnit (100 CoinUnit = 1 Coin).
 */
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const adminFinanceService = require("../services/adminFinanceService");

// ─── Guard: Auth + Admin ────────────────────────────────────────────────────

router.use(authMiddleware);
router.use(requireAdmin);

// ─── 1. GET /admin/finance/summary ─────────────────────────────────────────

/**
 * @swagger
 * /admin/finance/summary:
 *   get:
 *     summary: (Admin) Tổng quan tài chính hệ thống
 *     description: |
 *       Các stat card tổng quan tài chính:
 *       - total_circulation_coin: Tổng Coin đang lưu hành (SUM balance+pending+available từ Wallet)
 *       - total_revenue_all_time_coin: Tổng doanh thu tích luỹ (SUM Revenue.coin_amount)
 *       - total_withdrawn_vnd: Tổng VND đã rút thực tế (chỉ status=completed)
 *       - total_platform_coin: 0 (project không có system wallet)
 *       - pending_withdrawals: Số yêu cầu rút đang chờ
 *       - total_users_with_balance: Số Wallet có số dư > 0
 *       - coin_to_vnd_rate: Tỷ giá Coin sang VND
 *
 *       **Tất cả giá trị Coin là raw integer CoinUnit (100 CoinUnit = 1 Coin)**
 *     tags: [Admin Finance]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total_circulation_coin: { type: integer, description: "Raw CoinUnit" }
 *                     total_revenue_all_time_coin: { type: integer, description: "Raw CoinUnit" }
 *                     total_withdrawn_vnd: { type: integer, description: "Raw VND" }
 *                     total_platform_coin: { type: integer, description: "Raw CoinUnit - luôn 0" }
 *                     pending_withdrawals:
 *                       type: object
 *                       properties:
 *                         count: { type: integer }
 *                         coin: { type: integer, description: "Raw CoinUnit" }
 *                     total_users_with_balance: { type: integer }
 *                     coin_to_vnd_rate: { type: integer }
 *       401: { description: "No token provided" }
 *       403: { description: "Access denied - Admin only" }
 */
router.get("/summary", async (req, res, next) => {
  try {
    const data = await adminFinanceService.getFinanceSummary();
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ─── 2. GET /admin/finance/revenue-by-role ──────────────────────────────────

/**
 * @swagger
 * /admin/finance/revenue-by-role:
 *   get:
 *     summary: (Admin) Phân bố tài chính theo role
 *     description: |
 *       Dữ liệu bar chart phân bố tài chính theo role.
 *       Bắt đầu aggregation từ User để các role không có Wallet vẫn xuất hiện.
 *
 *       **Tất cả giá trị Coin là raw integer CoinUnit (100 CoinUnit = 1 Coin)**
 *     tags: [Admin Finance]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     roles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           role: { type: string }
 *                           user_count: { type: integer }
 *                           total_earnings_coin: { type: integer, description: "Raw CoinUnit" }
 *                           total_withdrawn_coin: { type: integer, description: "Raw CoinUnit" }
 *                           current_balance_coin: { type: integer, description: "Raw CoinUnit" }
 *                           pending_balance_coin: { type: integer, description: "Raw CoinUnit" }
 *                     total_circulation_coin: { type: integer, description: "Raw CoinUnit" }
 *       401: { description: "No token provided" }
 *       403: { description: "Access denied - Admin only" }
 */
router.get("/revenue-by-role", async (req, res, next) => {
  try {
    const data = await adminFinanceService.getRevenueByRole();
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ─── 3. GET /admin/finance/revenue-timeline ─────────────────────────────────

/**
 * @swagger
 * /admin/finance/revenue-timeline:
 *   get:
 *     summary: (Admin) Timeline doanh thu theo ngày
 *     description: |
 *       Timeline doanh thu, withdrawal và new users theo ngày.
 *
 *       **Query params:**
 *       - period: `7d` | `30d` | `90d` | `all` (mặc định: `30d`)
 *
 *       **Quy tắc:**
 *       - Group theo ngày với format `YYYY-MM-DD`
 *       - Dùng timezone Asia/Ho_Chi_Minh
 *       - Revenue group theo Revenue.createdAt
 *       - Withdrawal completed group theo Withdrawal.processed_at
 *       - New users group theo User.created_at
 *       - Điền ngày trống bằng 0
 *
 *       **Tất cả giá trị Coin là raw integer CoinUnit (100 CoinUnit = 1 Coin)**
 *     tags: [Admin Finance]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 90d, all]
 *           default: 30d
 *         description: Khoảng thời gian
 *     responses:
 *       200:
 *         description: Thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     period: { type: string }
 *                     points:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           date: { type: string, format: date }
 *                           revenue_coin: { type: integer, description: "Raw CoinUnit" }
 *                           withdrawal_coin: { type: integer, description: "Raw CoinUnit" }
 *                           new_users: { type: integer }
 *                     summary:
 *                       type: object
 *                       properties:
 *                         total_revenue_coin: { type: integer, description: "Raw CoinUnit" }
 *                         total_withdrawal_coin: { type: integer, description: "Raw CoinUnit" }
 *                         net_flow_coin: { type: integer, description: "Raw CoinUnit" }
 *       400: { description: "Invalid period - Allowed: 7d, 30d, 90d, all" }
 *       401: { description: "No token provided" }
 *       403: { description: "Access denied - Admin only" }
 */
router.get("/revenue-timeline", async (req, res, next) => {
  try {
    const { period = "30d" } = req.query;
    const validPeriods = ["7d", "30d", "90d", "all"];

    if (!validPeriods.includes(period)) {
      return next(
        new AppError(
          "Invalid period. Allowed values: 7d, 30d, 90d, all",
          400
        )
      );
    }

    const data = await adminFinanceService.getRevenueTimeline(period);
    return res.json({ success: true, data });
  } catch (error) {
    if (error.message === "Invalid period") {
      return next(
        new AppError(
          "Invalid period. Allowed values: 7d, 30d, 90d, all",
          400
        )
      );
    }
    next(error);
  }
});

// ─── 4. GET /admin/finance/top-earners ──────────────────────────────────────

/**
 * @swagger
 * /admin/finance/top-earners:
 *   get:
 *     summary: (Admin) Top earners - người có doanh thu cao nhất
 *     description: |
 *       Danh sách top earners dựa trên tổng doanh thu từ Revenue.
 *
 *       **Query params:**
 *       - limit: Số lượng kết quả (1-50, mặc định: 10)
 *       - role: `Mangaka` | `Assistant` | undefined (cả hai)
 *
 *       **Công thức:**
 *       - current_balance_coin = wallet.balance + wallet.available_balance
 *       - pending_balance_coin = wallet.pending_balance
 *       - total_withdrawn_coin = SUM(Withdrawal.coin_amount WHERE status="completed")
 *       - series_count = COUNT DISTINCT Revenue.series_id
 *       - avg_monthly_revenue_coin = total_earnings_coin / số tháng có Revenue
 *
 *       **Tất cả giá trị Coin là raw integer CoinUnit (100 CoinUnit = 1 Coin)**
 *     tags: [Admin Finance]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 10
 *         description: Số lượng kết quả
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [Mangaka, Assistant]
 *         description: Lọc theo role (không truyền = cả hai)
 *     responses:
 *       200:
 *         description: Thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     earners:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           user_id: { type: string }
 *                           username: { type: string, nullable: true }
 *                           full_name: { type: string, nullable: true }
 *                           avatar_url: { type: string }
 *                           role: { type: string }
 *                           total_earnings_coin: { type: integer, description: "Raw CoinUnit" }
 *                           current_balance_coin: { type: integer, description: "Raw CoinUnit" }
 *                           pending_balance_coin: { type: integer, description: "Raw CoinUnit" }
 *                           total_withdrawn_coin: { type: integer, description: "Raw CoinUnit" }
 *                           series_count: { type: integer }
 *                           avg_monthly_revenue_coin: { type: integer, description: "Raw CoinUnit" }
 *       400: { description: "Invalid role - Allowed: Mangaka, Assistant" }
 *       401: { description: "No token provided" }
 *       403: { description: "Access denied - Admin only" }
 */
router.get("/top-earners", async (req, res, next) => {
  try {
    const { limit, role } = req.query;
    const validRoles = ["Mangaka", "Assistant"];

    if (role && !validRoles.includes(role)) {
      return next(
        new AppError("Invalid role. Allowed values: Mangaka, Assistant", 400)
      );
    }

    const data = await adminFinanceService.getTopEarners({ limit, role });
    return res.json({ success: true, data });
  } catch (error) {
    if (error.message === "Invalid role") {
      return next(
        new AppError("Invalid role. Allowed values: Mangaka, Assistant", 400)
      );
    }
    next(error);
  }
});

module.exports = router;
