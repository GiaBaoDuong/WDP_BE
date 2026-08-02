/**
 * Thin wrapper around the official payOS Node.js SDK.
 *
 * Keeping the SDK behind this module makes mock mode deterministic and keeps
 * PayOS credentials out of routes/controllers.
 */
const crypto = require("crypto");
const { PayOS } = require("@payos/node");
const config = require("../config/payment");

let client;

function assertConfigured() {
  const missing = [];
  if (!config.payos.clientId) missing.push("PAYOS_CLIENT_ID");
  if (!config.payos.apiKey) missing.push("PAYOS_API_KEY");
  if (!config.payos.checksumKey) missing.push("PAYOS_CHECKSUM_KEY");

  if (missing.length) {
    throw new Error(`Thiếu cấu hình PayOS: ${missing.join(", ")}`);
  }
}

function getClient() {
  assertConfigured();
  if (!client) {
    client = new PayOS({
      clientId: config.payos.clientId,
      apiKey: config.payos.apiKey,
      checksumKey: config.payos.checksumKey,
    });
  }
  return client;
}

async function createPaymentLink(args) {
  const {
    orderCode,
    amount,
    description,
    returnUrl = config.payos.returnUrl,
    cancelUrl = config.payos.cancelUrl,
    items = [],
  } = args;

  if (!Number.isSafeInteger(orderCode) || orderCode <= 0) {
    throw new Error("orderCode phải là số nguyên dương an toàn");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || !description) {
    throw new Error("amount và description không hợp lệ");
  }

  if (config.payos.mock) {
    return {
      checkoutUrl: `${returnUrl}?orderCode=${orderCode}&mock=1`,
      paymentLinkId: `mock_${orderCode}`,
      mock: true,
    };
  }

  return getClient().paymentRequests.create({
    orderCode,
    amount,
    description,
    returnUrl,
    cancelUrl,
    items,
  });
}

/**
 * Verify a webhook and return its signed data. The SDK throws when the
 * signature is invalid; callers can treat that as an invalid request.
 */
function verifyWebhookData(webhookBody) {
  if (config.payos.mock) return webhookBody?.data || null;
  return getClient().webhooks.verify(webhookBody);
}

async function confirmWebhook(webhookUrl = config.payos.webhookUrl) {
  if (!webhookUrl) {
    throw new Error("Thiếu PAYOS_WEBHOOK_URL hoặc BACKEND_URL");
  }
  return getClient().webhooks.confirm(webhookUrl);
}

/**
 * payOS accepts a positive integer orderCode of at most 16 digits.
 * Timestamp + random suffix keeps it sortable while avoiding collisions.
 */
function generateOrderCode() {
  const timestamp = Date.now().toString().slice(-11);
  const random = crypto.randomInt(1000, 10000).toString();
  return Number(timestamp + random);
}

module.exports = {
  createPaymentLink,
  verifyWebhookData,
  confirmWebhook,
  generateOrderCode,
};
