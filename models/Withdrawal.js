const mongoose = require("mongoose");

/**
 * Withdrawal - Yêu cầu rút tiền của Mangaka/Assistant.
 *
 * Lifecycle:
 *   pending  ──approve──►  approved  ──complete──►  completed
 *      │
 *      └────reject────►  rejected (tiền quay lại available_balance)
 *
 * Snapshot thông tin ngân hàng tại thời điểm tạo yêu cầu (tránh thay đổi sau).
 *
 * `coin_amount`: số Coin muốn rút (giá trị khả dụng tại thời điểm tạo)
 * `vnd_amount` : số tiền VNĐ quy đổi tương ứng theo tỷ giá lúc tạo
 */
const WITHDRAWAL_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  COMPLETED: "completed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
};

const withdrawalSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    user_role: {
      type: String,
      enum: ["Mangaka", "Assistant"],
      required: true,
    },
    coin_amount: { type: Number, required: true, min: 0 },
    vnd_amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: Object.values(WITHDRAWAL_STATUS),
      default: WITHDRAWAL_STATUS.PENDING,
      index: true,
    },
    // Snapshot thông tin ngân hàng
    bank_snapshot: {
      bank_name: { type: String, default: "" },
      account_holder: { type: String, default: "" },
      account_number: { type: String, default: "" },
    },
    note: { type: String, default: "", maxlength: 500 },
    // Xử lý bởi admin
    processed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    processed_at: { type: Date, default: null },
    admin_note: { type: String, default: "", maxlength: 500 },
    // Khi hoàn tiền (reject / cancel) - tiền được cộng lại available_balance
    refunded_at: { type: Date, default: null },
  },
  { timestamps: true }
);

withdrawalSchema.index({ user_id: 1, status: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, createdAt: -1 });

const Withdrawal = mongoose.model("Withdrawal", withdrawalSchema);
module.exports = Withdrawal;
module.exports.WITHDRAWAL_STATUS = WITHDRAWAL_STATUS;