require("dotenv").config();
const mongoose = require("mongoose");
const Page = require("./models/Page");

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const result = await Page.updateMany(
      {
        $or: [
          { current_version: { $exists: false } },
          { is_locked: { $exists: false } },
          { snapshots: { $exists: false } },
        ],
      },
      {
        $set: {
          current_version: 0,
          is_locked: false,
          snapshots: [],
        },
      }
    );

    console.log("Page migration completed");
    console.log("Matched:", result.matchedCount);
    console.log("Modified:", result.modifiedCount);
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await mongoose.disconnect();
  }
}

migrate();
