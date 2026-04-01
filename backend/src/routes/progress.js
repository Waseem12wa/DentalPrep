const express = require("express");
const { Progress, Quiz } = require("../db");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.get("/progress", authMiddleware, async (req, res) => {
  try {
    const filter = { userId: req.user.id };
    if (req.query.courseId) {
      filter.courseId = req.query.courseId;
    }

    const items = (await Progress.find(filter)).sort((left, right) => {
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

    const item = await Progress.findOneAndUpdate(
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

router.post("/quiz-submit", authMiddleware, async (req, res) => {
  try {
    const { quizId, courseId, answers } = req.body || {};
    
    if (!quizId || !courseId || !answers || typeof answers !== "object") {
      return res.status(400).json({ message: "quizId, courseId, and answers are required" });
    }

    const quiz = await Quiz.findOne({ quizId });
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    const questions = quiz.questions || [];
    let correctCount = 0;
    let totalCount = questions.length;

    const detailedResults = questions.map(question => {
      const studentAnswer = answers[question.id];
      const isCorrect = studentAnswer === question.correctAnswer;
      if (isCorrect) correctCount++;
      
      return {
        questionId: question.id,
        question: question.question,
        studentAnswer,
        correctAnswer: question.correctAnswer,
        isCorrect,
        options: question.options
      };
    });

    const scorePercentage = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

    const progress = await Progress.findOneAndUpdate(
      { userId: req.user.id, quizId, itemType: "quiz" },
      {
        userId: req.user.id,
        courseId,
        quizId,
        itemType: "quiz",
        referenceId: quizId,
        title: quiz.title,
        completed: true,
        score: scorePercentage,
        answersSelected: answers,
        totalQuestions: totalCount,
        correctAnswers: correctCount
      },
      { new: true, upsert: true }
    );

    return res.json({
      success: true,
      score: scorePercentage,
      message: `You scored ${correctCount}/${totalCount} (${scorePercentage}%)`,
      correctCount,
      totalCount,
      results: detailedResults,
      progress
    });
  } catch (err) {
    console.error("Quiz submission error:", err);
    return res.status(500).json({ message: "Server error during quiz submission" });
  }
});

module.exports = router;
