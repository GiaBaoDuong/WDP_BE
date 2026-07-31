const mongoose = require("mongoose");

/**
 * CoinPackage - Các gói nạp Coin do Admin quản lý.
 *
 * Ví dụ:
 *   name: "Gói 200 Coin"
 *   price_vnd: 20000
 *   coin_amount: 200      // Coin cơ bản
 *   bonus_coin: 0         // Bonus thêm
 *   total_coin: 200       // Tổng (coin_amount + bonus_coin) - dùng để cộng vào wallet
 *   sort_order: 1
 *   is_active: true
 *
 * `total_coin` được tính tự động trong pre-save nếu không nhập.
 */
const coinPackageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: "", maxlength: 500 },
    price_vnd: { type: Number, required: true, min: 1000 },
    coin_amount: { type: Number, required: true, min: 1 },
    bonus_coin: { type: Number, default: 0, min: 0 },
    total_coin: { type: Number, default: 0, min: 0 },
    sort_order: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

// Tính total_coin = coin_amount + bonus_coin trước khi validate.
// Cần dùng pre('validate') (không phải pre('save')) để giá trị được set
// trước khi Mongoose kiểm tra required.
coinPackageSchema.pre("validate", function () {
  if (this.isModified("coin_amount") || this.isModified("bonus_coin") || !this.total_coin) {
    this.total_coin = (this.coin_amount || 0) + (this.bonus_coin || 0);
  }
});

const CoinPackage = mongoose.model("CoinPackage", coinPackageSchema);
module.exports = CoinPackage;