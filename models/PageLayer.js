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
      enum: ["source-over", "normal", "multiply", "screen", "overlay", "darken", "lighten"],
      default: "source-over",
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
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    note: { type: String, default: "" },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

pageLayerSchema.virtual("index").get(function () { return this.z_order; });
pageLayerSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret) => {
    ret.created_at = doc.createdAt;
    delete ret.createdAt;
    delete ret.updatedAt;
    return ret;
  },
});
pageLayerSchema.set("toObject", { virtuals: true });
pageLayerSchema.index({ page_id: 1, z_order: 1 });

const PageLayer = mongoose.model("PageLayer", pageLayerSchema);
module.exports = PageLayer;
