const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const ROLES = ["Admin", "Mangaka", "Assistant", "Editor", "EB", "Reader"];

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "Username is required"],
      trim: true,
      maxlength: [50, "Username cannot exceed 50 characters"],
      unique: true,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
      select: false,
    },
    full_name: {
      type: String,
      required: [true, "Full name is required"],
      trim: true,
      maxlength: [100, "Full name cannot exceed 100 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,
      maxlength: [100, "Email cannot exceed 100 characters"],
    },
    phoneNumber: {
      type: String,
      default: "",
      trim: true,
    },
    role: {
      type: String,
      required: [true, "Role is required"],
      enum: {
        values: ROLES,
        message: "Role must be one of: Admin, Mangaka, Assistant, Editor, EB, Reader",
      },
    },
    status: {
      type: String,
      enum: ["active", "banned"],
      default: "active",
    },
    is_eb_representative: {
      type: Boolean,
      default: false,
    },
    avatar_url: {
      type: String,
      default: "",
    },
    cover_image_url: {
      type: String,
      default: "",
    },
    bio: {
      type: String,
      default: "",
      maxlength: [500, "Bio cannot exceed 500 characters"],
    },
    social_links: {
      type: {
        facebook: { type: String, default: "" },
        twitter: { type: String, default: "" },
        website: { type: String, default: "" },
      },
      default: () => ({ facebook: "", twitter: "", website: "" }),
    },
    // ─── Bank info (chỉ áp dụng cho Mangaka / Assistant) ─────────────────
    bank_name: { type: String, default: "", trim: true, maxlength: 100 },
    account_holder: { type: String, default: "", trim: true, maxlength: 100 },
    bank_account_number: { type: String, default: "", trim: true, maxlength: 30 },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        ret.userId = ret._id;
        delete ret._id;
        delete ret.__v;
        delete ret.password;
        return ret;
      },
    },
  }
);

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Trả về số tài khoản dạng che (vd: ********1234). Hữu ích cho các màn hình
// hiển thị profile công khai / dashboard, nơi chỉ chủ tài khoản + admin mới thấy đầy đủ.
userSchema.virtual("bank_account_number_masked").get(function () {
  const acc = this.bank_account_number || "";
  if (!acc) return "";
  if (acc.length <= 4) return "********";
  return "********" + acc.slice(-4);
});

const User = mongoose.model("User", userSchema);

module.exports = User;
