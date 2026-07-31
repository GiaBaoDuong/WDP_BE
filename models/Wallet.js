const mongoose = require("mongoose");

/**
 * Wallet - Ví Coin của user.
 *
 * Mỗi user có 1 wallet duy nhất. Wallet phục vụ cả 3 mục đích:
 *   1. Reader: nạp Coin (Deposit), mua chapter (Purchase)
 *   2. Mangaka/Assistant: nhận doanh thu chia (Revenue), rút tiền (Withdrawal)
 *
 * Các field chia doanh thu:
 *   - pending_balance: tổng Coin đang ở trạng thái Pending Revenue (chưa được available)
 *   - available_balance: tổng Coin đã available, có thể yêu cầu withdrawal
 *   - total_revenue: tổng doanh thu tích lũy (tất cả status)
 *
 * Các field cho Reader:
 *   - balance: số Coin hiện tại có thể dùng mua chapter
 *   - total_deposited: tổng Coin đã nạp qua PayOS
 *   - total_spent: tổng Coin đã dùng mua chapter
 *
 * Vì một user có thể vừa là Reader (nếu sau đổi role) vừa không nên giữ cả 2 loại,
 * nhưng thiết kế hiện tại: Reader chỉ có balance; Mangaka/Assistant chỉ có
 * pending/available. Có thể dùng chung model để đơn giản.
 */
const walletSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    // ─── Reader fields ─────────────────────────────────────────────────────
    balance: { type: Number, default: 0, min: 0 },
    total_deposited: { type: Number, default: 0, min: 0 },
    total_spent: { type: Number, default: 0, min: 0 },
    // ─── Mangaka/Assistant fields ──────────────────────────────────────────
    pending_balance: { type: Number, default: 0, min: 0 },
    available_balance: { type: Number, default: 0, min: 0 },
    total_revenue: { type: Number, default: 0, min: 0 },
    total_withdrawn: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

const Wallet = mongoose.model("Wallet", walletSchema);
module.exports = Wallet;