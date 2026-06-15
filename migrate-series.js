require("dotenv").config();
const mongoose = require("mongoose");
const Series = require("./models/Series");

async function migrateSeriesFields() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const result = await Series.updateMany(
      {
        $or: [
          { views_count: { $exists: false } },
          { category: { $exists: false } },
          { tags: { $exists: false } },
          { age_rating: { $exists: false } },
        ],
      },
      {
        $set: {
          views_count: 0,
          category: "",
          tags: [],
          age_rating: "All ages",
        },
      }
    );

    console.log("Migration completed");
    console.log("Matched:", result.matchedCount);
    console.log("Modified:", result.modifiedCount);
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    await mongoose.disconnect();
  }
}

migrateSeriesFields();