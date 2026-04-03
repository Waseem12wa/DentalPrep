const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { User, Subscription, generateId } = require("../db");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email, and password are required" });
    }

    // FIX: Add await for Mongoose operations
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ message: "Email already in use" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(20).toString("hex");
    const userId = `user_${generateId()}`;

    const user = await User.create({
      _id: userId,
      name,
      email,
      passwordHash,
      verificationToken,
      isVerified: false,
      accountStatus: "pending",
      role: "student"
    });

    console.log(`[MOCK EMAIL] Verification Link: http://localhost:5500/verify/?token=${verificationToken}`);

    return res.status(201).json({
      user: { id: user._id, name: user.name, email: user.email },
      message: "Account created successfully. Please wait for admin approval before logging in."
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

    const user = await User.findOne({ verificationToken: token });
    if (!user) return res.status(400).json({ message: "Invalid or expired token" });

    await User.findByIdAndUpdate(user._id, {
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
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const resetToken = crypto.randomBytes(20).toString("hex");
    await User.findByIdAndUpdate(user._id, {
      resetPasswordToken: resetToken,
      resetPasswordExpires: Date.now() + 3600000,
      updatedAt: new Date().toISOString()
    });

    console.log(`[MOCK EMAIL] Reset Link: http://localhost:5500/reset-password/?token=${resetToken}`);

    return res.json({ message: "Password reset link sent to email" });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    const user = await User.findOne({ resetPasswordToken: token });

    if (!user || !user.resetPasswordExpires || user.resetPasswordExpires < Date.now()) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await User.findByIdAndUpdate(user._id, {
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

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const accountStatus = user.accountStatus || "pending";
    if (accountStatus !== "active") {
      return res.status(403).json({
        message: accountStatus === "pending"
          ? "Your account is pending admin approval."
          : "Your account is blocked. Contact admin."
      });
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
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const subscription = await Subscription.findOne({ userId: req.user.id, status: "active" });

    return res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role || "student",
        accountStatus: user.accountStatus || "active"
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
