/**
 * PayOS service - Wrapper cho PayOS REST API.
 *
 * Hỗ trợ:
 *   - createPaymentLink({ orderCode, amount, description, returnUrl, cancelUrl, items })
 *     → { checkoutUrl, paymentLinkId, qrCode }
 *   - verifyWebhookData(payload)
 *     → boolean (true nếu chữ ký hợp lệ)
 *
 * Khi PAYOS_MOCK=true:
 *   - createPaymentLink trả về URL trỏ về /api/payments/mock-complete?orderCode=...
 *     để frontend/test redirect ngay → webhook được gọi local.
 *   - verifyWebhookData luôn trả true (dùng cho test).
 *
 * Việc cài SDK chính thức (@payos/node) là tuỳ chọn - nếu KHÔNG có trong node_modules
 * thì service sẽ tự fallback sang gọi HTTP thuần (axios không có sẵn, dùng https).
 * Phần HTTP thuần chỉ làm skeleton - nếu môi trường prod cần SDK thật, cài thêm:
 *   npm i @payos/node
 */
const crypto = require("crypto");
const config = require("../config/payment");

let payosSdk = null;
try {
  payosSdk = require("@payos/node");
} catch (_) {
  payosSdk = null;
}

/**
 * Sắp xếp object theo key (PayOS yêu cầu ký trên chuỗi sort theo key a-z).
 */
const sortObject = (obj) => {
  const sorted = {};
  Object.keys(obj)
    .sort()
    .forEach((k) => {
      sorted[k] = obj[k];
    });
  return sorted;
};

/**
 * Tính checksum PayOS cho payload.
 * Thuật toán: HMAC_SHA256(checksumKey, "?k1=v1&k2=v2...") - các key sort a-z,
 * value ký là raw value (không JSON stringify).
 */
const createSignature = (data, key) => {
  const sorted = sortObject(data);
  const str = Object.entries(sorted)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return crypto.createHmac("sha256", key).update(str).digest("hex");
};

/**
 * Tạo payment link PayOS.
 *
 * @param {Object} args
 * @param {number} args.orderCode      Số nguyên duy nhất (do server cấp)
 * @param {number} args.amount         Số tiền VNĐ
 * @param {string} args.description    Mô tả hiển thị cho user
 * @param {string} [args.returnUrl]    URL frontend sau khi thanh toán thành công
 * @param {string} [args.cancelUrl]    URL frontend khi user huỷ
 * @param {Array}  [args.items]        Danh sách item (PayOS yêu cầu)
 *
 * @returns {Promise<{checkoutUrl: string, paymentLinkId: string}>}
 */
async function createPaymentLink(args) {
  const {
    orderCode,
    amount,
    description,
    returnUrl = config.payos.returnUrl,
    cancelUrl = config.payos.cancelUrl,
    items = [],
  } = args;

  if (!orderCode || !amount || !description) {
    throw new Error("orderCode, amount, description are required");
  }

  // ─── Mock mode (cho dev) ───────────────────────────────────────────────
  if (config.payos.mock) {
    return {
      checkoutUrl: `${returnUrl}?orderCode=${orderCode}&mock=1`,
      paymentLinkId: `mock_${orderCode}`,
      mock: true,
    };
  }

  // ─── Thật: dùng SDK nếu có ────────────────────────────────────────────
  if (payosSdk && typeof payosSdk.PayOS === "function") {
    const payos = new payosSdk.PayOS({
      clientId: config.payos.clientId,
      apiKey: config.payos.apiKey,
      checksumKey: config.payos.checksumKey,
    });
    const result = await payos.createPaymentLink({
      orderCode,
      amount,
      description,
      returnUrl,
      cancelUrl,
      items,
    });
    return {
      checkoutUrl: result.checkoutUrl,
      paymentLinkId: result.paymentLinkId,
    };
  }

  // ─── Fallback: HTTP thuần (nếu SDK không khả dụng) ────────────────────
  // Tạo signature trên payload
  const payload = {
    orderCode,
    amount,
    description,
    returnUrl,
    cancelUrl,
    items: JSON.stringify(items),
    expiredAt: Math.floor(Date.now() / 1000) + 15 * 60,
  };
  payload.signature = createSignature(payload, config.payos.checksumKey);

  const https = require("https");
  const url = new URL("/v2/payment-requests", config.payos.baseUrl);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          "x-client-id": config.payos.clientId,
          "x-api-key": config.payos.apiKey,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.code !== 0 && json.code !== "00") {
              return reject(new Error(json.desc || "PayOS error"));
            }
            resolve({
              checkoutUrl: json.data?.checkoutUrl || "",
              paymentLinkId: json.data?.paymentLinkId || "",
            });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Xác thực dữ liệu webhook PayOS.
 *
 * PayOS gửi về object { code, desc, data, signature }.
 * Trong data có { orderCode, amount, description, accountNumber, reference,
 * transactionDateTime, paymentLinkId, code (SUCCESS|CANCELLED|...), ... }.
 *
 * Trả về:
 *   - true  : chữ ký hợp lệ
 *   - false : chữ ký sai
 *
 * Khi PAYOS_MOCK=true → luôn trả true.
 */
function verifyWebhookData(webhookBody) {
  if (config.payos.mock) {
    return true;
  }

  if (!webhookBody || typeof webhookBody !== "object") return false;
  const { signature, data } = webhookBody;
  if (!signature || !data) return false;
  if (!config.payos.checksumKey) return false;

  // PayOS ký trên data đã sort theo key, các value là raw
  const expected = createSignature(data, config.payos.checksumKey);
  return expected === signature;
}

/**
 * Sinh orderCode duy nhất (số nguyên dương, max 16 chữ số theo yêu cầu PayOS).
 * 6 chữ số timestamp (ms) + 10 chữ số random.
 */
function generateOrderCode() {
  const ts = Date.now().toString().slice(-6);
  const rand = crypto.randomInt(1000000000, 9999999999).toString();
  return Number(ts + rand);
}

module.exports = {
  createPaymentLink,
  verifyWebhookData,
  generateOrderCode,
  createSignature, // export để test
};