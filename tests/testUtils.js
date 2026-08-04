/**
 * Test bootstrap helpers.
 *
 * Quy tắc:
 * - `app.js` KHÔNG tự kết nối database khi import. Production start (bin/www)
 *   vẫn gọi connectAndSeedDatabase như cũ.
 * - Mỗi test file dùng setupTestApp() để tạo một mongodb-memory-server,
 *   kết nối mongoose, rồi mới require app qua buildApp().
 * - setupTestApp() return { app, request } để test đó dùng Supertest.
 * - teardownTestApp() đóng kết nối, dừng memory server.
 */

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const request = require("supertest");

let mongoServer;

async function setupTestApp() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  // Sử dụng Replica Set để hỗ trợ MongoDB transactions trong test
  // (MongoMemoryServer mặc định là standalone không hỗ trợ transactions).
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);

  // Require app AFTER connection so any model registration uses memory server.
  const { buildApp } = require("../app");
  const { app } = buildApp();
  return { app, request: (r) => request(app) };
}

async function teardownTestApp() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
    mongoServer = null;
  }
}

async function clearDatabase() {
  const collections = mongoose.connection.collections
    ? Object.values(mongoose.connection.collections)
    : [];
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/**
 * Tạo User test nhanh — hỗ trợ role, bank info, optional password.
 */
async function makeUser({
  username,
  email,
  role = "Reader",
  full_name,
  bank_name,
  account_holder,
  bank_account_number,
  password = "password123",
}) {
  const User = require("../models/User");
  return User.create({
    username,
    password,
    full_name: full_name || username,
    email,
    role,
    bank_name: bank_name || undefined,
    account_holder: account_holder || undefined,
    bank_account_number: bank_account_number || undefined,
  });
}

/**
 * Tạo JWT token cho user — nameid là _id stringified (giống auth middleware).
 */
function makeToken(user, secret, extra = {}) {
  const jwt = require("jsonwebtoken");
  const userId = typeof user === "string" ? user : String(user._id || user.id);
  return jwt.sign(
    { nameid: userId, role: user.role || extra.role, ...extra },
    secret,
    { expiresIn: "1h" }
  );
}

module.exports = {
  setupTestApp,
  teardownTestApp,
  clearDatabase,
  makeUser,
  makeToken,
};
