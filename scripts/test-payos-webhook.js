const assert = require("node:assert/strict");

process.env.PAYOS_MOCK = "true";

const express = require("express");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

async function main() {
  const mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });

  try {
    await mongoose.connect(mongo.getUri());

    const User = require("../models/User");
    const CoinPackage = require("../models/CoinPackage");
    const Payment = require("../models/Payment");
    const Wallet = require("../models/Wallet");
    const WalletTransaction = require("../models/WalletTransaction");

    const reader = await User.create({
      username: "payos-reader",
      password: "123456",
      full_name: "PayOS Reader",
      email: "payos-reader@example.com",
      phoneNumber: "0900000000",
      role: "Reader",
    });
    const coinPackage = await CoinPackage.create({
      name: "Webhook test package",
      price_vnd: 20000,
      coin_amount: 20000,
      bonus_coin: 0,
    });
    const payment = await Payment.create({
      user_id: reader._id,
      coin_package_id: coinPackage._id,
      order_code: 123456789012,
      amount_vnd: 20000,
      coin_amount: 20000,
      status: "expired",
      expires_at: new Date(Date.now() - 1000),
      expired_at: new Date(),
    });

    const app = express();
    app.use(express.json());
    app.use("/payments", require("../routes/payments"));

    const successPayload = {
      code: "00",
      desc: "success",
      success: true,
      data: {
        orderCode: payment.order_code,
        amount: payment.amount_vnd,
        description: "Webhook test",
        code: "00",
      },
      signature: "mock",
    };

    const first = await request(app)
      .post("/payments/payos/webhook")
      .send(successPayload);
    assert.equal(first.status, 200);

    const paidPayment = await Payment.findById(payment._id).lean();
    const walletAfterFirst = await Wallet.findOne({ user_id: reader._id }).lean();
    assert.equal(paidPayment.status, "paid");
    assert.equal(paidPayment.expired_at, null);
    assert.equal(walletAfterFirst.balance, 20000);
    assert.equal(walletAfterFirst.total_deposited, 20000);
    assert.equal(
      await WalletTransaction.countDocuments({ payment_id: payment._id }),
      1
    );

    // PayOS có thể retry cùng webhook. Lần hai phải trả 200 nhưng không cộng lại.
    const duplicate = await request(app)
      .post("/payments/payos/webhook")
      .send(successPayload);
    assert.equal(duplicate.status, 200);

    const walletAfterDuplicate = await Wallet.findOne({
      user_id: reader._id,
    }).lean();
    assert.equal(walletAfterDuplicate.balance, 20000);
    assert.equal(
      await WalletTransaction.countDocuments({ payment_id: payment._id }),
      1
    );

    // Payload thiếu orderCode phải dừng ở validation, không được gây Cast NaN/500.
    const invalid = await request(app)
      .post("/payments/payos/webhook")
      .send({
        code: "00",
        data: { amount: 20000, code: "00" },
        signature: "mock",
      });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.message, "Invalid orderCode");

    console.log("[PayOS webhook] All tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch((error) => {
  console.error("[PayOS webhook] Test failed:", error);
  process.exitCode = 1;
});
