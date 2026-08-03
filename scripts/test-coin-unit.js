const assert = require("node:assert/strict");
const {
  COIN_UNIT_SCALE,
  coinToUnits,
  unitsToCoinString,
  unitsToVnd,
  withCreatorVndBalances,
  formatCoinResponse,
} = require("../utils/coinUnit");
const { allocateUnits, roundPercentageOfUnits } = require("../services/revenueService");
const Wallet = require("../models/Wallet");
const Chapter = require("../models/Chapter");
const CoinPackage = require("../models/CoinPackage");

async function expectValidationError(document) {
  let failed = false;
  try {
    await document.validate();
  } catch (_error) {
    failed = true;
  }
  assert.equal(failed, true);
}

async function main() {
  assert.equal(COIN_UNIT_SCALE, 100);
  assert.equal(coinToUnits("1"), 100);
  assert.equal(coinToUnits("5"), 500);
  assert.equal(coinToUnits("2.40"), 240);
  assert.equal(coinToUnits("125.50"), 12550);
  assert.equal(unitsToCoinString(240), "2.40");
  assert.throws(() => coinToUnits("1.234"), /Invalid coin amount/);
  assert.throws(() => coinToUnits("-1"), /Invalid coin amount/);

  const shares = [
    { user_id: "m", role: "Mangaka", percentage: 60 },
    { user_id: "a", role: "Assistant", percentage: 40 },
  ];
  assert.equal(roundPercentageOfUnits(500, 20), 100);
  assert.deepEqual(allocateUnits(400, shares).map((item) => item.floor), [240, 160]);
  assert.deepEqual(allocateUnits(100, shares).map((item) => item.floor), [60, 40]);
  assert.equal(unitsToVnd(25050, 100), 25050);

  const creatorWallet = withCreatorVndBalances(
    { pending_balance: 240, available_balance: 160 },
    100
  );
  assert.equal(creatorWallet.current_balance, 400);
  assert.equal(creatorWallet.pending_balance_vnd, 240);
  assert.equal(creatorWallet.available_balance_vnd, 160);
  assert.equal(creatorWallet.current_balance_vnd, 400);

  const formatted = formatCoinResponse({ success: true, data: { balance: 12550, pending_balance: 240 } });
  assert.equal(formatted.data.balance, 12550);
  assert.equal(formatted.data.balance_coin, "125.50");
  assert.equal(formatted.data.pending_balance_coin, "2.40");
  assert.equal(formatted.coin_unit_scale, 100);

  const chapter = new Chapter({
    series_id: "64b000000000000000000001",
    chapter_number: 2,
    submitted_by: "64b000000000000000000002",
  });
  assert.equal(chapter.coin_price, 500);
  await chapter.validate();

  const wallet = new Wallet({ user_id: "64b000000000000000000003", balance: 1.5 });
  await expectValidationError(wallet);
  const negativeWallet = new Wallet({ user_id: "64b000000000000000000004", balance: -1 });
  await expectValidationError(negativeWallet);

  const pkg = new CoinPackage({ name: "Test", price_vnd: 1000, coin_amount: 50000, bonus_coin: 2000 });
  await pkg.validate();
  assert.equal(pkg.total_coin, 52000);

  console.log("CoinUnit tests passed: conversion, validation, 60/40 revenue, withdrawal, API display, defaults");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
