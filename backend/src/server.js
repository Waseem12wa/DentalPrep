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
const authMiddleware = require("./middleware/auth");

// Reliable file delivery for uploaded resources (documents/videos).
app.get("/api/files/:name", (req, res) => {
  let rawName = String(req.params.name || "");
  // Decode URI component if it's encoded
  try {
    rawName = decodeURIComponent(rawName);
  } catch (_err) {
    // If decode fails, use the raw name
  }
  
  const safeName = path.basename(rawName);
  if (!safeName) {
    return res.status(400).json({ message: "Invalid file name" });
  }

  const uploadsDir = path.join(__dirname, "../../static/uploads");
  const filePath = path.join(uploadsDir, safeName);
  
  // Prevent path traversal attacks
  if (!filePath.startsWith(uploadsDir)) {
    return res.status(400).json({ message: "Invalid file path" });
  }
  
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found: ${filePath}`);
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
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
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
  const { PdfAccessRequest, generateId } = require("./db");

  app.get("/api/pdf-access/my-requests", authMiddleware, async (req, res) => {
    try {
      const requests = await PdfAccessRequest.find({ userId: req.user.id });
      return res.json({
        requests: requests
          .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
          .map((request) => ({
            id: request._id,
            subjectKey: request.subjectKey,
            blockKey: request.blockKey,
            sectionName: request.sectionName,
            amount: Number(request.amount || 500),
            paymentMethod: request.paymentMethod || "easypaisa",
            easypaisaNumber: request.easypaisaNumber || "03327939323",
            easypaisaAccountName: request.easypaisaAccountName || "Muhammad Yousaf",
            paymentProof: request.paymentProof || "",
            status: request.status || "pending",
            adminNote: request.adminNote || "",
            reviewedAt: request.reviewedAt || null,
            createdAt: request.createdAt || null
          }))
      });
    } catch (err) {
      return res.status(500).json({ message: err.message || "Server error" });
    }
  });

  app.post("/api/pdf-access/request", authMiddleware, async (req, res) => {
    try {
      const subjectKey = String(req.body?.subjectKey || "").trim();
      const blockKey = String(req.body?.blockKey || "").trim();
      const sectionName = String(req.body?.sectionName || "").trim() || "__block__";
      const paymentProof = String(req.body?.paymentProof || "").trim();

      if (!subjectKey || !blockKey) {
        return res.status(400).json({ message: "subjectKey and blockKey are required" });
      }

      if (!paymentProof) {
        return res.status(400).json({ message: "Payment reference/proof is required" });
      }

      const existingPending = await PdfAccessRequest.findOne({
        userId: req.user.id,
        subjectKey,
        blockKey,
        sectionName,
        status: "pending"
      });

      if (existingPending) {
        return res.status(409).json({ message: "A pending request already exists for this module" });
      }

      const request = await PdfAccessRequest.create({
        _id: `pdf_req_${generateId()}`,
        userId: req.user.id,
        subjectKey,
        blockKey,
        sectionName,
        amount: 500,
        paymentMethod: "easypaisa",
        easypaisaNumber: "03327939323",
        easypaisaAccountName: "Muhammad Yousaf",
        paymentProof,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date()
      });

      return res.status(201).json({
        message: "Payment request submitted. Admin will verify and approve.",
        request: {
          id: request._id,
          subjectKey: request.subjectKey,
          blockKey: request.blockKey,
          sectionName: request.sectionName,
          amount: request.amount,
          paymentMethod: request.paymentMethod,
          easypaisaNumber: request.easypaisaNumber,
          easypaisaAccountName: request.easypaisaAccountName,
          status: request.status
        }
      });
    } catch (err) {
      return res.status(500).json({ message: err.message || "Server error" });
    }
  });

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
