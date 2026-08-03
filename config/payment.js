/**
 * Payment config - Đọc cấu hình từ biến môi trường.
 *
 * PayOS docs: https://payos.vn/docs
 *
 *  PAYOS_CLIENT_ID
 *  PAYOS_API_KEY
 *  PAYOS_CHECKSUM_KEY
 *  PAYOS_BASE_URL          (mặc định https://api-merchant.payos.vn)
 *  PAYOS_RETURN_URL        (URL frontend sau khi thanh toán thành công)
 *  PAYOS_CANCEL_URL        (URL frontend khi user huỷ)
 *  PAYOS_MOCK=true         (dùng cho dev/test không cần kết nối PayOS thật)
 *  PAYMENT_TIMEOUT_SECONDS (thời gian checkout còn hiệu lực, mặc định 120 giây)
 *
 *  REVENUE_PENDING_HOURS   (mặc định 24, dev có thể đặt 0.003 = ~10 giây)
 *  PLATFORM_FEE_PERCENT    (mặc định 20 = 20%)
 *  COIN_TO_VND_RATE        (1 Coin = bao nhiêu VNĐ, mặc định 100)
 *  CoinUnit scale is fixed at 100 in utils/coinUnit.js and is not configurable.
 *  MIN_WITHDRAWAL_VND      (mặc định 200000)
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const toNumber = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const toSafeInteger = (v, fallback) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};

const config = {
  payos: {
    clientId: process.env.PAYOS_CLIENT_ID || "",
    apiKey: process.env.PAYOS_API_KEY || "",
    checksumKey: process.env.PAYOS_CHECKSUM_KEY || "",
    baseUrl: process.env.PAYOS_BASE_URL || "https://api-merchant.payos.vn",
    returnUrl:
      process.env.PAYOS_RETURN_URL ||
      process.env.FRONTEND_PROD_URL ||
      "http://localhost:5173/payment/return",
    cancelUrl:
      process.env.PAYOS_CANCEL_URL ||
      process.env.FRONTEND_PROD_URL ||
      "http://localhost:5173/payment/cancel",
    webhookUrl:
      process.env.PAYOS_WEBHOOK_URL ||
      (process.env.BACKEND_URL
        ? `${process.env.BACKEND_URL.replace(/\/$/, "")}/payments/payos/webhook`
        : ""),
    // Khi true: không gọi PayOS thật, trả về mock checkout URL.
    // Cho phép dev/test mà không cần tài khoản PayOS.
    mock: String(process.env.PAYOS_MOCK || "false").toLowerCase() === "true",
    paymentTimeoutSeconds: Math.max(
      30,
      toSafeInteger(process.env.PAYMENT_TIMEOUT_SECONDS, 120)
    ),
  },
  revenue: {
    // Số giờ Revenue nằm ở trạng thái pending trước khi chuyển sang available.
    // Có thể là số thập phân (vd 0.0028 ~ 10 giây) để test.
    pendingHours: toNumber(process.env.REVENUE_PENDING_HOURS, 24),
  },
  monetization: {
    platformFeePercent: toNumber(process.env.PLATFORM_FEE_PERCENT, 20),
    coinToVndRate: toSafeInteger(process.env.COIN_TO_VND_RATE, 100),
    minWithdrawalVnd: toSafeInteger(process.env.MIN_WITHDRAWAL_VND, 200000),
  },
};

module.exports = config;
