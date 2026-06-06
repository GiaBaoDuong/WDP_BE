const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

const EXPIRES_IN = 7 * 24 * 60 * 60; // 7 days in seconds

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

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Đăng ký tài khoản mới
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
 *       201: { description: Đăng ký thành công }
 *       409: { description: Username hoặc email đã tồn tại }
 */
router.post("/register", async (req, res) => {
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

    const existingUser = await User.findOne({
      $or: [{ username }, { email }],
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Username or email already exists",
      });
    }

    const user = await User.create({
      username,
      password,
      full_name,
      email,
      role,
    });

    return res.status(201).json({
      success: true,
      message: "Đăng ký thành công",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

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
