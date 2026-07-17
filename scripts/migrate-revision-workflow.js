/**
 * Migration: Backfill PageNote and Chapter fields for revision workflow
 *
 * PageNote new fields:
 *   - note_kind     (default: "brief")
 *   - author_role   (default: "mangaka")
 *   - revision_round (default: 1)
 *
 * Chapter new fields:
 *   - revision_round (default: 1)
 *   - status enum: add "revision_requested" (no backfill needed for enum)
 *
 * Run: node scripts/migrate-revision-workflow.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PageNote = require("../models/PageNote");
const Chapter = require("../models/Chapter");

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-revision-workflow] Connected to MongoDB");

    // ─── 1. PageNote ────────────────────────────────────────────────────────────

    // Create compound index (page_id, note_kind, revision_round) if not exists
    const pageNoteIndexes = await mongoose.connection.db
      .collection("pagenotes")
      .indexes();
    const hasNoteKindIdx = pageNoteIndexes.some(
      (idx) =>
        idx.key &&
        idx.key.page_id !== undefined &&
        idx.key.note_kind !== undefined &&
        idx.key.revision_round !== undefined,
    );

    if (hasNoteKindIdx) {
      console.log("[migrate-revision-workflow] Index on (page_id, note_kind, revision_round) already exists");
    } else {
      await mongoose.connection.db
        .collection("pagenotes")
        .createIndex(
          { page_id: 1, note_kind: 1, revision_round: 1 },
          { background: true },
        );
      console.log("[migrate-revision-workflow] Created index on (page_id, note_kind, revision_round)");
    }

    // Backfill note_kind
    const noteKindResult = await PageNote.updateMany(
      { note_kind: { $exists: false } },
      { $set: { note_kind: "brief" } },
    );
    console.log(
      `[migrate-revision-workflow] PageNote note_kind: matched=${noteKindResult.matchedCount}, modified=${noteKindResult.modifiedCount}`,
    );

    // Backfill author_role
    const authorRoleResult = await PageNote.updateMany(
      { author_role: { $exists: false } },
      { $set: { author_role: "mangaka" } },
    );
    console.log(
      `[migrate-revision-workflow] PageNote author_role: matched=${authorRoleResult.matchedCount}, modified=${authorRoleResult.modifiedCount}`,
    );

    // Backfill revision_round
    const revisionRoundResult = await PageNote.updateMany(
      { revision_round: { $exists: false } },
      { $set: { revision_round: 1 } },
    );
    console.log(
      `[migrate-revision-workflow] PageNote revision_round: matched=${revisionRoundResult.matchedCount}, modified=${revisionRoundResult.modifiedCount}`,
    );

    // ─── 2. Chapter ─────────────────────────────────────────────────────────────

    // Create index on revision_round if not exists
    const chapterIndexes = await mongoose.connection.db
      .collection("chapters")
      .indexes();
    const hasRevisionRoundIdx = chapterIndexes.some(
      (idx) => idx.key && idx.key.revision_round !== undefined,
    );

    if (hasRevisionRoundIdx) {
      console.log("[migrate-revision-workflow] Index on revision_round already exists");
    } else {
      await mongoose.connection.db
        .collection("chapters")
        .createIndex({ revision_round: 1 }, { background: true });
      console.log("[migrate-revision-workflow] Created index on revision_round");
    }

    // Backfill revision_round (default: 1)
    const chapterRoundResult = await Chapter.updateMany(
      { revision_round: { $exists: false } },
      { $set: { revision_round: 1 } },
    );
    console.log(
      `[migrate-revision-workflow] Chapter revision_round: matched=${chapterRoundResult.matchedCount}, modified=${chapterRoundResult.modifiedCount}`,
    );

    // Ensure revision_requested is allowed in status enum — no backfill needed,
    // MongoDB stores enum values as plain strings; schema validation kicks in on save.

    // ─── 3. Sanity check ───────────────────────────────────────────────────────
    const totalPageNotes = await PageNote.countDocuments();
    const withNoteKind = await PageNote.countDocuments({ note_kind: { $exists: true } });
    const withAuthorRole = await PageNote.countDocuments({ author_role: { $exists: true } });
    const withRevisionRound = await PageNote.countDocuments({ revision_round: { $exists: true } });
    const totalChapters = await Chapter.countDocuments();
    const withChapterRound = await Chapter.countDocuments({ revision_round: { $exists: true } });

    console.log(
      `[migrate-revision-workflow] PageNote total=${totalPageNotes}, with note_kind=${withNoteKind}, author_role=${withAuthorRole}, revision_round=${withRevisionRound}`,
    );
    console.log(
      `[migrate-revision-workflow] Chapter total=${totalChapters}, with revision_round=${withChapterRound}`,
    );

    await mongoose.disconnect();
    console.log("[migrate-revision-workflow] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-revision-workflow] Failed:", err);
    process.exit(1);
  }
})();
