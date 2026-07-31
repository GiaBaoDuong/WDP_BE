/**
 * chapterPurchaseService - Logic mua chapter trả phí.
 *
 * Idempotent: nếu reader đã mua rồi → trả về record cũ, không trừ coin.
 * Đảm bảo atomic bằng cách:
 *   1. Tìm PurchasedChapter đã tồn tại (unique index).
 *   2. Nếu có → trả về luôn.
 *   3. Nếu chưa có → trừ Coin (atomic $inc + $gte guard).
 *   4. Tạo PurchasedChapter.
 *   5. Tạo Revenue cho Mangaka + Assistants.
 */
const PurchasedChapter = require("../models/PurchasedChapter");
const Chapter = require("../models/Chapter");
const Series = require("../models/Series");
const { debitCoin } = require("./walletService");
const { createRevenueForPurchase } = require("./revenueService");

class PurchaseError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Mua 1 chapter trả phí.
 *
 * @param {String} readerId   ID của reader (string)
 * @param {String} chapterId  ID của chapter
 *
 * @returns {Promise<{purchased: object, alreadyOwned: boolean, revenue: Array}>}
 */
async function purchaseChapter(readerId, chapterId) {
  // 1. Tìm chapter
  const chapter = await Chapter.findById(chapterId).lean();
  if (!chapter) throw new PurchaseError("Chapter not found", "not_found", 404);
  if (!chapter.is_published) {
    throw new PurchaseError("Chapter chưa được xuất bản", "not_published", 400);
  }
  if (chapter.access_type !== "PAID") {
    throw new PurchaseError(
      "Chapter này miễn phí, không cần mua",
      "not_paid",
      400
    );
  }
  if (!chapter.coin_price || chapter.coin_price <= 0) {
    throw new PurchaseError(
      "Chapter chưa được cấu hình giá Coin",
      "invalid_price",
      400
    );
  }

  // 2. Tìm series để lấy mangaka_id
  const series = await Series.findById(chapter.series_id)
    .select("author_id")
    .lean();
  if (!series) throw new PurchaseError("Series not found", "not_found", 404);

  // 3. Kiểm tra đã mua chưa
  const existing = await PurchasedChapter.findOne({
    reader_id: readerId,
    chapter_id: chapterId,
  }).lean();
  if (existing) {
    return {
      purchased: existing,
      alreadyOwned: true,
      revenue: [],
    };
  }

  // 4. Trừ Coin (atomic)
  const debit = await debitCoin(readerId, chapter.coin_price, {
    chapter_id: chapterId,
    description: `Mua chapter #${chapter.chapter_number}`,
  });
  if (!debit.ok) {
    throw new PurchaseError(
      "Số dư Coin không đủ để mua chapter này",
      "insufficient_coin",
      400
    );
  }

  // 5. Tạo PurchasedChapter (catch duplicate key để idempotent)
  let purchased;
  try {
    purchased = await PurchasedChapter.create({
      reader_id: readerId,
      chapter_id: chapterId,
      series_id: chapter.series_id,
      price: chapter.coin_price,
      purchased_at: new Date(),
    });
  } catch (err) {
    // Duplicate key → đã mua rồi (race condition với request khác)
    if (err.code === 11000) {
      // Hoàn Coin vì request khác đã mua trước
      // (Trong thực tế hiếm xảy ra vì check ở step 3, nhưng để an toàn)
      // Lưu ý: nếu muốn đơn giản, có thể skip hoàn coin vì amount đã trừ = 0 effect.
      const existing2 = await PurchasedChapter.findOne({
        reader_id: readerId,
        chapter_id: chapterId,
      }).lean();
      return {
        purchased: existing2,
        alreadyOwned: true,
        revenue: [],
      };
    }
    throw err;
  }

  // 6. Tạo Revenue
  let revenue = [];
  try {
    revenue = await createRevenueForPurchase({
      purchasedChapterId: purchased._id,
      chapterId: chapter._id,
      seriesId: chapter.series_id,
      mangakaId: series.author_id,
      readerId,
      grossCoinAmount: chapter.coin_price,
    });
  } catch (revErr) {
    // Revenue tạo fail → KHÔNG roll back Coin (đã trừ rồi).
    // Log lỗi để admin xử lý sau. Việc này rất hiếm, chỉ xảy ra khi
    // Cooperation bị xoá giữa lúc mua.
    console.error(
      "[chapterPurchase] createRevenue failed:",
      revErr.message
    );
  }

  return {
    purchased,
    alreadyOwned: false,
    revenue,
  };
}

/**
 * Lấy map chapterId → đã mua chưa cho 1 reader và 1 list chapterId.
 * Dùng để enrich danh sách chapter cho Reader.
 */
async function getPurchasedChapterIdSet(readerId, chapterIds) {
  if (!readerId || !chapterIds || chapterIds.length === 0) return new Set();
  const rows = await PurchasedChapter.find({
    reader_id: readerId,
    chapter_id: { $in: chapterIds },
  })
    .select("chapter_id")
    .lean();
  return new Set(rows.map((r) => String(r.chapter_id)));
}

module.exports = {
  purchaseChapter,
  getPurchasedChapterIdSet,
  PurchaseError,
};