const OTP = require("../models/OTP");
const { sendEmail } = require("./emailService");

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;

const generateCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const buildEmailHtml = (code) => `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; border: 1px solid #e0e0e0; border-radius: 8px;">
    <h2 style="color: #1a1a1a; margin-bottom: 8px;">Mã xác thực WDP Manga</h2>
    <p style="color: #555; font-size: 15px; margin-bottom: 24px;">
      Cảm ơn bạn đã đăng ký tài khoản WDP Manga. Vui lòng sử dụng mã bên dưới để xác minh email của bạn:
    </p>
    <div style="background: #f5f5f5; border-radius: 6px; padding: 20px; text-align: center; margin-bottom: 24px;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2563eb; font-family: monospace;">
        ${code}
      </span>
    </div>
    <p style="color: #888; font-size: 13px; margin-bottom: 0;">
      Mã này có hiệu lực trong <strong>${OTP_EXPIRY_MINUTES} phút</strong>. Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email.
    </p>
  </div>
`;

const sendOtp = async ({ email, purpose = "register" }) => {
  const code = generateCode();
  const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await OTP.deleteMany({ email, purpose, is_used: false });

  await OTP.create({ email, code, purpose, expires_at });

  const subject =
    purpose === "register"
      ? "WDP Manga — Mã xác thực đăng ký tài khoản"
      : "WDP Manga — Mã đặt lại mật khẩu";

  const sent = await sendEmail({
    to: email,
    subject,
    html: buildEmailHtml(code),
  });

  if (!sent) {
    throw new Error("Không thể gửi mã OTP qua email. Vui lòng kiểm tra cấu hình email.");
  }

  return { expires_at };
};

const verifyOtp = async ({ email, code, purpose = "register" }) => {
  const record = await OTP.findOne({ email, purpose, is_used: false }).sort({
    created_at: -1,
  });

  if (!record) {
    return { valid: false, reason: "Mã OTP không tồn tại hoặc đã hết hạn." };
  }

  if (new Date() > record.expires_at) {
    return { valid: false, reason: "Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới." };
  }

  if (record.code !== code) {
    return { valid: false, reason: "Mã OTP không đúng." };
  }

  await OTP.updateOne({ _id: record._id }, { is_used: true });
  return { valid: true };
};

module.exports = { sendOtp, verifyOtp };
