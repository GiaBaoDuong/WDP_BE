/**
 * Migration: Backfill round + is_current_round fields to Task
 *
 * Vì Task schema mới có 2 field mới (round, is_current_round) mà MongoDB
 * không tự thêm vào document cũ, các Task sẽ thiếu field này khi đọc
 * (Mongoose sẽ tự default nhưng vẫn nên backfill cho ổn định index + query).
 *
 * - round            = 1   (là vòng đầu tiên)
 * - is_current_round = true (Task cũ vẫn coi là vòng hiện tại)
 *
 * Idempotent: chạy nhiều lần đều an toàn — chỉ update task chưa có field.
 *
 * Run: node scripts/migrate-tasks-round.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Task = require("../models/Task");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-tasks-round] Connected to MongoDB");

    // 1) Tạo index trên (chapter_id, is_current_round) và (chapter_id, round) nếu chưa có
    const collection = mongoose.connection.db.collection("tasks");
    const existingIndexes = await collection.indexes();

    const hasChapterCurrentRoundIndex = existingIndexes.some(
      (idx) =>
        idx.key &&
        idx.key.chapter_id !== undefined &&
        idx.key.is_current_round !== undefined,
    );
    const hasChapterRoundIndex = existingIndexes.some(
      (idx) =>
        idx.key &&
        idx.key.chapter_id !== undefined &&
        idx.key.round !== undefined &&
        idx.key.is_current_round === undefined,
    );

    if (hasChapterCurrentRoundIndex) {
      console.log("[migrate-tasks-round] Index { chapter_id, is_current_round } already exists");
    } else {
      await collection.createIndex(
        { chapter_id: 1, is_current_round: 1 },
        { background: true },
      );
      console.log("[migrate-tasks-round] Created index { chapter_id, is_current_round }");
    }

    if (hasChapterRoundIndex) {
      console.log("[migrate-tasks-round] Index { chapter_id, round } already exists");
    } else {
      await collection.createIndex(
        { chapter_id: 1, round: 1 },
        { background: true },
      );
      console.log("[migrate-tasks-round] Created index { chapter_id, round }");
    }

    // 2) Backfill round = 1 cho task thiếu field
    const roundResult = await Task.updateMany(
      { round: { $exists: false } },
      { $set: { round: 1 } },
    );
    console.log(
      `[migrate-tasks-round] round backfill → Matched: ${roundResult.matchedCount}, Modified: ${roundResult.modifiedCount}`,
    );

    // 3) Backfill is_current_round = true cho task thiếu field
    const currentRoundResult = await Task.updateMany(
      { is_current_round: { $exists: false } },
      { $set: { is_current_round: true } },
    );
    console.log(
      `[migrate-tasks-round] is_current_round backfill → Matched: ${currentRoundResult.matchedCount}, Modified: ${currentRoundResult.modifiedCount}`,
    );

    // 4) Sanity check — đảm bảo không còn task nào thiếu 2 field này
    const missingRound = await Task.countDocuments({ round: { $exists: false } });
    const missingCurrentRound = await Task.countDocuments({
      is_current_round: { $exists: false },
    });
    const totalTasks = await Task.countDocuments();
    const currentRoundCount = await Task.countDocuments({ is_current_round: true });

    console.log(
      `[migrate-tasks-round] Total tasks: ${totalTasks}, is_current_round=true: ${currentRoundCount}, missing round: ${missingRound}, missing is_current_round: ${missingCurrentRound}`,
    );

    if (missingRound > 0 || missingCurrentRound > 0) {
      console.warn("[migrate-tasks-round] CẢNH BÁO: vẫn còn task thiếu field sau khi migrate");
    }

    await mongoose.disconnect();
    console.log("[migrate-tasks-round] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-tasks-round] Failed:", err);
    process.exit(1);
  }
})();
