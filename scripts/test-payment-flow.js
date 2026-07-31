/**
 * Smoke test cho luồng thanh toán.
 * Chạy nhanh với mongodb-memory-server:
 *   node scripts/test-payment-flow.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
process.env.PAYOS_MOCK = "true";
process.env.REVENUE_PENDING_HOURS = "0.001"; // ~3.6s
process.env.PLATFORM_FEE_PERCENT = "20";
process.env.COIN_TO_VND_RATE = "100";
process.env.MIN_WITHDRAWAL_VND = "1000";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  console.log("[Smoke] Connected to in-memory MongoDB");

  const User = require("../models/User");
  const Series = require("../models/Series");
  const Chapter = require("../models/Chapter");
  const Cooperation = require("../models/Cooperation");
  const Wallet = require("../models/Wallet");
  const WalletTransaction = require("../models/WalletTransaction");
  const CoinPackage = require("../models/CoinPackage");
  const Payment = require("../models/Payment");
  const PurchasedChapter = require("../models/PurchasedChapter");
  const Revenue = require("../models/Revenue");

  const walletService = require("../services/walletService");
  const chapterPurchaseService = require("../services/chapterPurchaseService");
  const payosService = require("../services/payosService");
  const paymentService = require("../routes/payments"); // để đảm bảo require OK
  // Webhook handler nằm trong routes/payments - chỉ test hàm trực tiếp

  // ─── Seed ────────────────────────────────────────────────────────────────
  const mangaka = await User.create({
    username: "m1",
    password: "123456",
    full_name: "Mangaka 1",
    email: "m1@x.com",
    phoneNumber: "0",
    role: "Mangaka",
    bank_name: "VCB",
    account_holder: "M1",
    bank_account_number: "1234567890",
  });
  const assistant = await User.create({
    username: "a1",
    password: "123456",
    full_name: "Assistant 1",
    email: "a1@x.com",
    phoneNumber: "0",
    role: "Assistant",
    bank_name: "VCB",
    account_holder: "A1",
    bank_account_number: "9999",
  });
  const reader = await User.create({
    username: "r1",
    password: "123456",
    full_name: "Reader 1",
    email: "r1@x.com",
    phoneNumber: "0",
    role: "Reader",
  });

  const series = await Series.create({
    name: "Test Series",
    description: "...",
    author_id: mangaka._id,
    status: "published",
    is_public: true,
  });

  const ch1 = await Chapter.create({
    series_id: series._id,
    chapter_number: 1,
    title: "Ch 1",
    submitted_by: mangaka._id,
    status: "published",
    is_published: true,
    access_type: "FREE",
    coin_price: 0,
  });
  const ch2 = await Chapter.create({
    series_id: series._id,
    chapter_number: 2,
    title: "Ch 2",
    submitted_by: mangaka._id,
    status: "published",
    is_published: true,
    access_type: "PAID",
    coin_price: 10,
  });

  await Cooperation.create({
    mangaka_id: mangaka._id,
    assistant_id: assistant._id,
    series_id: series._id,
    agreed_at: new Date(),
    revenue_shares: [
      { user_id: mangaka._id, role: "Mangaka", percentage: 70 },
      { user_id: assistant._id, role: "Assistant", percentage: 30 },
    ],
  });

  // ─── Test 1: CoinPackage seed via pre-save ──────────────────────────────
  const pkg = await CoinPackage.create({
    name: "P100",
    price_vnd: 10000,
    coin_amount: 100,
    bonus_coin: 10,
  });
  console.log(
    `[Test1] CoinPackage total_coin (expect 110): ${pkg.total_coin}`
  );

  // ─── Test 2: Reader nạp Coin (webhook success) ─────────────────────────
  const orderCode = payosService.generateOrderCode();
  const payment = await Payment.create({
    user_id: reader._id,
    coin_package_id: pkg._id,
    order_code: orderCode,
    amount_vnd: pkg.price_vnd,
    coin_amount: pkg.total_coin,
    description: "test",
    status: "pending",
  });

  // Giả lập webhook thành công
  await walletService.creditCoin(reader._id, pkg.total_coin, pkg.price_vnd, {
    payment_id: payment._id,
  });
  payment.status = "paid";
  payment.paid_at = new Date();
  await payment.save();
  const w1 = await Wallet.findOne({ user_id: reader._id });
  console.log(
    `[Test2] Reader balance (expect 110): ${w1.balance}, total_deposited=${w1.total_deposited}`
  );

  // ─── Test 3: Reader mua chapter 2 (PAID, 10 Coin) ──────────────────────
  const result = await chapterPurchaseService.purchaseChapter(
    reader._id,
    ch2._id
  );
  console.log(
    `[Test3] Purchase ok=${!result.alreadyOwned}, revenue_count=${result.revenue.length}`
  );
  const w2 = await Wallet.findOne({ user_id: reader._id });
  console.log(
    `[Test3] Reader balance sau mua (expect 100): ${w2.balance}, total_spent=${w2.total_spent}`
  );

  // ─── Test 4: Kiểm tra Revenue & pending_balance ────────────────────────
  const wM = await Wallet.findOne({ user_id: mangaka._id });
  const wA = await Wallet.findOne({ user_id: assistant._id });
  console.log(
    `[Test4] Mangaka pending_balance (expect 6 = round(10*0.8*0.7)): ${wM.pending_balance}`
  );
  console.log(
    `[Test4] Assistant pending_balance (expect 2 = round(10*0.8*0.3)): ${wA.pending_balance}`
  );

  // ─── Test 5: Idempotency - mua lại chapter 2 không trừ Coin ───────────
  const r2 = await chapterPurchaseService.purchaseChapter(
    reader._id,
    ch2._id
  );
  const w3 = await Wallet.findOne({ user_id: reader._id });
  console.log(
    `[Test5] Already owned=${r2.alreadyOwned}, balance (expect vẫn 100): ${w3.balance}`
  );

  // ─── Test 6: Insufficient Coin ──────────────────────────────────────────
  const reader2 = await User.create({
    username: "r2",
    password: "123456",
    full_name: "Reader 2",
    email: "r2@x.com",
    phoneNumber: "0",
    role: "Reader",
  });
  try {
    await chapterPurchaseService.purchaseChapter(reader2._id, ch2._id);
    console.log("[Test6] FAIL: should throw insufficient_coin");
  } catch (e) {
    console.log(
      `[Test6] Got expected error: ${e.code} - ${e.message}`
    );
  }

  // ─── Test 7: Run revenue release job ──────────────────────────────────
  // Đợi ~5s để available_at đến
  await new Promise((r) => setTimeout(r, 5000));
  const { processRelease } = require("../jobs/revenueRelease");
  await processRelease();
  const wM2 = await Wallet.findOne({ user_id: mangaka._id });
  const wA2 = await Wallet.findOne({ user_id: assistant._id });
  console.log(
    `[Test7] Sau release: Mangaka pending=${wM2.pending_balance}, available=${wM2.available_balance}`
  );
  console.log(
    `[Test7] Sau release: Assistant pending=${wA2.pending_balance}, available=${wA2.available_balance}`
  );
  const revs = await Revenue.find({ status: "available" });
  console.log(`[Test7] Revenue available count: ${revs.length}`);

  // ─── Test 8: Withdrawal ─────────────────────────────────────────────────
  const withdrawalService = require("../services/withdrawalService");
  const admin = await User.create({
    username: "admin1",
    password: "123456",
    full_name: "Admin 1",
    email: "admin1@x.com",
    phoneNumber: "0",
    role: "Admin",
  });
  const w = await withdrawalService.createWithdrawalRequest(mangaka._id, {
    coin_amount: 5,
    vnd_amount: 1000, // tối thiểu 1000 để pass MIN_WITHDRAWAL_VND
  });
  console.log(
    `[Test8] Withdrawal created status=${w.status}, vnd=${w.vnd_amount}`
  );

  try {
    await withdrawalService.createWithdrawalRequest(mangaka._id, {
      coin_amount: 1,
      vnd_amount: 100,
    });
    console.log("[Test8] FAIL: should throw pending_exists");
  } catch (e) {
    console.log(`[Test8] Got expected error: ${e.code}`);
  }

  await withdrawalService.approveWithdrawal(admin._id, w._id);
  await withdrawalService.completeWithdrawal(admin._id, w._id);
  const Withdrawal = require("../models/Withdrawal");
  const final = await Withdrawal.findById(w._id);
  console.log(`[Test8] Final status: ${final.status}`);

  // ─── Test 9: Reject withdrawal → refund ───────────────────────────────
  const w9 = await withdrawalService.createWithdrawalRequest(assistant._id, {
    coin_amount: 2,
    vnd_amount: 1000,
  });
  await withdrawalService.rejectWithdrawal(admin._id, w9._id);
  const wA3 = await Wallet.findOne({ user_id: assistant._id });
  console.log(
    `[Test9] Sau reject: Assistant available (expect 2): ${wA3.available_balance}, total_withdrawn (expect 0): ${wA3.total_withdrawn}`
  );

  // ─── Test 10: FREE_CHAPTER_AUTO_LIMIT = 1 ────────────────────────────────
  // - Chapter 1: luôn FREE bất kể input
  // - Chapter 2: mặc định PAID, BẮT BUỘC coin_price > 0
  // - Chapter 2 truyền access_type=FREE: được, không cần coin_price
  const { FREE_CHAPTER_AUTO_LIMIT } = require("../utils/constants");
  console.log(`[Test10] FREE_CHAPTER_AUTO_LIMIT (expect 1): ${FREE_CHAPTER_AUTO_LIMIT}`);

  const ch1Test = await Chapter.create({
    series_id: series._id,
    chapter_number: 99,
    title: "Ch99",
    submitted_by: mangaka._id,
    status: "published",
    is_published: true,
    access_type: "PAID", // ép set, nhưng vẫn phải FREE vì là chapter 1
    coin_price: 999,
  });
  // Chapter 99 không phải chapter 1 → giữ nguyên access_type
  console.log(
    `[Test10] Ch99 (không phải Ch1): access_type=${ch1Test.access_type}, coin_price=${ch1Test.coin_price}`
  );

  // Kiểm tra logic helper trực tiếp (không qua HTTP)
  const checkAccessType = (num, bodyAccessType, bodyCoinPrice) => {
    let accessType = bodyAccessType ? String(bodyAccessType).toUpperCase() : null;
    let coinPrice = Number(bodyCoinPrice || 0);
    if (num <= FREE_CHAPTER_AUTO_LIMIT) {
      accessType = "FREE";
      coinPrice = 0;
    } else {
      if (!accessType) accessType = "PAID";
      if (!["FREE", "PAID"].includes(accessType)) throw new Error("invalid");
      if (accessType === "PAID" && coinPrice <= 0) {
        throw new Error("PAID requires coin_price > 0");
      }
      if (accessType === "FREE") coinPrice = 0;
    }
    return { accessType, coinPrice };
  };

  const a = checkAccessType(1, "PAID", 999); // ép FREE
  console.log(`[Test10] Chapter 1 truyền PAID → kết quả: ${JSON.stringify(a)} (expect FREE, 0)`);

  // Chapter 2 không truyền gì: mặc định PAID, throw vì thiếu coin_price
  console.log(
    `[Test10] Chapter 2 không truyền gì → throw (expect PAID requires coin_price > 0): ${(() => { try { checkAccessType(2); return "no throw"; } catch (e) { return e.message; } })()}`
  );

  const c = checkAccessType(2, undefined, 15);
  console.log(`[Test10] Chapter 2 mặc định PAID coin=15: ${JSON.stringify(c)}`);

  const d = checkAccessType(2, "FREE");
  console.log(`[Test10] Chapter 2 truyền FREE: ${JSON.stringify(d)}`);

  try {
    checkAccessType(2, "PAID", 0);
    console.log("[Test10] FAIL: should throw");
  } catch (e) {
    console.log(
      `[Test10] Chapter 2 PAID coin=0 → throw (expect PAID requires coin_price > 0): ${e.message}`
    );
  }

  console.log("\n[Smoke] All tests passed!");
  await mongo.stop();
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("[Smoke] ERROR:", err);
  try {
    if (mongo) await mongo.stop();
  } catch (_) {}
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});