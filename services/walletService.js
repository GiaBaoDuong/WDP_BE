/**
 * walletService - Tất cả thao tác với Wallet + WalletTransaction.
 *
 * Mọi thay đổi balance/pending_balance/available_balance đều được ghi vào
 * WalletTransaction tương ứng. Các thao tác cập nhật dùng $inc để tránh race
 * condition cơ bản (MongoDB atomic).
 *
 * Hàm trả về { wallet, transaction } để caller có thể xử lý tiếp.
 */
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const { TX_TYPES } = require("../models/WalletTransaction");

/**
 * Lấy hoặc tạo mới Wallet cho user.
 */
async function getOrCreateWallet(userId) {
  let wallet = await Wallet.findOne({ user_id: userId });
  if (!wallet) {
    wallet = await Wallet.create({ user_id: userId });
  }
  return wallet;
}

/**
 * Cộng Coin vào wallet.Reader (balance) - dùng cho Deposit.
 *
 * @returns {Promise<{wallet, transaction}>}
 */
async function creditCoin(userId, coinAmount, vndAmount = 0, opts = {}) {
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId);
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    {
      $inc: {
        balance: coinAmount,
        total_deposited: coinAmount,
      },
    },
    { new: true }
  );
  const transaction = await WalletTransaction.create({
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.DEPOSIT,
    direction: "in",
    coin_amount: coinAmount,
    vnd_amount: vndAmount,
    description: opts.description || "Nạp Coin qua PayOS",
    payment_id: opts.payment_id || null,
  });
  return { wallet: updated, transaction };
}

/**
 * Trừ Coin khỏi wallet.Reader (balance) - dùng cho Purchase.
 *
 * Nếu balance không đủ sẽ trả về { ok: false, reason: 'insufficient' }.
 * Trước khi trừ, kiểm tra và trả về lỗi để caller có thể dừng.
 */
async function debitCoin(userId, coinAmount, opts = {}) {
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId);
  if (wallet.balance < coinAmount) {
    return { ok: false, reason: "insufficient", wallet };
  }
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id, balance: { $gte: coinAmount } },
    {
      $inc: {
        balance: -coinAmount,
        total_spent: coinAmount,
      },
    },
    { new: true }
  );
  if (!updated) {
    // Trường hợp hiếm: balance thay đổi giữa các bước
    return { ok: false, reason: "insufficient", wallet };
  }
  const transaction = await WalletTransaction.create({
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.PURCHASE,
    direction: "out",
    coin_amount: coinAmount,
    description: opts.description || "Mua chapter trả phí",
    chapter_id: opts.chapter_id || null,
    purchased_chapter_id: opts.purchased_chapter_id || null,
  });
  return { ok: true, wallet: updated, transaction };
}

/**
 * Cộng Revenue vào wallet của Mangaka/Assistant.
 *
 * Mặc định: tiền vào `pending_balance`. Sau khi job release sẽ chuyển sang
 * `available_balance`. Có thể truyền `immediate: true` để bỏ qua pending
 * (không khuyến khích - chỉ dùng cho seed/test).
 */
async function creditRevenue(userId, coinAmount, opts = {}) {
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId);
  const incFields = {
    pending_balance: opts.immediate ? 0 : coinAmount,
    available_balance: opts.immediate ? coinAmount : 0,
    total_revenue: coinAmount,
  };
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    { $inc: incFields },
    { new: true }
  );
  const transaction = await WalletTransaction.create({
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.REVENUE,
    direction: "in",
    coin_amount: coinAmount,
    vnd_amount: opts.vnd_amount || 0,
    description: opts.description || "Doanh thu từ chapter",
    chapter_id: opts.chapter_id || null,
    revenue_id: opts.revenue_id || null,
  });
  return { wallet: updated, transaction };
}

/**
 * Job nội bộ: chuyển tiền từ pending_balance sang available_balance
 * khi Revenue hết hạn pending. Ghi WalletTransaction dạng "move".
 *
 * Không tính là doanh thu mới, không cộng total_revenue (đã cộng khi tạo).
 */
async function releasePendingRevenue(userId, coinAmount, opts = {}) {
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId);
  if (wallet.pending_balance < coinAmount) {
    return { ok: false, reason: "insufficient_pending", wallet };
  }
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id, pending_balance: { $gte: coinAmount } },
    {
      $inc: {
        pending_balance: -coinAmount,
        available_balance: coinAmount,
      },
    },
    { new: true }
  );
  if (!updated) {
    return { ok: false, reason: "insufficient_pending", wallet };
  }
  const transaction = await WalletTransaction.create({
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.REVENUE,
    direction: "in",
    coin_amount: coinAmount,
    vnd_amount: opts.vnd_amount || 0,
    description: opts.description || "Revenue released to available balance",
    revenue_id: opts.revenue_id || null,
  });
  return { ok: true, wallet: updated, transaction };
}

/**
 * Trừ Coin từ available_balance khi user yêu cầu Withdrawal.
 */
async function debitWithdrawal(userId, coinAmount, opts = {}) {
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId);
  if (wallet.available_balance < coinAmount) {
    return { ok: false, reason: "insufficient_available", wallet };
  }
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id, available_balance: { $gte: coinAmount } },
    {
      $inc: {
        available_balance: -coinAmount,
        total_withdrawn: coinAmount,
      },
    },
    { new: true }
  );
  if (!updated) {
    return { ok: false, reason: "insufficient_available", wallet };
  }
  const transaction = await WalletTransaction.create({
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.WITHDRAWAL,
    direction: "out",
    coin_amount: coinAmount,
    vnd_amount: opts.vnd_amount || 0,
    description: opts.description || "Yêu cầu rút tiền",
    withdrawal_id: opts.withdrawal_id || null,
  });
  return { ok: true, wallet: updated, transaction };
}

/**
 * Hoàn lại Coin vào available_balance khi Withdrawal bị reject / cancel.
 */
async function refundWithdrawal(userId, coinAmount, opts = {}) {
  const wallet = await getOrCreateWallet(userId);
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    {
      $inc: {
        available_balance: coinAmount,
        // total_withdrawn đã được cộng khi tạo withdrawal → hoàn lại
        total_withdrawn: -coinAmount,
      },
    },
    { new: true }
  );
  const transaction = await WalletTransaction.create({
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.WITHDRAWAL,
    direction: "in",
    coin_amount: coinAmount,
    vnd_amount: opts.vnd_amount || 0,
    description: opts.description || "Hoàn tiền withdrawal",
    withdrawal_id: opts.withdrawal_id || null,
  });
  return { wallet: updated, transaction };
}

module.exports = {
  getOrCreateWallet,
  creditCoin,
  debitCoin,
  creditRevenue,
  releasePendingRevenue,
  debitWithdrawal,
  refundWithdrawal,
};