require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/User");

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const result = await User.updateMany(
      { phoneNumber: { $exists: false } },
      { $set: { phoneNumber: "" } }
    );

    console.log("User phoneNumber migration completed");
    console.log("Matched:", result.matchedCount);
    console.log("Modified:", result.modifiedCount);
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await mongoose.disconnect();
  }
}

migrate();
