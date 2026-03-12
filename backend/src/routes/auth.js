const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { User, Subscription } = require("../db");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email, and password are required" });
    }

    const existing = User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Email already in use" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(20).toString("hex");

    const user = User.create({
      name,
      email,
      passwordHash,
      verificationToken,
      isVerified: false,
      role: "student"
    });

    // Mock Email Service
    console.log(`[MOCK EMAIL] Verification Link: http://localhost:5500/verify/?token=${verificationToken}`);

    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email },
      message: "Account created! Please check your email to verify."
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/verify-email", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "Token required" });

    const user = User.findOne({ verificationToken: token });
    if (!user) return res.status(400).json({ message: "Invalid or expired token" });

    User.findByIdAndUpdate(user._id, {
      isVerified: true,
      verificationToken: null,
      updatedAt: new Date().toISOString()
    });

    return res.json({ message: "Email verified successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    const user = User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const resetToken = crypto.randomBytes(20).toString("hex");
    User.findByIdAndUpdate(user._id, {
      resetPasswordToken: resetToken,
      resetPasswordExpires: Date.now() + 3600000,
      updatedAt: new Date().toISOString()
    });

    // Mock Email
    console.log(`[MOCK EMAIL] Reset Link: http://localhost:5500/reset-password/?token=${resetToken}`);

    return res.json({ message: "Password reset link sent to email" });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    const user = User.findOne({ resetPasswordToken: token });

    if (!user || !user.resetPasswordExpires || user.resetPasswordExpires < Date.now()) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    User.findByIdAndUpdate(user._id, {
      passwordHash,
      resetPasswordToken: null,
      resetPasswordExpires: null,
      updatedAt: new Date().toISOString()
    });

    return res.json({ message: "Password reset successful" });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const storedHash = user.passwordHash || user.password;
    const isMatch = storedHash ? await bcrypt.compare(password, storedHash) : false;
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role || "student" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email }
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/user/profile", authMiddleware, async (req, res) => {
  try {
    const user = User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const subscription = Subscription.findOne({ userId: req.user.id, status: "active" });

    return res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role || "student"
      },
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            startedAt: subscription.startedAt
          }
        : null
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
