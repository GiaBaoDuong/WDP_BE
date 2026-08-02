const mongoose = require("mongoose");

/**
 * WalletTransaction - Lịch sử giao dịch ví.
 * `coin_amount` is a safe integer CoinUnit value (100 CoinUnit = 1 Coin).
 *
 * Loại giao dịch:
 *   - DEPOSIT   : Reader nạp Coin qua PayOS (+balance, +total_deposited)
 *   - PURCHASE  : Reader mua chapter (-balance, +total_spent)
 *   - REVENUE   : Mangaka/Assistant nhận doanh thu (+total_revenue, +pending_balance)
 *   - WITHDRAWAL: Rút tiền (-available_balance, +total_withdrawn)
 *   - REFUND    : Hoàn tiền (mở rộng sau) (+balance, -total_spent)
 *
 * `coin_amount` luôn dương (giá trị tuyệt đối của giao dịch).
 * `direction` = "in" (cộng) hoặc "out" (trừ) để dễ hiển thị lịch sử.
 *
 * Snapshot tỷ giá / số tiền VNĐ tương ứng tại thời điểm giao dịch
 * để hiển thị mà không phụ thuộc vào CoinPackage sau này.
 */
const TX_TYPES = {
  DEPOSIT: "Deposit",
  PURCHASE: "Purchase",
  REVENUE: "Revenue",
  WITHDRAWAL: "Withdrawal",
  REFUND: "Refund",
};

const txSchema = new mongoose.Schema(
  {
    wallet_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: true,
      index: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(TX_TYPES),
      required: true,
    },
    direction: {
      type: String,
      enum: ["in", "out"],
      required: true,
    },
    coin_amount: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "coin_amount must be integer CoinUnit" },
    },
    vnd_amount: { type: Number, default: 0, min: 0 },
    description: { type: String, default: "" },
    // Reference tuỳ loại:
    payment_id: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null },
    chapter_id: { type: mongoose.Schema.Types.ObjectId, ref: "Chapter", default: null },
    purchased_chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchasedChapter",
      default: null,
    },
    revenue_id: { type: mongoose.Schema.Types.ObjectId, ref: "Revenue", default: null },
    withdrawal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Withdrawal",
      default: null,
    },
  },
  { timestamps: true }
);

txSchema.index({ user_id: 1, createdAt: -1 });
txSchema.index({ wallet_id: 1, createdAt: -1 });

const WalletTransaction = mongoose.model("WalletTransaction", txSchema);
module.exports = WalletTransaction;
module.exports.TX_TYPES = TX_TYPES;
