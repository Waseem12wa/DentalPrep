const express = require("express");
const { Progress } = require("../db");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.get("/progress", authMiddleware, async (req, res) => {
  try {
    const filter = { userId: req.user.id };
    if (req.query.courseId) {
      filter.courseId = req.query.courseId;
    }

    const items = Progress.find(filter).sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    });
    return res.json({ items });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/progress", authMiddleware, async (req, res) => {
  try {
    const { courseId, videoId, lessonId, quizId, itemType, completed, score, title } = req.body || {};
    const normalizedType = itemType || (quizId ? "quiz" : "lesson");
    const referenceId = quizId || lessonId || videoId;

    if (!courseId || !referenceId) {
      return res.status(400).json({ message: "courseId and a lesson or quiz reference are required" });
    }

    const item = Progress.findOneAndUpdate(
      { userId: req.user.id, itemType: normalizedType, referenceId },
      {
        userId: req.user.id,
        courseId,
        videoId: videoId || referenceId,
        lessonId: lessonId || (normalizedType === "lesson" ? referenceId : undefined),
        quizId: quizId || (normalizedType === "quiz" ? referenceId : undefined),
        itemType: normalizedType,
        referenceId,
        title: title || null,
        completed: Boolean(completed),
        score: typeof score === "number" ? score : Number(score) || 0
      },
      { new: true, upsert: true }
    );

    return res.status(201).json({ item });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
