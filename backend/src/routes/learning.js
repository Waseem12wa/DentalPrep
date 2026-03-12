const express = require("express");
const { Course, Lesson, Quiz, Progress, Review, User, AiChat, generateId } = require("../db");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

const byText = (key) => (left, right) => String(left[key] || "").localeCompare(String(right[key] || ""));
const byDateDesc = (left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0);
const isYoutubeUrl = (value) => /(?:youtube\.com|youtu\.be)/i.test(String(value || ""));

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildLessonResponse(lesson, course) {
  const videoUrl = String(lesson.videoUrl || "").trim();

  return {
    id: lesson.lessonId,
    courseId: lesson.courseId,
    courseTitle: course ? course.title : lesson.courseId,
    title: lesson.title,
    summary: lesson.summary || "",
    videoUrl,
    videoType: videoUrl ? (lesson.videoType || (isYoutubeUrl(videoUrl) ? "youtube" : "upload")) : null,
    hasVideo: Boolean(videoUrl),
    audioItems: normalizeArray(lesson.audioItems),
    materials: normalizeArray(lesson.materials),
    caseStudies: normalizeArray(lesson.caseStudies),
    quizId: lesson.quizId,
    category: course?.category || "",
    curriculumTags: normalizeArray(course?.curriculumTags)
  };
}

function tokenize(text) {
  return Array.from(new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2)
  ));
}

function scoreText(text, tokens) {
  const haystack = String(text || "").toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function buildWeakAreas(progressItems, quizzesById, lessonsById, coursesById) {
  return progressItems
    .filter((item) => item.itemType === "quiz" && Number(item.score) < 70)
    .sort((left, right) => Number(left.score) - Number(right.score))
    .map((item) => {
      const quiz = quizzesById[item.quizId || item.referenceId];
      const lesson = lessonsById[item.lessonId || quiz?.lessonId];
      const course = coursesById[item.courseId || lesson?.courseId || quiz?.courseId];
      return {
        quizId: quiz?.quizId || item.quizId || item.referenceId,
        quizTitle: quiz ? quiz.title : item.title || "Quiz",
        lessonTitle: lesson ? lesson.title : "Lesson",
        courseTitle: course ? course.title : item.courseId,
        score: Number(item.score) || 0
      };
    })
    .filter((item, index, list) => list.findIndex((candidate) => candidate.quizId === item.quizId) === index)
    .slice(0, 5);
}

function findAssistantContext(prompt, courseId, lessonId) {
  const tokens = tokenize(prompt);
  const courses = courseId ? Course.find({ courseId }) : Course.find({});
  const lessons = lessonId ? Lesson.find({ lessonId }) : courseId ? Lesson.find({ courseId }) : Lesson.find({});
  const quizzes = (courseId || lessonId)
    ? Quiz.find({}).filter((quiz) => (!courseId || quiz.courseId === courseId) && (!lessonId || quiz.lessonId === lessonId))
    : Quiz.find({});

  const matchedCourses = courses
    .map((course) => ({ item: course, score: scoreText(`${course.title} ${course.description || ""} ${(course.curriculumTags || []).join(" ")} ${course.category || ""}`, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.item);

  const matchedLessons = lessons
    .map((lesson) => ({
      item: lesson,
      score: scoreText(
        `${lesson.title} ${lesson.summary || ""} ${(normalizeArray(lesson.caseStudies)).map((item) => `${item.title} ${item.scenario || ""} ${item.discussion || ""}`).join(" ")} ${(normalizeArray(lesson.materials)).map((item) => item.title || item.fileName).join(" ")}`,
        tokens
      )
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((entry) => entry.item);

  const matchedQuizzes = quizzes
    .map((quiz) => ({
      item: quiz,
      score: scoreText(`${quiz.title} ${(normalizeArray(quiz.questions)).map((question) => `${question.question} ${(question.options || []).join(" ")} ${question.correctAnswer || ""}`).join(" ")}`, tokens)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.item);

  if (!matchedCourses.length && !matchedLessons.length && !matchedQuizzes.length) {
    return {
      courses: courses.slice(0, 2),
      lessons: lessons.slice(0, 2),
      quizzes: quizzes.slice(0, 2)
    };
  }

  return {
    courses: matchedCourses,
    lessons: matchedLessons,
    quizzes: matchedQuizzes
  };
}

function buildLocalAssistantReply(prompt, context) {
  const sections = [`Topic: ${prompt.trim()}`];

  if (context.courses.length) {
    sections.push(`Relevant courses: ${context.courses.map((course) => course.title).join(", ")}.`);
  }

  if (context.lessons.length) {
    sections.push(`Lesson guidance: ${context.lessons.map((lesson) => `${lesson.title}: ${lesson.summary || "This lesson contains supporting media and case studies for the topic."}`).join(" ")}`);
  }

  if (context.quizzes.length) {
    const quizText = context.quizzes.slice(0, 2).map((quiz) => {
      const firstQuestion = normalizeArray(quiz.questions)[0];
      if (!firstQuestion) {
        return `${quiz.title} is available for additional practice.`;
      }
      return `${quiz.title}: one stored practice prompt is "${firstQuestion.question}" and the saved correct answer is "${firstQuestion.correctAnswer}".`;
    }).join(" ");
    sections.push(`Practice angle: ${quizText}`);
  }

  if (!context.courses.length && !context.lessons.length && !context.quizzes.length) {
    sections.push("No close course, lesson, or quiz match was found in the current DentalPrep content. Try naming the lesson, case, or quiz topic more specifically.");
  } else {
    sections.push("Use the lesson viewer, study materials, and quizzes linked in the portal to reinforce this explanation.");
  }

  return sections.join("\n\n");
}

async function maybeGenerateAiReply(prompt, context) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey || !model) {
    return buildLocalAssistantReply(prompt, context);
  }

  const contextText = [
    context.courses.map((course) => `Course: ${course.title}\nDescription: ${course.description || ""}\nTags: ${(course.curriculumTags || []).join(", ")}`).join("\n\n"),
    context.lessons.map((lesson) => `Lesson: ${lesson.title}\nSummary: ${lesson.summary || ""}\nCases: ${(normalizeArray(lesson.caseStudies)).map((item) => `${item.title}: ${item.scenario || item.discussion || ""}`).join(" | ")}`).join("\n\n"),
    context.quizzes.map((quiz) => `Quiz: ${quiz.title}\nQuestions: ${(normalizeArray(quiz.questions)).slice(0, 3).map((question) => `${question.question} -> ${question.correctAnswer || ""}`).join(" | ")}`).join("\n\n")
  ].filter(Boolean).join("\n\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: "You are DentalPrep's study assistant. Answer only from the supplied LMS context. If the material is insufficient, say so clearly and suggest what course, lesson, or quiz to open next."
          },
          {
            role: "user",
            content: `Question: ${prompt}\n\nDentalPrep context:\n${contextText || "No matching LMS context found."}`
          }
        ]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error((data && data.error && data.error.message) || "AI request failed");
    }

    if (typeof data.output_text === "string" && data.output_text.trim()) {
      return data.output_text.trim();
    }

    return buildLocalAssistantReply(prompt, context);
  } catch (_err) {
    return buildLocalAssistantReply(prompt, context);
  }
}

router.get("/courses", authMiddleware, async (req, res) => {
  try {
    const courses = Course.find({}).sort(byText("title"));
    const allLessons = Lesson.find({});
    const allQuizzes = Quiz.find({});
    const progressItems = req.user.id ? Progress.find({ userId: req.user.id, completed: true }) : [];

    const data = courses.map((course) => {
      const courseLessons = allLessons.filter((lesson) => lesson.courseId === course.courseId);
      const courseQuizzes = allQuizzes.filter((quiz) => quiz.courseId === course.courseId);
      const totalTrackableItems = courseLessons.length + courseQuizzes.length;
      const completedItems = progressItems.filter((item) => item.courseId === course.courseId).length;
      const audioCount = courseLessons.reduce((sum, lesson) => sum + normalizeArray(lesson.audioItems).length, 0);
      const materialsCount = courseLessons.reduce((sum, lesson) => sum + normalizeArray(lesson.materials).length, 0);
      const caseStudiesCount = courseLessons.reduce((sum, lesson) => sum + normalizeArray(lesson.caseStudies).length, 0);
      const progress = totalTrackableItems ? Math.round((completedItems / totalTrackableItems) * 100) : 0;

      return {
        id: course.courseId,
        title: course.title,
        description: course.description || "",
        category: course.category || "",
        curriculumTags: normalizeArray(course.curriculumTags),
        lessonsCount: courseLessons.length,
        quizCount: courseQuizzes.length,
        audioCount,
        materialsCount,
        caseStudiesCount,
        progress
      };
    });

    res.json({ courses: data });
  } catch (_err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/courses/:id", authMiddleware, async (req, res) => {
  try {
    const course = Course.findOne({ courseId: req.params.id });
    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    const lessons = Lesson.find({ courseId: course.courseId }).sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
    const quizzes = Quiz.find({ courseId: course.courseId });
    const lessonSummaries = lessons.map((lesson) => buildLessonResponse(lesson, course));

    return res.json({
      course: {
        id: course.courseId,
        title: course.title,
        description: course.description || "",
        category: course.category || "",
        curriculumTags: normalizeArray(course.curriculumTags),
        lessons: lessonSummaries,
        quizCount: quizzes.length,
        materialsCount: lessonSummaries.reduce((sum, lesson) => sum + lesson.materials.length, 0),
        caseStudiesCount: lessonSummaries.reduce((sum, lesson) => sum + lesson.caseStudies.length, 0)
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/lessons", authMiddleware, (req, res) => {
  try {
    const filter = req.query.courseId ? { courseId: req.query.courseId } : {};
    const lessons = Lesson.find(filter).sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
    const coursesById = Course.find({}).reduce((acc, course) => {
      acc[course.courseId] = course;
      return acc;
    }, {});

    res.json({ lessons: lessons.map((lesson) => buildLessonResponse(lesson, coursesById[lesson.courseId])) });
  } catch (_err) {
    res.status(500).json({ message: "Server error" });
  }
});

router.get("/videos/:id", authMiddleware, (req, res) => {
  try {
    const lesson = Lesson.findOne({ lessonId: req.params.id });
    if (!lesson) {
      return res.status(404).json({ message: "Video not found" });
    }

    const course = Course.findOne({ courseId: lesson.courseId });
    const quiz = lesson.quizId ? Quiz.findOne({ quizId: lesson.quizId }) : null;
    const progressItem = req.user.id
      ? Progress.find({ userId: req.user.id, courseId: lesson.courseId }).find((item) => item.referenceId === lesson.lessonId || item.lessonId === lesson.lessonId)
      : null;

    return res.json({
      video: {
        ...buildLessonResponse(lesson, course),
        progress: progressItem || null,
        quiz: quiz
          ? {
              id: quiz.quizId,
              title: quiz.title,
              questionCount: normalizeArray(quiz.questions).length
            }
          : null
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/materials", authMiddleware, (req, res) => {
  try {
    const courseFilter = req.query.courseId;
    const lessonFilter = req.query.lessonId;
    const coursesById = Course.find({}).reduce((acc, course) => {
      acc[course.courseId] = course;
      return acc;
    }, {});

    const lessons = Lesson.find({}).filter((lesson) => (
      (!courseFilter || lesson.courseId === courseFilter)
      && (!lessonFilter || lesson.lessonId === lessonFilter)
    ));

    const materials = lessons.flatMap((lesson) => normalizeArray(lesson.materials).map((material) => ({
      id: material.id,
      title: material.title || material.fileName,
      fileName: material.fileName,
      fileUrl: material.fileUrl,
      mimeType: material.mimeType,
      size: material.size,
      lessonId: lesson.lessonId,
      lessonTitle: lesson.title,
      courseId: lesson.courseId,
      courseTitle: coursesById[lesson.courseId]?.title || lesson.courseId,
      curriculumTags: normalizeArray(coursesById[lesson.courseId]?.curriculumTags)
    })));

    return res.json({ materials });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/quizzes", authMiddleware, (req, res) => {
  try {
    const filter = {};
    if (req.query.courseId) filter.courseId = req.query.courseId;
    if (req.query.lessonId) filter.lessonId = req.query.lessonId;

    const progressByQuizId = req.user.id
      ? Progress.find({ userId: req.user.id, itemType: "quiz" }).reduce((acc, item) => {
          const id = item.quizId || item.referenceId;
          if (!id) {
            return acc;
          }
          if (!acc[id] || Number(item.score) > Number(acc[id].score || 0)) {
            acc[id] = item;
          }
          return acc;
        }, {})
      : {};

    const quizzes = Quiz.find(filter).sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
    const summaries = quizzes.map((quiz) => ({
      id: quiz.quizId,
      courseId: quiz.courseId,
      lessonId: quiz.lessonId,
      title: quiz.title,
      questions: normalizeArray(quiz.questions).length,
      bestScore: progressByQuizId[quiz.quizId] ? Number(progressByQuizId[quiz.quizId].score) || 0 : null
    }));

    return res.json({ quizzes: summaries });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/quizzes/:id", authMiddleware, (req, res) => {
  try {
    const quiz = Quiz.findOne({ quizId: req.params.id });
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    return res.json({
      quiz: {
        id: quiz.quizId,
        courseId: quiz.courseId,
        lessonId: quiz.lessonId,
        title: quiz.title,
        questions: normalizeArray(quiz.questions)
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/analytics", authMiddleware, async (req, res) => {
  try {
    const courses = Course.find({});
    const lessons = Lesson.find({});
    const quizzes = Quiz.find({});
    const items = Progress.find({ userId: req.user.id }).sort(byDateDesc);
    const completedLessons = items.filter((item) => item.itemType === "lesson" && item.completed).length;
    const quizAttempts = items.filter((item) => item.itemType === "quiz");
    const completedQuizAttempts = quizAttempts.filter((item) => item.completed).length;
    const avgScore = quizAttempts.length
      ? Math.round(quizAttempts.reduce((sum, item) => sum + (Number(item.score) || 0), 0) / quizAttempts.length)
      : 0;
    const totalTrackableItems = lessons.length + quizzes.length;
    const completionRate = totalTrackableItems
      ? Math.round(((completedLessons + completedQuizAttempts) / totalTrackableItems) * 100)
      : 0;

    const quizzesById = quizzes.reduce((acc, quiz) => {
      acc[quiz.quizId] = quiz;
      return acc;
    }, {});
    const lessonsById = lessons.reduce((acc, lesson) => {
      acc[lesson.lessonId] = lesson;
      return acc;
    }, {});
    const coursesById = courses.reduce((acc, course) => {
      acc[course.courseId] = course;
      return acc;
    }, {});

    const weakAreas = buildWeakAreas(items, quizzesById, lessonsById, coursesById);
    const recentActivity = items.slice(0, 8).map((item) => ({
      id: item._id,
      title: item.title || item.referenceId,
      itemType: item.itemType,
      courseTitle: coursesById[item.courseId]?.title || item.courseId,
      score: item.itemType === "quiz" ? Number(item.score) || 0 : null,
      completed: Boolean(item.completed),
      updatedAt: item.updatedAt || item.createdAt
    }));

    return res.json({
      totalCourses: courses.length,
      totalLessons: lessons.length,
      completedLessons,
      totalQuizAttempts: quizAttempts.length,
      avgScore,
      completionRate,
      weakAreas,
      recentActivity
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/reviews", authMiddleware, async (req, res) => {
  try {
    const filter = req.query.courseId ? { courseId: req.query.courseId } : {};
    const reviews = Review.find(filter)
      .sort(byDateDesc)
      .map((review) => {
        const user = User.findById(review.userId);
        return {
          id: review._id,
          courseId: review.courseId,
          rating: review.rating,
          comment: review.comment,
          userName: user ? user.name : review.userName || "Student",
          createdAt: review.createdAt
        };
      });

    return res.json({ reviews });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/reviews", authMiddleware, async (req, res) => {
  try {
    const { courseId, rating, comment } = req.body || {};
    if (!courseId || !rating || !comment) {
      return res.status(400).json({ message: "courseId, rating, and comment are required" });
    }

    const course = Course.findOne({ courseId });
    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    const lessons = Lesson.find({ courseId });
    if (lessons.length === 0) {
      return res.status(400).json({ message: "This course has no lessons yet" });
    }

    const completedLessonsList = Progress.find({ userId: req.user.id, courseId, itemType: "lesson", completed: true });
    if (completedLessonsList.length < lessons.length) {
      return res.status(400).json({ message: "Complete all lessons before leaving a review" });
    }

    const numericRating = Math.max(1, Math.min(5, Number(rating)));
    const user = User.findById(req.user.id);
    const review = Review.findOneAndUpdate(
      { userId: req.user.id, courseId },
      {
        userId: req.user.id,
        courseId,
        rating: numericRating,
        comment: String(comment).trim(),
        userName: user ? user.name : "Student"
      },
      { new: true, upsert: true }
    );

    return res.status(201).json({ review });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/assistant/history", authMiddleware, async (req, res) => {
  try {
    const chats = AiChat.find({ userId: req.user.id })
      .filter((chat) => (!req.query.courseId || chat.courseId === req.query.courseId) && (!req.query.lessonId || chat.lessonId === req.query.lessonId))
      .sort(byDateDesc)
      .slice(0, 25)
      .map((chat) => ({
        id: chat._id,
        prompt: chat.prompt,
        response: chat.response,
        sourceTitles: normalizeArray(chat.sourceTitles),
        courseId: chat.courseId || null,
        lessonId: chat.lessonId || null,
        createdAt: chat.createdAt
      }));

    return res.json({ chats });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/assistant/explain", authMiddleware, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || req.body?.question || req.body?.topic || "").trim();
    const courseId = String(req.body?.courseId || "").trim() || null;
    const lessonId = String(req.body?.lessonId || "").trim() || null;

    if (!prompt) {
      return res.status(400).json({ message: "A topic or question is required" });
    }

    const context = findAssistantContext(prompt, courseId, lessonId);
    const reply = await maybeGenerateAiReply(prompt, context);
    const sourceTitles = [
      ...context.courses.map((item) => item.title),
      ...context.lessons.map((item) => item.title),
      ...context.quizzes.map((item) => item.title)
    ].filter(Boolean);

    const chat = AiChat.create({
      _id: `ai_${generateId()}`,
      userId: req.user.id,
      courseId,
      lessonId,
      prompt,
      response: reply,
      sourceTitles
    });

    return res.status(201).json({
      answer: reply,
      chat: {
        id: chat._id,
        prompt: chat.prompt,
        response: chat.response,
        sourceTitles: chat.sourceTitles,
        createdAt: chat.createdAt
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
