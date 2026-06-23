/**
 * Verify & fix: kiểm tra document cụ thể và đảm bảo có final_image_url
 * Chạy: node scripts/verify-final-image-url.js
 */
const mongoose = require("mongoose");

const MONGO_URI =
  "mongodb+srv://giabaoduong6868_db_user:Giabao2003.@mangadb.dqnxeei.mongodb.net/mangaManagement_db?appName=MangaDB";

async function migrate() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✓ Connected to MongoDB");

    const db = mongoose.connection.db;
    const collection = db.collection("pages");

    // Lấy 1 document mẫu
    const doc = await collection.findOne();
    console.log("\n1 document mẫu:");
    console.log(JSON.stringify(doc, null, 2));

    // Check xem field có tồn tại trong schema không
    const hasField = await collection.findOne({}, { projection: { final_image_url: 1 } });
    console.log("\nProjection { final_image_url: 1 }:", JSON.stringify(hasField, null, 2));

    // Force set final_image_url cho tất cả documents (phòng ngừa)
    const updateResult = await collection.updateMany(
      {},
      { $set: { final_image_url: "" } }
    );
    console.log(`\nUpdate all: ${updateResult.modifiedCount} modified, ${updateResult.matchedCount} matched`);

    // Verify lại
    const after = await collection.findOne({}, { projection: { _id: 1, page_number: 1, final_image_url: 1 } });
    console.log("\nSau update:", JSON.stringify(after, null, 2));

    process.exit(0);
  } catch (err) {
    console.error("✗ Error:", err.message);
    process.exit(1);
  }
}

migrate();
