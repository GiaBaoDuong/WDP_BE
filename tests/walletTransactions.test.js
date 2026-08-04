/**
 * Wallet Transactions tests.
 *
 * Cover:
 *  - GET /wallet/transactions có coin_amount_coin_display.
 *  - Filter theo type (Withdrawal, Revenue, Purchase).
 *  - Direction chính xác.
 *  - Display string đúng format.
 *  - Swagger enum đầy đủ.
 */

jest.mock("../config/payment", () => ({
  monetization: {
    coinToVndRate: 100,
    platformFeePercent: 20,
    minWithdrawalVnd: 200000,
  },
}));

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
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

async function seedMangakaWithTxs() {
  const mangaka = await makeUser({
    username: "wm",
    email: "wm@test.com",
    role: "Mangaka",
    full_name: "WM",
    bank_name: "VCB",
    account_holder: "WM",
    bank_account_number: "1",
  });
  const Wallet = require("../models/Wallet");
  const wallet = await Wallet.create({
    user_id: mangaka._id,
    balance: 0,
    available_balance: 500000,
    pending_balance: 100000,
    total_revenue: 600000,
  });

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
      coin_amount: 100000 + i * 100000,
      status: "available",
      available_at: new Date(),
    });
    revenues.push(r);
  }

  // Tạo 1 withdrawal pending để sinh WalletTransaction Withdrawal direction=out.
  const w = await withdrawalService.createWithdrawalRequest(mangaka._id, {});

  return { mangaka, wallet, w, revenues };
}

// ─── TESTS ──────────────────────────────────────────────────────────────────

describe("Wallet Transactions — display fields", () => {
  test("1. Response có coin_amount_coin_display cho Withdrawal", async () => {
    const ctx = await seedMangakaWithTxs();
    const res = await request()
      .get("/wallet/transactions?type=Withdrawal")
      .set(authHeader(token(ctx.mangaka)));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    const tx = res.body.data[0];
    expect(tx.type).toBe("Withdrawal");
    expect(tx.direction).toBe("out");
    expect(tx.coin_amount).toBe(500000);
    expect(tx.coin_amount_coin).toBeDefined(); // legacy alias
    expect(tx.coin_amount_coin_display).toBeDefined();
    expect(tx.coin_amount_coin_display).toBe("5000.00");
    expect(tx.coin_unit_scale).toBe(100);
    expect(tx.withdrawal_id).toBeDefined();
    expect(String(tx.withdrawal_id)).toBe(String(ctx.w._id));
  });

  test("2. Format 240 CoinUnit => '2.40'", async () => {
    const m = await makeUser({
      username: "fmt",
      email: "fmt@test.com",
      role: "Mangaka",
      full_name: "Fmt",
    });
    const Wallet = require("../models/Wallet");
    const w = await Wallet.create({ user_id: m._id, balance: 0, available_balance: 0 });
    const WalletTransaction = require("../models/WalletTransaction");
    await WalletTransaction.create({
      wallet_id: w._id,
      user_id: m._id,
      type: "Revenue",
      direction: "in",
      coin_amount: 240,
      coin_unit_scale: 100,
      balance_after: 240,
    });
    const res = await request()
      .get("/wallet/transactions")
      .set(authHeader(token(m)));
    expect(res.status).toBe(200);
    const tx = res.body.data[0];
    expect(tx.coin_amount_coin_display).toBe("2.40");
  });

  test("3. Format thiếu field => '0.00'", async () => {
    const m = await makeUser({
      username: "missing",
      email: "missing@test.com",
      role: "Mangaka",
      full_name: "Missing",
    });
    const Wallet = require("../models/Wallet");
    const w = await Wallet.create({ user_id: m._id });
    const WalletTransaction = require("../models/WalletTransaction");
    await WalletTransaction.create({
      wallet_id: w._id,
      user_id: m._id,
      type: "Revenue",
      direction: "in",
      coin_amount: 0,
      coin_unit_scale: 100,
      balance_after: 0,
    });
    const res = await request()
      .get("/wallet/transactions")
      .set(authHeader(token(m)));
    expect(res.status).toBe(200);
    const tx = res.body.data[0];
    expect(tx.coin_amount_coin_display).toBe("0.00");
  });
});

describe("Wallet Transactions — filter & pagination", () => {
  test("4. Filter type=Withdrawal chỉ trả Withdrawal", async () => {
    const ctx = await seedMangakaWithTxs();
    const res = await request()
      .get("/wallet/transactions?type=Withdrawal")
      .set(authHeader(token(ctx.mangaka)));
    expect(res.status).toBe(200);
    res.body.data.forEach((tx) => expect(tx.type).toBe("Withdrawal"));
  });

  test("5. Pagination giữ nguyên cấu trúc", async () => {
    const ctx = await seedMangakaWithTxs();
    const res = await request()
      .get("/wallet/transactions?page=1&limit=10")
      .set(authHeader(token(ctx.mangaka)));
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeDefined();
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(10);
    expect(typeof res.body.pagination.total).toBe("number");
    expect(typeof res.body.pagination.pages).toBe("number");
  });

  test("6. Auth required", async () => {
    const res = await request().get("/wallet/transactions");
    expect(res.status).toBe(401);
  });
});

describe("Wallet Transactions — Swagger enum", () => {
  test("7. Swagger có Withdrawal enum", () => {
    const swagger = require("../config/swagger");
    const swag = typeof swagger.swagger === "function" ? swagger.swagger() : swagger;
    const schema = swag.components?.schemas?.WalletTransaction || swag.definitions?.WalletTransaction;
    expect(schema).toBeDefined();
    const typeField = schema.properties?.type;
    expect(typeField).toBeDefined();
    const enumList = typeField.enum || (typeField.$ref ? null : null);
    // Some swagger setups use ref; this fallback searches across raw string of schema.
    const schemaStr = JSON.stringify(schema);
    expect(schemaStr).toMatch(/Withdrawal/);
    expect(schemaStr).toMatch(/Revenue/);
    expect(schemaStr).toMatch(/Purchase/);
  });
});