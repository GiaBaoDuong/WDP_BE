const mongoose = require("mongoose");

const cooperationSchema = new mongoose.Schema(
  {
    mangaka_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assistant_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    series_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Series",
      default: null,
    },
    mangaka_note: { type: String, default: "" },
    assistant_note: { type: String, default: "" },
    agreed_at: { type: Date, default: null },
    // Stats cho Assistant
    total_approved_tasks: { type: Number, default: 0 },
    total_earnings: { type: Number, default: 0 },
    // ─── Tỷ lệ chia doanh thu cho Reader purchases ────────────────────
    // shares = [{ user_id, role: "Mangaka" | "Assistant", percentage }]
    // Tổng percentage trong mảng phải bằng 100.
    // Nếu chưa set → mặc định dùng fallback: Mangaka 100% (assistant 0%).
    revenue_shares: {
      type: [
        {
          user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
          role: { type: String, enum: ["Mangaka", "Assistant"], required: true },
          percentage: { type: Number, required: true, min: 0, max: 100 },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

cooperationSchema.index({ mangaka_id: 1 });
cooperationSchema.index({ assistant_id: 1 });
cooperationSchema.index({ series_id: 1 });

const Cooperation = mongoose.model("Cooperation", cooperationSchema);
module.exports = Cooperation;
