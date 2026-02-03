const express = require("express");
const { Course, Lesson, Quiz } = require("../db");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.get("/courses", authMiddleware, async (req, res) => {
  try {
    const courses = await Course.find({}).sort({ title: 1 });

    const data = await Promise.all(courses.map(async (course) => {
      const lessonsCount = await Lesson.countDocuments({ courseId: course.courseId });
      // simplistic quiz count: count unique quizzes linked to lessons of this course?
      // Or just quizzes with this courseId
      const quizCount = await Quiz.countDocuments({ courseId: course.courseId });

      // Mock progress for now (random 0-100 or 0)
      const progress = 0;

      return {
        id: course.courseId,
        title: course.title,
        lessonsCount,
        quizCount,
        progress
      };
    }));

    res.json({ courses: data });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/lessons", authMiddleware, (req, res) => {
  const { courseId } = req.query;
  const filter = courseId ? { courseId } : {};

  Lesson.find(filter)
    .sort({ createdAt: 1 })
    .then((lessons) => {
      const data = lessons.map((lesson) => ({
        id: lesson.lessonId,
        courseId: lesson.courseId,
        title: lesson.title,
        videoUrl: lesson.videoUrl,
        quizId: lesson.quizId
      }));
      res.json({ lessons: data });
    })
    .catch(() => res.status(500).json({ message: "Server error" }));
});

router.get("/videos/:id", authMiddleware, (req, res) => {
  Lesson.findOne({ lessonId: req.params.id })
    .then((lesson) => {
      if (!lesson) {
        return res.status(404).json({ message: "Video not found" });
      }
      return res.json({
        video: {
          id: lesson.lessonId,
          courseId: lesson.courseId,
          title: lesson.title,
          videoUrl: lesson.videoUrl,
          quizId: lesson.quizId
        }
      });
    })
    .catch(() => res.status(500).json({ message: "Server error" }));
});

router.get("/quizzes", authMiddleware, (req, res) => {
  Quiz.find({})
    .sort({ createdAt: 1 })
    .then((quizzes) => {
      const quizSummaries = quizzes.map((quiz) => ({
        id: quiz.quizId,
        courseId: quiz.courseId,
        lessonId: quiz.lessonId,
        title: quiz.title,
        questions: quiz.questions.length
      }));
      res.json({ quizzes: quizSummaries });
    })
    .catch(() => res.status(500).json({ message: "Server error" }));
});

router.get("/quizzes/:id", authMiddleware, (req, res) => {
  Quiz.findOne({ quizId: req.params.id })
    .then((quiz) => {
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found" });
      }
      return res.json({
        quiz: {
          id: quiz.quizId,
          courseId: quiz.courseId,
          lessonId: quiz.lessonId,
          title: quiz.title,
          questions: quiz.questions
        }
      });
    })
    .catch(() => res.status(500).json({ message: "Server error" }));
});

router.get("/analytics", authMiddleware, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const totalItems = await Progress.countDocuments({ userId });
    const completedItems = await Progress.countDocuments({ userId, completed: true });

    const avgScoreAgg = await Progress.aggregate([
      { $match: { userId } },
      { $group: { _id: null, avgScore: { $avg: "$score" } } }
    ]);

    const avgScore = avgScoreAgg.length ? Math.round(avgScoreAgg[0].avgScore) : 0;
    const completionRate = totalItems ? Math.round((completedItems / totalItems) * 100) : 0;

    res.json({
      totalItems,
      completedItems,
      completionRate,
      avgScore
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/subscribe", authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body || {};

    if (!plan) {
      return res.status(400).json({ message: "Plan is required" });
    }

    const subscription = await Subscription.findOneAndUpdate(
      { userId: req.user.id },
      { plan, status: "active", startedAt: new Date() },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({
      message: "Subscription activated",
      subscription: {
        plan: subscription.plan,
        status: subscription.status,
        startedAt: subscription.startedAt
      }
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
