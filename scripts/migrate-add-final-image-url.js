/**
 * Migrate: Thêm field final_image_url vào Page model cho các document chưa có
 * Chạy: node scripts/migrate-add-final-image-url.js
 */
const mongoose = require("mongoose");

async function migrate() {
    "mongodb+srv://giabaoduong6868_db_user:Giabao2003.@mangadb.dqnxeei.mongodb.net/mangaManagement_db?appName=MangaDB"

  try {
    await mongoose.connect(MONGO_URI);
    console.log("✓ Connected to MongoDB");

    const db = mongoose.connection.db;
    const collection = db.collection("pages");

    // Tìm các document chưa có field final_image_url
    const missing = await collection.countDocuments({ final_image_url: { $exists: false } });
    console.log(`Pages chưa có final_image_url: ${missing}`);

    if (missing === 0) {
      console.log("✓ Không có document nào cần migrate.");
      process.exit(0);
    }

    // Update tất cả document thiếu field → gán giá trị mặc định ""
    const result = await collection.updateMany(
      { final_image_url: { $exists: false } },
      { $set: { final_image_url: "" } }
    );

    console.log(`✓ Đã migrate ${result.modifiedCount} document.`);
    console.log(`  Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);

    // Verify
    const stillMissing = await collection.countDocuments({ final_image_url: { $exists: false } });
    console.log(`Pages vẫn thiếu final_image_url sau migrate: ${stillMissing}`);

    process.exit(0);
  } catch (err) {
    console.error("✗ Migration failed:", err.message);
    process.exit(1);
  }
}

migrate();
