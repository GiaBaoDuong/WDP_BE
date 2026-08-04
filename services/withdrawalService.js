/**
 * withdrawalService - Yêu cầu rút tiền cho Mangaka/Assistant.
 * Wallet amounts are CoinUnit; VND conversion divides by COIN_UNIT_SCALE.
 *
 * Flow chuẩn hoá v2 (mọi bước chạy trong 1 MongoDB transaction để atomic):
 *   1. POST /withdrawals
 *      - Validate role, bank info, min VND, không có withdrawal pending/approved.
 *      - Lấy wallet, đọc coin_amount = available_balance.
 *      - Snapshot các Revenue đang `available` của user (theo createdAt) vào
 *        `revenue_ids`. Nếu user không có revenue nào đang available thì để mảng
 *        rỗng — phù hợp trường hợp legacy hoặc seed.
 *      - Tạo Withdrawal trước (để có _id cố định cho transaction Withdrawal).
 *      - Trong cùng session: debitWithdrawal (chỉ trừ available, KHÔNG tăng
 *        total_withdrawn) + tạo WalletTransaction có withdrawal_id.
 *   2. PATCH /withdrawals/admin/:id/approve
 *      - Chỉ chuyển pending → approved, KHÔNG động balance.
 *   3. PATCH /withdrawals/admin/:id/complete
 *      - approved → completed.
 *      - Tăng total_withdrawn đúng coin_amount.
 *      - Cập nhật Revenue.status từ `available` → `withdrawn` CHỈ cho các
 *        Revenue nằm trong `revenue_ids` (snapshot lúc tạo). Nếu withdrawal
 *        cũ không có revenue_ids → dùng fallback an toàn (xem bên dưới).
 *      - Tạo WalletTransaction gắn withdrawal_id (direction=in, total marker).
 *   4. PATCH /withdrawals/admin/:id/reject
 *      - Hoàn coin_amount về available_balance qua refundWithdrawal.
 *      - KHÔNG giảm total_withdrawn (đã quy ước ở walletService).
 *      - Idempotent theo refunded_at: nếu đã refunded_at thì trả về chính
 *        record (không hoàn 2 lần).
 *
 * Backward compatibility cho withdrawal cũ (legacy):
 *   - Schema thêm field `revenue_ids` với default [] — doc cũ đọc vẫn OK.
 *   - completeWithdrawal() xử lý legacy:
 *       + Nếu có revenue_ids: chỉ update các Revenue này (an toàn).
 *       + Nếu không có revenue_ids: KHÔNG mark bất kỳ Revenue nào (tránh
 *         ảnh hưởng tới Revenue mới phát sinh sau thời điểm tạo). Doc giải
 *         thích rõ ràng trong code.
 *     Lưu ý: balance đã debit theo logic cũ ở bước tạo (tức available_balance
 *     đã trừ và total_withdrawn đã được +coin_amount NGAY khi user tạo
 *     withdrawal trong code cũ). Khi complete legacy:
 *       - Nếu wallet đã được cộng total_withdrawn theo code cũ → KHÔNG cộng nữa.
 *       - Logic chuẩn hoá phát hiện qua so sánh wallet.total_withdrawn với
 *         tổng withdrawal completed khác. Để đơn giản và an toàn nhất, ta chỉ
 *       cộng total_withdrawn nếu wallet.total_withdrawn HIỆN TẠI < tổng coin
 *       của các withdrawal đã completed của user này (gap fill).
 *     Xem `completeWithdrawal` để biết chi tiết.
 */
const mongoose = require("mongoose");
const User = require("../models/User");
const Withdrawal = require("../models/Withdrawal");
const Revenue = require("../models/Revenue");
const config = require("../config/payment");
const { COIN_UNIT_SCALE, assertCoinUnits, unitsToVnd } = require("../utils/coinUnit");
const {
  getOrCreateWallet,
  debitWithdrawal,
  refundWithdrawal,
  creditWithdrawalComplete,
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
 * User chỉ được rút TOÀN BỘ `available_balance`, không rút một phần.
 * Mọi side-effect (debit + Withdrawal create + WalletTransaction) chạy trong
 * 1 MongoDB transaction để rollback toàn bộ nếu có bất kỳ bước nào fail.
 */
async function createWithdrawalRequest(userId, body) {
  const user = await User.findById(userId).lean();
  if (!user) throw new WithdrawalError("User not found", "not_found", 404);
  ensureMangakaOrAssistant(user);
  ensureHasBankInfo(user);

  const wallet = await getOrCreateWallet(userId);
  const coinAmount = wallet.available_balance;

  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0) {
    throw new WithdrawalError(
      "Số dư khả dụng phải > 0 để tạo yêu cầu rút tiền",
      "zero_balance",
      400
    );
  }

  assertCoinUnits(coinAmount, "available_balance", { allowZero: false });
  const vndAmount = unitsToVnd(coinAmount, config.monetization.coinToVndRate);

  if (vndAmount < config.monetization.minWithdrawalVnd) {
    throw new WithdrawalError(
      `Số tiền rút tối thiểu là ${config.monetization.minWithdrawalVnd} VNĐ (hiện có ${vndAmount} VNĐ)`,
      "below_minimum",
      400
    );
  }

  const existingActive = await Withdrawal.findOne({
    user_id: userId,
    status: { $in: ["pending", "approved"] },
  });
  if (existingActive) {
    const reason =
      existingActive.status === "approved"
        ? "Yêu cầu rút tiền hiện tại đã được admin duyệt, đang chờ chuyển khoản. Vui lòng chờ hoàn tất trước khi tạo yêu cầu mới."
        : "Bạn đã có yêu cầu rút tiền đang chờ xử lý. Vui lòng chờ admin xử lý trước khi tạo yêu cầu mới.";
    throw new WithdrawalError(reason, "active_withdrawal_exists", 400);
  }

  // Snapshot các Revenue đang `available` tại thời điểm tạo.
  // Lưu ý: chỉ lấy revenue của CHÍNH user này (Mangaka hoặc Assistant),
  // và CHỈ các revenue có createdAt ≤ now (tránh race với revenue vừa
  // được release ngay sau khi snapshot).
  const revenueSnapshot = await Revenue.find(
    {
      user_id: userId,
      status: "available",
    },
    { _id: 1 }
  ).lean();
  const revenueIds = revenueSnapshot.map((r) => r._id);

  // Bắt đầu transaction. Nếu MONGODB_URI không phải replica set thì
  // transaction sẽ fail — fallback là chạy không transaction nhưng vẫn
  // giữ logic đúng (admin run on render.com Atlas thường là replica set).
  const session = await mongoose.startSession();
  let withdrawal;
  let debit;
  try {
    session.startTransaction();
    try {
      // 1. Tạo Withdrawal trước để có _id.
      [withdrawal] = await Withdrawal.create(
        [
          {
            user_id: userId,
            user_role: user.role,
            coin_amount: coinAmount,
            coin_unit_scale: COIN_UNIT_SCALE,
            coin_to_vnd_rate: config.monetization.coinToVndRate,
            vnd_amount: vndAmount,
            status: "pending",
            bank_snapshot: {
              bank_name: user.bank_name || "",
              account_holder: user.account_holder || "",
              account_number: user.bank_account_number || "",
            },
            note: body?.note || "",
            revenue_ids: revenueIds,
          },
        ],
        { session }
      );

      // 2. Debit wallet và tạo WalletTransaction trong cùng session.
      debit = await debitWithdrawal(
        userId,
        coinAmount,
        {
          session,
          withdrawal_id: withdrawal._id,
          vnd_amount: vndAmount,
          description: `Yêu cầu rút ${vndAmount} VNĐ`,
        }
      );
      if (!debit.ok) {
        await session.abortTransaction();
        throw new WithdrawalError(
          "Số dư khả dụng không đủ để rút",
          "insufficient_available",
          400
        );
      }

      await session.commitTransaction();
    } catch (err) {
      try { await session.abortTransaction(); } catch (_) {}
      throw err;
    }
  } catch (err) {
    // Nếu là lỗi do MongoDB không hỗ trợ transaction (replica set chưa bật)
    // thì fallback: vẫn chạy tuần tự ngoài transaction. Vẫn phải rollback
    // thủ công nếu có bước nào fail.
    if (
      err &&
      err.code === "TransactionNumbersNotSupported" &&
      !withdrawal
    ) {
      // Fallback path: chạy ngoài transaction.
      session.endSession();
      withdrawal = await Withdrawal.create({
        user_id: userId,
        user_role: user.role,
        coin_amount: coinAmount,
        coin_unit_scale: COIN_UNIT_SCALE,
        coin_to_vnd_rate: config.monetization.coinToVndRate,
        vnd_amount: vndAmount,
        status: "pending",
        bank_snapshot: {
          bank_name: user.bank_name || "",
          account_holder: user.account_holder || "",
          account_number: user.bank_account_number || "",
        },
        note: body?.note || "",
        revenue_ids: revenueIds,
      });
      debit = await debitWithdrawal(userId, coinAmount, {
        withdrawal_id: withdrawal._id,
        vnd_amount: vndAmount,
        description: `Yêu cầu rút ${vndAmount} VNĐ`,
      });
      if (!debit.ok) {
        // Rollback thủ công: xoá Withdrawal vừa tạo để khỏi orphan.
        await Withdrawal.deleteOne({ _id: withdrawal._id });
        throw new WithdrawalError(
          "Số dư khả dụng không đủ để rút",
          "insufficient_available",
          400
        );
      }
    } else if (!debit || !debit.ok) {
      // Đã tạo Withdrawal nhưng transaction abort do không đủ tiền.
      // Không có gì cần rollback thêm vì transaction đã abort.
      throw err;
    } else {
      session.endSession();
      throw err;
    }
  }
  session.endSession();

  return withdrawal;
}

/**
 * Admin approve yêu cầu.
 * KHÔNG động vào balance, KHÔNG tăng total_withdrawn.
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
 *
 * approved → completed. Trong 1 transaction:
 *   1. Tăng wallet.total_withdrawn đúng coin_amount.
 *   2. Update Revenue.status: chỉ các Revenue nằm trong revenue_ids chuyển
 *      từ `available` → `withdrawn`. Các Revenue phát sinh sau khi tạo
 *      withdrawal KHÔNG bị ảnh hưởng.
 *   3. Tạo WalletTransaction Withdrawal direction=in gắn withdrawal_id
 *      (ghi nhận tổng withdrawn).
 *
 * Backward compat (legacy withdrawal không có revenue_ids):
 *   - Không mark Revenue nào cả. Lý do: data cũ không snapshot revenue, không
 *     thể biết revenue nào là của withdrawal này nếu user rút nhiều lần.
 *     Không mark tránh sai balance tổng revenue.
 *   - Về total_withdrawn: code cũ debit available và tăng total_withdrawn NGAY
 *     khi user tạo withdrawal. Khi complete withdrawal cũ, nếu wallet đã có
 *     total_withdrawn ≥ tổng coin_amount của các withdrawal completed khác
 *     của user → KHÔNG cộng thêm. Ngược lại mới cộng bù (gap fill) để user
 *     không bị mất total_withdrawn nếu thiếu.
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

  // Tính xem có cần gap-fill total_withdrawn cho legacy không.
  // (Chỉ áp dụng nếu withdrawal này legacy — không có revenue_ids.)
  const isLegacy = !w.revenue_ids || w.revenue_ids.length === 0;

  const session = await mongoose.startSession();
  let commitWithFallback = false;
  try {
    session.startTransaction();
    try {
      // 1. Tăng total_withdrawn. Với legacy withdrawal CÓ THỂ đã được cộng
      // ở code cũ → không cộng thêm.
      let doCredit = true;
      if (isLegacy) {
        const Wallet = require("../models/Wallet");
        const userWallet = await Wallet.findOne({ user_id: w.user_id }).session(session);
        if (userWallet) {
          // Tổng coin của các withdrawal đã completed (không tính withdrawal
          // hiện tại) — nếu wallet.total_withdrawn >= tổng này thì không
          // cần cộng thêm.
          const othersAgg = await Withdrawal.aggregate([
            {
              $match: {
                user_id: w.user_id,
                status: "completed",
                _id: { $ne: w._id },
              },
            },
            { $group: { _id: null, total: { $sum: "$coin_amount" } } },
          ]).session(session);
          const othersSum = othersAgg[0]?.total || 0;
          if (userWallet.total_withdrawn >= othersSum + w.coin_amount) {
            doCredit = false;
          }
        }
      }

      if (doCredit) {
        const creditRes = await creditWithdrawalComplete(w.user_id, w.coin_amount, {
          session,
          withdrawal_id: w._id,
          vnd_amount: w.vnd_amount,
          description: `Withdrawal ${w._id} completed: total_withdrawn +${w.coin_amount}`,
        });
        if (!creditRes) {
          throw new Error("creditWithdrawalComplete failed");
        }
      }

      // 2. Update Revenue: chỉ các revenue_ids, chỉ status=available → withdrawn.
      // Với legacy (revenue_ids rỗng) → bỏ qua (xem doc comment).
      if (!isLegacy) {
        await Revenue.updateMany(
          {
            _id: { $in: w.revenue_ids },
            user_id: w.user_id,
            status: "available",
          },
          { $set: { status: "withdrawn" } },
          { session }
        );
      }

      // 3. Cập nhật trạng thái Withdrawal.
      w.status = "completed";
      w.processed_by = adminId;
      w.processed_at = new Date();
      w.admin_note = adminNote;
      await w.save({ session });

      await session.commitTransaction();
    } catch (err) {
      try { await session.abortTransaction(); } catch (_) {}
      throw err;
    }
  } catch (err) {
    if (err && err.code === "TransactionNumbersNotSupported") {
      // Fallback: chạy ngoài transaction. Vẫn giữ logic gap-fill cho legacy.
      commitWithFallback = true;
      session.endSession();

      const Wallet = require("../models/Wallet");
      const userWallet = await Wallet.findOne({ user_id: w.user_id });
      let doCredit = true;
      if (isLegacy && userWallet) {
        const othersAgg = await Withdrawal.aggregate([
          {
            $match: {
              user_id: w.user_id,
              status: "completed",
              _id: { $ne: w._id },
            },
          },
          { $group: { _id: null, total: { $sum: "$coin_amount" } } },
        ]);
        const othersSum = othersAgg[0]?.total || 0;
        if (userWallet.total_withdrawn >= othersSum + w.coin_amount) {
          doCredit = false;
        }
      }

      if (doCredit) {
        await creditWithdrawalComplete(w.user_id, w.coin_amount, {
          withdrawal_id: w._id,
          vnd_amount: w.vnd_amount,
          description: `Withdrawal ${w._id} completed: total_withdrawn +${w.coin_amount}`,
        });
      }
      if (!isLegacy) {
        await Revenue.updateMany(
          {
            _id: { $in: w.revenue_ids },
            user_id: w.user_id,
            status: "available",
          },
          { $set: { status: "withdrawn" } }
        );
      }
      w.status = "completed";
      w.processed_by = adminId;
      w.processed_at = new Date();
      w.admin_note = adminNote;
      await w.save();
      return w;
    }
    session.endSession();
    throw err;
  }
  session.endSession();
  return w;
}

/**
 * Admin reject yêu cầu: hoàn coin về available_balance.
 *
 * Idempotent: nếu withdrawal đã có refunded_at thì không hoàn lần 2.
 */
async function rejectWithdrawal(adminId, withdrawalId, adminNote = "") {
  const w = await Withdrawal.findById(withdrawalId);
  if (!w) throw new WithdrawalError("Withdrawal not found", "not_found", 404);

  // Idempotent: nếu đã refund trước đó (refunded_at != null) thì trả về chính
  // record đó mà KHÔNG hoàn lại lần 2. Áp dụng cho cả khi status = rejected
  // (đã refund rồi) hoặc bất kỳ status nào sau refund.
  if (w.refunded_at) {
    return w;
  }

  if (!["pending", "approved"].includes(w.status)) {
    throw new WithdrawalError(
      `Không thể reject yêu cầu ở trạng thái ${w.status}`,
      "invalid_state",
      400
    );
  }

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    try {
      // Hoàn coin về available_balance.
      await refundWithdrawal(w.user_id, w.coin_amount, {
        session,
        withdrawal_id: w._id,
        vnd_amount: w.vnd_amount,
        description: `Hoàn tiền withdrawal #${w._id}`,
      });

      // Cập nhật Withdrawal.
      w.status = "rejected";
      w.processed_by = adminId;
      w.processed_at = new Date();
      w.admin_note = adminNote;
      w.refunded_at = new Date();
      await w.save({ session });

      await session.commitTransaction();
    } catch (err) {
      try { await session.abortTransaction(); } catch (_) {}
      throw err;
    }
  } catch (err) {
    if (err && err.code === "TransactionNumbersNotSupported") {
      session.endSession();
      await refundWithdrawal(w.user_id, w.coin_amount, {
        withdrawal_id: w._id,
        vnd_amount: w.vnd_amount,
        description: `Hoàn tiền withdrawal #${w._id}`,
      });
      w.status = "rejected";
      w.processed_by = adminId;
      w.processed_at = new Date();
      w.admin_note = adminNote;
      w.refunded_at = new Date();
      await w.save();
      return w;
    }
    session.endSession();
    throw err;
  }
  session.endSession();
  return w;
}

module.exports = {
  createWithdrawalRequest,
  approveWithdrawal,
  completeWithdrawal,
  rejectWithdrawal,
  WithdrawalError,
};
