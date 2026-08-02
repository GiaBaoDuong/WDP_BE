/**
 * Revenue Release Job
 * Revenue and wallet amounts are integer CoinUnit values; no Coin rounding occurs here.
 *
 * Chạy mỗi 1 phút: tìm các Revenue đã đến `available_at` mà vẫn ở status "pending"
 * → chuyển sang "available" + cộng tiền vào available_balance của wallet.
 *
 * Idempotent: chỉ xử lý các record status = "pending" và available_at <= now.
 * Sau khi xử lý, set available_at_processed_at để trace.
 *
 * Cấu hình thời gian pending nằm ở biến môi trường REVENUE_PENDING_HOURS (xem config/payment).
 * Mặc định 24h. Khi dev có thể đặt 0.003 (~10 giây) để test.
 *
 * Start: startRevenueReleaseJob() trong bin/www
 * Stop:  stopRevenueReleaseJob() khi server shutdown
 */
const Revenue = require("../models/Revenue");
const { releasePendingRevenue } = require("../services/walletService");

const INTERVAL_MS = 60 * 1000; // mỗi 1 phút
const BATCH_SIZE = 100; // xử lý tối đa 100 record / lượt

let intervalHandle = null;
let isRunning = false;

function startRevenueReleaseJob() {
  if (intervalHandle) return;
  console.log(`[RevenueRelease] Job started (every ${INTERVAL_MS / 1000}s)`);
  intervalHandle = setInterval(processRelease, INTERVAL_MS);
  // Chạy ngay lần đầu
  processRelease().catch((err) =>
    console.error("[RevenueRelease] initial run error:", err.message)
  );
}

function stopRevenueReleaseJob() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[RevenueRelease] Job stopped");
  }
}

async function processRelease() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    const due = await Revenue.find({
      status: "pending",
      available_at: { $lte: now },
    })
      .limit(BATCH_SIZE)
      .lean();

    if (!due || due.length === 0) return;

    console.log(`[RevenueRelease] Processing ${due.length} due revenue(s)`);

    let releasedCount = 0;
    for (const rev of due) {
      try {
        // Chuyển tiền từ pending → available
        const res = await releasePendingRevenue(rev.user_id, rev.coin_amount, {
          vnd_amount: rev.vnd_amount,
          description: `Revenue released from chapter #${rev.chapter_id}`,
          revenue_id: rev._id,
        });
        if (res.ok) {
          await Revenue.updateOne(
            { _id: rev._id, status: "pending" },
            {
              $set: {
                status: "available",
                available_at_processed_at: new Date(),
              },
            }
          );
          releasedCount += 1;
        } else {
          console.warn(
            `[RevenueRelease] Skip revenue ${rev._id}: ${res.reason}`
          );
        }
      } catch (err) {
        console.error(
          `[RevenueRelease] Failed revenue ${rev._id}:`,
          err.message
        );
      }
    }

    if (releasedCount > 0) {
      console.log(`[RevenueRelease] Released ${releasedCount} revenue(s)`);
    }
  } catch (err) {
    console.error("[RevenueRelease] Job error:", err.message);
  } finally {
    isRunning = false;
  }
}

module.exports = { startRevenueReleaseJob, stopRevenueReleaseJob, processRelease };
