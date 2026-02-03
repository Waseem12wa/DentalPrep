const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDb = require("./config/db");
const authRoutes = require("./routes/auth");
const progressRoutes = require("./routes/progress");
const contactRoutes = require("./routes/contact");
const learningRoutes = require("./routes/learning");
const adminRoutes = require("./routes/admin");

dotenv.config();

const app = express();

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

// Serve static files from the parent directory (frontend)
const path = require("path");
app.use(express.static(path.join(__dirname, "../../")));


app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api", authRoutes);
app.use("/api", progressRoutes);
app.use("/api", contactRoutes);
app.use("/api", learningRoutes);
app.use("/api/subscription", require("./routes/subscription")); // Prefix with /subscription
app.use("/api", adminRoutes);

// Catch-all route to serve index.html for frontend routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../../index.html"));
});


const port = process.env.PORT || 4000;

connectDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`API running on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("DB connection failed", err);
    process.exit(1);
  });
