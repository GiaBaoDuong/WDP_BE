const mongoose = require("mongoose");

const coinUnitField = (required = false) => ({
  type: Number,
  required,
  default: required ? undefined : 0,
  min: required ? 1 : 0,
  validate: { validator: Number.isSafeInteger, message: "CoinPackage value must be integer CoinUnit" },
});

/**
 * CoinPackage - Các gói nạp Coin do Admin quản lý.
 * `coin_amount`, `bonus_coin`, and `total_coin` are integer CoinUnit values.
 *
 * Ví dụ:
 *   name: "Gói 200 Coin"
 *   price_vnd: 20000
 *   coin_amount: 20000    // 200.00 Coin
 *   bonus_coin: 0         // CoinUnit bonus
 *   total_coin: 20000     // CoinUnit total used to credit the wallet
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
    coin_amount: coinUnitField(true),
    bonus_coin: coinUnitField(),
    total_coin: coinUnitField(),
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
