/**
 * Admin Finance Routes Tests
 *
 * Test các endpoint:
 * - GET /admin/finance/summary
 * - GET /admin/finance/revenue-by-role
 * - GET /admin/finance/revenue-timeline
 * - GET /admin/finance/top-earners
 * - GET /withdrawals/admin/all (stats)
 *
 * Run: npm test
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

let app;
let request;
let adminToken;
let readerToken;
let testUsers;
let testWallets;

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

  // Tạo test users
  const adminUser = await makeUser({
    username: "admin_test",
    email: "admin@test.com",
    role: "Admin",
    full_name: "Admin Test",
  });
  const mangaka1 = await makeUser({
    username: "mangaka1",
    email: "mangaka1@test.com",
    role: "Mangaka",
    full_name: "Mangaka One",
  });
  const mangaka2 = await makeUser({
    username: "mangaka2",
    email: "mangaka2@test.com",
    role: "Mangaka",
    full_name: "Mangaka Two",
  });
  const assistant1 = await makeUser({
    username: "assistant1",
    email: "assistant1@test.com",
    role: "Assistant",
    full_name: "Assistant One",
  });
  const reader1 = await makeUser({
    username: "reader1",
    email: "reader1@test.com",
    role: "Reader",
    full_name: "Reader One",
  });

  testUsers = { adminUser, mangaka1, mangaka2, assistant1, reader1 };

  const Wallet = require("../models/Wallet");
  testWallets = {
    mangaka1: await Wallet.create({
      user_id: mangaka1._id,
      balance: 0,
      pending_balance: 1000000,
      available_balance: 5000000,
      total_revenue: 6000000,
      total_withdrawn: 3000000,
    }),
    mangaka2: await Wallet.create({
      user_id: mangaka2._id,
      balance: 0,
      pending_balance: 2000000,
      available_balance: 3000000,
      total_revenue: 5000000,
      total_withdrawn: 1000000,
    }),
    assistant1: await Wallet.create({
      user_id: assistant1._id,
      balance: 0,
      pending_balance: 500000,
      available_balance: 2000000,
      total_revenue: 2500000,
      total_withdrawn: 500000,
    }),
    reader1: await Wallet.create({
      user_id: reader1._id,
      balance: 800000,
      total_deposited: 1000000,
      total_spent: 200000,
    }),
  };

  const Revenue = require("../models/Revenue");
  const series1 = new mongoose.Types.ObjectId();
  const chapter1 = new mongoose.Types.ObjectId();
  const purchasedChapter1 = new mongoose.Types.ObjectId();
  const readerId = new mongoose.Types.ObjectId();

  await Revenue.create({
    user_id: mangaka1._id,
    user_role: "Mangaka",
    series_id: series1,
    chapter_id: chapter1,
    purchased_chapter_id: purchasedChapter1,
    reader_id: readerId,
    gross_coin_amount: 50000,
    platform_fee_coin: 10000,
    net_coin_amount: 40000,
    share_percentage: 60,
    coin_amount: 30000,
    status: "available",
    available_at: new Date(),
  });

  await Revenue.create({
    user_id: assistant1._id,
    user_role: "Assistant",
    series_id: series1,
    chapter_id: chapter1,
    purchased_chapter_id: purchasedChapter1,
    reader_id: readerId,
    gross_coin_amount: 50000,
    platform_fee_coin: 10000,
    net_coin_amount: 40000,
    share_percentage: 40,
    coin_amount: 20000,
    status: "available",
    available_at: new Date(),
  });

  const Withdrawal = require("../models/Withdrawal");
  await Withdrawal.create({
    user_id: mangaka1._id,
    user_role: "Mangaka",
    coin_amount: 1000000,
    vnd_amount: 10000000,
    status: "completed",
    processed_at: new Date(),
  });
  await Withdrawal.create({
    user_id: mangaka2._id,
    user_role: "Mangaka",
    coin_amount: 500000,
    vnd_amount: 5000000,
    status: "pending",
  });
  await Withdrawal.create({
    user_id: mangaka2._id,
    user_role: "Mangaka",
    coin_amount: 300000,
    vnd_amount: 3000000,
    status: "approved",
  });
  await Withdrawal.create({
    user_id: assistant1._id,
    user_role: "Assistant",
    coin_amount: 200000,
    vnd_amount: 2000000,
    status: "completed",
    processed_at: new Date(),
  });
  await Withdrawal.create({
    user_id: mangaka1._id,
    user_role: "Mangaka",
    coin_amount: 100000,
    vnd_amount: 1000000,
    status: "rejected",
  });

  adminToken = jwt.sign(
    { nameid: adminUser._id.toString(), role: "Admin" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
  readerToken = jwt.sign(
    { nameid: reader1._id.toString(), role: "Reader" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
});

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

// ─── AUTH TESTS ─────────────────────────────────────────────────────────────

describe("Admin Finance - Auth", () => {
  test("1. No token returns 401", async () => {
    const res = await request().get("/admin/finance/summary");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("2. Non-admin role returns 403", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(readerToken));
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("3. Admin token returns 200", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ─── SUMMARY TESTS ──────────────────────────────────────────────────────────

describe("Admin Finance - Summary", () => {
  test("4. Empty database returns zeros", async () => {
    await clearDatabase();
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.total_circulation_coin).toBe(0);
    expect(data.total_revenue_all_time_coin).toBe(0);
    expect(data.total_withdrawn_vnd).toBe(0);
    expect(data.total_platform_coin).toBe(0);
    expect(data.pending_withdrawals.count).toBe(0);
    expect(data.pending_withdrawals.coin).toBe(0);
    expect(data.total_users_with_balance).toBe(0);
  });

  test("5. total_circulation_coin = balance + pending_balance + available_balance", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const data = res.body.data;
    // Reader: 800000
    // Mangaka1: pending 1000000 + available 5000000 = 6000000
    // Mangaka2: pending 2000000 + available 3000000 = 5000000
    // Assistant1: pending 500000 + available 2000000 = 2500000
    expect(data.total_circulation_coin).toBe(14300000);
  });

  test("6. total_revenue_all_time_coin = SUM Revenue.coin_amount", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.total_revenue_all_time_coin).toBe(50000);
  });

  test("7. total_withdrawn_vnd only counts completed", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.total_withdrawn_vnd).toBe(12000000);
  });

  test("8. pending_withdrawals only counts pending", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.pending_withdrawals.count).toBe(1);
    expect(res.body.data.pending_withdrawals.coin).toBe(500000);
  });

  test("9. total_users_with_balance counts wallets with balance > 0", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.total_users_with_balance).toBe(4);
  });

  test("10. total_platform_coin is always 0", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.total_platform_coin).toBe(0);
  });

  test("11. coin_to_vnd_rate from config", async () => {
    const res = await request()
      .get("/admin/finance/summary")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.coin_to_vnd_rate).toBe(100);
  });
});

// ─── REVENUE BY ROLE TESTS ───────────────────────────────────────────────────

describe("Admin Finance - Revenue By Role", () => {
  test("12. User without wallet still counted in user_count", async () => {
    const res = await request()
      .get("/admin/finance/revenue-by-role")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const roles = res.body.data.roles;
    const readerRole = roles.find((r) => r.role === "Reader");
    expect(readerRole).toBeDefined();
    expect(readerRole.user_count).toBe(1);
  });

  test("13. User without wallet has zero amounts", async () => {
    await makeUser({
      username: "mangaka_no_wallet",
      email: "mangaka_nowallet@test.com",
      role: "Mangaka",
      full_name: "Mangaka No Wallet",
    });

    const res = await request()
      .get("/admin/finance/revenue-by-role")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const roles = res.body.data.roles;
    const mangakaRole = roles.find((r) => r.role === "Mangaka");
    expect(mangakaRole.user_count).toBe(3);
  });

  test("14. total_circulation_coin matches summary", async () => {
    const [summaryRes, roleRes] = await Promise.all([
      request().get("/admin/finance/summary").set(authHeader(adminToken)),
      request()
        .get("/admin/finance/revenue-by-role")
        .set(authHeader(adminToken)),
    ]);

    expect(summaryRes.body.data.total_circulation_coin).toBe(
      roleRes.body.data.total_circulation_coin
    );
  });

  test("15. current_balance_coin = pending + available (chuẩn hoá v2)", async () => {
    const res = await request()
      .get("/admin/finance/revenue-by-role")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const roles = res.body.data.roles;
    const mangakaRole = roles.find((r) => r.role === "Mangaka");
    expect(mangakaRole).toBeDefined();
    expect(mangakaRole.user_count).toBe(2);
    expect(mangakaRole.total_earnings_coin).toBe(11000000);
    expect(mangakaRole.total_withdrawn_coin).toBe(4000000);
    // current_balance = pending + available = (1000000+2000000) + (5000000+3000000) = 11000000
    expect(mangakaRole.current_balance_coin).toBe(11000000);
    expect(mangakaRole.pending_balance_coin).toBe(3000000);
  });
});

// ─── TIMELINE TESTS ─────────────────────────────────────────────────────────

describe("Admin Finance - Revenue Timeline", () => {
  test("16. Default period is 30d", async () => {
    const res = await request()
      .get("/admin/finance/revenue-timeline")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe("30d");
  });

  test("17. Supports 7d period", async () => {
    const res = await request()
      .get("/admin/finance/revenue-timeline?period=7d")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe("7d");
  });

  test("18. Supports 90d period", async () => {
    const res = await request()
      .get("/admin/finance/revenue-timeline?period=90d")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe("90d");
  });

  test("19. Supports all period", async () => {
    const res = await request()
      .get("/admin/finance/revenue-timeline?period=all")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.period).toBe("all");
  });

  test("20. Invalid period returns 400", async () => {
    const res = await request()
      .get("/admin/finance/revenue-timeline?period=invalid")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Invalid period");
  });

  test("21. Points are sorted by date ascending", async () => {
    const res = await request()
      .get("/admin/finance/revenue-timeline?period=7d")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const points = res.body.data.points;
    if (points.length > 1) {
      for (let i = 1; i < points.length; i++) {
        expect(points[i].date >= points[i - 1].date).toBe(true);
      }
    }
  });

  test("22. net_flow_coin = revenue - withdrawal", async () => {
    const res = await request()
      .get("/admin/finance/revenue-timeline?period=all")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;
    expect(summary.net_flow_coin).toBe(
      summary.total_revenue_coin - summary.total_withdrawal_coin
    );
  });

  test("23. Empty data returns empty points array", async () => {
    await clearDatabase();
    const res = await request()
      .get("/admin/finance/revenue-timeline?period=all")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.points).toEqual([]);
  });
});

// ─── TOP EARNERS TESTS ──────────────────────────────────────────────────────

describe("Admin Finance - Top Earners", () => {
  test("24. Default returns both Mangaka and Assistant", async () => {
    const res = await request()
      .get("/admin/finance/top-earners")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.earners).toBeDefined();
    expect(Array.isArray(res.body.data.earners)).toBe(true);
  });

  test("25. Filter by Mangaka role", async () => {
    const res = await request()
      .get("/admin/finance/top-earners?role=Mangaka")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    res.body.data.earners.forEach((e) => {
      expect(e.role).toBe("Mangaka");
    });
  });

  test("26. Filter by Assistant role", async () => {
    const res = await request()
      .get("/admin/finance/top-earners?role=Assistant")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    res.body.data.earners.forEach((e) => {
      expect(e.role).toBe("Assistant");
    });
  });

  test("27. Invalid role returns 400", async () => {
    const res = await request()
      .get("/admin/finance/top-earners?role=Admin")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid role");
  });

  test("28. Limit works correctly", async () => {
    const res = await request()
      .get("/admin/finance/top-earners?limit=1")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.earners.length).toBeLessThanOrEqual(1);
  });

  test("29. Max limit is 50", async () => {
    const res = await request()
      .get("/admin/finance/top-earners?limit=100")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.earners.length).toBeLessThanOrEqual(50);
  });

  test("30. Sorted by total_earnings_coin descending", async () => {
    const res = await request()
      .get("/admin/finance/top-earners")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const earners = res.body.data.earners;
    if (earners.length > 1) {
      for (let i = 1; i < earners.length; i++) {
        expect(earners[i].total_earnings_coin).toBeLessThanOrEqual(
          earners[i - 1].total_earnings_coin
        );
      }
    }
  });

  test("31. series_count is distinct series count", async () => {
    const res = await request()
      .get("/admin/finance/top-earners")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    res.body.data.earners.forEach((e) => {
      expect(typeof e.series_count).toBe("number");
      expect(e.series_count).toBeGreaterThanOrEqual(0);
    });
  });

  test("32. avg_monthly_revenue_coin is integer", async () => {
    const res = await request()
      .get("/admin/finance/top-earners")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    res.body.data.earners.forEach((e) => {
      expect(Number.isInteger(e.avg_monthly_revenue_coin)).toBe(true);
    });
  });

  test("33. Empty earners returns empty array", async () => {
    const Revenue = require("../models/Revenue");
    await Revenue.deleteMany({});

    const res = await request()
      .get("/admin/finance/top-earners")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.earners).toEqual([]);
  });
});

// ─── WITHDRAWAL STATS TESTS ────────────────────────────────────────────────

describe("Withdrawals Admin - Stats", () => {
  test("34. Stats has all 10 fields", async () => {
    const res = await request()
      .get("/withdrawals/admin/all")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.stats).toBeDefined();
    const stats = res.body.stats;
    expect(stats.pending_count).toBeDefined();
    expect(stats.pending_coin).toBeDefined();
    expect(stats.approved_count).toBeDefined();
    expect(stats.approved_coin).toBeDefined();
    expect(stats.completed_count).toBeDefined();
    expect(stats.completed_coin).toBeDefined();
    expect(stats.rejected_count).toBeDefined();
    expect(stats.rejected_coin).toBeDefined();
    expect(stats.cancelled_count).toBeDefined();
    expect(stats.cancelled_coin).toBeDefined();
  });

  test("35. Stats has correct counts from test data", async () => {
    const res = await request()
      .get("/withdrawals/admin/all")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const stats = res.body.stats;
    expect(stats.pending_count).toBe(1);
    expect(stats.pending_coin).toBe(500000);
    expect(stats.approved_count).toBe(1);
    expect(stats.approved_coin).toBe(300000);
    expect(stats.completed_count).toBe(2);
    expect(stats.completed_coin).toBe(1200000);
    expect(stats.rejected_count).toBe(1);
    expect(stats.rejected_coin).toBe(100000);
    expect(stats.cancelled_count).toBe(0);
    expect(stats.cancelled_coin).toBe(0);
  });

  test("36. Stats not affected by page/limit", async () => {
    const [page1Res, page2Res] = await Promise.all([
      request()
        .get("/withdrawals/admin/all?page=1&limit=1")
        .set(authHeader(adminToken)),
      request()
        .get("/withdrawals/admin/all?page=2&limit=1")
        .set(authHeader(adminToken)),
    ]);
    expect(page1Res.body.stats).toEqual(page2Res.body.stats);
  });

  test("37. Stats not affected by query status", async () => {
    const [allRes, pendingRes] = await Promise.all([
      request()
        .get("/withdrawals/admin/all")
        .set(authHeader(adminToken)),
      request()
        .get("/withdrawals/admin/all?status=pending")
        .set(authHeader(adminToken)),
    ]);
    expect(allRes.body.stats).toEqual(pendingRes.body.stats);
  });

  test("38. Response structure preserved", async () => {
    const res = await request()
      .get("/withdrawals/admin/all")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.total).toBeDefined();
    expect(res.body.pagination.page).toBeDefined();
    expect(res.body.pagination.limit).toBeDefined();
    expect(res.body.pagination.pages).toBeDefined();
  });
});
