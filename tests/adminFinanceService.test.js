/**
 * Admin Finance Service Tests
 *
 * Unit tests cho adminFinanceService.js
 * Sử dụng mongodb-memory-server
 *
 * Run: npm test
 */

// Mock mongoose
jest.mock("mongoose", () => {
  const originalMongoose = jest.requireActual("mongoose");
  return {
    ...originalMongoose,
    connect: jest.fn().mockResolvedValue({}),
    disconnect: jest.fn().mockResolvedValue({}),
    connection: {
      readyState: 0,
      on: jest.fn(),
      once: jest.fn(),
      db: {
        createCollection: jest.fn().mockResolvedValue({}),
      },
    },
  };
});

// Mock config
jest.mock("../config/payment", () => ({
  monetization: {
    coinToVndRate: 100,
    platformFeePercent: 20,
    minWithdrawalVnd: 200000,
  },
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const adminFinanceService = require("../services/adminFinanceService");

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  const User = require("../models/User");
  const Wallet = require("../models/Wallet");
  const Revenue = require("../models/Revenue");
  const Withdrawal = require("../models/Withdrawal");
  const Series = require("../models/Series");

  await Promise.all([
    User.deleteMany({}),
    Wallet.deleteMany({}),
    Revenue.deleteMany({}),
    Withdrawal.deleteMany({}),
    Series.deleteMany({}),
  ]);
});

// ─── SERVICE UNIT TESTS ─────────────────────────────────────────────────────

describe("Admin Finance Service", () => {
  describe("getFinanceSummary", () => {
    test("1. Returns zeros for empty database", async () => {
      const result = await adminFinanceService.getFinanceSummary();

      expect(result.total_circulation_coin).toBe(0);
      expect(result.total_revenue_all_time_coin).toBe(0);
      expect(result.total_withdrawn_vnd).toBe(0);
      expect(result.total_platform_coin).toBe(0);
      expect(result.pending_withdrawals.count).toBe(0);
      expect(result.pending_withdrawals.coin).toBe(0);
      expect(result.total_users_with_balance).toBe(0);
      expect(result.coin_to_vnd_rate).toBe(100);
    });

    test("2. total_circulation_coin = balance + pending + available", async () => {
      const User = require("../models/User");
      const Wallet = require("../models/Wallet");

      const user = await User.create({
        username: "test_user",
        password: "password123",
        full_name: "Test User",
        email: "test@test.com",
        role: "Mangaka",
      });

      await Wallet.create({
        user_id: user._id,
        balance: 1000,
        pending_balance: 2000,
        available_balance: 3000,
      });

      const result = await adminFinanceService.getFinanceSummary();

      // 1000 + 2000 + 3000 = 6000
      expect(result.total_circulation_coin).toBe(6000);
    });

    test("3. Does NOT include total_revenue in circulation", async () => {
      const User = require("../models/User");
      const Wallet = require("../models/Wallet");

      const user = await User.create({
        username: "test_user2",
        password: "password123",
        full_name: "Test User 2",
        email: "test2@test.com",
        role: "Mangaka",
      });

      await Wallet.create({
        user_id: user._id,
        balance: 1000,
        pending_balance: 2000,
        available_balance: 3000,
        total_revenue: 100000, // Should NOT be added to circulation
        total_withdrawn: 50000, // Should NOT be added to circulation
      });

      const result = await adminFinanceService.getFinanceSummary();

      // Should be 6000, NOT 106000
      expect(result.total_circulation_coin).toBe(6000);
    });

    test("4. total_revenue_all_time_coin = SUM Revenue.coin_amount", async () => {
      const User = require("../models/User");
      const Revenue = require("../models/Revenue");

      const user = await User.create({
        username: "test_user3",
        password: "password123",
        full_name: "Test User 3",
        email: "test3@test.com",
        role: "Mangaka",
      });

      await Revenue.create({
        user_id: user._id,
        user_role: "Mangaka",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 5000,
        platform_fee_coin: 1000,
        net_coin_amount: 4000,
        coin_amount: 3000,
      });

      await Revenue.create({
        user_id: user._id,
        user_role: "Mangaka",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 3000,
        platform_fee_coin: 600,
        net_coin_amount: 2400,
        coin_amount: 2000,
      });

      const result = await adminFinanceService.getFinanceSummary();

      // 3000 + 2000 = 5000
      expect(result.total_revenue_all_time_coin).toBe(5000);
    });

    test("5. total_withdrawn_vnd only counts completed withdrawals", async () => {
      const User = require("../models/User");
      const Withdrawal = require("../models/Withdrawal");

      const user = await User.create({
        username: "test_user4",
        password: "password123",
        full_name: "Test User 4",
        email: "test4@test.com",
        role: "Mangaka",
      });

      await Withdrawal.create({
        user_id: user._id,
        user_role: "Mangaka",
        coin_amount: 50000,
        vnd_amount: 500000,
        status: "completed",
        processed_at: new Date(),
      });

      await Withdrawal.create({
        user_id: user._id,
        user_role: "Mangaka",
        coin_amount: 30000,
        vnd_amount: 300000,
        status: "pending",
      });

      await Withdrawal.create({
        user_id: user._id,
        user_role: "Mangaka",
        coin_amount: 20000,
        vnd_amount: 200000,
        status: "rejected",
      });

      const result = await adminFinanceService.getFinanceSummary();

      // Only completed: 500000
      expect(result.total_withdrawn_vnd).toBe(500000);
    });

    test("6. pending_withdrawals only counts pending status", async () => {
      const User = require("../models/User");
      const Withdrawal = require("../models/Withdrawal");

      const user = await User.create({
        username: "test_user5",
        password: "password123",
        full_name: "Test User 5",
        email: "test5@test.com",
        role: "Mangaka",
      });

      await Withdrawal.create({
        user_id: user._id,
        user_role: "Mangaka",
        coin_amount: 50000,
        vnd_amount: 500000,
        status: "pending",
      });

      await Withdrawal.create({
        user_id: user._id,
        user_role: "Mangaka",
        coin_amount: 30000,
        vnd_amount: 300000,
        status: "completed",
      });

      const result = await adminFinanceService.getFinanceSummary();

      expect(result.pending_withdrawals.count).toBe(1);
      expect(result.pending_withdrawals.coin).toBe(50000);
    });

    test("7. total_platform_coin is always 0", async () => {
      const result = await adminFinanceService.getFinanceSummary();
      expect(result.total_platform_coin).toBe(0);
    });
  });

  describe("getRevenueByRole", () => {
    test("8. Returns roles present in database", async () => {
      const User = require("../models/User");

      await User.create({
        username: "manga_test",
        password: "password123",
        full_name: "Mangaka Test",
        email: "manga@test.com",
        role: "Mangaka",
      });

      await User.create({
        username: "assist_test",
        password: "password123",
        full_name: "Assistant Test",
        email: "assist@test.com",
        role: "Assistant",
      });

      const result = await adminFinanceService.getRevenueByRole();

      expect(result.roles.length).toBeGreaterThan(0);
      const roles = result.roles.map((r) => r.role);
      expect(roles).toContain("Mangaka");
      expect(roles).toContain("Assistant");
    });

    test("9. User without wallet has zero amounts", async () => {
      const User = require("../models/User");

      await User.create({
        username: "orphan_user",
        password: "password123",
        full_name: "Orphan User",
        email: "orphan@test.com",
        role: "Mangaka",
      });

      const result = await adminFinanceService.getRevenueByRole();

      const mangakaRole = result.roles.find((r) => r.role === "Mangaka");
      expect(mangakaRole.total_earnings_coin).toBe(0);
      expect(mangakaRole.total_withdrawn_coin).toBe(0);
      expect(mangakaRole.current_balance_coin).toBe(0);
      expect(mangakaRole.pending_balance_coin).toBe(0);
    });

    test("10. total_circulation_coin = sum of all role balances", async () => {
      const User = require("../models/User");
      const Wallet = require("../models/Wallet");

      const user1 = await User.create({
        username: "user_circ1",
        password: "password123",
        full_name: "User Circ 1",
        email: "circ1@test.com",
        role: "Mangaka",
      });

      const user2 = await User.create({
        username: "user_circ2",
        password: "password123",
        full_name: "User Circ 2",
        email: "circ2@test.com",
        role: "Assistant",
      });

      await Wallet.create({
        user_id: user1._id,
        balance: 0,
        available_balance: 10000,
        pending_balance: 5000,
      });

      await Wallet.create({
        user_id: user2._id,
        balance: 0,
        available_balance: 8000,
        pending_balance: 3000,
      });

      const result = await adminFinanceService.getRevenueByRole();

      // 10000 + 5000 + 8000 + 3000 = 26000
      expect(result.total_circulation_coin).toBe(26000);
    });
  });

  describe("getRevenueTimeline", () => {
    test("11. Default period is 30d", async () => {
      const result = await adminFinanceService.getRevenueTimeline();
      expect(result.period).toBe("30d");
    });

    test("12. Returns empty points for no data", async () => {
      const result = await adminFinanceService.getRevenueTimeline("all");

      expect(result.points).toEqual([]);
      expect(result.summary.total_revenue_coin).toBe(0);
      expect(result.summary.total_withdrawal_coin).toBe(0);
      expect(result.summary.net_flow_coin).toBe(0);
    });

    test("13. Throws error for invalid period", async () => {
      await expect(adminFinanceService.getRevenueTimeline("invalid")).rejects.toThrow(
        "Invalid period"
      );
    });

    test("14. net_flow_coin = revenue - withdrawal", async () => {
      const User = require("../models/User");
      const Revenue = require("../models/Revenue");
      const Withdrawal = require("../models/Withdrawal");

      const user = await User.create({
        username: "timeline_user",
        password: "password123",
        full_name: "Timeline User",
        email: "timeline@test.com",
        role: "Mangaka",
      });

      await Revenue.create({
        user_id: user._id,
        user_role: "Mangaka",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 5000,
        platform_fee_coin: 1000,
        net_coin_amount: 4000,
        coin_amount: 3000,
      });

      await Withdrawal.create({
        user_id: user._id,
        user_role: "Mangaka",
        coin_amount: 1000,
        vnd_amount: 10000,
        status: "completed",
        processed_at: new Date(),
      });

      const result = await adminFinanceService.getRevenueTimeline("all");

      expect(result.summary.net_flow_coin).toBe(
        result.summary.total_revenue_coin - result.summary.total_withdrawal_coin
      );
    });
  });

  describe("getTopEarners", () => {
    test("15. Returns empty array for no revenue", async () => {
      const result = await adminFinanceService.getTopEarners();
      expect(result.earners).toEqual([]);
    });

    test("16. Filter by Mangaka role", async () => {
      const User = require("../models/User");
      const Revenue = require("../models/Revenue");

      const mangaka = await User.create({
        username: "top_manga",
        password: "password123",
        full_name: "Top Mangaka",
        email: "topmanga@test.com",
        role: "Mangaka",
      });

      const assistant = await User.create({
        username: "top_assist",
        password: "password123",
        full_name: "Top Assistant",
        email: "topassist@test.com",
        role: "Assistant",
      });

      await Revenue.create({
        user_id: mangaka._id,
        user_role: "Mangaka",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 5000,
        platform_fee_coin: 1000,
        net_coin_amount: 4000,
        coin_amount: 3000,
      });

      await Revenue.create({
        user_id: assistant._id,
        user_role: "Assistant",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 3000,
        platform_fee_coin: 600,
        net_coin_amount: 2400,
        coin_amount: 1500,
      });

      const result = await adminFinanceService.getTopEarners({ role: "Mangaka" });

      expect(result.earners.length).toBe(1);
      expect(result.earners[0].role).toBe("Mangaka");
      expect(result.earners[0].total_earnings_coin).toBe(3000);
    });

    test("17. Throws error for invalid role", async () => {
      await expect(
        adminFinanceService.getTopEarners({ role: "Admin" })
      ).rejects.toThrow("Invalid role");
    });

    test("18. Default limit is 10, max is 50", async () => {
      const User = require("../models/User");
      const Revenue = require("../models/Revenue");

      for (let i = 0; i < 60; i++) {
        const user = await User.create({
          username: `user_${i}`,
          password: "password123",
          full_name: `User ${i}`,
          email: `user${i}@test.com`,
          role: "Mangaka",
        });

        await Revenue.create({
          user_id: user._id,
          user_role: "Mangaka",
          series_id: new mongoose.Types.ObjectId(),
          chapter_id: new mongoose.Types.ObjectId(),
          purchased_chapter_id: new mongoose.Types.ObjectId(),
          reader_id: new mongoose.Types.ObjectId(),
          gross_coin_amount: 1000,
          platform_fee_coin: 200,
          net_coin_amount: 800,
          coin_amount: 500 + i * 100,
        });
      }

      const result = await adminFinanceService.getTopEarners();

      // Should be limited to 10 by default
      expect(result.earners.length).toBe(10);

      const maxResult = await adminFinanceService.getTopEarners({ limit: 100 });
      // Should be capped at 50
      expect(maxResult.earners.length).toBe(50);
    });

    test("19. Sorted by total_earnings_coin descending", async () => {
      const User = require("../models/User");
      const Revenue = require("../models/Revenue");

      const user1 = await User.create({
        username: "low_earner",
        password: "password123",
        full_name: "Low Earner",
        email: "low@test.com",
        role: "Mangaka",
      });

      const user2 = await User.create({
        username: "high_earner",
        password: "password123",
        full_name: "High Earner",
        email: "high@test.com",
        role: "Mangaka",
      });

      await Revenue.create({
        user_id: user1._id,
        user_role: "Mangaka",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 1000,
        platform_fee_coin: 200,
        net_coin_amount: 800,
        coin_amount: 1000,
      });

      await Revenue.create({
        user_id: user2._id,
        user_role: "Mangaka",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 5000,
        platform_fee_coin: 1000,
        net_coin_amount: 4000,
        coin_amount: 5000,
      });

      const result = await adminFinanceService.getTopEarners();

      expect(result.earners[0].total_earnings_coin).toBe(5000);
      expect(result.earners[1].total_earnings_coin).toBe(1000);
    });

    test("20. avg_monthly_revenue_coin is integer", async () => {
      const User = require("../models/User");
      const Revenue = require("../models/Revenue");

      const user = await User.create({
        username: "monthly_user",
        password: "password123",
        full_name: "Monthly User",
        email: "monthly@test.com",
        role: "Mangaka",
      });

      // Create revenue in 2 different months
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);

      await Revenue.create({
        user_id: user._id,
        user_role: "Mangaka",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 5000,
        platform_fee_coin: 1000,
        net_coin_amount: 4000,
        coin_amount: 6000,
        createdAt: now,
      });

      await Revenue.create({
        user_id: user._id,
        user_role: "Mangaka",
        series_id: new mongoose.Types.ObjectId(),
        chapter_id: new mongoose.Types.ObjectId(),
        purchased_chapter_id: new mongoose.Types.ObjectId(),
        reader_id: new mongoose.Types.ObjectId(),
        gross_coin_amount: 3000,
        platform_fee_coin: 600,
        net_coin_amount: 2400,
        coin_amount: 4000,
        createdAt: lastMonth,
      });

      const result = await adminFinanceService.getTopEarners();

      // 10000 total / 2 months = 5000
      expect(result.earners[0].avg_monthly_revenue_coin).toBe(5000);
      expect(Number.isInteger(result.earners[0].avg_monthly_revenue_coin)).toBe(true);
    });
  });
});
