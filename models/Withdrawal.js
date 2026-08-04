const mongoose = require("mongoose");

/**
 * Withdrawal - Yêu cầu rút tiền của Mangaka/Assistant.
 * `coin_amount` is integer CoinUnit; scale/rate/VND are immutable snapshots.
 *
 * Lifecycle (chuẩn hoá v2):
 *   pending  ──approve──►  approved  ──complete──►  completed
 *      │
 *      └────reject────►  rejected  (tiền quay lại available_balance)
 *
 * Quy ước số dư:
 *   - available_balance : Coin khả dụng mà user có thể yêu cầu rút.
 *   - pending/approved withdrawal đã giữ coin (debit khỏi available_balance)
 *     nhưng chưa tính vào total_withdrawn.
 *   - total_withdrawn chỉ tăng khi status = completed.
 *   - rejected: hoàn coin về available_balance; KHÔNG giảm total_withdrawn
 *     (vì field này chưa được tăng trước complete).
 *
 * `revenue_ids` (mảng ObjectId trỏ tới Revenue): snapshot các Revenue được
 * "rút" bởi yêu cầu này. Khi complete sẽ chuyển các Revenue trong mảng từ
 * `available → withdrawn`. Withdrawal cũ (tạo trước khi cập nhật) sẽ không
 * có field này — xem withdrawalService.completeWithdrawal để xử lý legacy.
 *
 * Snapshot thông tin ngân hàng tại thời điểm tạo yêu cầu (tránh thay đổi sau).
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
    coin_amount: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: "coin_amount must be integer CoinUnit" },
    },
    coin_unit_scale: { type: Number, required: true, default: 100, immutable: true },
    coin_to_vnd_rate: { type: Number, required: true, default: 100, immutable: true },
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
    // Revenue IDs được "rút" bởi yêu cầu này (snapshot tại thời điểm tạo).
    // Khi complete, các Revenue này chuyển từ `available` → `withdrawn`.
    // Có thể rỗng với dữ liệu legacy tạo trước khi field ra đời.
    revenue_ids: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Revenue",
        },
      ],
      default: [],
      index: true,
    },
  },
  { timestamps: true }
);

withdrawalSchema.index({ user_id: 1, status: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, createdAt: -1 });

const Withdrawal = mongoose.model("Withdrawal", withdrawalSchema);
module.exports = Withdrawal;
module.exports.WITHDRAWAL_STATUS = WITHDRAWAL_STATUS;
