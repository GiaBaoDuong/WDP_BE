// Test với MongoDB trong bộ nhớ — chứng minh bug CŨ và PASS với logic MỚI
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const path = require("path");

// Load .env (PORT không quan trọng, ta chỉ cần MONGODB_URI)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Cooperation = require("../models/Cooperation");

async function run() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const mangakaId = new mongoose.Types.ObjectId();
  const assistantId = new mongoose.Types.ObjectId();
  const otherAssistantId = new mongoose.Types.ObjectId();
  const seriesId = new mongoose.Types.ObjectId();
  const otherSeriesId = new mongoose.Types.ObjectId();

  // Tạo cooperation y hệt DB thật (giả lập dữ liệu user báo)
  await Cooperation.create([
    {
      mangaka_id: mangakaId,
      assistant_id: assistantId,
      agreed_at: new Date("2026-06-01"),
      series_id: null,                  // ← toàn cục
    },
    {
      mangaka_id: mangakaId,
      assistant_id: otherAssistantId,
      agreed_at: new Date("2026-06-02"),
      series_id: seriesId,              // ← gắn với seriesId
    },
  ]);

  console.log("\n── TEST 1: Logic CŨ (status:'accepted') — đoạn code BỊ LỖI ──");
  const oldResult = await Cooperation.findOne({
    mangaka_id: mangakaId,
    assistant_id: assistantId,
    status: "accepted",                // ← field không tồn tại trong schema
  });
  console.log(`  → ${oldResult ? "✅ match" : "❌ NULL → trả 403 cho user"}`);
  const oldFail = !oldResult;

  console.log("\n── TEST 2: Logic MỚI (agreed_at + $or series_id) ──");
  const newResult = await Cooperation.findOne({
    mangaka_id: mangakaId,
    assistant_id: assistantId,
    agreed_at: { $ne: null },
    $or: [
      { series_id: otherSeriesId },     // chapter thuộc series khác
      { series_id: null },              // cooperation toàn cục → match
    ],
  });
  console.log(`  → ${newResult ? "✅ match" : "❌ NULL"}`);
  const newPass = !!newResult;

  console.log("\n── TEST 3: Logic MỚI — cooperation series-specific, cùng series ──");
  const sameSeries = await Cooperation.findOne({
    mangaka_id: mangakaId,
    assistant_id: otherAssistantId,
    agreed_at: { $ne: null },
    $or: [
      { series_id: seriesId },
      { series_id: null },
    ],
  });
  console.log(`  → ${sameSeries ? "✅ match" : "❌ NULL"}`);
  const t3 = !!sameSeries;

  console.log("\n── TEST 4: Logic MỚI — cooperation series-specific, khác series → KHÔNG match ──");
  const wrongSeries = await Cooperation.findOne({
    mangaka_id: mangakaId,
    assistant_id: otherAssistantId,
    agreed_at: { $ne: null },
    $or: [
      { series_id: otherSeriesId },
      { series_id: null },
    ],
  });
  console.log(`  → ${wrongSeries ? "❌ SAI — match nhầm" : "✅ đúng — không match"}`);
  const t4 = !wrongSeries;

  console.log("\n── TEST 5: Cooperation chưa ký (agreed_at=null) → bị reject ──");
  const stranger = new mongoose.Types.ObjectId();
  await Cooperation.create({
    mangaka_id: mangakaId,
    assistant_id: stranger,
    agreed_at: null,
    series_id: null,
  });
  const unsignedResult = await Cooperation.findOne({
    mangaka_id: mangakaId,
    assistant_id: stranger,
    agreed_at: { $ne: null },
    $or: [{ series_id: otherSeriesId }, { series_id: null }],
  });
  console.log(`  → ${unsignedResult ? "❌ SAI" : "✅ đúng — không match (chưa ký)"}`);
  const t5 = !unsignedResult;

  await mongoose.disconnect();
  await mem.stop();

  const allPass = oldFail && newPass && t3 && t4 && t5;
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Kết luận:`);
  console.log(`  Logic CŨ fail (đúng — đây là bug)        : ${oldFail ? "✅" : "❌"}`);
  console.log(`  Logic MỚI pass (toàn cục match mọi series): ${newPass ? "✅" : "❌"}`);
  console.log(`  Logic MỚI pass (cụ thể, cùng series)     : ${t3 ? "✅" : "❌"}`);
  console.log(`  Logic MỚI đúng (cụ thể, khác series)     : ${t4 ? "✅" : "❌"}`);
  console.log(`  Logic MỚI đúng (chưa ký → reject)        : ${t5 ? "✅" : "❌"}`);
  console.log(`${"=".repeat(50)}`);
  process.exit(allPass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
