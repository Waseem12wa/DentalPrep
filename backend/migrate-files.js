const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://Waseem:1234@cluster0.zgbbo9e.mongodb.net/dentalprep?retryWrites=true&w=majority";

async function migrateFilesToGridFS() {
  console.log("🔄 Starting file migration to MongoDB GridFS...");
  
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✓ MongoDB Connected Successfully");

    const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "uploads"
    });
    console.log("✓ GridFS bucket 'uploads' initialized");

    const uploadsDir = path.resolve(__dirname, "../static/uploads");
    if (!fs.existsSync(uploadsDir)) {
      console.log("⚠️  No uploads directory found");
      return;
    }

    const files = fs.readdirSync(uploadsDir);
    console.log(`📁 Found ${files.length} files to migrate`);

    let migrated = 0;
    let skipped = 0;

    for (const file of files) {
      const filePath = path.join(uploadsDir, file);
      const stats = fs.statSync(filePath);
      
      if (!stats.isFile()) {
        skipped++;
        continue;
      }

      // Check if file already exists in GridFS
      const existing = await bucket.find({ filename: file }).limit(1).toArray();
      if (existing.length > 0) {
        console.log(`⏭️  Skipping (already exists): ${file}`);
        skipped++;
        continue;
      }

      const ext = path.extname(file).toLowerCase();
      const mimeTypes = {
        '.pdf': 'application/pdf',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.ogg': 'video/ogg',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.txt': 'text/plain'
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';

      await new Promise((resolve, reject) => {
        const uploadStream = bucket.openUploadStream(file, {
          contentType: contentType,
          metadata: { originalName: file }
        });

        const readStream = fs.createReadStream(filePath);
        
        uploadStream.on('error', (err) => {
          console.error(`❌ Error uploading ${file}:`, err.message);
          reject(err);
        });

        uploadStream.on('finish', () => {
          console.log(`✅ Migrated: ${file}`);
          migrated++;
          resolve();
        });

        readStream.pipe(uploadStream);
      });
    }

    console.log(`\n📊 Migration complete:`);
    console.log(`   ✅ Migrated: ${migrated} files`);
    console.log(`   ⏭️  Skipped: ${skipped} files`);
    console.log(`   📁 Total processed: ${files.length} files`);

  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 MongoDB connection closed");
  }
}

migrateFilesToGridFS().then(() => process.exit(0));
