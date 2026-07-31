/**
 * revenueService - Chia doanh thu khi Reader mua chapter trả phí.
 *
 * Flow:
 *   Reader pays N Coin → mua chapter
 *     → Platform giữ PLATFORM_FEE_PERCENT * N Coin
 *     → Phần còn lại (1 - fee) * N = net → chia theo Cooperation.revenue_shares
 *     → Mỗi share tạo 1 Revenue record (status = pending, available_at = now + pending_hours)
 *     → creditRevenue() cho từng user
 *
 * Nếu không tìm thấy Cooperation cho chapter.series_id → mặc định 100% cho Mangaka.
 *
 * Tổng `revenue_shares` luôn phải bằng 100 (validator bên ngoài). Nếu vi phạm,
 * hàm sẽ throw error.
 */
const mongoose = require("mongoose");
const Cooperation = require("../models/Cooperation");
const Revenue = require("../models/Revenue");
const Chapter = require("../models/Chapter");
const config = require("../config/payment");
const { creditRevenue } = require("./walletService");

const DEFAULT_SHARES = (mangakaId) => [
  { user_id: mangakaId, role: "Mangaka", percentage: 100 },
];

/**
 * Lấy tỷ lệ chia cho 1 series từ các Cooperation (accepted) của series đó.
 *
 * Quy tắc:
 *  - Tổng hợp tất cả Cooperation có series_id = seriesId (hoặc null) đã agreed_at.
 *  - Mỗi cooperation có revenue_shares. Nếu có nhiều cooperation cho cùng 1 user
 *    (vd: 1 cooperation cho series X, 1 cooperation chung) → lấy của series X trước.
 *  - Mangaka luôn phải có 1 entry với 100% nếu không có assistant.
 *  - Nếu tổng percentage != 100 → throw error.
 *
 * Trả về mảng [{ user_id, role, percentage }].
 */
async function resolveSharesForSeries(seriesId, mangakaId) {
  const coops = await Cooperation.find({
    $or: [{ series_id: seriesId }, { series_id: null }],
    agreed_at: { $ne: null },
  })
    .populate("assistant_id", "_id role")
    .lean();

  // Gom các share theo user. Ưu tiên cooperation có series_id khớp seriesId,
  // sau đó mới fallback cooperation chung (series_id = null).
  const byUser = new Map();

  const applyCoop = (coop) => {
    if (Array.isArray(coop.revenue_shares) && coop.revenue_shares.length > 0) {
      for (const s of coop.revenue_shares) {
        const uid = String(s.user_id);
        // Chỉ áp dụng nếu chưa có share cho user này
        if (!byUser.has(uid)) {
          byUser.set(uid, {
            user_id: s.user_id,
            role: s.role,
            percentage: s.percentage,
          });
        }
      }
    }
  };

  // Ưu tiên match theo series_id
  for (const c of coops) {
    if (String(c.series_id || "") === String(seriesId)) applyCoop(c);
  }
  // Sau đó mới fallback cooperation chung
  for (const c of coops) {
    if (!c.series_id) applyCoop(c);
  }

  // Đảm bảo Mangaka luôn có share
  if (!byUser.has(String(mangakaId))) {
    byUser.set(String(mangakaId), {
      user_id: mangakaId,
      role: "Mangaka",
      percentage: 0, // sẽ được cộng thêm phần dư bên dưới
    });
  }

  let shares = Array.from(byUser.values());

  // Chuẩn hoá: tổng = 100. Nếu tổng < 100 → phần dư cộng vào Mangaka.
  // Nếu tổng > 100 → throw error (config sai).
  const total = shares.reduce((sum, s) => sum + (Number(s.percentage) || 0), 0);
  if (total > 100.0001) {
    throw new Error(
      `Tổng tỷ lệ chia doanh thu phải bằng 100% (hiện ${total}%). Vui lòng kiểm tra Cooperation.`
    );
  }
  if (total < 100) {
    // Cộng phần dư vào Mangaka
    const mangakaEntry = shares.find((s) => String(s.user_id) === String(mangakaId));
    if (mangakaEntry) {
      mangakaEntry.percentage = Number(mangakaEntry.percentage || 0) + (100 - total);
    } else {
      shares.push({
        user_id: mangakaId,
        role: "Mangaka",
        percentage: 100 - total,
      });
    }
  }

  // Tròn 2 chữ số thập phân
  shares = shares.map((s) => ({
    ...s,
    percentage: Math.round(Number(s.percentage) * 100) / 100,
  }));

  return shares;
}

/**
 * Tính toán và tạo Revenue cho 1 purchase.
 *
 * @param {Object} ctx
 * @param {mongoose.Types.ObjectId} ctx.purchasedChapterId
 * @param {mongoose.Types.ObjectId} ctx.chapterId
 * @param {mongoose.Types.ObjectId} ctx.seriesId
 * @param {mongoose.Types.ObjectId} ctx.mangakaId
 * @param {mongoose.Types.ObjectId} ctx.readerId
 * @param {number} ctx.grossCoinAmount  Số Coin chapter (giá bán)
 *
 * @returns {Promise<Array>} Mảng các Revenue đã tạo
 */
async function createRevenueForPurchase(ctx) {
  const {
    purchasedChapterId,
    chapterId,
    seriesId,
    mangakaId,
    readerId,
    grossCoinAmount,
  } = ctx;

  if (!grossCoinAmount || grossCoinAmount <= 0) {
    throw new Error("grossCoinAmount phải > 0");
  }

  const shares = await resolveSharesForSeries(seriesId, mangakaId);

  const platformFeePercent = config.monetization.platformFeePercent;
  const platformFeeCoin = Math.round((grossCoinAmount * platformFeePercent) / 100);
  const netCoinAmount = grossCoinAmount - platformFeeCoin;

  const vndRate = config.monetization.coinToVndRate;

  const pendingHours = config.revenue.pendingHours;
  const availableAt = new Date(
    Date.now() + pendingHours * 60 * 60 * 1000
  );

  const created = [];

  for (const share of shares) {
    // Tính số Coin user này nhận = netCoinAmount * share.percentage / 100
    const coinAmount = Math.round(
      (netCoinAmount * share.percentage) / 100
    );
    if (coinAmount <= 0) continue;

    const vndAmount = coinAmount * vndRate;

    const revenue = await Revenue.create({
      user_id: share.user_id,
      user_role: share.role,
      series_id: seriesId,
      chapter_id: chapterId,
      purchased_chapter_id: purchasedChapterId,
      reader_id: readerId,
      gross_coin_amount: grossCoinAmount,
      platform_fee_coin: Math.round(
        (grossCoinAmount * platformFeePercent * share.percentage) / 10000
      ),
      net_coin_amount: Math.round(
        (netCoinAmount * share.percentage) / 100
      ),
      share_percentage: share.percentage,
      coin_amount: coinAmount,
      vnd_amount: vndAmount,
      status: "pending",
      available_at: availableAt,
      cooperation_snapshot: {
        mangaka_id: mangakaId,
        shares,
        platform_fee_percentage: platformFeePercent,
      },
    });

    // Cộng vào pending_balance của wallet user
    await creditRevenue(share.user_id, coinAmount, {
      vnd_amount: vndAmount,
      description: `Doanh thu từ chapter (${share.percentage}%)`,
      chapter_id: chapterId,
      revenue_id: revenue._id,
    });

    created.push(revenue);
  }

  return created;
}

module.exports = {
  resolveSharesForSeries,
  createRevenueForPurchase,
};