const mongoose = require("mongoose");

const cooperationRequestSchema = new mongoose.Schema(
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
    message: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "accepted_meet", "rejected", "meeting", "accepted", "declined"],
      default: "pending",
    },
    responded_at: { type: Date, default: null },
  },
  { timestamps: true }
);

cooperationRequestSchema.index({ assistant_id: 1, status: 1 });
cooperationRequestSchema.index({ mangaka_id: 1 });
cooperationRequestSchema.index({ mangaka_id: 1, assistant_id: 1 });

const CooperationRequest = mongoose.model("CooperationRequest", cooperationRequestSchema);
module.exports = CooperationRequest;
