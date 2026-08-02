const mongoose = require("mongoose");

const coinUnitField = () => ({
  type: Number,
  required: true,
  min: 0,
  validate: { validator: Number.isSafeInteger, message: "Revenue value must be integer CoinUnit" },
});

/**
 * Revenue - Doanh thu được chia cho từng Mangaka/Assistant khi Reader mua chapter.
 * All Coin amount fields are integer CoinUnit values (100 CoinUnit = 1 Coin).
 *
 * Mỗi lượt mua chapter tạo N Revenue record (N = 1 nếu không có assistant, N = 2
 * nếu có assistant). Mọi record cùng `purchased_chapter_id` chia sẻ các field
 * ở cấp "purchase"; field ở cấp "share" chỉ áp dụng cho user trong record đó.
 *
 * Lifecycle:
 *   - status = "pending"  : vừa tạo, chưa đến thời điểm available
 *   - available_at       : thời điểm có thể chuyển sang available
 *   - status = "available": job đã chuyển sang available, tiền cộng vào available_balance
 *   - status = "withdrawn": đã được rút (mở rộng sau)
 *
 * Field semantic (đồng bộ với services/revenueService.js):
 *   `gross_coin_amount` : tổng Coin chapter (chưa trừ phí platform)
 *                         — CẤP PURCHASE: giống nhau trên MỌI record cùng purchase.
 *   `platform_fee_coin` : phần phí platform ứng với share của user này
 *                         (dùng largest-remainder; tổng per-record = platformFeeCoin/purchase)
 *                         — CẤP SHARE: khác nhau giữa Mangaka và Assistant.
 *   `net_coin_amount`   : tổng phần còn lại của purchase sau phí platform
 *                         — CẤP PURCHASE: giống nhau trên MỌI record cùng purchase.
 *                         — Trước khi thay đổi: trường này lưu sai = phần user nhận,
 *                            hiện đã sửa. Dữ liệu cũ vẫn còn trong DB — xem migration note.
 *   `share_percentage`  : tỷ lệ (%) của user này (60 / 40 / 100)
 *   `coin_amount`       : số Coin user này thực nhận
 *                         — CẤP SHARE: phân bổ bằng largest-remainder trên net_coin_amount.
 *
 * Quy ước aggregate (dashboard, thống kê, Revenue Hub):
 *   - Tổng Coin thực chia cho sáng tác: SUM(coin_amount) trên tất cả record
 *     (không bị double vì mỗi record thuộc về 1 user duy nhất).
 *   - Tổng Platform Fee của 1 purchase: SUM(platform_fee_coin) trên MỌI record
 *     của purchase đó (= platformFeeCoin/purchase).
 *   - Tổng Gross / Net / chapters_sold: GROUP BY purchased_chapter_id trước
 *     rồi $first lấy 1 bản đại diện, sum ở stage ngoài. Nếu sum trực tiếp
 *     sẽ bị nhân N lần do mỗi purchase tạo nhiều record.
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
    gross_coin_amount: coinUnitField(),
    platform_fee_coin: coinUnitField(),
    net_coin_amount: coinUnitField(),
    share_percentage: { type: Number, required: true, min: 0, max: 100 },
    coin_amount: coinUnitField(),
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
        // "CHAPTER_ASSISTANT" (mới) | "COOPERATION" (cũ, deprecated)
        source: {
          type: String,
          enum: ["CHAPTER_ASSISTANT", "COOPERATION", null],
          default: null,
        },
        mangaka_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        // Snapshot Assistant từ chapter (mới, optional)
        assistant_id: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
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
