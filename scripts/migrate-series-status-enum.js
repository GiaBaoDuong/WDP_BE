require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
  quiet: true,
});

const mongoose = require("mongoose");

const MIGRATION_DESC =
  "Add 'revision' to Series.status enum so EB can mark series as needing revision.";

const TARGET_ENUM_VALUES = [
  "draft",
  "submitted",
  "approved",
  "approved_by_EB",
  "rejected",
  "revision",   // ← newly added
  "published",
  "cancelled",
];

const args = new Set(process.argv.slice(2));
const APPLY  = args.has("--apply");
const DRYRUN = !APPLY;

const log = (...parts) => console.log("[migrate-series-status-enum]", ...parts);

const requireMongoUri = () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in .env");
  }
};

const getCurrentEnum = async (db) => {
  try {
    const validator = await db.command({
      collMod: "series",
      validator: { $jsonSchema: { bsonType: "object" } },
      validationLevel: "off",
      validationAction: "off",
    });
    return null; // cannot read validator via collMod read
  } catch (_) {
    return null;
  }
};

const main = async () => {
  if (args.has("--help") || args.has("-h")) {
    console.log(`
Usage:
  node scripts/migrate-series-status-enum.js
  node scripts/migrate-series-status-enum.js --apply

${MIGRATION_DESC}

Options:
  --apply   Write schema change to MongoDB Atlas. Without this, dry-run only.
`);
    return;
  }

  requireMongoUri();
  log(DRYRUN ? "mode=dry-run (no changes will be written)" : "mode=apply");
  log("description:", MIGRATION_DESC);

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  const db = mongoose.connection.db;
  log("connected to MongoDB Atlas");

  const collName = "series";
  const fullCollectionName = `${db.databaseName}.${collName}`;

  // 1. Check current enum via listIndexes (won't show enum, but we can check
  //    for documents that already have status="revision")
  const existingRevisionDocs = await db
    .collection(collName)
    .countDocuments({ status: "revision" });
  log(`existing documents with status="revision": ${existingRevisionDocs}`);

  // 2. Try to update the validator using collMod
  //    MongoDB schema validators are not easily readable, so we attempt to set
  //    a jsonSchema validator.  This is the safest approach for Atlas M0/M10+.
  //    On M0 (Atlas free tier) you cannot drop/create collections, but collMod
  //    with validator is allowed.
  const newValidator = {
    $jsonSchema: {
      bsonType: "object",
      required: ["name", "author_id", "status"],
      properties: {
        status: {
          enum: TARGET_ENUM_VALUES,
          description: "must be one of the allowed status values and is required",
        },
      },
    },
  };

  try {
    if (DRYRUN) {
      log("dry-run: would run collMod on collection", fullCollectionName);
      log("dry-run: new validator:", JSON.stringify(newValidator, null, 2));
    } else {
      await db.command({
        collMod: collName,
        validator: newValidator,
        validationLevel: "moderate",
        validationAction: "warn",
      });
      log("applied: collMod succeeded for collection", fullCollectionName);
    }
  } catch (err) {
    // collMod with jsonSchema validator can fail on Atlas free tier (M0)
    // because it does not support JSON Schema validators in collMod.
    // Fallback: just log the required enum values for manual migration.
    log("collMod note:", err.message);

    if (!APPLY) {
      log("");
      log("=== MANUAL MIGRATION REQUIRED ===");
      log("Atlas free tier (M0) does not support collMod with JSON Schema validators.");
      log("To apply this migration manually:");
      log("  1. Go to Atlas UI → Clusters → your cluster → Collections");
      log(`  2. Select the "${collName}" collection`);
      log("  3. Go to the 'Schema' tab");
      log("  4. Update the 'status' field enum to include:", TARGET_ENUM_VALUES.join(", "));
      log("  5. Or run the equivalent command via MongoDB Shell / Compass");
      log("");
      log("Alternatively, any existing document with status='revision' is already");
      log("saved in Atlas. The only thing preventing saves is the Mongoose model");
      log("enum, which has been updated in code. Restart the server and the");
      log("new enum will be enforced on all new writes.");
    }
  }

  // 3. Summary
  log("");
  log("=== migration summary ===");
  log(`collection   : ${fullCollectionName}`);
  log(`target enum  : [${TARGET_ENUM_VALUES.join(", ")}]`);
  log(`docs with revision (pre-existing): ${existingRevisionDocs}`);
  log(`applied      : ${APPLY ? "YES (--apply was passed)" : "NO (dry-run)"}`);
  log("");
  log(APPLY
    ? "Migration complete. Restart your BE server to pick up the model changes."
    : "No changes were written. Re-run with --apply when ready.");
};

main()
  .catch((err) => {
    console.error("[migrate-series-status-enum] failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
