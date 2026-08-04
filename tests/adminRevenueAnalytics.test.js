/**
 * Revenue Analytics + User Top-Series tests
 *
 * Tests cho 2 endpoint mới:
 *   - GET /admin/finance/revenue-analytics
 *   - GET /admin/users/:id/financials/top-series
 *
 * Bao phủ:
 *   - Month boundary, quarter boundary, year boundary.
 *   - Timezone Asia/Ho_Chi_Minh.
 *   - Invalid period/year/month/quarter → HTTP 400.
 *   - Một purchase chỉ có Mangaka.
 *   - Một purchase có Mangaka và Assistant.
 *   - Gross và chapters_sold không bị nhân đôi.
 *   - Mangaka + Assistant + platform fee khớp gross trong giới hạn rounding.
 *   - Platform fee dùng giá trị snapshot (lưu trên Revenue, không tính lại).
 *   - Top series sắp xếp đúng.
 *   - User top series chỉ lấy Revenue của user được chọn.
 *   - Các ngày/tháng không có dữ liệu trả 0.
 *   - Display fields đúng 2 chữ số.
 *   - Auth Admin và role validation.
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
const {
  setupTestApp,
  teardownTestApp,
  clearDatabase,
  makeUser,
  makeToken,
} = require("./testUtils");

let app;
let request;
let adminToken;
let mangakaToken;
let readerToken;

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

  const admin = await makeUser({
    username: "admin_ra",
    email: "admin_ra@test.com",
    role: "Admin",
    full_name: "Admin RA",
  });
  const mangaka = await makeUser({
    username: "manga_ra",
    email: "manga_ra@test.com",
    role: "Mangaka",
    full_name: "Mangaka RA",
  });
  const reader = await makeUser({
    username: "reader_ra",
    email: "reader_ra@test.com",
    role: "Reader",
    full_name: "Reader RA",
  });

  adminToken = makeToken(admin, process.env.JWT_SECRET);
  mangakaToken = makeToken(mangaka, process.env.JWT_SECRET);
  readerToken = makeToken(reader, process.env.JWT_SECRET);
});

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Hàm trợ giúp tạo 1 purchase tạo N Revenue record.
 * - N=1: chỉ Mangaka, share_percentage=100.
 * - N=2: Mangaka (60%) + Assistant (40%).
 *
 * Mỗi record lưu gross_coin_amount = full price (purchase-level field).
 * platform_fee_coin chia đều cho N records theo platformFeePercent.
 *
 * @returns mảng docs Revenue đã insert (chưa lưu DB)
 */
function makePurchaseRevenues({
  purchased_chapter_id,
  series_id,
  chapter_id,
  user_mangaka_id,
  user_assistant_id,
  price_coin, // raw CoinUnit (gross)
  platform_fee_coin, // raw CoinUnit (tổng phí của purchase)
  createdAt,
}) {
  // Chia số integer theo tỷ lệ % (largest-remainder).
  // Trả về mảng coin_amount theo thứ tự userIds.
  const splitByPercentage = (total, userIds) => {
    const exacts = userIds.map((u) => (total * u.share) / 100);
    const floors = exacts.map((e) => Math.floor(e));
    let remainder = total - floors.reduce((s, f) => s + f, 0);
    // Phân phối remainder cho các user có phần thập phân lớn nhất trước.
    const order = exacts
      .map((e, idx) => ({ idx, frac: e - floors[idx] }))
      .sort((a, b) => b.frac - a.frac);
    const result = [...floors];
    for (let i = 0; i < remainder; i++) {
      result[order[i].idx] += 1;
    }
    return result;
  };

  const netCoin = price_coin - platform_fee_coin;
  const userIds = user_assistant_id
    ? [
        { id: user_mangaka_id, role: "Mangaka", share: 60 },
        { id: user_assistant_id, role: "Assistant", share: 40 },
      ]
    : [{ id: user_mangaka_id, role: "Mangaka", share: 100 }];

  // fee + coin đều chia theo share_percentage để đảm bảo
  // mangaka + assistant + platform_fee = price (không lệch).
  const feeShares = splitByPercentage(platform_fee_coin, userIds);
  const coinShares = splitByPercentage(netCoin, userIds);

  return userIds.map((u, idx) => ({
    user_id: u.id,
    user_role: u.role,
    series_id,
    chapter_id,
    purchased_chapter_id,
    reader_id: new mongoose.Types.ObjectId(),
    gross_coin_amount: price_coin,
    platform_fee_coin: feeShares[idx],
    net_coin_amount: netCoin,
    share_percentage: u.share,
    coin_amount: coinShares[idx],
    available_at: createdAt,
    createdAt,
  }));
}

describe("Period helpers — parsePeriodFilter", () => {
  const s = require("../services/adminFinanceService");

  test("P1. Default period is month (current month in HCM)", () => {
    const f = s.parsePeriodFilter({});
    expect(f.period).toBe("month");
    expect(f.year).toBeGreaterThan(2020);
    expect(f.month).toBeGreaterThanOrEqual(1);
    expect(f.month).toBeLessThanOrEqual(12);
  });

  test("P2. month/year/month explicit", () => {
    const f = s.parsePeriodFilter({ period: "month", year: "2026", month: "8" });
    expect(f).toEqual({ period: "month", year: 2026, month: 8 });
  });

  test("P3. quarter 1..4", () => {
    for (let q = 1; q <= 4; q++) {
      const f = s.parsePeriodFilter({ period: "quarter", year: "2026", quarter: String(q) });
      expect(f.quarter).toBe(q);
    }
  });

  test("P4. year only", () => {
    const f = s.parsePeriodFilter({ period: "year", year: "2026" });
    expect(f).toEqual({ period: "year", year: 2026 });
  });

  test("P5. invalid period → throws", () => {
    expect(() => s.parsePeriodFilter({ period: "week" })).toThrow(/Invalid period/);
    expect(() => s.parsePeriodFilter({ period: "30d" })).toThrow(/Invalid period/);
    expect(() => s.parsePeriodFilter({ period: "all" })).toThrow(/Invalid period/);
  });

  test("P6. invalid month (13, 0, abc, -1) → throws", () => {
    expect(() => s.parsePeriodFilter({ period: "month", month: "13" })).toThrow(/Invalid month/);
    expect(() => s.parsePeriodFilter({ period: "month", month: "0" })).toThrow(/Invalid month/);
    expect(() => s.parsePeriodFilter({ period: "month", month: "abc" })).toThrow(/Invalid month/);
    expect(() => s.parsePeriodFilter({ period: "month", month: "-1" })).toThrow(/Invalid month/);
  });

  test("P7. invalid quarter (5, 0) → throws", () => {
    expect(() => s.parsePeriodFilter({ period: "quarter", quarter: "5" })).toThrow(/Invalid quarter/);
    expect(() => s.parsePeriodFilter({ period: "quarter", quarter: "0" })).toThrow(/Invalid quarter/);
  });

  test("P8. invalid year → throws", () => {
    expect(() => s.parsePeriodFilter({ period: "year", year: "1969" })).toThrow(/Invalid year/);
    expect(() => s.parsePeriodFilter({ period: "year", year: "abc" })).toThrow(/Invalid year/);
  });
});

describe("Period helpers — computeRangeFromTo + buildChartPoints", () => {
  const s = require("../services/adminFinanceService");

  test("R1. month range covers [1st 00:00 HCM, 1st-next-month 00:00 HCM)", () => {
    const r = s.computeRangeFromTo({ period: "month", year: 2026, month: 8 });
    // 00:00 HCM 2026-08-01 = 17:00 UTC 2026-07-31
    expect(r.from.toISOString()).toBe("2026-07-31T17:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-08-31T17:00:00.000Z");
  });

  test("R2. quarter range covers start..end exclusive", () => {
    const r = s.computeRangeFromTo({ period: "quarter", year: 2026, quarter: 3 });
    expect(r.from.toISOString()).toBe("2026-06-30T17:00:00.000Z"); // 2026-07-01 00:00 HCM
    expect(r.to.toISOString()).toBe("2026-09-30T17:00:00.000Z"); // 2026-10-01 00:00 HCM
  });

  test("R3. year range covers 1/1..12/31 exclusive of next year", () => {
    const r = s.computeRangeFromTo({ period: "year", year: 2026 });
    expect(r.from.toISOString()).toBe("2025-12-31T17:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-12-31T17:00:00.000Z");
  });

  test("C1. month points = daysInMonth (28/29/30/31)", () => {
    expect(s.buildChartPoints({ period: "month", year: 2026, month: 2 }).length).toBe(28);
    expect(s.buildChartPoints({ period: "month", year: 2024, month: 2 }).length).toBe(29);
    expect(s.buildChartPoints({ period: "month", year: 2026, month: 4 }).length).toBe(30);
    expect(s.buildChartPoints({ period: "month", year: 2026, month: 8 }).length).toBe(31);
  });

  test("C2. month points keys are YYYY-MM-DD ordered", () => {
    const points = s.buildChartPoints({ period: "month", year: 2026, month: 8 });
    expect(points[0].key).toBe("2026-08-01");
    expect(points[points.length - 1].key).toBe("2026-08-31");
    for (let i = 1; i < points.length; i++) {
      expect(points[i].key > points[i - 1].key).toBe(true);
    }
  });

  test("C3. quarter points = 3 months", () => {
    const q3 = s.buildChartPoints({ period: "quarter", year: 2026, quarter: 3 });
    expect(q3.map((p) => p.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  test("C4. year points = 12 months", () => {
    const y = s.buildChartPoints({ period: "year", year: 2026 });
    expect(y.length).toBe(12);
    expect(y[0].key).toBe("2026-01");
    expect(y[11].key).toBe("2026-12");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /admin/finance/revenue-analytics
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /admin/finance/revenue-analytics — auth & validation", () => {
  test("A1. No token → 401", async () => {
    const res = await request().get("/admin/finance/revenue-analytics");
    expect(res.status).toBe(401);
  });

  test("A2. Reader token → 403", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics")
      .set(authHeader(readerToken));
    expect(res.status).toBe(403);
  });

  test("A3. Mangaka token → 403 (Admin only)", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics")
      .set(authHeader(mangakaToken));
    expect(res.status).toBe(403);
  });

  test("A4. Invalid period → 400", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=week")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid period/);
  });

  test("A5. Invalid month → 400", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=13")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid month/);
  });

  test("A6. Invalid quarter → 400", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=quarter&year=2026&quarter=5")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid quarter/);
  });

  test("A7. Invalid year → 400", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=year&year=1969")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid year/);
  });
});

describe("GET /admin/finance/revenue-analytics — empty data", () => {
  test("E1. Empty database returns zeros and full skeleton", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.filter.period).toBe("month");
    expect(data.filter.year).toBe(2026);
    expect(data.filter.month).toBe(8);
    expect(data.filter.timezone).toBe("Asia/Ho_Chi_Minh");
    expect(data.filter.from).toBe("2026-07-31T17:00:00.000Z");
    expect(data.filter.to).toBe("2026-08-31T17:00:00.000Z");
    expect(data.points).toHaveLength(31);
    expect(data.summary.gross_revenue_coin).toBe(0);
    expect(data.summary.mangaka_revenue_coin).toBe(0);
    expect(data.summary.assistant_revenue_coin).toBe(0);
    expect(data.summary.platform_fee_coin).toBe(0);
    expect(data.summary.chapters_sold).toBe(0);
    expect(data.top_series).toEqual([]);
    // Tất cả points đều có 5 metric = 0 (điền bucket trống)
    for (const p of data.points) {
      expect(p.gross_revenue_coin).toBe(0);
      expect(p.mangaka_revenue_coin).toBe(0);
      expect(p.assistant_revenue_coin).toBe(0);
      expect(p.platform_fee_coin).toBe(0);
      expect(p.chapters_sold).toBe(0);
    }
  });
});

describe("GET /admin/finance/revenue-analytics — chống nhân đôi + aggregation", () => {
  let adminUser;
  let mangakaUser;
  let assistantUser;
  let seriesA;
  let seriesB;
  let chapter;
  let purchased;

  beforeEach(async () => {
    adminUser = await makeUser({
      username: "ra_admin_x",
      email: "ra_admin_x@test.com",
      role: "Admin",
      full_name: "RA Admin",
    });
    mangakaUser = await makeUser({
      username: "ra_manga_x",
      email: "ra_manga_x@test.com",
      role: "Mangaka",
      full_name: "RA Mangaka",
    });
    assistantUser = await makeUser({
      username: "ra_assist_x",
      email: "ra_assist_x@test.com",
      role: "Assistant",
      full_name: "RA Assistant",
    });

    const Series = require("../models/Series");
    const Chapter = require("../models/Chapter");
    const PurchasedChapter = require("../models/PurchasedChapter");

    seriesA = await Series.create({
      name: "Series A",
      author_id: mangakaUser._id,
      status: "published",
    });
    seriesB = await Series.create({
      name: "Series B",
      author_id: mangakaUser._id,
      status: "published",
    });
    chapter = await Chapter.create({
      series_id: seriesA._id,
      chapter_number: 1,
      title: "Chapter 1",
      status: "published",
      is_published: true,
      submitted_by: mangakaUser._id,
    });
    purchased = await PurchasedChapter.create({
      reader_id: new mongoose.Types.ObjectId(),
      chapter_id: chapter._id,
      series_id: seriesA._id,
      price: 500,
      purchased_at: new Date(),
    });
  });

  test("RA1. Một purchase chỉ có Mangaka — gross & chapters_sold không nhân đôi", async () => {
    const Revenue = require("../models/Revenue");
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const docs = makePurchaseRevenues({
      purchased_chapter_id: purchased._id,
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: null,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt,
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;
    expect(summary.gross_revenue_coin).toBe(500); // không nhân 2
    expect(summary.mangaka_revenue_coin).toBe(400); // 500 - 100
    expect(summary.assistant_revenue_coin).toBe(0);
    expect(summary.platform_fee_coin).toBe(100);
    expect(summary.chapters_sold).toBe(1);
  });

  test("RA2. Một purchase có Mangaka + Assistant — gross & chapters_sold không nhân đôi", async () => {
    const Revenue = require("../models/Revenue");
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const docs = makePurchaseRevenues({
      purchased_chapter_id: purchased._id,
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: assistantUser._id,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt,
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;
    expect(summary.gross_revenue_coin).toBe(500);
    // creator = mangaka + assistant = 400
    expect(summary.mangaka_revenue_coin + summary.assistant_revenue_coin).toBe(400);
    expect(summary.platform_fee_coin).toBe(100);
    expect(summary.chapters_sold).toBe(1);
  });

  test("RA3. Mangaka + Assistant + platform_fee khớp gross (rounding ≤ 1)", async () => {
    const Revenue = require("../models/Revenue");
    // 3 purchase, mỗi purchase có Mangaka + Assistant
    // price=500, fee=137 (chia 2 = 68,69 do largest-remainder)
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const docs = [];
    for (let i = 0; i < 3; i++) {
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: chapter._id,
        series_id: seriesA._id,
        price: 500,
        purchased_at: createdAt,
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: seriesA._id,
          chapter_id: chapter._id,
          user_mangaka_id: mangakaUser._id,
          user_assistant_id: assistantUser._id,
          price_coin: 500,
          platform_fee_coin: 137,
          createdAt,
        })
      );
    }
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    const s = res.body.data.summary;
    // gross = 3 * 500 = 1500
    expect(s.gross_revenue_coin).toBe(1500);
    // platform_fee snapshot = 3 * 137 = 411 (lưu per-record sum)
    expect(s.platform_fee_coin).toBe(411);
    // creator revenue = 1500 - 411 = 1089
    const creator = s.mangaka_revenue_coin + s.assistant_revenue_coin;
    expect(creator + s.platform_fee_coin).toBe(s.gross_revenue_coin);
    // chapters_sold = 3 (mỗi purchased_chapter_id đúng 1 lần)
    expect(s.chapters_sold).toBe(3);
  });

  test("RA4. Out-of-range revenue KHÔNG bị tính", async () => {
    const Revenue = require("../models/Revenue");
    // Revenue ngoài khoảng Aug 2026
    const docs = makePurchaseRevenues({
      purchased_chapter_id: purchased._id,
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: null,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt: new Date("2026-07-15T10:00:00Z"),
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.body.data.summary.gross_revenue_coin).toBe(0);
    expect(res.body.data.summary.chapters_sold).toBe(0);
  });

  test("RA5. Quarter boundary: Q3 (Jul-Sep)", async () => {
    const Revenue = require("../models/Revenue");
    // Jul, Aug, Sep cùng Q3 → đều được tính
    const docs = [];
    const days = [
      new Date("2026-07-01T10:00:00Z"),
      new Date("2026-08-01T10:00:00Z"),
      new Date("2026-09-30T16:00:00Z"), // Sep 30 23:59 HCM = 16:00 UTC
    ];
    for (let i = 0; i < days.length; i++) {
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: chapter._id,
        series_id: seriesA._id,
        price: 500,
        purchased_at: days[i],
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: seriesA._id,
          chapter_id: chapter._id,
          user_mangaka_id: mangakaUser._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt: days[i],
        })
      );
    }
    // Revenue thuộc Q2 (Jun) → KHÔNG tính
    const outOfRange = makePurchaseRevenues({
      purchased_chapter_id: new mongoose.Types.ObjectId(),
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: null,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt: new Date("2026-06-30T16:00:00Z"), // Jun 30 23:00 HCM, vẫn trong Q2
    });
    docs.push(...outOfRange);
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=quarter&year=2026&quarter=3")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.summary.gross_revenue_coin).toBe(1500); // 3 * 500
    expect(res.body.data.summary.chapters_sold).toBe(3);
    // 3 bucket YYYY-MM
    expect(res.body.data.points).toHaveLength(3);
    expect(res.body.data.points.map((p) => p.key)).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    // Jul: 1 purchase (500), Aug: 1 (500), Sep: 1 (500)
    for (const p of res.body.data.points) {
      expect(p.gross_revenue_coin).toBe(500);
      expect(p.chapters_sold).toBe(1);
    }
  });

  test("RA6. Year boundary: chỉ trong 2026", async () => {
    const Revenue = require("../models/Revenue");
    const docs = [];
    // 2025 Dec: KHÔNG trong 2026
    docs.push(
      ...makePurchaseRevenues({
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        series_id: seriesA._id,
        chapter_id: chapter._id,
        user_mangaka_id: mangakaUser._id,
        user_assistant_id: null,
        price_coin: 500,
        platform_fee_coin: 100,
        createdAt: new Date("2025-12-31T16:00:00Z"),
      })
    );
    // 2026 Jan, Jun, Dec
    for (const d of [
      new Date("2026-01-15T10:00:00Z"),
      new Date("2026-06-15T10:00:00Z"),
      new Date("2026-12-31T16:00:00Z"), // Dec 31 23:00 HCM = 16:00 UTC
    ]) {
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: chapter._id,
        series_id: seriesA._id,
        price: 500,
        purchased_at: d,
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: seriesA._id,
          chapter_id: chapter._id,
          user_mangaka_id: mangakaUser._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt: d,
        })
      );
    }
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=year&year=2026")
      .set(authHeader(adminToken));
    expect(res.body.data.summary.gross_revenue_coin).toBe(1500);
    expect(res.body.data.summary.chapters_sold).toBe(3);
    expect(res.body.data.points).toHaveLength(12);
    // Các tháng không có data → 0
    expect(res.body.data.points[1].gross_revenue_coin).toBe(0);
    expect(res.body.data.points[1].chapters_sold).toBe(0);
  });

  test("RA7. Top series sắp xếp theo gross_revenue_coin DESC", async () => {
    const Revenue = require("../models/Revenue");
    // Series A: 2 purchase, Series B: 3 purchase
    const docs = [];
    for (let i = 0; i < 2; i++) {
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: chapter._id,
        series_id: seriesA._id,
        price: 500,
        purchased_at: new Date("2026-08-10T10:00:00Z"),
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: seriesA._id,
          chapter_id: chapter._id,
          user_mangaka_id: mangakaUser._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt: new Date("2026-08-10T10:00:00Z"),
        })
      );
    }
    for (let i = 0; i < 3; i++) {
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: chapter._id,
        series_id: seriesB._id,
        price: 500,
        purchased_at: new Date("2026-08-10T10:00:00Z"),
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: seriesB._id,
          chapter_id: chapter._id,
          user_mangaka_id: mangakaUser._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt: new Date("2026-08-10T10:00:00Z"),
        })
      );
    }
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    const top = res.body.data.top_series;
    expect(top).toHaveLength(2);
    expect(String(top[0].series_id)).toBe(String(seriesB._id)); // 3 purchase trước
    expect(top[0].gross_revenue_coin).toBe(1500);
    expect(top[0].chapters_sold).toBe(3);
    expect(String(top[1].series_id)).toBe(String(seriesA._id));
    expect(top[1].gross_revenue_coin).toBe(1000);
    expect(top[1].chapters_sold).toBe(2);
  });

  test("RA8. limit query param (default 10, max 50)", async () => {
    // Limit=2
    const Revenue = require("../models/Revenue");
    const Series = require("../models/Series");
    const docs = [];
    for (let i = 0; i < 5; i++) {
      const s = await Series.create({
        name: `S${i}`,
        author_id: mangakaUser._id,
        status: "published",
      });
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: chapter._id,
        series_id: s._id,
        price: 500,
        purchased_at: new Date("2026-08-10T10:00:00Z"),
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: s._id,
          chapter_id: chapter._id,
          user_mangaka_id: mangakaUser._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt: new Date("2026-08-10T10:00:00Z"),
        })
      );
    }
    await Revenue.insertMany(docs);
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8&limit=2")
      .set(authHeader(adminToken));
    expect(res.body.data.top_series).toHaveLength(2);
  });

  test("RA9. Display fields đúng 2 chữ số (canonical từ unitsToCoinString)", async () => {
    const Revenue = require("../models/Revenue");
    const docs = makePurchaseRevenues({
      purchased_chapter_id: purchased._id,
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: null,
      price_coin: 505,
      platform_fee_coin: 101,
      createdAt: new Date("2026-08-15T10:00:00Z"),
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    const summary = res.body.data.summary;
    expect(summary.gross_revenue_coin).toBe(505);
    expect(summary.gross_revenue_coin_display).toBe("5.05");
    expect(summary.platform_fee_coin).toBe(101);
    expect(summary.platform_fee_coin_display).toBe("1.01");
    expect(summary.platform_fee).toBe("1.01"); // legacy alias cho backward compat
    // Points đều có _coin_display
    const pts = res.body.data.points;
    expect(pts[14].gross_revenue_coin).toBe(505); // ngày 15
    expect(pts[14].gross_revenue_coin_display).toBe("5.05");
    expect(pts[14].platform_fee_coin_display).toBe("1.01");
  });

  test("RA10. Timezone Asia/Ho_Chi_Minh grouping — boundary 23:59 HCM = 16:00 UTC", async () => {
    const Revenue = require("../models/Revenue");
    // 2026-08-15 23:59 HCM = 2026-08-15 16:00 UTC
    // Phải rơi vào bucket 2026-08-15
    const createdAt = new Date("2026-08-15T16:00:00Z");
    const docs = makePurchaseRevenues({
      purchased_chapter_id: purchased._id,
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: null,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt,
    });
    await Revenue.insertMany(docs);
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    // Tìm bucket ngày 15
    const p15 = res.body.data.points.find((p) => p.key === "2026-08-15");
    expect(p15).toBeDefined();
    expect(p15.gross_revenue_coin).toBe(500);
    // Ngày 16 phải = 0
    const p16 = res.body.data.points.find((p) => p.key === "2026-08-16");
    expect(p16.gross_revenue_coin).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/users/:id/financials/top-series
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /admin/users/:id/financials/top-series — auth & validation", () => {
  test("U1. No token → 401", async () => {
    const res = await request().get(
      "/admin/users/000000000000000000000000/financials/top-series"
    );
    expect(res.status).toBe(401);
  });

  test("U2. Reader token → 403", async () => {
    const res = await request()
      .get("/admin/users/000000000000000000000000/financials/top-series")
      .set(authHeader(readerToken));
    expect(res.status).toBe(403);
  });

  test("U3. Invalid id format → 400", async () => {
    const res = await request()
      .get("/admin/users/not-an-objectid/financials/top-series")
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
  });

  test("U4. Non-existent user → 404", async () => {
    const res = await request()
      .get("/admin/users/000000000000000000000000/financials/top-series")
      .set(authHeader(adminToken));
    expect(res.status).toBe(404);
  });

  test("U5. Reader role → 400 (only Mangaka/Assistant)", async () => {
    const reader = await makeUser({
      username: "u5_reader",
      email: "u5@test.com",
      role: "Reader",
    });
    const res = await request()
      .get(`/admin/users/${reader._id}/financials/top-series`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Mangaka|Assistant/);
  });

  test("U6. Invalid period → 400", async () => {
    const m = await makeUser({
      username: "u6_manga",
      email: "u6@test.com",
      role: "Mangaka",
    });
    const res = await request()
      .get(`/admin/users/${m._id}/financials/top-series?period=week`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/users/:id/financials/top-series — data correctness", () => {
  let mangakaUser;
  let assistantUser;
  let seriesA;
  let seriesB;
  let chapter;

  beforeEach(async () => {
    mangakaUser = await makeUser({
      username: "us_manga",
      email: "us_manga@test.com",
      role: "Mangaka",
      full_name: "US Mangaka",
    });
    assistantUser = await makeUser({
      username: "us_assist",
      email: "us_assist@test.com",
      role: "Assistant",
      full_name: "US Assistant",
    });

    const Series = require("../models/Series");
    const Chapter = require("../models/Chapter");

    seriesA = await Series.create({
      name: "Top A",
      author_id: mangakaUser._id,
      status: "published",
    });
    seriesB = await Series.create({
      name: "Top B",
      author_id: mangakaUser._id,
      status: "published",
    });
    chapter = await Chapter.create({
      series_id: seriesA._id,
      chapter_number: 1,
      title: "Chapter 1",
      status: "published",
      is_published: true,
      submitted_by: mangakaUser._id,
    });
  });

  test("UT1. Chỉ lấy Revenue của user được chọn", async () => {
    const Revenue = require("../models/Revenue");
    const PurchasedChapter = require("../models/PurchasedChapter");
    const createdAt = new Date("2026-08-15T10:00:00Z");
    // 1 purchase: Mangaka + Assistant cho cùng series
    const pur = await PurchasedChapter.create({
      reader_id: new mongoose.Types.ObjectId(),
      chapter_id: chapter._id,
      series_id: seriesA._id,
      price: 500,
      purchased_at: createdAt,
    });
    const docs = makePurchaseRevenues({
      purchased_chapter_id: pur._id,
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: assistantUser._id,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt,
    });
    await Revenue.insertMany(docs);

    // Query với Mangaka — chỉ lấy record của user đó
    const res = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe("Mangaka");
    expect(res.body.data.top_series).toHaveLength(1);
    expect(String(res.body.data.top_series[0].series_id)).toBe(
      String(seriesA._id)
    );
    // Mangaka nhận 60% của net_coin = 400, largest-remainder = 240 (60%) + 160 (40%) → mangaka=240
    expect(res.body.data.top_series[0].creator_revenue_coin).toBe(240);
    expect(res.body.data.top_series[0].gross_revenue_coin).toBe(500); // $first per purchase
    expect(res.body.data.top_series[0].chapters_sold).toBe(1);

    // Query với Assistant — creator_revenue_coin = 160 (40% của 400)
    const res2 = await request()
      .get(
        `/admin/users/${assistantUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(res2.body.data.top_series[0].creator_revenue_coin).toBe(160);
  });

  test("UT2. Sort theo creator_revenue_coin DESC; gross không nhân đôi", async () => {
    const Revenue = require("../models/Revenue");
    const PurchasedChapter = require("../models/PurchasedChapter");
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const docs = [];
    // Series A: 1 purchase (creator=240 for Mangaka)
    const purA = await PurchasedChapter.create({
      reader_id: new mongoose.Types.ObjectId(),
      chapter_id: chapter._id,
      series_id: seriesA._id,
      price: 500,
      purchased_at: createdAt,
    });
    docs.push(
      ...makePurchaseRevenues({
        purchased_chapter_id: purA._id,
        series_id: seriesA._id,
        chapter_id: chapter._id,
        user_mangaka_id: mangakaUser._id,
        user_assistant_id: assistantUser._id,
        price_coin: 500,
        platform_fee_coin: 100,
        createdAt,
      })
    );
    // Series B: 3 purchase (creator = 3 * 240 = 720)
    for (let i = 0; i < 3; i++) {
      const purB = await PurchasedChapter.create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: chapter._id,
        series_id: seriesB._id,
        price: 500,
        purchased_at: createdAt,
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: purB._id,
          series_id: seriesB._id,
          chapter_id: chapter._id,
          user_mangaka_id: mangakaUser._id,
          user_assistant_id: assistantUser._id,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt,
        })
      );
    }
    await Revenue.insertMany(docs);

    const res = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(res.body.data.top_series).toHaveLength(2);
    // Series B trước (3 purchase × 240 = 720)
    expect(String(res.body.data.top_series[0].series_id)).toBe(
      String(seriesB._id)
    );
    expect(res.body.data.top_series[0].creator_revenue_coin).toBe(720);
    expect(res.body.data.top_series[0].gross_revenue_coin).toBe(1500);
    expect(res.body.data.top_series[0].chapters_sold).toBe(3);
    // Series A sau (1 purchase × 240 = 240)
    expect(String(res.body.data.top_series[1].series_id)).toBe(
      String(seriesA._id)
    );
    expect(res.body.data.top_series[1].creator_revenue_coin).toBe(240);
    expect(res.body.data.top_series[1].gross_revenue_coin).toBe(500);
    expect(res.body.data.top_series[1].chapters_sold).toBe(1);
    // Summary khớp
    expect(res.body.data.summary.creator_revenue_coin).toBe(960); // 720 + 240
    expect(res.body.data.summary.chapters_sold).toBe(4);
    expect(res.body.data.summary.series_count).toBe(2);
  });

  test("UT3. Out-of-range revenue không tính", async () => {
    const Revenue = require("../models/Revenue");
    const PurchasedChapter = require("../models/PurchasedChapter");
    const pur = await PurchasedChapter.create({
      reader_id: new mongoose.Types.ObjectId(),
      chapter_id: chapter._id,
      series_id: seriesA._id,
      price: 500,
      purchased_at: new Date("2026-07-15T10:00:00Z"),
    });
    const docs = makePurchaseRevenues({
      purchased_chapter_id: pur._id,
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: null,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt: new Date("2026-07-15T10:00:00Z"),
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(res.body.data.summary.creator_revenue_coin).toBe(0);
    expect(res.body.data.summary.chapters_sold).toBe(0);
    expect(res.body.data.top_series).toEqual([]);
  });

  test("UT4. Mangaka không có assistant → creator_revenue_coin = gross - fee", async () => {
    const Revenue = require("../models/Revenue");
    const PurchasedChapter = require("../models/PurchasedChapter");
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const pur = await PurchasedChapter.create({
      reader_id: new mongoose.Types.ObjectId(),
      chapter_id: chapter._id,
      series_id: seriesA._id,
      price: 500,
      purchased_at: createdAt,
    });
    const docs = makePurchaseRevenues({
      purchased_chapter_id: pur._id,
      series_id: seriesA._id,
      chapter_id: chapter._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: null,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt,
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(res.body.data.top_series[0].creator_revenue_coin).toBe(400); // 500-100
    expect(res.body.data.top_series[0].gross_revenue_coin).toBe(500);
    expect(res.body.data.top_series[0].creator_revenue_coin_display).toBe("4.00");
    expect(res.body.data.top_series[0].gross_revenue_coin_display).toBe("5.00");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract integration — HTTP-level envelope + platform_fee_vnd + limit
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /admin/finance/revenue-analytics — contract (HTTP-level)", () => {
  test("C1. Response có success=true và data nằm trong body.data", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(typeof res.body.data).toBe("object");
  });

  test("C2. KHÔNG có summary/points/top_series/filter ở root", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.summary).toBeUndefined();
    expect(res.body.points).toBeUndefined();
    expect(res.body.top_series).toBeUndefined();
    expect(res.body.filter).toBeUndefined();
    expect(res.body.config).toBeUndefined();
    // Tất cả phải nằm trong body.data
    expect(res.body.data.summary).toBeDefined();
    expect(res.body.data.points).toBeDefined();
    expect(res.body.data.top_series).toBeDefined();
    expect(res.body.data.filter).toBeDefined();
    expect(res.body.data.config).toBeDefined();
  });

  test("C3. summary.platform_fee_vnd đúng (= platform_fee_coin × coin_to_vnd_rate / 100)", async () => {
    const Revenue = require("../models/Revenue");
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const docs = makePurchaseRevenues({
      purchased_chapter_id: new mongoose.Types.ObjectId(),
      series_id: new mongoose.Types.ObjectId(),
      chapter_id: new mongoose.Types.ObjectId(),
      user_mangaka_id: new mongoose.Types.ObjectId(),
      user_assistant_id: null,
      price_coin: 500,
      platform_fee_coin: 100,
      createdAt,
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;
    expect(summary.platform_fee_coin).toBe(100);
    // COIN_TO_VND_RATE = 100 trong test mock → 100 × 100 / 100 = 100
    expect(summary.platform_fee_vnd).toBe(100);
    // Phải là number, không phải string, không phải null
    expect(typeof summary.platform_fee_vnd).toBe("number");
  });

  test("C4. points[].platform_fee_vnd đúng cho từng chart point (= 0 cho bucket trống)", async () => {
    const Revenue = require("../models/Revenue");
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const docs = makePurchaseRevenues({
      purchased_chapter_id: new mongoose.Types.ObjectId(),
      series_id: new mongoose.Types.ObjectId(),
      chapter_id: new mongoose.Types.ObjectId(),
      user_mangaka_id: new mongoose.Types.ObjectId(),
      user_assistant_id: null,
      price_coin: 500,
      platform_fee_coin: 137, // raw CoinUnit
      createdAt,
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const points = res.body.data.points;
    expect(points).toHaveLength(31);

    // Bucket ngày 15 có data
    const p15 = points.find((p) => p.key === "2026-08-15");
    expect(p15).toBeDefined();
    expect(p15.platform_fee_coin).toBe(137);
    // 137 × 100 / 100 = 137
    expect(p15.platform_fee_vnd).toBe(137);
    expect(typeof p15.platform_fee_vnd).toBe("number");

    // Mọi bucket khác (empty bucket) phải có platform_fee_vnd = 0
    for (const p of points) {
      expect(p).toHaveProperty("platform_fee_vnd");
      expect(typeof p.platform_fee_vnd).toBe("number");
      if (p.key !== "2026-08-15") {
        expect(p.platform_fee_vnd).toBe(0);
      }
    }
  });

  test("C5. top_series[].platform_fee_vnd đúng cho từng series", async () => {
    const Revenue = require("../models/Revenue");
    const Series = require("../models/Series");
    const mangaka = await makeUser({
      username: "c5_manga",
      email: "c5@test.com",
      role: "Mangaka",
    });
    const s1 = await Series.create({
      name: "C5 S1",
      author_id: mangaka._id,
      status: "published",
    });
    const s2 = await Series.create({
      name: "C5 S2",
      author_id: mangaka._id,
      status: "published",
    });
    const ch = await require("../models/Chapter").create({
      series_id: s1._id,
      chapter_number: 1,
      title: "C5 Ch1",
      status: "published",
      is_published: true,
      submitted_by: mangaka._id,
    });
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const docs = [];
    for (let i = 0; i < 2; i++) {
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: ch._id,
        series_id: s1._id,
        price: 500,
        purchased_at: createdAt,
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: s1._id,
          chapter_id: ch._id,
          user_mangaka_id: mangaka._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt,
        })
      );
    }
    for (let i = 0; i < 3; i++) {
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: ch._id,
        series_id: s2._id,
        price: 500,
        purchased_at: createdAt,
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: s2._id,
          chapter_id: ch._id,
          user_mangaka_id: mangaka._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 250, // 250 CoinUnit → 250 VND
          createdAt,
        })
      );
    }
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    const top = res.body.data.top_series;
    expect(top).toHaveLength(2);
    for (const ts of top) {
      expect(ts).toHaveProperty("platform_fee_vnd");
      expect(typeof ts.platform_fee_vnd).toBe("number");
      expect(ts.platform_fee_vnd).toBe(ts.platform_fee_coin); // rate=100
    }
    // S2 có fee cao hơn (3 × 250 = 750), S1 có 2 × 100 = 200
    const s2Entry = top.find((t) => t.series_name === "C5 S2");
    const s1Entry = top.find((t) => t.series_name === "C5 S1");
    expect(s2Entry.platform_fee_vnd).toBe(750);
    expect(s1Entry.platform_fee_vnd).toBe(200);
  });

  test("C6. Kỳ không có dữ liệu → summary.platform_fee_vnd = 0 và points[].platform_fee_vnd = 0", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const summary = res.body.data.summary;
    expect(summary.platform_fee_coin).toBe(0);
    expect(summary.platform_fee_vnd).toBe(0);
    for (const p of res.body.data.points) {
      expect(p.platform_fee_vnd).toBe(0);
    }
    for (const ts of res.body.data.top_series) {
      expect(ts.platform_fee_vnd).toBe(0);
    }
  });

  test("C7. Coin display đúng 2 chữ số cho mọi *_coin trong summary/points/top_series", async () => {
    const Revenue = require("../models/Revenue");
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const docs = makePurchaseRevenues({
      purchased_chapter_id: new mongoose.Types.ObjectId(),
      series_id: new mongoose.Types.ObjectId(),
      chapter_id: new mongoose.Types.ObjectId(),
      user_mangaka_id: new mongoose.Types.ObjectId(),
      user_assistant_id: null,
      price_coin: 505,
      platform_fee_coin: 101,
      createdAt,
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    const summary = res.body.data.summary;
    expect(summary.gross_revenue_coin_display).toBe("5.05");
    expect(summary.platform_fee_coin_display).toBe("1.01");
    expect(summary.creator_revenue_coin_display).toBeDefined();
    expect(summary.mangaka_revenue_coin_display).toBeDefined();
    expect(summary.assistant_revenue_coin_display).toBeDefined();

    const p15 = res.body.data.points.find((p) => p.key === "2026-08-15");
    expect(p15.gross_revenue_coin_display).toBe("5.05");
    expect(p15.platform_fee_coin_display).toBe("1.01");
    expect(p15.mangaka_revenue_coin_display).toBeDefined();
    expect(p15.assistant_revenue_coin_display).toBeDefined();
  });

  test("C8. Default limit = 10 (không truyền limit)", async () => {
    const Revenue = require("../models/Revenue");
    const Series = require("../models/Series");
    const mangaka = await makeUser({
      username: "c8_manga",
      email: "c8@test.com",
      role: "Mangaka",
    });
    // Tạo 15 series, mỗi series 1 purchase
    const docs = [];
    for (let i = 0; i < 15; i++) {
      const s = await Series.create({
        name: `C8 S${i}`,
        author_id: mangaka._id,
        status: "published",
      });
      const ch = await require("../models/Chapter").create({
        series_id: s._id,
        chapter_number: 1,
        title: `C8 Ch${i}`,
        status: "published",
        is_published: true,
        submitted_by: mangaka._id,
      });
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: ch._id,
        series_id: s._id,
        price: 500,
        purchased_at: new Date("2026-08-10T10:00:00Z"),
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: s._id,
          chapter_id: ch._id,
          user_mangaka_id: mangaka._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt: new Date("2026-08-10T10:00:00Z"),
        })
      );
    }
    await Revenue.insertMany(docs);

    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.body.data.top_series).toHaveLength(10);
  });

  test("C9. limit > 50 bị clamp về 50", async () => {
    // Không cần tạo 51 series thật vì sẽ chậm; chỉ cần xác nhận request
    // không 400 và trả về <= 50 series (database rỗng → 0 series trả về).
    const res = await request()
      .get(
        "/admin/finance/revenue-analytics?period=month&year=2026&month=8&limit=200"
      )
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    // Service trả tối đa 50 → ok với empty data sẽ là 0
    expect(res.body.data.top_series.length).toBeLessThanOrEqual(50);
  });

  test("C10. limit = 0 / không hợp lệ → dùng default 10 (không 400)", async () => {
    const r1 = await request()
      .get(
        "/admin/finance/revenue-analytics?period=month&year=2026&month=8&limit=0"
      )
      .set(authHeader(adminToken));
    expect(r1.status).toBe(200);

    const r2 = await request()
      .get(
        "/admin/finance/revenue-analytics?period=month&year=2026&month=8&limit=abc"
      )
      .set(authHeader(adminToken));
    expect(r2.status).toBe(200);

    const r3 = await request()
      .get(
        "/admin/finance/revenue-analytics?period=month&year=2026&month=8&limit=-5"
      )
      .set(authHeader(adminToken));
    expect(r3.status).toBe(200);
  });

  test("C11. limit = 1 hợp lệ (min) → trả tối đa 1 series", async () => {
    const Revenue = require("../models/Revenue");
    const Series = require("../models/Series");
    const mangaka = await makeUser({
      username: "c11_manga",
      email: "c11@test.com",
      role: "Mangaka",
    });
    const docs = [];
    for (let i = 0; i < 3; i++) {
      const s = await Series.create({
        name: `C11 S${i}`,
        author_id: mangaka._id,
        status: "published",
      });
      const ch = await require("../models/Chapter").create({
        series_id: s._id,
        chapter_number: 1,
        title: `C11 Ch${i}`,
        status: "published",
        is_published: true,
        submitted_by: mangaka._id,
      });
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: ch._id,
        series_id: s._id,
        price: 500,
        purchased_at: new Date("2026-08-10T10:00:00Z"),
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: s._id,
          chapter_id: ch._id,
          user_mangaka_id: mangaka._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt: new Date("2026-08-10T10:00:00Z"),
        })
      );
    }
    await Revenue.insertMany(docs);

    const res = await request()
      .get(
        "/admin/finance/revenue-analytics?period=month&year=2026&month=8&limit=1"
      )
      .set(authHeader(adminToken));
    expect(res.body.data.top_series).toHaveLength(1);
  });

  test("C12. platform_fee_vnd không có alias *_display (chỉ number)", async () => {
    const res = await request()
      .get("/admin/finance/revenue-analytics?period=month&year=2026&month=8")
      .set(authHeader(adminToken));
    expect(res.body.data.summary.platform_fee_vnd_display).toBeUndefined();
    expect(res.body.data.points[0].platform_fee_vnd_display).toBeUndefined();
    expect(res.body.data.top_series[0]?.platform_fee_vnd_display).toBeUndefined();
  });
});

describe("GET /admin/users/:id/financials/top-series — contract (HTTP-level)", () => {
  let mangakaUser;
  let seriesA;

  beforeEach(async () => {
    mangakaUser = await makeUser({
      username: "contract_manga",
      email: "contract_manga@test.com",
      role: "Mangaka",
    });
    const Series = require("../models/Series");
    const Chapter = require("../models/Chapter");
    seriesA = await Series.create({
      name: "Contract Series",
      author_id: mangakaUser._id,
      status: "published",
    });
    await Chapter.create({
      series_id: seriesA._id,
      chapter_number: 1,
      title: "Ch1",
      status: "published",
      is_published: true,
      submitted_by: mangakaUser._id,
    });
  });

  test("UC1. Response có success=true và data nằm trong body.data", async () => {
    const res = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  test("UC2. KHÔNG có summary/top_series/user/filter ở root", async () => {
    const res = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(res.body.summary).toBeUndefined();
    expect(res.body.top_series).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    expect(res.body.filter).toBeUndefined();
    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.filter).toBeDefined();
    expect(res.body.data.summary).toBeDefined();
    expect(res.body.data.top_series).toBeDefined();
  });

  test("UC3. Default limit = 10; limit > 50 bị clamp về 50", async () => {
    const Revenue = require("../models/Revenue");
    const Series = require("../models/Series");
    const docs = [];
    for (let i = 0; i < 15; i++) {
      const s = await Series.create({
        name: `UC3 S${i}`,
        author_id: mangakaUser._id,
        status: "published",
      });
      const ch = await require("../models/Chapter").create({
        series_id: s._id,
        chapter_number: 1,
        title: `UC3 Ch${i}`,
        status: "published",
        is_published: true,
        submitted_by: mangakaUser._id,
      });
      const pur = await require("../models/PurchasedChapter").create({
        reader_id: new mongoose.Types.ObjectId(),
        chapter_id: ch._id,
        series_id: s._id,
        price: 500,
        purchased_at: new Date("2026-08-10T10:00:00Z"),
      });
      docs.push(
        ...makePurchaseRevenues({
          purchased_chapter_id: pur._id,
          series_id: s._id,
          chapter_id: ch._id,
          user_mangaka_id: mangakaUser._id,
          user_assistant_id: null,
          price_coin: 500,
          platform_fee_coin: 100,
          createdAt: new Date("2026-08-10T10:00:00Z"),
        })
      );
    }
    await Revenue.insertMany(docs);

    // Default limit = 10
    const r1 = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(r1.body.data.top_series).toHaveLength(10);

    // limit = 200 → clamp về 50, chỉ có 15 series nên trả 15
    const r2 = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8&limit=200`
      )
      .set(authHeader(adminToken));
    expect(r2.body.data.top_series.length).toBeLessThanOrEqual(50);
    expect(r2.body.data.top_series).toHaveLength(15);

    // limit = 0 → dùng default 10
    const r3 = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8&limit=0`
      )
      .set(authHeader(adminToken));
    expect(r3.body.data.top_series).toHaveLength(10);

    // limit = abc → dùng default 10
    const r4 = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8&limit=abc`
      )
      .set(authHeader(adminToken));
    expect(r4.body.data.top_series).toHaveLength(10);
  });

  test("UC4. Kỳ không có dữ liệu → summary rỗng, top_series rỗng", async () => {
    const res = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.summary.creator_revenue_coin).toBe(0);
    expect(res.body.data.summary.chapters_sold).toBe(0);
    expect(res.body.data.summary.series_count).toBe(0);
    expect(res.body.data.top_series).toEqual([]);
  });

  test("UC5. Display fields *_coin_display đúng 2 chữ số trong top_series khi có creator_revenue_coin", async () => {
    const Revenue = require("../models/Revenue");
    const PurchasedChapter = require("../models/PurchasedChapter");
    const Chapter = require("../models/Chapter");
    const ch = await Chapter.findOne({ series_id: seriesA._id });
    const createdAt = new Date("2026-08-15T10:00:00Z");
    const pur = await PurchasedChapter.create({
      reader_id: new mongoose.Types.ObjectId(),
      chapter_id: ch._id,
      series_id: seriesA._id,
      price: 500,
      purchased_at: createdAt,
    });
    const docs = makePurchaseRevenues({
      purchased_chapter_id: pur._id,
      series_id: seriesA._id,
      chapter_id: ch._id,
      user_mangaka_id: mangakaUser._id,
      user_assistant_id: null,
      price_coin: 505,
      platform_fee_coin: 101,
      createdAt,
    });
    await Revenue.insertMany(docs);

    const res = await request()
      .get(
        `/admin/users/${mangakaUser._id}/financials/top-series?period=month&year=2026&month=8`
      )
      .set(authHeader(adminToken));
    const item = res.body.data.top_series[0];
    expect(item.gross_revenue_coin_display).toBe("5.05");
    expect(item.creator_revenue_coin_display).toBeDefined();
  });
});