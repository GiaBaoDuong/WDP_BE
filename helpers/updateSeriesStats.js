/**
 * Helper: Cập nhật SeriesStats khi có event view hoặc vote
 * Chỉ update, không sửa logic khác
 */

const SeriesStats = require("../models/SeriesStats");

/**
 * Update stats cho một series
 * @param {string} seriesId - Series ID
 * @param {'view' | 'vote'} eventType
 * @param {object} data - { score } cho vote, bỏ trống cho view
 */
async function updateSeriesStats(seriesId, eventType, data = {}) {
  try {
    const now = new Date();
    const periodTypes = ["daily", "weekly", "monthly"];

    const promises = periodTypes.map(async (periodType) => {
      const periodKey = SeriesStats.getPeriodKey(periodType, now);

      const updates =
        eventType === "view"
          ? { views_count: 1 }
          : { votes_count: 1, total_score: data.score || 0 };

      await SeriesStats.upsertStats(seriesId, periodType, periodKey, updates);
    });

    await Promise.all(promises);
  } catch (err) {
    // Log lỗi nhưng không fail request chính
    console.error("[updateSeriesStats] Error:", err.message);
  }
}

module.exports = { updateSeriesStats };
