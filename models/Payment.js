const mongoose = require("mongoose");

/**
 * Payment - Giao dịch thanh toán PayOS.
 * `coin_amount` is an integer CoinUnit snapshot; `amount_vnd` remains VND.
 *
 * Lifecycle:
 *   1. Reader chọn gói Coin → tạo Payment (status = "pending") + gọi PayOS tạo link
 *   2. PayOS redirect user về checkout, sau khi thanh toán gửi webhook về server
 *   3. Server verify webhook → status = "paid" + cộng Coin vào Wallet
 *   4. Nếu user huỷ / timeout → status = "cancelled" hoặc "expired"
 *
 * `order_code` là số nguyên duy nhất do server tạo, PayOS dùng để đối chiếu.
 * Webhook có thể gửi nhiều lần → check status = "paid" để idempotent.
 */
const PAYMENT_STATUS = {
  PENDING: "pending",
  PAID: "paid",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  FAILED: "failed",
};

const paymentSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    coin_package_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CoinPackage",
      required: true,
    },
    order_code: { type: Number, required: true, unique: true, index: true },
    amount_vnd: { type: Number, required: true, min: 1 },
    coin_amount: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: "coin_amount must be integer CoinUnit" },
    }, // total CoinUnit (base + bonus)
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
      index: true,
    },
    description: { type: String, default: "" },
    checkout_url: { type: String, default: "" },
    payos_payment_link_id: { type: String, default: "" },
    payos_raw_payload: { type: Object, default: null },
    paid_at: { type: Date, default: null },
    cancelled_at: { type: Date, default: null },
    expired_at: { type: Date, default: null },
    expires_at: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

paymentSchema.index({ user_id: 1, status: 1, createdAt: -1 });

const Payment = mongoose.model("Payment", paymentSchema);
module.exports = Payment;
module.exports.PAYMENT_STATUS = PAYMENT_STATUS;
