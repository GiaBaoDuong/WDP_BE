const mongoose = require("mongoose");

const pageLayerSchema = new mongoose.Schema(
  {
    page_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Page",
      required: true,
    },
    name: { type: String, default: "" },
    image_url: { type: String, required: true },
    blend_mode: {
      type: String,
      enum: ["normal", "multiply", "screen", "overlay", "darken", "lighten"],
      default: "normal",
    },
    opacity: { type: Number, min: 0, max: 100, default: 100 },
    visible: { type: Boolean, default: true },
    z_order: { type: Number, default: 0 },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    rotation: { type: Number, default: 0 },
    scale: { type: Number, default: 1 },
    locked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

pageLayerSchema.index({ page_id: 1, z_order: 1 });

const PageLayer = mongoose.model("PageLayer", pageLayerSchema);
module.exports = PageLayer;
