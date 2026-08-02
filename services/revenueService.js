/**
 * revenueService - Chia doanh thu khi Reader mua chapter trả phí.
 *
 * Nghiệp vụ hiện tại (từ nâng cấp mới):
 *   Tỷ lệ chia doanh thu được xác định TRỰC TIẾP từ `chapter.assistant_id`
 *   chứ không còn lấy từ `Cooperation.revenue_shares`.
 *
 *   Quy tắc:
 *     - Chapter KHÔNG có assistant_id:
 *         Mangaka nhận 100% phần doanh thu sau khi trừ phí nền tảng.
 *     - Chapter CÓ assistant_id (khác Mangaka):
 *         Mangaka 60% / Assistant 40% (chia trên phần net).
 *     - Mangaka = Assistant (chapter tự gán cho mình): fallback 100% cho Mangaka.
 *
 *   Flow:
 *     Reader pays N Coin → mua chapter
 *       → Platform giữ PLATFORM_FEE_PERCENT * N Coin
 *       → Phần còn lại (1 - fee) * N = net → chia theo resolveChapterRevenueShares
 *       → Mỗi share tạo 1 Revenue record (status = pending, available_at = now + pending_hours)
 *       → creditRevenue() cho từng user
 *
 * Lưu ý tương thích ngược:
 *   - `resolveSharesForSeries` (đọc `Cooperation.revenue_shares`) vẫn được export
 *     để các luồng khác (vd: dashboard, admin) còn dùng. Tuy nhiên luồng mua
 *     chapter KHÔNG còn gọi hàm này nữa.
 *   - `cooperation_snapshot` trong Revenue được mở rộng thêm:
 *       source: "CHAPTER_ASSISTANT"  (mới)
 *       assistant_id: <id> | null      (mới)
 *     Giá trị cũ (mangaka_id, shares, platform_fee_percentage) vẫn có để
 *     đảm bảo đọc được các record cũ.
 */
const mongoose = require("mongoose");
const Cooperation = require("../models/Cooperation");
const Revenue = require("../models/Revenue");
const Chapter = require("../models/Chapter");
const config = require("../config/payment");
const { creditRevenue } = require("./walletService");
const { assertCoinUnits, unitsToVnd } = require("../utils/coinUnit");

const PERCENT_BASIS = 10000n;

function percentToBasisPoints(value) {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Percentage must have at most two decimal places");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const basisPoints = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (basisPoints > PERCENT_BASIS) throw new Error("Percentage must be between 0 and 100");
  return basisPoints;
}

function roundPercentageOfUnits(units, percentage) {
  assertCoinUnits(units);
  const numerator = BigInt(units) * percentToBasisPoints(percentage);
  return Number((numerator + PERCENT_BASIS / 2n) / PERCENT_BASIS);
}

function allocateUnits(totalUnits, shares) {
  assertCoinUnits(totalUnits);
  if (!Array.isArray(shares) || shares.length === 0) throw new Error("Revenue shares are required");
  const totalBasisPoints = shares.reduce(
    (sum, share) => sum + percentToBasisPoints(share.percentage),
    0n
  );
  if (totalBasisPoints !== PERCENT_BASIS) throw new Error("Revenue shares must total 100%");
  const allocations = shares.map((share, idx) => {
    const numerator = BigInt(totalUnits) * percentToBasisPoints(share.percentage);
    return {
      share,
      idx,
      floor: Number(numerator / PERCENT_BASIS),
      remainder: numerator % PERCENT_BASIS,
    };
  });
  const ordered = [...allocations].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    const aMangaka = a.share.role === "Mangaka";
    const bMangaka = b.share.role === "Mangaka";
    if (aMangaka !== bMangaka) return aMangaka ? -1 : 1;
    return a.idx - b.idx;
  });
  const leftover = totalUnits - allocations.reduce((sum, item) => sum + item.floor, 0);
  for (let i = 0; i < leftover; i++) ordered[i % ordered.length].floor += 1;
  return allocations;
}

const DEFAULT_SHARES = (mangakaId) => [
  { user_id: mangakaId, role: "Mangaka", percentage: 100 },
];

/**
 * DEPRECATED — chỉ còn được export cho tương thích ngược.
 * Không dùng để tính doanh thu chapter mới.
 *
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
 * Xác định tỷ lệ chia doanh thu cho 1 lần mua chapter, dựa trực tiếp vào
 * `chapter.assistant_id` (KHÔNG phụ thuộc `Cooperation.revenue_shares`).
 *
 * Quy tắc:
 *   - assistantId null/undefined/rỗng:
 *       Mangaka 100%.
 *   - assistantId trùng Mangaka (chapter tự gán cho mình):
 *       Mangaka 100% (fallback an toàn, validation đã chặn ở route).
 *   - Có assistant hợp lệ (khác Mangaka):
 *       Mangaka 60% / Assistant 40%.
 *
 * @param {String|ObjectId|null} mangakaId
 * @param {String|ObjectId|null} assistantId
 * @returns {Array<{user_id, role, percentage}>}
 */
function resolveChapterRevenueShares(mangakaId, assistantId = null) {
  if (!mangakaId) {
    throw new Error("mangakaId is required");
  }

  const aid = assistantId ? String(assistantId) : null;
  const mid = String(mangakaId);

  if (!aid || aid === mid) {
    return [
      {
        user_id: mangakaId,
        role: "Mangaka",
        percentage: 100,
      },
    ];
  }

  return [
    {
      user_id: mangakaId,
      role: "Mangaka",
      percentage: 60,
    },
    {
      user_id: assistantId,
      role: "Assistant",
      percentage: 40,
    },
  ];
}

/**
 * Tính toán và tạo Revenue cho 1 purchase.
 *
 * Lưu ý: tỷ lệ chia lấy từ `assistantId` (chapter.assistant_id),
 * không còn dùng Cooperation.revenue_shares.
 *
 * @param {Object} ctx
 * @param {mongoose.Types.ObjectId} ctx.purchasedChapterId
 * @param {mongoose.Types.ObjectId} ctx.chapterId
 * @param {mongoose.Types.ObjectId} ctx.seriesId
 * @param {mongoose.Types.ObjectId} ctx.mangakaId
 * @param {mongoose.Types.ObjectId|null} [ctx.assistantId]  ID Assistant gắn trên chapter (snapshot)
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
    assistantId = null,
    readerId,
    grossCoinAmount,
  } = ctx;

  if (!Number.isSafeInteger(grossCoinAmount) || grossCoinAmount <= 0) {
    throw new Error("grossCoinAmount phải > 0");
  }

  // Tỷ lệ chia doanh thu xác định từ chapter.assistant_id (không qua Cooperation).
  const shares = resolveChapterRevenueShares(mangakaId, assistantId);

  const platformFeePercent = config.monetization.platformFeePercent;
  // platformFeeCoin & netCoin là số nguyên Coin.
  // Nếu grossCoinAmount * platformFeePercent / 100 bị lẻ → làm tròn platformFeeCoin
  // rồi suy ra netCoin = gross - platformFeeCoin để đảm bảo platform + share = gross.
  const platformFeeCoin = roundPercentageOfUnits(grossCoinAmount, platformFeePercent);
  const netCoinAmount = grossCoinAmount - platformFeeCoin;

  const vndRate = config.monetization.coinToVndRate;

  const pendingHours = config.revenue.pendingHours;
  const availableAt = new Date(
    Date.now() + pendingHours * 60 * 60 * 1000
  );

  // ====================================================================
  // Phân bổ Coin cho từng share bằng largest-remainder method.
  // ====================================================================
  // Mục tiêu: tổng coin_amount trên MỌI record của cùng 1 purchase = netCoin
  // (không được mất Coin do làm tròn xuống nhiều lần).
  //
  // Ví dụ: gross=5, fee=20% → netCoin=4.
  //   Mangaka 60% * 4 = 2.4 → floor=2 (remainder=0.4)
  //   Assistant 40% * 4 = 1.6 → floor=1 (remainder=0.6)
  //   leftover = 4 - (2+1) = 1 → Assistant (remainder lớn hơn) nhận +1 → 2.
  //   Tổng = 2 + 2 = 4 = netCoin ✓
  //
  // Tie-break khi remainder bằng nhau: ưu tiên Mangaka (giữ idx/index hợp lý).
  //
  // QUAN TRỌNG — pointer chứ không copy:
  //   `indexed` chỉ chứa { allocation, idx, isMangaka }, KHÔNG spread
  //   các field của allocation. Mọi `.floor += 1` được thực hiện trên chính
  //   `allocation` gốc trong `allocations` để vòng lặp tạo Revenue đọc đúng.
  // ====================================================================
  const allocations = allocateUnits(netCoinAmount, shares);

  // Phân bổ leftover (nếu có) cho user có remainder lớn nhất.
  // Tie-break: ưu tiên Mangaka, sau đó theo idx gốc.
  const leftover = netCoinAmount - allocations.reduce((sum, a) => sum + a.floor, 0);
  if (leftover > 0) {
    const indexed = allocations.map((allocation, idx) => ({
      allocation,
      idx,
      isMangaka: allocation.share.role === "Mangaka",
    }));
    indexed.sort((a, b) => {
      if (b.allocation.remainder !== a.allocation.remainder) {
        return b.allocation.remainder - a.allocation.remainder;
      }
      // Tie-break: ưu tiên Mangaka (sort ascending → Mangaka đứng trước).
      if (a.isMangaka !== b.isMangaka) {
        return a.isMangaka ? -1 : 1;
      }
      return a.idx - b.idx;
    });
    for (let i = 0; i < leftover; i++) {
      indexed[i % indexed.length].allocation.floor += 1;
    }
  }

  // ====================================================================
  // Phân bổ phí platform theo tỷ lệ (audit per-record).
  // ====================================================================
  // `platform_fee_coin` lưu trên mỗi Revenue record là phần phí TƯƠNG ỨNG
  // với share này (không phải phí gốc của cả purchase). Dùng
  // largest-remainder để đảm bảo:
  //     sum(platform_fee_coin across records) == platformFeeCoin
  // Nếu sau này cần tổng phí platform của 1 purchase, group theo
  // `purchased_chapter_id` rồi sum — KHÔNG cộng tất cả record rồi nhân tỷ lệ.
  // ====================================================================
  const platformAllocations = allocateUnits(platformFeeCoin, shares);
  const platformLeftover =
    platformFeeCoin - platformAllocations.reduce((sum, a) => sum + a.floor, 0);
  if (platformLeftover > 0) {
    const indexed = platformAllocations.map((allocation, idx) => ({
      allocation,
      idx,
      isMangaka: allocation.share.role === "Mangaka",
    }));
    indexed.sort((a, b) => {
      if (b.allocation.remainder !== a.allocation.remainder) {
        return b.allocation.remainder - a.allocation.remainder;
      }
      if (a.isMangaka !== b.isMangaka) {
        return a.isMangaka ? -1 : 1;
      }
      return a.idx - b.idx;
    });
    for (let i = 0; i < platformLeftover; i++) {
      indexed[i % indexed.length].allocation.floor += 1;
    }
  }
  // Map share_user_id → phần phí platform đã phân bổ.
  const platformAllocByUser = new Map(
    platformAllocations.map((a) => [String(a.share.user_id), a.floor])
  );

  // ====================================================================
  // Tạo Revenue record cho từng share.
  // ====================================================================
  // Semantics field (đồng bộ với comment trong models/Revenue.js):
  //   gross_coin_amount   = giá chapter trước phí (giống nhau trên mọi record)
  //   platform_fee_coin   = phần phí platform ứng với share này (≠ nhau)
  //   net_coin_amount     = TỔNG phần còn lại của purchase sau phí
  //                         (giống nhau trên mọi record cùng purchased_chapter_id)
  //   share_percentage    = tỷ lệ user này (vd: 60 / 40 / 100)
  //   coin_amount         = phần user này THỰC NHẬN = floor(net * pct/100) + dư
  //   vnd_amount          = floor(coin_amount * coinToVndRate / COIN_UNIT_SCALE)
  //
  // Lưu ý cho các luồng aggregate (dashboard, thống kê, Revenue Hub):
  //   - Tổng Gross của 1 purchase: SUM(gross_coin_amount) lấy DISTINCT theo
  //     purchased_chapter_id (mỗi purchase chỉ tính 1 lần).
  //   - Tổng Platform Fee của 1 purchase: GROUP BY purchased_chapter_id SUM(...)
  //     hoặc lấy trong 1 bất kỳ record vì gross/net/platform đều giống nhau
  //     trên mọi record cùng purchase.
  //   - Tổng Coin chia cho sáng tác: SUM(coin_amount) — không trùng lặp.
  //   - Tổng Net = Tổng Coin chia + Tổng Platform Fee (per purchase).
  // ====================================================================
  const created = [];

  for (let i = 0; i < allocations.length; i++) {
    const coinAmount = allocations[i].floor;
    if (coinAmount <= 0) continue;

    const share = allocations[i].share;
    const vndAmount = unitsToVnd(coinAmount, vndRate);
    const allocatedPlatformFee =
      platformAllocByUser.get(String(share.user_id)) || 0;

    const revenue = await Revenue.create({
      user_id: share.user_id,
      user_role: share.role,
      series_id: seriesId,
      chapter_id: chapterId,
      purchased_chapter_id: purchasedChapterId,
      reader_id: readerId,
      gross_coin_amount: grossCoinAmount,
      platform_fee_coin: allocatedPlatformFee,
      net_coin_amount: netCoinAmount,
      share_percentage: share.percentage,
      coin_amount: coinAmount,
      vnd_amount: vndAmount,
      status: "pending",
      available_at: availableAt,
      cooperation_snapshot: {
        source: "CHAPTER_ASSISTANT",
        mangaka_id: mangakaId,
        assistant_id: assistantId || null,
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
  allocateUnits,
  roundPercentageOfUnits,
  resolveChapterRevenueShares,
  resolveSharesForSeries,
  createRevenueForPurchase,
};
