const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();

// CORS Configuration
const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes("*")) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

app.use(express.json());

// Reliable file delivery for uploaded resources (documents/videos).
app.get("/api/files/:name", (req, res) => {
  const rawName = String(req.params.name || "");
  const safeName = path.basename(rawName);
  if (!safeName || safeName !== rawName) {
    return res.status(400).json({ message: "Invalid file name" });
  }

  const uploadsDir = path.join(__dirname, "../../static/uploads");
  const filePath = path.join(uploadsDir, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: "File not found" });
  }

  const ext = path.extname(safeName).toLowerCase();
  const inlineExts = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".ogg", ".txt"]);
  const mimeMap = {
    ".pdf": "application/pdf",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "video/ogg",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };

  if (mimeMap[ext]) {
    res.type(mimeMap[ext]);
  }
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `${inlineExts.has(ext) ? "inline" : "attachment"}; filename=\"${safeName}\"`);
  return res.sendFile(filePath);
});

// Serve static files with correct MIME types
app.use(express.static(path.join(__dirname, "../../"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html');
    }
  }
}));

// Health check (before routes)
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    storage: "mongodb",
    db: "dentalprep"
  });
});


const port = process.env.PORT || 4000;

// Async initialization function
async function startServer() {
  try {
    // Import DB once so mongoose connection initializes before route usage.
    require("./db");

    // Seed admin user in MongoDB.
    const seedAdmin = require("./seedAdmin");
    await seedAdmin();
  } catch (err) {
    console.error("Failed to initialize backend:", err);
    process.exit(1);
  }

  // Import routes AFTER storage is initialized
  console.log("Loading routes...");
  const authRoutes = require("./routes/auth");
  const progressRoutes = require("./routes/progress");
  const contactRoutes = require("./routes/contact");
  const learningRoutes = require("./routes/learning");
  const adminRoutes = require("./routes/admin");

  app.use("/api", authRoutes);
  app.use("/api", progressRoutes);
  app.use("/api", contactRoutes);
  app.use("/api", learningRoutes);
  app.use("/api/subscription", require("./routes/subscription"));
  app.use("/api", adminRoutes);

  console.log("Routes loaded successfully");

  // Catch-all route to serve index.html for frontend routing
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "../../index.html"));
  });

  // Start server
  app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${port}`);
    console.log("🗄️ Storage: MongoDB (dentalprep)");
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  }).on('error', (err) => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  });
}

// Start the server
startServer().catch(err => {
  console.error('❌ Fatal error during startup:', err);
  process.exit(1);
});
