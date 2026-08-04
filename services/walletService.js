/**
 * walletService - Tất cả thao tác với Wallet + WalletTransaction.
 * Every monetary amount is a positive safe integer CoinUnit unless explicitly documented.
 *
 * Mọi thay đổi balance/pending_balance/available_balance đều được ghi vào
 * WalletTransaction tương ứng. Các thao tác cập nhật dùng $inc để tránh race
 * condition cơ bản (MongoDB atomic).
 *
 * Quy ước total_withdrawn (chuẩn hoá v2):
 *   - Coin bị debit khỏi available_balance khi user tạo Withdrawal (pending).
 *   - Coin được cộng vào total_withdrawn khi Withdrawal chuyển sang completed.
 *   - Reject hoàn coin về available_balance; KHÔNG giảm total_withdrawn
 *     (vì field này chưa được tăng trước complete).
 */
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const { TX_TYPES } = require("../models/WalletTransaction");
const { assertCoinUnits } = require("../utils/coinUnit");

/**
 * Lấy hoặc tạo mới Wallet cho user.
 */
async function getOrCreateWallet(userId, opts = {}) {
  let query = Wallet.findOne({ user_id: userId });
  if (opts.session) query = query.session(opts.session);
  let wallet = await query;
  if (!wallet) {
    if (opts.session) {
      [wallet] = await Wallet.create([{ user_id: userId }], {
        session: opts.session,
      });
    } else {
      wallet = await Wallet.create({ user_id: userId });
    }
  }
  return wallet;
}

/**
 * Cộng Coin vào wallet.Reader (balance) - dùng cho Deposit.
 *
 * @returns {Promise<{wallet, transaction}>}
 */
async function creditCoin(userId, coinAmount, vndAmount = 0, opts = {}) {
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId, { session: opts.session });
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    {
      $inc: {
        balance: coinAmount,
        total_deposited: coinAmount,
      },
    },
    { new: true, session: opts.session }
  );
  const transactionData = {
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.DEPOSIT,
    direction: "in",
    coin_amount: coinAmount,
    vnd_amount: vndAmount,
    description: opts.description || "Nạp Coin qua PayOS",
    payment_id: opts.payment_id || null,
  };
  const transaction = opts.session
    ? (await WalletTransaction.create([transactionData], { session: opts.session }))[0]
    : await WalletTransaction.create(transactionData);
  return { wallet: updated, transaction };
}

/**
 * Trừ Coin khỏi wallet.Reader (balance) - dùng cho Purchase.
 *
 * Nếu balance không đủ sẽ trả về { ok: false, reason: 'insufficient' }.
 * Trước khi trừ, kiểm tra và trả về lỗi để caller có thể dừng.
 */
async function debitCoin(userId, coinAmount, opts = {}) {
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId, { session: opts.session });
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
    { new: true, session: opts.session }
  );
  if (!updated) {
    return { ok: false, reason: "insufficient", wallet };
  }
  const transactionData = {
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.PURCHASE,
    direction: "out",
    coin_amount: coinAmount,
    description: opts.description || "Mua chapter trả phí",
    chapter_id: opts.chapter_id || null,
    purchased_chapter_id: opts.purchased_chapter_id || null,
  };
  const transaction = opts.session
    ? (await WalletTransaction.create([transactionData], { session: opts.session }))[0]
    : await WalletTransaction.create(transactionData);
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
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId, { session: opts.session });
  const incFields = {
    pending_balance: opts.immediate ? 0 : coinAmount,
    available_balance: opts.immediate ? coinAmount : 0,
    total_revenue: coinAmount,
  };
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    { $inc: incFields },
    { new: true, session: opts.session }
  );
  const transactionData = {
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.REVENUE,
    direction: "in",
    coin_amount: coinAmount,
    vnd_amount: opts.vnd_amount || 0,
    description: opts.description || "Doanh thu từ chapter",
    chapter_id: opts.chapter_id || null,
    revenue_id: opts.revenue_id || null,
  };
  const transaction = opts.session
    ? (await WalletTransaction.create([transactionData], { session: opts.session }))[0]
    : await WalletTransaction.create(transactionData);
  return { wallet: updated, transaction };
}

/**
 * Job nội bộ: chuyển tiền từ pending_balance sang available_balance
 * khi Revenue hết hạn pending.
 *
 * KHÔNG tạo WalletTransaction mới — doanh thu đã được ghi nhận lúc tạo
 * Revenue. Nếu ghi thêm sẽ làm ledger "thấy" doanh thu 2 lần và tổng inflow
 * bị nhân đôi trong thống kê. Đây là internal transfer; chỉ đổi trạng thái
 * balance giữa 2 bucket.
 */
async function releasePendingRevenue(userId, coinAmount, opts = {}) {
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  const wallet = await getOrCreateWallet(userId, { session: opts.session });
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
    { new: true, session: opts.session }
  );
  if (!updated) {
    return { ok: false, reason: "insufficient_pending", wallet };
  }
  // Không tạo WalletTransaction — đây là internal transfer.
  return { ok: true, wallet: updated, transaction: null };
}

/**
 * Trừ Coin từ available_balance khi user tạo Withdrawal (pending).
 *
 * Hàm này KHÔNG tăng total_withdrawn — chỉ "giữ" coin khỏi available.
 * total_withdrawn chỉ được tăng khi withdrawal chuyển sang status=completed
 * (xem `creditWithdrawalComplete`).
 *
 * Args:
 *   - userId
 *   - coinAmount (integer CoinUnit, > 0)
 *   - opts.session: optional MongoDB session để gom vào 1 transaction
 *   - opts.withdrawal_id: bắt buộc khi dùng trong luồng withdrawal
 *   - opts.vnd_amount, opts.description
 *
 * Returns { ok, wallet, transaction }. Khi ok=false (insufficient_available)
 * thì KHÔNG có transaction / side-effect.
 */
async function debitWithdrawal(userId, coinAmount, opts = {}) {
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  if (!opts.withdrawal_id) {
    throw new Error("withdrawal_id is required when debiting for withdrawal");
  }
  const wallet = await getOrCreateWallet(userId, { session: opts.session });
  if (wallet.available_balance < coinAmount) {
    return { ok: false, reason: "insufficient_available", wallet };
  }
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id, available_balance: { $gte: coinAmount } },
    {
      $inc: {
        available_balance: -coinAmount,
        // total_withdrawn KHÔNG tăng ở bước này (xem doc ở đầu file).
      },
    },
    { new: true, session: opts.session }
  );
  if (!updated) {
    return { ok: false, reason: "insufficient_available", wallet };
  }
  const transactionData = {
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.WITHDRAWAL,
    direction: "out",
    coin_amount: coinAmount,
    vnd_amount: opts.vnd_amount || 0,
    description: opts.description || "Yêu cầu rút tiền",
    withdrawal_id: opts.withdrawal_id || null,
  };
  const transaction = opts.session
    ? (await WalletTransaction.create([transactionData], { session: opts.session }))[0]
    : await WalletTransaction.create(transactionData);
  return { ok: true, wallet: updated, transaction };
}

/**
 * Cộng total_withdrawn khi Withdrawal chuyển sang completed.
 * KHÔNG thay đổi available_balance/pending_balance (đã được xử lý bởi
 * debitWithdrawal lúc tạo). Tạo 1 WalletTransaction "in" gắn với withdrawal
 * để ledger phản ánh "đã rút thực sự" nhưng KHÔNG tăng balance.
 *
 * Implementation: $inc total_withdrawn và ghi 1 transaction direction=in
 * với amount coin_amount — số dư available_balance không đổi, total_withdrawn
 * được công dồn cho thống kê và admin. Đây là quy ước ledger được chấp nhận
 * (ghi nhận completion, không động vào balance).
 */
async function creditWithdrawalComplete(userId, coinAmount, opts = {}) {
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) {
    throw new Error("coinAmount phải > 0");
  }
  if (!opts.withdrawal_id) {
    throw new Error("withdrawal_id is required when crediting withdrawal complete");
  }
  const wallet = await getOrCreateWallet(userId, { session: opts.session });
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    { $inc: { total_withdrawn: coinAmount } },
    { new: true, session: opts.session }
  );
  const transactionData = {
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.WITHDRAWAL,
    direction: "in",
    coin_amount: coinAmount,
    vnd_amount: opts.vnd_amount || 0,
    description:
      opts.description ||
      `Withdrawal completed: ghi nhận total_withdrawn +${coinAmount}`,
    withdrawal_id: opts.withdrawal_id || null,
  };
  const transaction = opts.session
    ? (await WalletTransaction.create([transactionData], { session: opts.session }))[0]
    : await WalletTransaction.create(transactionData);
  return { wallet: updated, transaction };
}

/**
 * Hoàn lại Coin vào available_balance khi Withdrawal bị reject.
 *
 * Đặc điểm chuẩn hoá v2:
 *   - Coin được cộng lại available_balance.
 *   - total_withdrawn KHÔNG bị giảm (chưa được tăng ở bước complete trước
 *     reject, nên không có gì để hoàn).
 *   - Idempotent theo withdrawal_id: caller phải đảm bảo chỉ gọi 1 lần
 *     cho mỗi withdrawal (xem withdrawalService.rejectWithdrawal).
 */
async function refundWithdrawal(userId, coinAmount, opts = {}) {
  assertCoinUnits(coinAmount, "coinAmount", { allowZero: false });
  if (!opts.withdrawal_id) {
    throw new Error("withdrawal_id is required when refunding withdrawal");
  }
  const wallet = await getOrCreateWallet(userId, { session: opts.session });
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    {
      $inc: {
        available_balance: coinAmount,
        // total_withdrawn KHÔNG được điều chỉnh (xem comment ở đầu file).
      },
    },
    { new: true, session: opts.session }
  );
  const transactionData = {
    wallet_id: updated._id,
    user_id: userId,
    type: TX_TYPES.WITHDRAWAL,
    direction: "in",
    coin_amount: coinAmount,
    vnd_amount: opts.vnd_amount || 0,
    description: opts.description || "Hoàn tiền withdrawal",
    withdrawal_id: opts.withdrawal_id || null,
  };
  const transaction = opts.session
    ? (await WalletTransaction.create([transactionData], { session: opts.session }))[0]
    : await WalletTransaction.create(transactionData);
  return { wallet: updated, transaction };
}

module.exports = {
  getOrCreateWallet,
  creditCoin,
  debitCoin,
  creditRevenue,
  releasePendingRevenue,
  debitWithdrawal,
  creditWithdrawalComplete,
  refundWithdrawal,
};
