/**
 * Profile routes - Cho Reader/Mangaka/Assistant cập nhật thông tin cá nhân + bank info.
 *
 *  GET   /profile                  - Lấy profile hiện tại (gồm bank info masked)
 *  PATCH /profile                  - Cập nhật full_name, bio, avatar (optional)
 *  PATCH /profile/bank-information - Cập nhật thông tin ngân hàng
 *                                     Bắt buộc nhập current_password để xác thực
 */
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/auth");
const { AppError } = require("../middleware/errorHandler");
const User = require("../models/User");

const maskAccountNumber = (acc) => {
  if (!acc) return "";
  if (acc.length <= 4) return "********";
  return "********" + acc.slice(-4);
};

const shapeUser = (user) => {
  const u = user.toObject ? user.toObject() : user;
  return {
    _id: u._id,
    username: u.username,
    full_name: u.full_name,
    email: u.email,
    phoneNumber: u.phoneNumber || "",
    role: u.role,
    bio: u.bio || "",
    avatar_url: u.avatar_url || "",
    cover_image_url: u.cover_image_url || "",
    social_links: u.social_links || { facebook: "", twitter: "", website: "" },
    bank_info: {
      bank_name: u.bank_name || "",
      account_holder: u.account_holder || "",
      account_number_masked: maskAccountNumber(u.bank_account_number),
      has_account_number: !!u.bank_account_number,
      has_bank_info: !!(
        u.bank_name &&
        u.account_holder &&
        u.bank_account_number
      ),
    },
  };
};

// ─── GET /profile ─────────────────────────────────────────────────────────────
/**
 * @swagger
 * /profile:
 *   get:
 *     summary: Lấy profile của current user (kèm bank info masked)
 *     tags: [Profile]
 *     security: [{ BearerAuth: [] }]
 *     responses:
 *       200: { description: Profile }
 */
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.nameid);
    if (!user) return next(new AppError("User not found", 404));
    return res.json({ success: true, data: shapeUser(user) });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /profile ───────────────────────────────────────────────────────────
/**
 * @swagger
 * /profile:
 *   patch:
 *     summary: Cập nhật thông tin profile cơ bản (không gồm bank info)
 *     tags: [Profile]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name: { type: string }
 *               bio: { type: string }
 *               social_links: { type: object }
 *     responses:
 *       200: { description: OK }
 */
router.patch("/", authMiddleware, async (req, res, next) => {
  try {
    const updates = {};
    const { full_name, bio, social_links } = req.body;

    if (full_name !== undefined) {
      if (
        typeof full_name !== "string" ||
        full_name.trim().length < 2 ||
        full_name.trim().length > 100
      ) {
        return next(new AppError("Tên phải từ 2-100 ký tự", 400));
      }
      updates.full_name = full_name.trim();
    }
    if (bio !== undefined) {
      if (typeof bio !== "string" || bio.length > 500) {
        return next(new AppError("Bio tối đa 500 ký tự", 400));
      }
      updates.bio = bio.trim();
    }
    if (social_links !== undefined) {
      if (typeof social_links !== "object") {
        return next(new AppError("social_links phải là object", 400));
      }
      updates.social_links = {
        facebook: social_links.facebook || "",
        twitter: social_links.twitter || "",
        website: social_links.website || "",
      };
    }

    const user = await User.findByIdAndUpdate(
      req.user.nameid,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!user) return next(new AppError("User not found", 404));

    return res.json({
      success: true,
      message: "Cập nhật profile thành công",
      data: shapeUser(user),
    });
  } catch (error) {
    next(error);
  }
});

// ─── PATCH /profile/bank-information ─────────────────────────────────────────
/**
 * @swagger
 * /profile/bank-information:
 *   patch:
 *     summary: Cập nhật thông tin ngân hàng (chỉ Mangaka/Assistant, yêu cầu current_password)
 *     tags: [Profile]
 *     security: [{ BearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [current_password, bank_name, account_holder, bank_account_number]
 *             properties:
 *               current_password: { type: string, description: "Mật khẩu hiện tại để xác thực" }
 *               bank_name: { type: string }
 *               account_holder: { type: string }
 *               bank_account_number: { type: string }
 *     responses:
 *       200: { description: OK }
 *       401: { description: Sai mật khẩu hiện tại }
 *       403: { description: Không phải Mangaka/Assistant }
 */
router.patch("/bank-information", authMiddleware, async (req, res, next) => {
  try {
    const role = req.user.role;
    if (!["Mangaka", "Assistant"].includes(role)) {
      return next(
        new AppError(
          "Chỉ Mangaka/Assistant mới có thông tin ngân hàng",
          403
        )
      );
    }

    const {
      current_password,
      bank_name,
      account_holder,
      bank_account_number,
    } = req.body;

    if (!current_password) {
      return next(new AppError("Vui lòng nhập mật khẩu hiện tại", 400));
    }
    if (!bank_name || !account_holder || !bank_account_number) {
      return next(
        new AppError(
          "Vui lòng nhập đầy đủ: bank_name, account_holder, bank_account_number",
          400
        )
      );
    }
    if (typeof bank_account_number !== "string" || bank_account_number.length > 30) {
      return next(new AppError("Số tài khoản không hợp lệ", 400));
    }

    // Xác thực mật khẩu - cần select password
    const user = await User.findById(req.user.nameid).select("+password");
    if (!user) return next(new AppError("User not found", 404));

    const ok = await user.comparePassword(current_password);
    if (!ok) {
      return next(
        new AppError("Mật khẩu hiện tại không đúng", 401)
      );
    }

    user.bank_name = bank_name.trim();
    user.account_holder = account_holder.trim();
    user.bank_account_number = bank_account_number.trim();
    await user.save();

    return res.json({
      success: true,
      message: "Cập nhật thông tin ngân hàng thành công",
      data: shapeUser(user),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
