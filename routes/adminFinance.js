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
 *  GET /admin/finance/revenue-analytics- Thống kê doanh thu theo month/quarter/year
 *
 * All monetary values are raw integer CoinUnit (100 CoinUnit = 1 Coin).
 */
const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/roles");
const { AppError } = require("../middleware/errorHandler");
const adminFinanceService = require("../services/adminFinanceService");
const { unitsToCoinString } = require("../utils/coinUnit");

/**
 * Gắn thêm alias `*_coin_display` cho các field Coin mà middleware
 * `formatCoinResponse` không tự sinh (do displayField không kết thúc
 * bằng "_coin"). Hiện chỉ `platform_fee_coin` rơi vào trường hợp này
 * (được map sang legacy `platform_fee` trong DISPLAY_FIELDS).
 * Dùng đệ quy để áp dụng cho cả summary, points và top_series.
 */
function appendCoinDisplayAlias(node) {
  if (Array.isArray(node)) {
    node.forEach(appendCoinDisplayAlias);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "platform_fee_coin" &&
      Number.isInteger(value) &&
      !Object.prototype.hasOwnProperty.call(node, "platform_fee_coin_display")
    ) {
      node.platform_fee_coin_display = unitsToCoinString(value);
    }
    appendCoinDisplayAlias(value);
  }
}

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

// ─── 5. GET /admin/finance/revenue-analytics ────────────────────────────────

/**
 * @swagger
 * /admin/finance/revenue-analytics:
 *   get:
 *     summary: (Admin) Thống kê doanh thu theo month/quarter/year
 *     description: |
 *       Endpoint canonical cho dashboard finance Admin. Hỗ trợ 3 loại period:
 *         - month:   bắt buộc year + month (1-12). Chart group theo ngày.
 *         - quarter: bắt buộc year + quarter (1-4). Chart group theo tháng.
 *         - year:    bắt buộc year. Chart group theo tháng.
 *       Nếu không truyền → mặc định month hiện tại theo timezone Asia/Ho_Chi_Minh.
 *       Khoảng dùng [from, to) (from inclusive, to exclusive).
 *
 *       **Metric giải thích:**
 *         - gross_revenue_coin     : tổng Coin Reader đã trả (SUM gross_coin_amount per purchase).
 *         - creator_revenue_coin   : tổng Coin thực chia (SUM coin_amount).
 *         - mangaka_revenue_coin   : SUM coin_amount với user_role=Mangaka.
 *         - assistant_revenue_coin : SUM coin_amount với user_role=Assistant.
 *         - platform_fee_coin      : phí platform (SUM platform_fee_coin — giá trị snapshot).
 *         - platform_fee_vnd       : phí nền tảng thực tế quy đổi theo coin_to_vnd_rate.
 *                                   Tính trực tiếp từ platform_fee_coin × coin_to_vnd_rate / 100.
 *                                   Number để FE tự format tiền Việt Nam.
 *         - chapters_sold          : số lượt mua (đếm purchased_chapter_id duy nhất).
 *
 *       **Chống nhân đôi Revenue (MỖI purchase có thể tạo 2 record: Mangaka + Assistant):**
 *         - gross_coin_amount dùng $first ở cấp purchase (mọi record của cùng purchase lưu full price).
 *         - platform_fee_coin là field cấp SHARE nên SUM tất cả record của purchase (= phí platform của purchase đó).
 *         - chapters_sold đếm mỗi purchased_chapter_id đúng 1 lần.
 *         - creator_revenue (SUM coin_amount) là field cấp SHARE → SUM trực tiếp không bị nhân đôi
 *           vì mỗi record thuộc về đúng 1 user.
 *
 *       **Field convention:**
 *         - Field raw CoinUnit là integer (không có hậu tố _display).
 *         - Field `*_coin_display` là chuỗi "x.xx" canonical từ unitsToCoinString().
 *         - Mọi trường có `*_coin` đều có `*_coin_display` kèm theo (do formatCoinResponse middleware).
 *         - Tên trường canonical duy nhất cho mỗi metric — KHÔNG alias legacy.
 *
 *       **Response envelope:** `{ success: true, data: { filter, config, summary, points, top_series } }`.
 *       KHÔNG đưa filter/summary/points/top_series ra ngoài `data`.
 *
 *       **Tất cả giá trị Coin là raw integer CoinUnit (100 CoinUnit = 1 Coin)**
 *     tags: [Admin Finance]
 *     security: [{ BearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [month, quarter, year]
 *           default: month
 *         description: Loại khoảng thời gian. Mặc định = month (theo Asia/Ho_Chi_Minh).
 *       - in: query
 *         name: year
 *         schema: { type: integer, minimum: 1970, maximum: 9999 }
 *         description: Năm. Mặc định = năm hiện tại.
 *       - in: query
 *         name: month
 *         schema: { type: integer, minimum: 1, maximum: 12 }
 *         description: Bắt buộc khi period=month.
 *       - in: query
 *         name: quarter
 *         schema: { type: integer, minimum: 1, maximum: 4 }
 *         description: Bắt buộc khi period=quarter.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 10 }
 *         description: |
 *           Số series trả về trong top_series.
 *           Mặc định 10, tối thiểu 1, tối đa 50.
 *           Giá trị không hợp lệ (không phải số nguyên dương) → dùng default 10.
 *           Giá trị > 50 bị clamp về 50.
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
 *                     filter:
 *                       type: object
 *                       properties:
 *                         period: { type: string, enum: [month, quarter, year] }
 *                         year: { type: integer }
 *                         month: { type: integer, description: "Chỉ có khi period=month" }
 *                         quarter: { type: integer, description: "Chỉ có khi period=quarter" }
 *                         from: { type: string, format: date-time, description: "ISO, inclusive" }
 *                         to: { type: string, format: date-time, description: "ISO, exclusive" }
 *                         timezone: { type: string, example: Asia/Ho_Chi_Minh }
 *                     config:
 *                       type: object
 *                       properties:
 *                         platform_fee_percent: { type: number }
 *                         coin_to_vnd_rate: { type: integer }
 *                     summary:
 *                       type: object
 *                       properties:
 *                         gross_revenue_coin: { type: integer }
 *                         creator_revenue_coin: { type: integer }
 *                         mangaka_revenue_coin: { type: integer }
 *                         assistant_revenue_coin: { type: integer }
 *                         platform_fee_coin: { type: integer }
 *                         platform_fee_vnd:
 *                           type: integer
 *                           description: |
 *                             Phí nền tảng quy đổi VND (number).
 *                             FE tự format tiền Việt Nam từ number này.
 *                             Công thức: platform_fee_coin × coin_to_vnd_rate / 100.
 *                         chapters_sold: { type: integer }
 *                     points:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key: { type: string, description: "YYYY-MM-DD hoặc YYYY-MM" }
 *                           label: { type: string }
 *                           gross_revenue_coin: { type: integer }
 *                           mangaka_revenue_coin: { type: integer }
 *                           assistant_revenue_coin: { type: integer }
 *                           platform_fee_coin: { type: integer }
 *                           platform_fee_vnd:
 *                             type: integer
 *                             description: "Phí nền tảng quy đổi VND của chart point (= 0 cho bucket không có data)."
 *                           chapters_sold: { type: integer }
 *                     top_series:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           series_id: { type: string }
 *                           series_name: { type: string }
 *                           cover_image_url: { type: string }
 *                           author:
 *                             type: object
 *                             nullable: true
 *                             properties:
 *                               user_id: { type: string }
 *                               username: { type: string, nullable: true }
 *                               full_name: { type: string, nullable: true }
 *                           gross_revenue_coin: { type: integer }
 *                           creator_revenue_coin: { type: integer }
 *                           platform_fee_coin: { type: integer }
 *                           platform_fee_vnd:
 *                             type: integer
 *                             description: "Phí nền tảng quy đổi VND của series (= platform_fee_coin × coin_to_vnd_rate / 100)."
 *                           chapters_sold: { type: integer }
 *       400:
 *         description: |
 *           Invalid query — period/year/month/quarter không hợp lệ.
 *       401: { description: "No token provided" }
 *       403: { description: "Access denied - Admin only" }
 */
router.get("/revenue-analytics", async (req, res, next) => {
  try {
    const data = await adminFinanceService.getRevenueAnalytics(req.query);
    // `platform_fee_coin` trong DISPLAY_FIELDS map sang legacy "platform_fee"
    // nên middleware formatCoinResponse không tự sinh `platform_fee_coin_display`.
    // Gắn thủ công để response tuân theo contract canonical.
    appendCoinDisplayAlias(data);
    return res.json({ success: true, data });
  } catch (error) {
    if (error && /^(Invalid (period|year|month|quarter))/.test(error.message || "")) {
      return next(new AppError(error.message, 400));
    }
    next(error);
  }
});

module.exports = router;
