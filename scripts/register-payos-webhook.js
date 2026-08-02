/**
 * Register and validate this backend's webhook URL with payOS.
 * Usage: npm run payos:webhook
 */
const config = require("../config/payment");
const payos = require("../services/payosService");

async function main() {
  if (config.payos.mock) {
    throw new Error("Hãy đặt PAYOS_MOCK=false trước khi đăng ký webhook thật");
  }

  const result = await payos.confirmWebhook();
  console.log("Đã kết nối webhook PayOS:", result.webhookUrl || config.payos.webhookUrl);
}

main().catch((error) => {
  console.error("Không thể kết nối webhook PayOS:", error.message);
  process.exitCode = 1;
});
