/**
 * withdrawalService - Yêu cầu rút tiền cho Mangaka/Assistant.
 *
 * Flow:
 *   1. User gửi POST /withdrawals → validate đủ điều kiện, tạo Withdrawal (pending)
 *      và debit ngay available_balance (giữ tiền).
 *   2. Admin approve / reject / complete.
 *   3. Nếu reject → refund lại vào available_balance.
 *   4. Nếu complete → finalize (tiền đã được trừ ở step 1).
 */
const mongoose = require("mongoose");
const User = require("../models/User");
const Withdrawal = require("../models/Withdrawal");
const config = require("../config/payment");
const {
  getOrCreateWallet,
  debitWithdrawal,
  refundWithdrawal,
} = require("./walletService");

class WithdrawalError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const ensureMangakaOrAssistant = (user) => {
  if (!["Mangaka", "Assistant"].includes(user.role)) {
    throw new WithdrawalError(
      "Chỉ Mangaka hoặc Assistant mới được rút tiền",
      "wrong_role",
      403
    );
  }
};

const ensureHasBankInfo = (user) => {
  if (!user.bank_name || !user.account_holder || !user.bank_account_number) {
    throw new WithdrawalError(
      "Bạn cần cập nhật thông tin ngân hàng trước khi rút tiền",
      "missing_bank_info",
      400
    );
  }
};

/**
 * Tạo yêu cầu withdrawal.
 *
 * @param {String} userId
 * @param {Object} body  { coin_amount, vnd_amount, note }
 *                      Nếu chỉ truyền coin_amount, vnd_amount sẽ tự tính theo tỷ giá.
 */
async function createWithdrawalRequest(userId, body) {
  const user = await User.findById(userId).lean();
  if (!user) throw new WithdrawalError("User not found", "not_found", 404);
  ensureMangakaOrAssistant(user);
  ensureHasBankInfo(user);

  const coinAmount = Number(body.coin_amount);
  if (!Number.isFinite(coinAmount) || coinAmount <= 0) {
    throw new WithdrawalError("coin_amount phải > 0", "invalid_amount", 400);
  }

  const vndAmount =
    body.vnd_amount != null
      ? Number(body.vnd_amount)
      : coinAmount * config.monetization.coinToVndRate;

  if (vndAmount < config.monetization.minWithdrawalVnd) {
    throw new WithdrawalError(
      `Số tiền rút tối thiểu là ${config.monetization.minWithdrawalVnd} VNĐ`,
      "below_minimum",
      400
    );
  }

  // Không cho tạo 2 yêu cầu pending cùng lúc
  const existingPending = await Withdrawal.findOne({
    user_id: userId,
    status: "pending",
  });
  if (existingPending) {
    throw new WithdrawalError(
      "Bạn đã có yêu cầu rút tiền đang chờ xử lý",
      "pending_exists",
      400
    );
  }

  // Trừ tiền ngay để giữ chỗ
  const debit = await debitWithdrawal(userId, coinAmount, {
    vnd_amount: vndAmount,
    description: `Yêu cầu rút ${vndAmount} VNĐ`,
  });
  if (!debit.ok) {
    throw new WithdrawalError(
      "Số dư khả dụng không đủ để rút",
      "insufficient_available",
      400
    );
  }

  const withdrawal = await Withdrawal.create({
    user_id: userId,
    user_role: user.role,
    coin_amount: coinAmount,
    vnd_amount: vndAmount,
    status: "pending",
    bank_snapshot: {
      bank_name: user.bank_name || "",
      account_holder: user.account_holder || "",
      account_number: user.bank_account_number || "",
    },
    note: body.note || "",
  });

  return withdrawal;
}

/**
 * Admin approve yêu cầu.
 */
async function approveWithdrawal(adminId, withdrawalId, adminNote = "") {
  const w = await Withdrawal.findById(withdrawalId);
  if (!w) throw new WithdrawalError("Withdrawal not found", "not_found", 404);
  if (w.status !== "pending") {
    throw new WithdrawalError(
      `Chỉ approve được yêu cầu đang pending (hiện ${w.status})`,
      "invalid_state",
      400
    );
  }
  w.status = "approved";
  w.processed_by = adminId;
  w.processed_at = new Date();
  w.admin_note = adminNote;
  await w.save();
  return w;
}

/**
 * Admin complete (mô phỏng chuyển khoản thành công).
 */
async function completeWithdrawal(adminId, withdrawalId, adminNote = "") {
  const w = await Withdrawal.findById(withdrawalId);
  if (!w) throw new WithdrawalError("Withdrawal not found", "not_found", 404);
  if (w.status !== "approved") {
    throw new WithdrawalError(
      `Chỉ complete được yêu cầu đã approved (hiện ${w.status})`,
      "invalid_state",
      400
    );
  }
  w.status = "completed";
  w.processed_by = adminId;
  w.processed_at = new Date();
  w.admin_note = adminNote;
  await w.save();
  return w;
}

/**
 * Admin reject hoặc user huỷ - hoàn tiền về available_balance.
 */
async function rejectWithdrawal(adminId, withdrawalId, adminNote = "") {
  const w = await Withdrawal.findById(withdrawalId);
  if (!w) throw new WithdrawalError("Withdrawal not found", "not_found", 404);
  if (!["pending", "approved"].includes(w.status)) {
    throw new WithdrawalError(
      `Không thể reject yêu cầu ở trạng thái ${w.status}`,
      "invalid_state",
      400
    );
  }

  // Hoàn tiền
  await refundWithdrawal(w.user_id, w.coin_amount, {
    vnd_amount: w.vnd_amount,
    description: `Hoàn tiền withdrawal #${w._id}`,
    withdrawal_id: w._id,
  });

  w.status = "rejected";
  w.processed_by = adminId;
  w.processed_at = new Date();
  w.admin_note = adminNote;
  w.refunded_at = new Date();
  await w.save();
  return w;
}

module.exports = {
  createWithdrawalRequest,
  approveWithdrawal,
  completeWithdrawal,
  rejectWithdrawal,
  WithdrawalError,
};