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
  },
  { timestamps: true }
);

cooperationSchema.index({ mangaka_id: 1 });
cooperationSchema.index({ assistant_id: 1 });
cooperationSchema.index({ series_id: 1 });

const Cooperation = mongoose.model("Cooperation", cooperationSchema);
module.exports = Cooperation;
