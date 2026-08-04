const COIN_UNIT_SCALE = 100;

function coinError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function assertCoinUnits(value, fieldName = "coin_units", { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw coinError(`Invalid ${fieldName}`, "invalid_coin_units");
  }
  return value;
}

function coinToUnits(coinValue) {
  const normalized = String(coinValue).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw coinError("Invalid coin amount", "invalid_coin_amount");
  }
  const [wholePart, decimalPart = ""] = normalized.split(".");
  const units = BigInt(wholePart) * 100n + BigInt(decimalPart.padEnd(2, "0"));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw coinError("Coin amount exceeds safe range", "invalid_coin_amount");
  }
  return assertCoinUnits(Number(units));
}

function unitsToCoinString(units) {
  assertCoinUnits(units);
  return `${Math.floor(units / COIN_UNIT_SCALE)}.${String(units % COIN_UNIT_SCALE).padStart(2, "0")}`;
}

function unitsToVnd(units, coinToVndRate) {
  assertCoinUnits(units);
  if (!Number.isSafeInteger(coinToVndRate) || coinToVndRate < 0) {
    throw coinError("Invalid coin_to_vnd_rate", "invalid_coin_to_vnd_rate");
  }
  const amount = (BigInt(units) * BigInt(coinToVndRate)) / BigInt(COIN_UNIT_SCALE);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw coinError("Invalid VND amount", "invalid_vnd_amount");
  }
  return Number(amount);
}

function withCreatorVndBalances(wallet, coinToVndRate) {
  const source = wallet && wallet.toObject ? wallet.toObject() : { ...wallet };
  const pendingBalance = source.pending_balance ?? 0;
  const availableBalance = source.available_balance ?? 0;

  assertCoinUnits(pendingBalance, "pending_balance");
  assertCoinUnits(availableBalance, "available_balance");

  const currentBalance = pendingBalance + availableBalance;
  assertCoinUnits(currentBalance, "current_balance");

  return {
    ...source,
    current_balance: currentBalance,
    pending_balance_vnd: unitsToVnd(pendingBalance, coinToVndRate),
    available_balance_vnd: unitsToVnd(availableBalance, coinToVndRate),
    current_balance_vnd: unitsToVnd(currentBalance, coinToVndRate),
  };
}

function withWalletCoinDisplayFields(wallet) {
  const source = wallet && wallet.toObject ? wallet.toObject() : { ...wallet };
  const getDisplay = (field) => unitsToCoinString(source[field] ?? 0);

  return {
    ...source,
    balance_coin_display: getDisplay("balance"),
    available_balance_coin_display: getDisplay("available_balance"),
    pending_balance_coin_display: getDisplay("pending_balance"),
    total_revenue_coin_display: getDisplay("total_revenue"),
    total_withdrawn_coin_display: getDisplay("total_withdrawn"),
    total_deposited_coin_display: getDisplay("total_deposited"),
    total_spent_coin_display: getDisplay("total_spent"),
  };
}

function withCoinFields(value, fields) {
  if (!value) return value;
  const result = value.toObject ? value.toObject() : { ...value };
  for (const [rawField, displayField] of Object.entries(fields)) {
    if (result[rawField] !== undefined && result[rawField] !== null) {
      result[displayField] = unitsToCoinString(result[rawField]);
    }
  }
  result.coin_unit_scale = COIN_UNIT_SCALE;
  return result;
}

const DISPLAY_FIELDS = {
  balance: "balance_coin",
  pending_balance: "pending_balance_coin",
  available_balance: "available_balance_coin",
  total_deposited: "total_deposited_coin",
  total_spent: "total_spent_coin",
  total_revenue: "total_revenue_coin",
  total_withdrawn: "total_withdrawn_coin",
  coin_amount: "coin_amount_coin",
  bonus_coin: "bonus_coin_display",
  total_coin: "total_coin_display",
  coin_price: "coin_price_coin",
  gross_coin_amount: "gross_coin",
  platform_fee_coin: "platform_fee",
  net_coin_amount: "net_coin",
  total_gross_coin: "total_gross_coin_display",
  total_platform_fee_coin: "total_platform_fee_coin_display",
  pending_coin: "pending_coin_display",
  available_coin: "available_coin_display",
  withdrawn_coin: "withdrawn_coin_display",
  total_coin_spent: "total_coin_spent_display",
  price: "price_coin",
  coin: "coin_display",
  gross_coin: "gross_coin_display",
  net_coin: "net_coin_display",
  total_net_coin: "total_net_coin_display",
  total_coin_in_wallets: "total_coin_in_wallets_display",
  total_pending_revenue: "total_pending_revenue_display",
  total_available_revenue: "total_available_revenue_display",
  current_coin: "current_coin_display",
  current_balance: "current_balance_display",
  pending_revenue: "pending_revenue_display",
  total_deposit: "total_deposit_display",
  total_purchase: "total_purchase_display",
  total_withdrawal: "total_withdrawal_display",
  total_refund: "total_refund_display",
  total_coin_received: "total_coin_received_display",
  // Admin Finance fields
  total_circulation_coin: "total_circulation_coin_display",
  total_revenue_all_time_coin: "total_revenue_all_time_coin_display",
  total_platform_coin: "total_platform_coin_display",
  total_earnings_coin: "total_earnings_coin_display",
  current_balance_coin: "current_balance_coin_display",
  pending_balance_coin: "pending_balance_coin_display",
  revenue_coin: "revenue_coin_display",
  withdrawal_coin: "withdrawal_coin_display",
  net_flow_coin: "net_flow_coin_display",
  total_revenue_coin: "total_revenue_coin_display",
  avg_monthly_revenue_coin: "avg_monthly_revenue_coin_display",
  // Withdrawal stats fields
  pending_coin: "pending_coin_display",
  approved_coin: "approved_coin_display",
  completed_coin: "completed_coin_display",
  rejected_coin: "rejected_coin_display",
  cancelled_coin: "cancelled_coin_display",
};

function formatCoinResponse(payload) {
  const visit = (input) => {
    if (input === null || input === undefined) return { value: input, hasCoin: false };
    if (input instanceof Date || Buffer.isBuffer(input)) return { value: input, hasCoin: false };
    if (Array.isArray(input)) {
      let hasCoin = false;
      const value = input.map((item) => {
        const visited = visit(item);
        hasCoin ||= visited.hasCoin;
        return visited.value;
      });
      return { value, hasCoin };
    }
    if (typeof input !== "object" || typeof input.toHexString === "function") {
      return { value: input, hasCoin: false };
    }

    const source = input.toObject ? input.toObject() : input;
    const value = {};
    let hasCoin = false;
    let hasDirectCoin = false;
    for (const [key, item] of Object.entries(source)) {
      const visited = visit(item);
      value[key] = visited.value;
      hasCoin ||= visited.hasCoin;
    }
    for (const [rawField, displayField] of Object.entries(DISPLAY_FIELDS)) {
      if (Object.prototype.hasOwnProperty.call(source, rawField) && source[rawField] !== null) {
        assertCoinUnits(source[rawField], rawField);
        value[displayField] = unitsToCoinString(source[rawField]);
        hasCoin = true;
        hasDirectCoin = true;
      }
    }
    if (hasDirectCoin) value.coin_unit_scale = COIN_UNIT_SCALE;
    return { value, hasCoin };
  };

  const result = visit(payload);
  if (result.hasCoin && result.value && !Array.isArray(result.value) && typeof result.value === "object") {
    result.value.coin_unit_scale = COIN_UNIT_SCALE;
  }
  return result.value;
}

module.exports = {
  COIN_UNIT_SCALE,
  assertCoinUnits,
  coinToUnits,
  unitsToCoinString,
  unitsToVnd,
  withCreatorVndBalances,
  withWalletCoinDisplayFields,
  withCoinFields,
  formatCoinResponse,
};
