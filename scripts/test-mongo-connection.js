/**
 * Test MongoDB connection via Mongoose
 * Run: node scripts/test-mongo-connection.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

(async () => {
  console.log("MONGODB_URI:", process.env.MONGODB_URI ? "(set)" : "(missing)");
  console.log("→ Connecting...");

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✓ Connected:", mongoose.connection.name);

    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    console.log("Collections:", collections.map((c) => c.name));

    await mongoose.disconnect();
    console.log("✓ Disconnected. Done.");
    process.exit(0);
  } catch (err) {
    console.error("✗ Failed:", err.message);
    process.exit(1);
  }
})();
