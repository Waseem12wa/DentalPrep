const express = require("express");
const { Progress } = require("../db");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.get("/progress", authMiddleware, async (req, res) => {
  try {
    const items = await Progress.find({ userId: req.user.id }).sort({ updatedAt: -1 });
    return res.json({ items });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/progress", authMiddleware, async (req, res) => {
  try {
    const { courseId, videoId, completed, score } = req.body || {};

    if (!courseId || !videoId) {
      return res.status(400).json({ message: "courseId and videoId are required" });
    }

    const item = await Progress.findOneAndUpdate(
      { userId: req.user.id, courseId, videoId },
      { completed: !!completed, score: typeof score === "number" ? score : 0 },
      { new: true, upsert: true }
    );

    return res.status(201).json({ item });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
