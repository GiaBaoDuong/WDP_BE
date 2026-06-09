const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");
const { sendOtp, verifyOtp } = require("../services/otpService");

const router = express.Router();

const EXPIRES_IN = 7 * 24 * 60 * 60;

const buildTokenPayload = (user) => ({
  nameid: user._id,
  unique_name: user.username,
  role: user.role,
});

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: EXPIRES_IN,
  });

const buildUserResponse = (user) => ({
  userId: user._id,
  accountId: user._id,
  username: user.username,
  email: user.email,
  fullName: user.full_name,
  role: user.role,
  isProMember: false,
  avatarUrl: user.avatar_url || "",
  proExpiredAt: null,
});

// ─── Step 1: Send OTP ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /auth/register/send-otp:
 *   post:
 *     summary: Gửi mã OTP đến email để xác thực đăng ký
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, full_name, email, role]
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *               full_name: { type: string }
 *               email: { type: string }
 *               role: { type: string, enum: [Mangaka, Assistant, Editor, EB, Reader] }
 *     responses:
 *       200: { description: OTP đã được gửi đến email }
 *       400: { description: Thiếu thông tin hoặc role không hợp lệ }
 *       409: { description: Username hoặc email đã tồn tại }
 *       500: { description: Lỗi gửi email }
 */
router.post("/register/send-otp", async (req, res) => {
  try {
    const { username, password, full_name, email, role } = req.body;

    if (!username || !password || !full_name || !email || !role) {
      return res.status(400).json({
        success: false,
        message: "All fields are required: username, password, full_name, email, role",
      });
    }

    const validRoles = ["Mangaka", "Assistant", "Editor", "EB", "Reader"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Role must be one of: ${validRoles.join(", ")}`,
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }

    const existingUser = await User.findOne({
      $or: [{ username }, { email }],
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Username or email already exists",
      });
    }

    await sendOtp({ email, purpose: "register" });

    return res.status(200).json({
      success: true,
      message: "Mã OTP đã được gửi đến email của bạn.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
});

// ─── Step 2: Verify OTP & Create Account ──────────────────────────────────────

/**
 * @swagger
 * /auth/register/verify-otp:
 *   post:
 *     summary: Xác thực OTP và hoàn tất đăng ký tài khoản
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password, full_name, email, role, otp]
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *               full_name: { type: string }
 *               email: { type: string }
 *               role: { type: string, enum: [Mangaka, Assistant, Editor, EB, Reader] }
 *               otp: { type: string, description: 6-digit OTP code sent to email }
 *     responses:
 *       201: { description: Đăng ký thành công }
 *       400: { description: Mã OTP không hợp lệ hoặc đã hết hạn }
 *       409: { description: Username hoặc email đã tồn tại }
 *       500: { description: Lỗi server }
 */
router.post("/register/verify-otp", async (req, res) => {
  try {
    const { username, password, full_name, email, role, otp } = req.body;

    if (!username || !password || !full_name || !email || !role || !otp) {
      return res.status(400).json({
        success: false,
        message: "All fields including otp are required",
      });
    }

    const { valid, reason } = await verifyOtp({ email, code: otp.trim(), purpose: "register" });

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: reason,
      });
    }

    const existingUser = await User.findOne({
      $or: [{ username }, { email }],
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Username or email already exists",
      });
    }

    await User.create({ username, password, full_name, email, role });

    return res.status(201).json({
      success: true,
      message: "Đăng ký tài khoản thành công!",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
});

// ─── Login (giữ nguyên) ───────────────────────────────────────────────────────

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Đăng nhập
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username: { type: string }
 *               password: { type: string }
 *     responses:
 *       200: { description: Đăng nhập thành công, trả về JWT token }
 *       401: { description: Sai username hoặc password }
 */
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required",
      });
    }

    const user = await User.findOne({ username }).select("+password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const payload = buildTokenPayload(user);
    const token = signToken(payload);

    return res.status(200).json({
      token,
      tokenType: "Bearer",
      expiresIn: EXPIRES_IN,
      user: buildUserResponse(user),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// ─── Get current user ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /auth/me:
 *   get:
 *     summary: Lấy thông tin user hiện tại
 *     tags: [Auth]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200: { description: Thông tin user }
 *       404: { description: User not found }
 */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.nameid);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      user: buildUserResponse(user),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

module.exports = router;
