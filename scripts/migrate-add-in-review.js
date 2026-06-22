/* eslint-disable no-console */
require("dotenv").config();
const mongoose = require("mongoose");

const COLLECTIONS = [
  {
    name: "tasks",
    statusEnum: ["pending", "in_progress", "submitted", "in_review", "approved", "revision"],
  },
  {
    name: "pages",
    statusEnum: ["raw", "has_task", "submitted", "in_review", "approved", "revision"],
  },
];

const getCollectionInfo = async (db, name) => {
  const all = await db.listCollections().toArray();
  return all.find((c) => c.name === name) || null;
};

const buildValidator = (existing, newEnum) => {
  // Nếu chưa có validator hoặc không phải $jsonSchema thì tạo mới
  if (!existing || !existing.options || !existing.options.validator) {
    return {
      $jsonSchema: {
        bsonType: "object",
        required: ["status"],
        properties: {
          status: { enum: newEnum, description: "status must be one of " + newEnum.join(", ") },
        },
      },
    };
  }

  const validator = JSON.parse(JSON.stringify(existing.options.validator));

  // Đảm bảo có $jsonSchema
  if (!validator.$jsonSchema) {
    validator.$jsonSchema = {
      bsonType: "object",
      required: ["status"],
      properties: { status: { enum: newEnum } },
    };
    return validator;
  }

  const schema = validator.$jsonSchema;
  if (!schema.properties) schema.properties = {};
  const statusProp = schema.properties.status || {};

  // Lấy enum hiện tại (nếu có) rồi merge với enum mới
  const existingEnum = Array.isArray(statusProp.enum) ? statusProp.enum : [];
  const merged = Array.from(new Set([...existingEnum, ...newEnum]));

  statusProp.enum = merged;
  statusProp.description = "status must be one of " + merged.join(", ");
  schema.properties.status = statusProp;

  // Đảm bảo status nằm trong required
  if (Array.isArray(schema.required) && !schema.required.includes("status")) {
    schema.required.push("status");
  }

  return validator;
};

const migrate = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set in .env");
  }

  console.log("→ Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log("  Connected:", db.databaseName);

  for (const { name, statusEnum } of COLLECTIONS) {
    console.log(`\n→ Migrating collection: ${name}`);

    const info = await getCollectionInfo(db, name);
    const newValidator = buildValidator(info, statusEnum);
    const oldEnum = info?.options?.validator?.$jsonSchema?.properties?.status?.enum;

    try {
      if (!info) {
        // Collection chưa tồn tại → tạo mới với validator luôn
        await db.createCollection(name, {
          validator: newValidator,
          validationLevel: "moderate",
          validationAction: "warn",
        });
        console.log(`  ✓ Created collection "${name}" with validator.`);
      } else {
        // Đã tồn tại → update validator bằng collMod
        await db.command({
          collMod: name,
          validator: newValidator,
          validationLevel: "moderate",
          validationAction: "warn",
        });
        console.log(`  ✓ Updated validator for "${name}".`);
      }
      if (oldEnum) console.log(`    old enum:`, oldEnum);
      console.log(`    new enum:`, newValidator.$jsonSchema.properties.status.enum);
    } catch (err) {
      console.error(`  ✗ Failed to migrate "${name}":`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log("\n✓ Done. Disconnected.");
};

migrate().catch((err) => {
  console.error("Migration failed:", err);
  mongoose.disconnect();
  process.exit(1);
});
