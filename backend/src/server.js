const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");

dotenv.config();

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

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Import routes (now using JSON storage)
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

// Catch-all route to serve index.html for frontend routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../../index.html"));
});

const port = process.env.PORT || 4000;

// Initialize JSON storage
const dataDir = path.join(__dirname, "../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Create initial data files if they don't exist
const initFiles = {
  "users.json": [],
  "courses.json": [],
  "lessons.json": [],
  "quizzes.json": [],
  "progress.json": [],
  "contacts.json": []
};

Object.entries(initFiles).forEach(([filename, defaultData]) => {
  const filePath = path.join(dataDir, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Data directory: ${dataDir}`);
});
