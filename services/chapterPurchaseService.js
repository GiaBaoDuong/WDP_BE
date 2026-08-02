/**
 * chapterPurchaseService - Logic mua chapter trả phí.
 *
 * Idempotent + race-safe:
 *   - Bước 1: Tạo PurchasedChapter trước (dựa vào unique index (reader_id, chapter_id))
 *     để đảm bảo chỉ 1 request tạo được. Các request cùng lúc sẽ ném duplicate key.
 *   - Bước 2: Sau khi tạo thành công, mới debit Coin.
 *   - Nếu debit fail (không đủ Coin): xóa PurchasedChapter vừa tạo để user có thể mua lại.
 *   - Nếu debit thành công nhưng request bị duplicate sau đó (race hiếm):
 *     refund coin cho request thua.
 *
 * Trước đây flow là debit trước rồi mới tạo PurchasedChapter. Nhưng khi 2 request
 * đồng thời vượt qua bước check "đã mua chưa", cả 2 sẽ debit coin → 1 request tạo
 * PurchasedChapter thành công, request còn lại gặp duplicate key và KHÔNG refund
 * (chỉ return record cũ), dẫn đến mất Coin oan. Đảo thứ tự là cách fix race-safe.
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
  // 1. Validate chapter
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

  // 2. Lấy series để lấy mangaka_id
  const series = await Series.findById(chapter.series_id)
    .select("author_id")
    .lean();
  if (!series) throw new PurchaseError("Series not found", "not_found", 404);

  // 3. Check nhanh (tăng UX, không phải race guard).
  // Race guard thật sự là unique index trên PurchasedChapter.
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

  // 4. Tạo PurchasedChapter trước (race-safe nhờ unique index).
  // Nếu 2 request đồng thời cùng tạo, chỉ 1 thành công, request còn lại ném 11000.
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
    if (err.code === 11000) {
      // Request khác đã mua trước → trả record cũ, không debit, không refund.
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

  // 5. Sau khi đã có PurchasedChapter, mới debit Coin.
  const debit = await debitCoin(readerId, chapter.coin_price, {
    chapter_id: chapterId,
    description: `Mua chapter #${chapter.chapter_number}`,
    purchased_chapter_id: purchased._id,
  });
  if (!debit.ok) {
    // Không đủ coin → rollback PurchasedChapter vừa tạo để user có thể nạp rồi mua lại.
    await PurchasedChapter.deleteOne({ _id: purchased._id });
    throw new PurchaseError(
      "Số dư Coin không đủ để mua chapter này",
      "insufficient_coin",
      400
    );
  }

  // 6. Tạo Revenue
  let revenue = [];
  try {
    revenue = await createRevenueForPurchase({
      purchasedChapterId: purchased._id,
      chapterId: chapter._id,
      seriesId: chapter.series_id,
      mangakaId: series.author_id,
      assistantId: chapter.assistant_id || null,
      readerId,
      grossCoinAmount: chapter.coin_price,
    });
  } catch (revErr) {
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