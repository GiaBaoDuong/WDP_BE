require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
  quiet: true,
});

const mongoose = require("mongoose");
const EBEvaluation = require("../models/EBEvaluation");
const { CORE_CRITERIA_KEYS } = require("../utils/ebScoringRubric");

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const DRY_RUN_SAMPLE = parseInt(
  process.argv.find((a) => a.startsWith("--sample="))?.split("=")[1] || "10",
  10
);

const usage = `
Usage:
  node scripts/migrate-eb-evaluation-rubric.js
  node scripts/migrate-eb-evaluation-rubric.js --apply
  node scripts/migrate-eb-evaluation-rubric.js --apply --sample=50

Options:
  --apply         Write changes to MongoDB. Without this, dry-run only.
  --sample=N      Limit to N documents per collection (default 10, ignored in apply mode).

This migration:
  1. Backfill 'applied_rubric_total_weight' = 100 for existing EBEvaluation docs.
  2. Backfill 'age_safety' defaults for existing EBEvaluation docs.
  3. Backfill 'content_levels' defaults for existing EBEvaluation docs.
  4. Backfill 'applied_rubric_weights' as empty Map for existing EBEvaluation docs.
     (Note: extension_scores is nested inside member_scores[]; no migration needed —
      existing docs will have undefined which the code handles with || [].)
  5. Report evaluation counts and age_rating distribution.
`;

const log = (...parts) => console.log("[EBEvalRubricMigration]", ...parts);

const requireMongoUri = () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in .env");
  }
};

const updateIfApply = async (description, callback) => {
  if (!APPLY) {
    log("dry-run:", description);
    return null;
  }
  log("apply:", description);
  return callback();
};

const main = async () => {
  if (args.has("--help") || args.has("-h")) {
    console.log(usage.trim());
    return;
  }

  requireMongoUri();

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  log("connected to MongoDB Atlas");
  log(APPLY ? "mode=apply" : "mode=dry-run");

  // ─── 1. Stats before migration ───────────────────────────────────────────────
  const totalEvals = await EBEvaluation.countDocuments();
  log(`Total EBEvaluation docs: ${totalEvals}`);

  const byStatus = await EBEvaluation.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  log("By status:", JSON.stringify(byStatus));

  const byFirstReview = await EBEvaluation.aggregate([
    { $group: { _id: "$first_review", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  log("By first_review:", JSON.stringify(byFirstReview));

  const withRubricId = await EBEvaluation.countDocuments({
    applied_rubric_id: { $ne: null },
  });
  log(`Docs with applied_rubric_id set: ${withRubricId}`);

  const withTotalWeight = await EBEvaluation.countDocuments({
    applied_rubric_total_weight: { $exists: true, $ne: null },
  });
  log(`Docs with applied_rubric_total_weight set: ${withTotalWeight}`);

  const withAgeSafety = await EBEvaluation.countDocuments({
    "age_safety.passed": { $exists: true },
  });
  log(`Docs with age_safety.passed set: ${withAgeSafety}`);

  const withContentLevels = await EBEvaluation.countDocuments({
    "content_levels.violence": { $exists: true },
  });
  log(`Docs with content_levels.violence set: ${withContentLevels}`);

  // ─── 2. Apply migrations ────────────────────────────────────────────────────

  // 2a. Set applied_rubric_total_weight = 100 where missing
  const missingWeight = await EBEvaluation.countDocuments({
    applied_rubric_total_weight: { $exists: false },
  });
  if (missingWeight > 0) {
    await updateIfApply(
      `set applied_rubric_total_weight=100 for ${missingWeight} doc(s)`,
      () =>
        EBEvaluation.updateMany(
          { applied_rubric_total_weight: { $exists: false } },
          { $set: { applied_rubric_total_weight: 100 } }
        )
    );
  } else {
    log("No docs missing applied_rubric_total_weight");
  }

  // 2b. Set age_safety defaults where missing
  const missingAgeSafety = await EBEvaluation.countDocuments({
    "age_safety.passed": { $exists: false },
  });
  if (missingAgeSafety > 0) {
    await updateIfApply(
      `set age_safety defaults for ${missingAgeSafety} doc(s)`,
      () =>
        EBEvaluation.updateMany(
          { "age_safety.passed": { $exists: false } },
          {
            $set: {
              "age_safety.passed": true,
              "age_safety.severity": "Không vi phạm",
              "age_safety.rules_note": "",
              "age_safety.violations": [],
            },
          }
        )
    );
  } else {
    log("No docs missing age_safety fields");
  }

  // 2c. Set content_levels defaults where missing
  const missingContentLevels = await EBEvaluation.countDocuments({
    "content_levels.violence": { $exists: false },
  });
  if (missingContentLevels > 0) {
    await updateIfApply(
      `set content_levels defaults for ${missingContentLevels} doc(s)`,
      () =>
        EBEvaluation.updateMany(
          { "content_levels.violence": { $exists: false } },
          {
            $set: {
              "content_levels.violence": 0,
              "content_levels.fear": 0,
              "content_levels.profanity": 0,
              "content_levels.nudity": 0,
              "content_levels.danger_simulation": 0,
            },
          }
        )
    );
  } else {
    log("No docs missing content_levels fields");
  }

  // 2d. Ensure applied_rubric_weights Map field exists (it defaults to empty Map,
  //     but we verify no doc has undefined/null instead of a proper Map)
  const missingWeightsMap = await EBEvaluation.countDocuments({
    $or: [
      { applied_rubric_weights: { $exists: false } },
      { applied_rubric_weights: null },
    ],
  });
  if (missingWeightsMap > 0) {
    await updateIfApply(
      `set applied_rubric_weights=empty Map for ${missingWeightsMap} doc(s)`,
      () =>
        EBEvaluation.updateMany(
          {
            $or: [
              { applied_rubric_weights: { $exists: false } },
              { applied_rubric_weights: null },
            ],
          },
          { $set: { applied_rubric_weights: {} } }
        )
    );
  } else {
    log("All docs have applied_rubric_weights Map field");
  }

  // ─── 3. Backfill extension_scores into member_scores for existing docs ──────
  // Find docs where member_scores exists but some entries may lack extension_scores
  // (simpler approach: fetch docs and check in JS)
  const allWithMemberScores = await EBEvaluation.find({
    member_scores: { $exists: true, $ne: [] },
  })
    .select("_id member_scores")
    .limit(APPLY ? undefined : 100)
    .lean();

  const docsNeedingExtScores = allWithMemberScores.filter((doc) =>
    doc.member_scores.some((m) => !m.extension_scores)
  );

  if (docsNeedingExtScores.length > 0) {
    log(`Found ${docsNeedingExtScores.length} doc(s) needing extension_scores backfill`);
    for (const doc of docsNeedingExtScores) {
      if (APPLY) {
        const updatedScores = doc.member_scores.map((m) => ({
          ...m,
          extension_scores: m.extension_scores || [],
        }));
        await EBEvaluation.updateOne(
          { _id: doc._id },
          { $set: { member_scores: updatedScores } }
        );
        log(`  backfilled doc ${doc._id}`);
      } else {
        log(`  dry-run: would backfill extension_scores for doc ${doc._id}`);
      }
    }
  } else {
    log("All member_scores entries already have extension_scores");
  }

  // ─── 4. Dry-run sample ──────────────────────────────────────────────────────
  if (!APPLY) {
    const sample = await EBEvaluation.find()
      .select(
        "_id first_review status result applied_rubric_id applied_rubric_total_weight age_safety.passed content_levels.violence"
      )
      .limit(DRY_RUN_SAMPLE)
      .lean();

    log(`\nSample (first ${sample.length} docs):`);
    for (const doc of sample) {
      log(
        `  _id=${doc._id} first_review=${doc.first_review} ` +
        `status=${doc.status} result=${doc.result} ` +
        `rubric_id=${doc.applied_rubric_id ?? "(null)"} ` +
        `total_weight=${doc.applied_rubric_total_weight ?? "(missing)"} ` +
        `age_safety_passed=${doc.age_safety?.passed ?? "(missing)"} ` +
        `content_violence=${doc.content_levels?.violence ?? "(missing)"}`
      );
    }
    log("\nNo data was changed. Re-run with --apply to write these changes.");
  } else {
    log("\nAll migrations applied successfully.");
  }
};

main()
  .catch((err) => {
    console.error("[EBEvalRubricMigration] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
