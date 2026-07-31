const mongoose = require("mongoose");

/**
 * Revenue - Doanh thu được chia cho từng Mangaka/Assistant khi Reader mua chapter.
 *
 * Lifecycle:
 *   - status = "pending"  : vừa tạo, chưa đến thời điểm available
 *   - available_at       : thời điểm có thể chuyển sang available
 *   - status = "available": job đã chuyển sang available, tiền cộng vào available_balance
 *   - status = "withdrawn": đã được rút (mở rộng sau)
 *
 * `gross_coin_amount` : tổng Coin chapter (chưa trừ phí platform)
 * `platform_fee_coin` : phí platform giữ lại (theo PLATFORM_FEE_PERCENTAGE)
 * `net_coin_amount`   : phần còn lại sau phí platform
 * `share_percentage`  : tỷ lệ (%) của user này từ Cooperation (snapshot)
 * `coin_amount`       : số Coin user này thực nhận = net_coin_amount * share_percentage / 100
 */
const REVENUE_STATUS = {
  PENDING: "pending",
  AVAILABLE: "available",
  WITHDRAWN: "withdrawn",
};

const revenueSchema = new mongoose.Schema(
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
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      required: true,
      index: true,
    },
    chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chapter",
      required: true,
      index: true,
    },
    purchased_chapter_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchasedChapter",
      required: true,
    },
    reader_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    gross_coin_amount: { type: Number, required: true, min: 0 },
    platform_fee_coin: { type: Number, required: true, min: 0 },
    net_coin_amount: { type: Number, required: true, min: 0 },
    share_percentage: { type: Number, required: true, min: 0, max: 100 },
    coin_amount: { type: Number, required: true, min: 0 },
    vnd_amount: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: Object.values(REVENUE_STATUS),
      default: REVENUE_STATUS.PENDING,
      index: true,
    },
    available_at: { type: Date, required: true, index: true },
    available_at_processed_at: { type: Date, default: null },
    cooperation_snapshot: {
      type: {
        mangaka_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        shares: {
          type: [
            {
              user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
              role: { type: String, enum: ["Mangaka", "Assistant"] },
              percentage: { type: Number, min: 0, max: 100 },
            },
          ],
          default: [],
        },
        platform_fee_percentage: { type: Number, min: 0, max: 100 },
      },
      default: null,
    },
  },
  { timestamps: true }
);

revenueSchema.index({ user_id: 1, status: 1, createdAt: -1 });
revenueSchema.index({ status: 1, available_at: 1 });

const Revenue = mongoose.model("Revenue", revenueSchema);
module.exports = Revenue;
module.exports.REVENUE_STATUS = REVENUE_STATUS;