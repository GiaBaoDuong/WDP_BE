const nodemailer = require("nodemailer");

let transporter = null;

const createTransporter = () => {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  return transporter;
};

const sendEmail = async ({ to, subject, html }) => {
  try {
    const transport = createTransporter();
    await transport.sendMail({
      from: `"WDP Manga" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error("Email send error:", error.message);
    return false;
  }
};

module.exports = { sendEmail };
