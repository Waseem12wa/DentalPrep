/**
 * cleanup-gridfs.js
 *
 * Frees MongoDB storage by deleting orphaned GridFS files (files in the
 * `uploads` bucket that are no longer referenced by any document).
 *
 * This is the fix for the "over your space quota / writes are blocked" error:
 * old videos that were "deleted" in the admin panel only had their reference
 * removed, but their bytes stayed in GridFS. This script purges those bytes.
 *
 * Usage:
 *   node cleanup-gridfs.js            # dry run: shows what WOULD be deleted
 *   node cleanup-gridfs.js --delete   # actually delete orphaned files
 */

const mongoose = require("mongoose");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, ".env") });

const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://Waseem:1234@cluster0.zgbbo9e.mongodb.net/dentalprep?retryWrites=true&w=majority";

const DO_DELETE = process.argv.includes("--delete");

// Matches filenames inside URLs like /static/uploads/<name> or /api/files/<name>
const FILE_URL_REGEX = /(?:static\/uploads|api\/files)\/([^"'\s?\\)]+)/gi;

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

async function collectReferencedFilenames(db) {
  const referenced = new Set();
  const collections = await db.listCollections().toArray();

  for (const { name } of collections) {
    // Skip the GridFS collections themselves.
    if (name === "uploads.files" || name === "uploads.chunks") continue;

    const docs = await db.collection(name).find({}).toArray();
    for (const doc of docs) {
      const json = JSON.stringify(doc);
      let match;
      FILE_URL_REGEX.lastIndex = 0;
      while ((match = FILE_URL_REGEX.exec(json)) !== null) {
        try {
          referenced.add(decodeURIComponent(match[1]));
        } catch (_err) {
          referenced.add(match[1]);
        }
      }
    }
  }

  return referenced;
}

async function main() {
  console.log(`Connecting to MongoDB...`);
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  console.log(`Connected. Mode: ${DO_DELETE ? "DELETE" : "DRY RUN"}\n`);

  const referenced = await collectReferencedFilenames(db);
  console.log(`Referenced files still in use: ${referenced.size}`);

  const filesColl = db.collection("uploads.files");
  const allFiles = await filesColl.find({}).toArray();
  console.log(`Total files in GridFS: ${allFiles.length}\n`);

  const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: "uploads" });

  let orphanCount = 0;
  let reclaimed = 0;
  let totalSize = 0;

  for (const file of allFiles) {
    totalSize += file.length || 0;
    if (referenced.has(file.filename)) continue;

    orphanCount += 1;
    reclaimed += file.length || 0;
    console.log(
      `${DO_DELETE ? "DELETING" : "ORPHAN  "}: ${file.filename} (${formatBytes(file.length || 0)})`
    );

    if (DO_DELETE) {
      try {
        await bucket.delete(file._id);
      } catch (err) {
        console.error(`  ! Failed to delete ${file.filename}: ${err.message}`);
      }
    }
  }

  console.log(`\n----------------------------------------`);
  console.log(`Current GridFS total:   ${formatBytes(totalSize)}`);
  console.log(`Orphaned files:         ${orphanCount}`);
  console.log(
    `${DO_DELETE ? "Space reclaimed:        " : "Space to reclaim:       "}${formatBytes(reclaimed)}`
  );
  console.log(`Remaining after clean:  ${formatBytes(totalSize - reclaimed)}`);
  console.log(`----------------------------------------`);

  if (!DO_DELETE && orphanCount > 0) {
    console.log(`\nThis was a DRY RUN. Re-run with --delete to actually free space:`);
    console.log(`  node cleanup-gridfs.js --delete`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
