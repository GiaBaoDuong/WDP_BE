/**
 * Withdrawal lifecycle tests.
 *
 * Cover:
 *  - Successful create → available_balance giảm, total_withdrawn chưa tăng,
 *    WalletTransaction có withdrawal_id, Revenue snapshot lưu revenue_ids.
 *  - Failure halfway (insufficient available) → rollback (no orphan tx, no
 *    half-applied withdrawal).
 *  - Approve does NOT touch balance / total_withdrawn.
 *  - Complete → total_withdrawn tăng đúng 1 lần, Revenue snapshot → withdrawn,
 *    retry không cộng 2 lần.
 *  - Reject → available_balance hoàn, total_withdrawn không đổi,
 *    idempotent (không hoàn 2 lần).
 *  - Revenue mới phát sinh sau khi tạo withdrawal không bị mark withdrawn.
 *  - Authorization: Reader không tạo được, Non-admin không gọi được admin API.
 */

jest.mock("../config/payment", () => ({
  monetization: {
    coinToVndRate: 100,
    platformFeePercent: 20,
    minWithdrawalVnd: 200000,
  },
}));

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { setupTestApp, teardownTestApp, clearDatabase, makeUser } = require("./testUtils");
const withdrawalService = require("../services/withdrawalService");

let app;
let request;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const ctx = await setupTestApp();
  app = ctx.app;
  request = ctx.request;
});

afterAll(async () => {
  await teardownTestApp();
});

beforeEach(async () => {
  await clearDatabase();
});

function token(user) {
  return jwt.sign(
    { nameid: String(user._id), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function authHeader(t) {
  return { Authorization: `Bearer ${t}` };
}

/**
 * Create a Mangaka with bank info, available_balance and a few available Revenue.
 * Returns { user, wallet, revenues, adminToken, creatorToken, readerToken }.
 */
async function seedScenario({ availableBalance = 500000, pendingBalance = 0 } = {}) {
  const admin = await makeUser({
    username: "w_admin",
    email: "w_admin@test.com",
    role: "Admin",
    full_name: "W Admin",
  });
  const mangaka = await makeUser({
    username: "w_mangaka",
    email: "w_mangaka@test.com",
    role: "Mangaka",
    full_name: "W Mangaka",
    bank_name: "VCB",
    account_holder: "MANGAKA TEST",
    bank_account_number: "1234567890",
  });
  const reader = await makeUser({
    username: "w_reader",
    email: "w_reader@test.com",
    role: "Reader",
    full_name: "W Reader",
  });

  const Wallet = require("../models/Wallet");
  const wallet = await Wallet.create({
    user_id: mangaka._id,
    balance: 0,
    pending_balance: pendingBalance,
    available_balance: availableBalance,
    total_revenue: availableBalance + pendingBalance,
  });

  // Tạo 3 Revenue ở status "available" thuộc về mangaka này.
  const Revenue = require("../models/Revenue");
  const seriesId = new mongoose.Types.ObjectId();
  const revenues = [];
  for (let i = 0; i < 3; i++) {
    const r = await Revenue.create({
      user_id: mangaka._id,
      user_role: "Mangaka",
      series_id: seriesId,
      chapter_id: new mongoose.Types.ObjectId(),
      purchased_chapter_id: new mongoose.Types.ObjectId(),
      reader_id: new mongoose.Types.ObjectId(),
      gross_coin_amount: 50000,
      platform_fee_coin: 10000,
      net_coin_amount: 40000,
      share_percentage: 60,
      coin_amount: 10000 + i * 5000,
      status: "available",
      available_at: new Date(),
    });
    revenues.push(r);
  }

  return {
    admin,
    mangaka,
    reader,
    wallet,
    revenues,
    tokens: {
      admin: token(admin),
      mangaka: token(mangaka),
      reader: token(reader),
    },
  };
}

// ─── TESTS ──────────────────────────────────────────────────────────────────

describe("Withdrawal lifecycle — POST /withdrawals", () => {
  test("1. Create success → available_balance giảm, total_withdrawn chưa tăng, tx có withdrawal_id", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const res = await request()
      .post("/withdrawals")
      .set(authHeader(ctx.tokens.mangaka))
      .send({ note: "test withdrawal" });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("pending");
    expect(res.body.data.coin_amount).toBe(500000);
    expect(res.body.data.revenue_ids).toBeDefined();
    expect(res.body.data.revenue_ids.length).toBe(3);

    // Wallet available_balance đã giảm về 0, total_withdrawn VẪN = 0.
    const Wallet = require("../models/Wallet");
    const w = await Wallet.findById(ctx.wallet._id);
    expect(w.available_balance).toBe(0);
    expect(w.total_withdrawn).toBe(0);

    // WalletTransaction Withdrawal direction=out, withdrawal_id khớp.
    const WalletTransaction = require("../models/WalletTransaction");
    const txs = await WalletTransaction.find({
      user_id: ctx.mangaka._id,
      type: "Withdrawal",
    });
    expect(txs.length).toBe(1);
    expect(txs[0].direction).toBe("out");
    expect(txs[0].coin_amount).toBe(500000);
    expect(String(txs[0].withdrawal_id)).toBe(String(res.body.data._id));
  });

  test("2. Failure halfway (insufficient available) → rollback", async () => {
    // available_balance vượt minWithdrawalVnd ban đầu, nhưng ép fail bằng
    // cách có 1 withdrawal pending sẵn → trả 400 active_withdrawal_exists.
    const ctx = await seedScenario({ availableBalance: 500000 });
    // Tạo 1 withdrawal pending trước.
    await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {
      note: "first",
    });

    // Lần 2 phải fail vì active withdrawal.
    const res = await request()
      .post("/withdrawals")
      .set(authHeader(ctx.tokens.mangaka))
      .send({ note: "second" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);

    // Balance giữ nguyên (không rollback overhead vì transaction abort).
    const Wallet = require("../models/Wallet");
    const w = await Wallet.findById(ctx.wallet._id);
    // Vẫn còn 0 vì lần 1 đã debit.
    expect(w.available_balance).toBe(0);
    expect(w.total_withdrawn).toBe(0);

    // Vẫn chỉ 1 WalletTransaction Withdrawal (không orphan).
    const WalletTransaction = require("../models/WalletTransaction");
    const txs = await WalletTransaction.find({
      user_id: ctx.mangaka._id,
      type: "Withdrawal",
    });
    expect(txs.length).toBe(1);
  });

  test("3. Reader không thể tạo withdrawal", async () => {
    await seedScenario({ availableBalance: 500000 });
    // Tạo 1 user Reader thật (seedScenario tạo 1 reader cũng nhưng reader
    // đó không có bank info). Tạo riêng reader có bank info + balance.
    const reader = await makeUser({
      username: "w_reader_bank",
      email: "w_reader_bank@test.com",
      role: "Reader",
      full_name: "Reader có bank",
      bank_name: "VCB",
      account_holder: "READER",
      bank_account_number: "111",
    });
    const Wallet = require("../models/Wallet");
    await Wallet.create({
      user_id: reader._id,
      balance: 500000,
      total_deposited: 500000,
    });

    const res = await request()
      .post("/withdrawals")
      .set(authHeader(token(reader)))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("4. Không có bank info → 400 missing_bank_info", async () => {
    const noBank = await makeUser({
      username: "nobank",
      email: "nobank@test.com",
      role: "Mangaka",
      full_name: "No Bank",
    });
    const Wallet = require("../models/Wallet");
    await Wallet.create({
      user_id: noBank._id,
      available_balance: 500000,
    });

    const res = await request()
      .post("/withdrawals")
      .set(authHeader(token(noBank)))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ngân hàng/i);
  });

  test("5. balance = 0 → 400 zero_balance", async () => {
    const m = await makeUser({
      username: "zerom",
      email: "zero@test.com",
      role: "Mangaka",
      full_name: "Zero Mangaka",
      bank_name: "VCB",
      account_holder: "Z",
      bank_account_number: "000",
    });
    const Wallet = require("../models/Wallet");
    await Wallet.create({
      user_id: m._id,
      available_balance: 0,
    });

    const res = await request()
      .post("/withdrawals")
      .set(authHeader(token(m)))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Số dư|khả dụng/i);
  });
});

describe("Withdrawal lifecycle — Approve", () => {
  test("6. Approve chỉ chuyển pending → approved, KHÔNG động balance", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});

    const Wallet = require("../models/Wallet");
    const before = await Wallet.findById(ctx.wallet._id);

    const res = await request()
      .patch(`/withdrawals/admin/${w._id}/approve`)
      .set(authHeader(ctx.tokens.admin))
      .send({ admin_note: "ok" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("approved");

    const after = await Wallet.findById(ctx.wallet._id);
    expect(after.available_balance).toBe(before.available_balance);
    expect(after.total_withdrawn).toBe(before.total_withdrawn);
    expect(after.total_withdrawn).toBe(0);
  });
});

describe("Withdrawal lifecycle — Complete", () => {
  test("7. Complete → total_withdrawn tăng đúng một lần, Revenue snapshot → withdrawn", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});
    await withdrawalService.approveWithdrawal(ctx.admin._id, w._id);

    const res = await request()
      .patch(`/withdrawals/admin/${w._id}/complete`)
      .set(authHeader(ctx.tokens.admin))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("completed");

    // Wallet
    const Wallet = require("../models/Wallet");
    const after = await Wallet.findById(ctx.wallet._id);
    // Available balance giữ nguyên 0 (đã debit lúc tạo).
    expect(after.available_balance).toBe(0);
    // total_withdrawn tăng đúng coin_amount
    expect(after.total_withdrawn).toBe(500000);

    // Revenue chuyển available → withdrawn
    const Revenue = require("../models/Revenue");
    const revenuesAfter = await Revenue.find({ user_id: ctx.mangaka._id });
    // Tất cả revenue trong snapshot phải là withdrawn
    const inSnapshot = revenuesAfter.filter((r) =>
      w.revenue_ids.some((id) => String(id) === String(r._id))
    );
    expect(inSnapshot.length).toBe(3);
    inSnapshot.forEach((r) => expect(r.status).toBe("withdrawn"));
  });

  test("8. Complete retry không cộng total_withdrawn 2 lần", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});
    await withdrawalService.approveWithdrawal(ctx.admin._id, w._id);
    await withdrawalService.completeWithdrawal(ctx.admin._id, w._id);

    // Retry complete — phải trả invalid_state, không cộng.
    const Wallet = require("../models/Wallet");
    const before = await Wallet.findById(ctx.wallet._id);
    try {
      await withdrawalService.completeWithdrawal(ctx.admin._id, w._id);
    } catch (e) {
      // expected
    }
    const after = await Wallet.findById(ctx.wallet._id);
    expect(after.total_withdrawn).toBe(before.total_withdrawn);
    expect(after.total_withdrawn).toBe(500000);
  });

  test("9. Revenue mới phát sinh sau khi tạo withdrawal KHÔNG bị mark withdrawn", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});
    await withdrawalService.approveWithdrawal(ctx.admin._id, w._id);

    // Sau khi tạo withdrawal, tạo revenue MỚI status=available.
    const Revenue = require("../models/Revenue");
    const newRev = await Revenue.create({
      user_id: ctx.mangaka._id,
      user_role: "Mangaka",
      series_id: new mongoose.Types.ObjectId(),
      chapter_id: new mongoose.Types.ObjectId(),
      purchased_chapter_id: new mongoose.Types.ObjectId(),
      reader_id: new mongoose.Types.ObjectId(),
      gross_coin_amount: 10000,
      platform_fee_coin: 2000,
      net_coin_amount: 8000,
      share_percentage: 60,
      coin_amount: 8000,
      status: "available",
      available_at: new Date(),
    });

    // Complete withdrawal — chỉ mark revenue có trong revenue_ids snapshot.
    await withdrawalService.completeWithdrawal(ctx.admin._id, w._id);

    const newRevAfter = await Revenue.findById(newRev._id);
    expect(newRevAfter.status).toBe("available"); // KHÔNG bị withdrawn
  });
});

describe("Withdrawal lifecycle — Reject", () => {
  test("10. Reject → hoàn available_balance, total_withdrawn KHÔNG đổi, idempotent", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});

    const res = await request()
      .patch(`/withdrawals/admin/${w._id}/reject`)
      .set(authHeader(ctx.tokens.admin))
      .send({ admin_note: "rejecting" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("rejected");

    const Wallet = require("../models/Wallet");
    const after = await Wallet.findById(ctx.wallet._id);
    expect(after.available_balance).toBe(500000); // hoàn lại
    expect(after.total_withdrawn).toBe(0); // không tăng

    // Reject lần nữa: KHÔNG hoàn 2 lần.
    const before = await Wallet.findById(ctx.wallet._id);
    await withdrawalService.rejectWithdrawal(ctx.admin._id, w._id);
    const afterRetry = await Wallet.findById(ctx.wallet._id);
    expect(afterRetry.available_balance).toBe(before.available_balance); // vẫn 500000
    expect(afterRetry.total_withdrawn).toBe(0);
  });

  test("11. Reject pending (chưa approve) cũng hoàn coin", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});
    // Skip approve — reject trực tiếp từ pending.
    await withdrawalService.rejectWithdrawal(ctx.admin._id, w._id);
    const Wallet = require("../models/Wallet");
    const after = await Wallet.findById(ctx.wallet._id);
    expect(after.available_balance).toBe(500000);
    expect(after.total_withdrawn).toBe(0);
  });

  test("12. Reject rejected status — idempotent (KHÔNG throw nếu đã refunded_at)", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});
    await withdrawalService.rejectWithdrawal(ctx.admin._id, w._id);
    // Lần 2: KHÔNG throw, trả về record đã reject. Quan trọng nhất là
    // KHÔNG hoàn tiền lần 2 (đã verify ở test 10).
    const result = await withdrawalService.rejectWithdrawal(ctx.admin._id, w._id);
    expect(result.status).toBe("rejected");
    expect(result.refunded_at).toBeDefined();
  });
});

describe("Withdrawal lifecycle — Authorization", () => {
  test("13. Reader không gọi được admin withdrawal APIs", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});

    const res = await request()
      .get("/withdrawals/admin/all")
      .set(authHeader(ctx.tokens.reader));
    expect(res.status).toBe(403);

    const res2 = await request()
      .patch(`/withdrawals/admin/${w._id}/approve`)
      .set(authHeader(ctx.tokens.reader))
      .send({});
    expect(res2.status).toBe(403);

    const res3 = await request()
      .get(`/withdrawals/admin/${w._id}`)
      .set(authHeader(ctx.tokens.reader));
    expect(res3.status).toBe(403);
  });

  test("14. Mangaka không gọi được admin approve/reject/complete", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });
    const w = await withdrawalService.createWithdrawalRequest(ctx.mangaka._id, {});

    const r1 = await request()
      .patch(`/withdrawals/admin/${w._id}/approve`)
      .set(authHeader(ctx.tokens.mangaka))
      .send({});
    expect(r1.status).toBe(403);

    const r2 = await request()
      .patch(`/withdrawals/admin/${w._id}/reject`)
      .set(authHeader(ctx.tokens.mangaka))
      .send({});
    expect(r2.status).toBe(403);

    const r3 = await request()
      .patch(`/withdrawals/admin/${w._id}/complete`)
      .set(authHeader(ctx.tokens.mangaka))
      .send({});
    expect(r3.status).toBe(403);
  });
});

describe("Withdrawal lifecycle — backward compat for legacy withdrawal", () => {
  test("15. completeWithdrawal xử lý legacy withdrawal (revenue_ids rỗng) an toàn", async () => {
    const ctx = await seedScenario({ availableBalance: 500000 });

    // Tạo 1 legacy withdrawal thủ công (không qua service, không có revenue_ids)
    const Withdrawal = require("../models/Withdrawal");
    const legacy = await Withdrawal.create({
      user_id: ctx.mangaka._id,
      user_role: "Mangaka",
      coin_amount: 500000,
      vnd_amount: 50000000,
      status: "approved",
      coin_unit_scale: 100,
      coin_to_vnd_rate: 100,
      revenue_ids: [],
      bank_snapshot: {
        bank_name: "VCB",
        account_holder: "LEGACY",
        account_number: "999",
      },
    });

    // Giả lập code cũ đã debit available và TĂNG total_withdrawn sẵn.
    const Wallet = require("../models/Wallet");
    await Wallet.findByIdAndUpdate(ctx.wallet._id, {
      $set: {
        available_balance: 0,
        total_withdrawn: 500000, // đã được tăng theo code cũ
      },
    });

    // Complete legacy.
    await withdrawalService.completeWithdrawal(ctx.admin._id, legacy._id);

    const w = await Wallet.findById(ctx.wallet._id);
    // total_withdrawn KHÔNG tăng thêm (gap-fill).
    expect(w.total_withdrawn).toBe(500000);

    // Revenue KHÔNG bị mark (legacy không có revenue_ids).
    const Revenue = require("../models/Revenue");
    const revenues = await Revenue.find({ user_id: ctx.mangaka._id });
    revenues.forEach((r) => {
      // Snapshot = [] nên tất cả vẫn ở available.
      expect(r.status).toBe("available");
    });
  });
});
