const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Course, Lesson, Quiz, Progress, Review, User, Subscription, AiChat, SubjectContent, AcademyProfile, PdfAccessRequest, generateId } = require("../db");

const router = express.Router();

const uploadsDir = path.resolve(__dirname, "../../../static/uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const quizUpload = multer({ storage: multer.memoryStorage() });
const contentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsDir),
    filename: (_req, file, callback) => {
      const ext = path.extname(file.originalname) || "";
      const base = normalizeId(path.basename(file.originalname, ext)) || "asset";
      callback(null, `${Date.now()}_${base}${ext}`);
    }
  })
});

function normalizeId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function splitValues(value) {
  return String(value || "")
    .split(/\r?\n|,/) 
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTagList(value) {
  return Array.from(new Set(splitValues(value)));
}

function isYoutubeUrl(value) {
  return /(?:youtube\.com|youtu\.be)/i.test(String(value || ""));
}

function normalizeAccessLevel(value) {
  return String(value || "free").trim().toLowerCase() === "paid" ? "paid" : "free";
}

function createAssetRecord(file, kind, index = 0, accessLevel = "free") {
  const ext = path.extname(file.originalname || "");
  const title = path.basename(file.originalname || `${kind}_${index + 1}`, ext) || `${kind} ${index + 1}`;
  const fileUrl = `/static/uploads/${file.filename}`;
  return {
    id: `${kind}_${generateId()}`,
    kind,
    title,
    fileName: file.originalname,
    fileUrl,
    url: fileUrl,
    accessLevel: normalizeAccessLevel(accessLevel),
    mimeType: file.mimetype || "application/octet-stream",
    size: file.size || 0
  };
}

function parseCaseStudies(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item, index) => ({
            id: item.id || `case_${generateId()}`,
            title: String(item.title || `Case Study ${index + 1}`).trim(),
            scenario: String(item.scenario || "").trim(),
            diagnosis: String(item.diagnosis || "").trim(),
            discussion: String(item.discussion || "").trim(),
            relevance: String(item.relevance || "").trim()
          }))
          .filter((item) => item.title || item.scenario || item.discussion || item.diagnosis);
      }
    } catch (_err) {
      // Fall through to block parsing.
    }
  }

  return raw
    .split(/\n\s*---+\s*\n/g)
    .map((block, index) => {
      const caseStudy = {
        id: `case_${generateId()}`,
        title: `Case Study ${index + 1}`,
        scenario: "",
        diagnosis: "",
        discussion: "",
        relevance: ""
      };
      let currentField = "scenario";

      block.split(/\r?\n/).forEach((line) => {
        const match = line.match(/^(title|scenario|diagnosis|discussion|relevance)\s*:\s*(.*)$/i);
        if (match) {
          currentField = match[1].toLowerCase();
          caseStudy[currentField] = match[2].trim();
          return;
        }

        if (!line.trim()) {
          return;
        }

        caseStudy[currentField] = `${caseStudy[currentField]}${caseStudy[currentField] ? "\n" : ""}${line.trim()}`;
      });

      return caseStudy;
    })
    .filter((item) => item.title || item.scenario || item.diagnosis || item.discussion || item.relevance);
}

function parseLineLinks(value, accessLevel) {
  const normalizedAccessLevel = accessLevel ? normalizeAccessLevel(accessLevel) : null;
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split("|").map((part) => part.trim());
      if (parts.length >= 2) {
        const item = {
          title: parts[0] || `Resource ${index + 1}`,
          url: parts.slice(1).join("|") || "#"
        };
        if (normalizedAccessLevel) {
          item.accessLevel = normalizedAccessLevel;
        }
        return item;
      }

      const item = {
        title: `Resource ${index + 1}`,
        url: parts[0] || "#"
      };
      if (normalizedAccessLevel) {
        item.accessLevel = normalizedAccessLevel;
      }
      return item;
    });
}

function sanitizeLinks(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const raw = (item && typeof item.toObject === "function") ? item.toObject() : item;
      const doc = raw && raw._doc ? raw._doc : raw;
      const title = String((doc && doc.title) || "").trim();
      const rawUrl = (doc && doc.url) || "";
      const rawFileUrl = (doc && doc.fileUrl) || "";
      const accessLevel = normalizeAccessLevel((doc && doc.accessLevel) || "free");
      const preferredUrl = (rawUrl && String(rawUrl).trim() !== "#") ? rawUrl : (rawFileUrl || rawUrl || "");
      const url = String(preferredUrl || "").trim();
      if (!title && !url) {
        return null;
      }
      if (!url || url === "#") {
        return null;
      }
      return {
        title: title || url || "Resource",
        url,
        accessLevel
      };
    })
    .filter(Boolean);
}

function mergeUniqueStrings(existingValues, incomingValues) {
  const seen = new Set();
  const merged = [];

  const add = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized) {
      return;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(normalized);
  };

  (Array.isArray(existingValues) ? existingValues : []).forEach(add);
  (Array.isArray(incomingValues) ? incomingValues : []).forEach(add);

  return merged;
}

function mergeUniqueLinks(existingItems, incomingItems) {
  const seen = new Set();
  const merged = [];

  const add = (item) => {
    if (!item || typeof item !== "object") {
      return;
    }

    const raw = (item && typeof item.toObject === "function") ? item.toObject() : item;
    const doc = raw && raw._doc ? raw._doc : raw;
    const title = String((doc && doc.title) || "").trim();
    const rawUrl = (doc && doc.url) || "";
    const rawFileUrl = (doc && doc.fileUrl) || "";
    const accessLevel = normalizeAccessLevel((doc && doc.accessLevel) || "free");
    const preferredUrl = (rawUrl && String(rawUrl).trim() !== "#") ? rawUrl : (rawFileUrl || rawUrl || "");
    const url = String(preferredUrl || "").trim();

    if (!url || url === "#") {
      return;
    }

    const normalizedTitle = title || url || "Resource";
    const key = `${normalizedTitle.toLowerCase()}|${url.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push({
      ...doc,
      title: normalizedTitle,
      url,
      accessLevel,
      fileUrl: String((doc && doc.fileUrl) || url).trim()
    });
  };

  (Array.isArray(existingItems) ? existingItems : []).forEach(add);
  (Array.isArray(incomingItems) ? incomingItems : []).forEach(add);

  return merged;
}

async function ensureAcademyProfile() {
  const existing = await AcademyProfile.findOne({ id: "academy_profile" });
  if (existing) {
    return existing;
  }

  return await AcademyProfile.findOneAndUpdate(
    { id: "academy_profile" },
    {
      id: "academy_profile",
      aboutAcademyText: "Dental Prep is your structured BDS preparation platform where each subject is organized into simple blocks, helping students move from fundamentals to clinical confidence.",
      generalOverview: {
        books: [{ title: "BDS Core Reading List", url: "#" }],
        premiumNotes: [{ title: "Premium Notes Pack", url: "#" }],
        importantSlides: [{ title: "Important Slides Collection", url: "#" }],
        shortNotes: [{ title: "Short Notes for Final Revision", url: "#" }],
        videos: Array.from({ length: 6 }).map((_, index) => ({
          title: `General Overview Video ${index + 1}`,
          url: "https://www.youtube.com/@pulseprepofficial"
        }))
      },
      aboutUs: {
        profileImageUrl: "/static/images/favicon.png",
        introVideoUrl: "https://www.youtube.com/@pulseprepofficial",
        notes: [{ title: "Academy Intro Notes", url: "#" }],
        pdfResources: [{ title: "Academy Resource PDF", url: "#" }],
        contactEmail: "admin@dentalprep.com",
        contactNumbers: ["+92 335 9591271"],
        socialLinks: {
          facebook: "https://facebook.com/profile.php?id=61576776451528",
          youtube: "https://www.youtube.com/@pulseprepofficial",
          instagram: "https://instagram.com/pulseprepofficial",
          linkedin: "https://linkedin.com/in/pulse-prep-778292368"
        }
      }
    },
    { new: true, upsert: true }
  );
}

async function buildStudentAnalytics() {
  const courses = await Course.find({});
  const lessons = await Lesson.find({});
  const quizzes = await Quiz.find({});
  const progressItems = await Progress.find({});
  const students = (await User.find({})).filter((user) => user.role !== "admin");

  const coursesById = courses.reduce((acc, course) => {
    acc[course.courseId] = course;
    return acc;
  }, {});
  const lessonsById = lessons.reduce((acc, lesson) => {
    acc[lesson.lessonId] = lesson;
    return acc;
  }, {});
  const quizzesById = quizzes.reduce((acc, quiz) => {
    acc[quiz.quizId] = quiz;
    return acc;
  }, {});
  const totalTrackableItems = lessons.length + quizzes.length;

  return students
    .map((student) => {
      const userProgress = progressItems.filter((item) => item.userId === student._id);
      const completedLessons = userProgress.filter((item) => item.itemType === "lesson" && item.completed).length;
      const quizAttempts = userProgress.filter((item) => item.itemType === "quiz");
      const avgScore = quizAttempts.length
        ? Math.round(quizAttempts.reduce((sum, item) => sum + (Number(item.score) || 0), 0) / quizAttempts.length)
        : 0;
      const weakAreas = quizAttempts
        .filter((item) => Number(item.score) < 70)
        .sort((left, right) => Number(left.score) - Number(right.score))
        .slice(0, 3)
        .map((item) => {
          const quiz = quizzesById[item.quizId || item.referenceId];
          const lesson = lessonsById[item.lessonId || quiz?.lessonId];
          const course = coursesById[item.courseId || lesson?.courseId || quiz?.courseId];
          return {
            quizTitle: quiz ? quiz.title : item.title || "Quiz",
            lessonTitle: lesson ? lesson.title : "Lesson",
            courseTitle: course ? course.title : item.courseId,
            score: Number(item.score) || 0
          };
        });

      return {
        userId: student._id,
        name: student.name || "Student",
        email: student.email || "",
        completedLessons,
        quizAttempts: quizAttempts.length,
        avgScore,
        completionRate: totalTrackableItems
          ? Math.round(((completedLessons + quizAttempts.filter((item) => item.completed).length) / totalTrackableItems) * 100)
          : 0,
        weakAreas,
        updatedAt: userProgress[0]?.updatedAt || student.updatedAt || student.createdAt
      };
    })
    .sort((left, right) => right.completionRate - left.completionRate || right.avgScore - left.avgScore);
}

async function buildManagedStudents() {
  const courses = await Course.find({});
  const lessons = await Lesson.find({});
  const quizzes = await Quiz.find({});
  const progressItems = await Progress.find({});
  const students = (await User.find({})).filter((user) => user.role !== "admin");

  const coursesById = courses.reduce((acc, course) => {
    acc[course.courseId] = course;
    return acc;
  }, {});
  const lessonsById = lessons.reduce((acc, lesson) => {
    acc[lesson.lessonId] = lesson;
    return acc;
  }, {});
  const quizzesById = quizzes.reduce((acc, quiz) => {
    acc[quiz.quizId] = quiz;
    return acc;
  }, {});
  const totalTrackableItems = lessons.length + quizzes.length;

  return students
    .map((student) => {
      const userProgress = progressItems.filter((item) => item.userId === student._id);
      const completedLessons = userProgress.filter((item) => item.itemType === "lesson" && item.completed).length;
      const quizAttempts = userProgress.filter((item) => item.itemType === "quiz");
      const avgScore = quizAttempts.length
        ? Math.round(quizAttempts.reduce((sum, item) => sum + (Number(item.score) || 0), 0) / quizAttempts.length)
        : 0;

      return {
        userId: student._id,
        name: student.name || "Student",
        email: student.email || "",
        role: student.role || "student",
        isVerified: Boolean(student.isVerified),
        accountStatus: student.accountStatus || "active",
        completedLessons,
        quizAttempts: quizAttempts.length,
        avgScore,
        completionRate: totalTrackableItems
          ? Math.round(((completedLessons + quizAttempts.filter((item) => item.completed).length) / totalTrackableItems) * 100)
          : 0,
        weakAreas: quizAttempts
          .filter((item) => Number(item.score) < 70)
          .sort((left, right) => Number(left.score) - Number(right.score))
          .slice(0, 3)
          .map((item) => {
            const quiz = quizzesById[item.quizId || item.referenceId];
            const lesson = lessonsById[item.lessonId || quiz?.lessonId];
            const course = coursesById[item.courseId || lesson?.courseId || quiz?.courseId];
            return {
              quizTitle: quiz ? quiz.title : item.title || "Quiz",
              lessonTitle: lesson ? lesson.title : "Lesson",
              courseTitle: course ? course.title : item.courseId,
              score: Number(item.score) || 0
            };
          }),
        updatedAt: userProgress[0]?.updatedAt || student.updatedAt || student.createdAt
      };
    })
    .sort((left, right) => right.completionRate - left.completionRate || right.avgScore - left.avgScore);
}

function createTemporaryPassword() {
  return crypto.randomBytes(6).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || `Temp${generateId().slice(0, 6)}`;
}

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Missing admin token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ message: "Forbidden" });
    }
    req.admin = decoded;
    return next();
  } catch (_err) {
    return res.status(401).json({ message: "Invalid admin token" });
  }
}

router.post("/admin/login", (req, res) => {
  const { email, password } = req.body || {};
  const adminEmail = process.env.ADMIN_EMAIL || "admin@dentalprep.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "1234";

  if (email !== adminEmail || password !== adminPassword) {
    return res.status(401).json({ message: "Invalid admin credentials" });
  }

  const token = jwt.sign({ role: "admin", email }, process.env.JWT_SECRET, { expiresIn: "7d" });
  return res.json({ token });
});

router.post("/admin/course", adminAuth, async (req, res) => {
  try {
    const { title, description, category, curriculumTags, courseId } = req.body || {};
    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }

    const id = courseId || `course_${normalizeId(title)}`;
    const course = await Course.findOneAndUpdate(
      { courseId: id },
      {
        courseId: id,
        title,
        description: String(description || "").trim(),
        category: String(category || "").trim(),
        curriculumTags: parseTagList(curriculumTags)
      },
      { new: true, upsert: true }
    );

    return res.status(201).json({
      course: {
        id: course.courseId,
        title: course.title,
        description: course.description || "",
        category: course.category || "",
        curriculumTags: course.curriculumTags || []
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.delete("/admin/course/:courseId", adminAuth, async (req, res) => {
  try {
    const courseId = String(req.params.courseId || "").trim();
    if (!courseId) {
      return res.status(400).json({ message: "Course ID is required" });
    }

    const course = await Course.findOne({ courseId });
    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    const lessonRows = await Lesson.find({ courseId }, { lessonId: 1 });
    const lessonIds = lessonRows.map((row) => row.lessonId).filter(Boolean);

    const directQuizRows = await Quiz.find({ courseId }, { quizId: 1 });
    const lessonQuizRows = lessonIds.length ? await Quiz.find({ lessonId: { $in: lessonIds } }, { quizId: 1 }) : [];
    const quizIds = Array.from(new Set([...directQuizRows, ...lessonQuizRows].map((row) => row.quizId).filter(Boolean)));

    const progressOrFilters = [{ courseId }];
    if (lessonIds.length) {
      progressOrFilters.push({ lessonId: { $in: lessonIds } });
      progressOrFilters.push({ referenceId: { $in: lessonIds } });
    }
    if (quizIds.length) {
      progressOrFilters.push({ quizId: { $in: quizIds } });
      progressOrFilters.push({ referenceId: { $in: quizIds } });
    }

    const [deletedLessons, deletedQuizzes, deletedReviews, deletedProgress, deletedCourse] = await Promise.all([
      Lesson.deleteMany({ courseId }),
      Quiz.deleteMany({ $or: [{ courseId }, ...(lessonIds.length ? [{ lessonId: { $in: lessonIds } }] : [])] }),
      Review.deleteMany({ courseId }),
      Progress.deleteMany({ $or: progressOrFilters }),
      Course.deleteOne({ courseId })
    ]);

    return res.json({
      message: "Course and related data deleted permanently",
      deleted: {
        course: deletedCourse.deletedCount || 0,
        lessons: deletedLessons.deletedCount || 0,
        quizzes: deletedQuizzes.deletedCount || 0,
        reviews: deletedReviews.deletedCount || 0,
        progress: deletedProgress.deletedCount || 0
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/courses - Get all courses for admin dropdown (requires admin auth)
router.get("/courses", adminAuth, async (_req, res) => {
  try {
    const courses = await Course.find({}).sort({ title: 1 });
    const allLessons = await Lesson.find({});
    const allQuizzes = await Quiz.find({});
    
    const data = courses.map((course) => {
      const courseLessons = allLessons.filter((lesson) => lesson.courseId === course.courseId);
      const courseQuizzes = allQuizzes.filter((quiz) => quiz.courseId === course.courseId);
      
      return {
        id: course.courseId,
        title: course.title,
        description: course.description || "",
        category: course.category || "",
        curriculumTags: course.curriculumTags || [],
        lessonsCount: courseLessons.length,
        quizCount: courseQuizzes.length
      };
    });
    
    res.json({ courses: data });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/lessons - Get all lessons for admin panel (requires admin auth)
router.get("/lessons", adminAuth, async (_req, res) => {
  try {
    const lessons = await Lesson.find({}).sort({ title: 1 });
    const data = lessons.map((lesson) => ({
      id: lesson.lessonId,
      title: lesson.title,
      courseId: lesson.courseId,
      summary: lesson.summary || "",
      videoUrl: lesson.videoUrl || ""
    }));
    res.json({ lessons: data });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

// GET /api/quizzes - Get all quizzes for admin panel (requires admin auth)
router.get("/quizzes", adminAuth, async (_req, res) => {
  try {
    const quizzes = await Quiz.find({}).sort({ title: 1 });
    const data = quizzes.map((quiz) => ({
      id: quiz.quizId,
      title: quiz.title,
      courseId: quiz.courseId,
      lessonId: quiz.lessonId,
      questionCount: (quiz.questions || []).length
    }));
    res.json({ quizzes: data });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/overview", adminAuth, async (_req, res) => {
  try {
    const courses = await Course.find({});
    const lessons = await Lesson.find({});
    const quizzes = await Quiz.find({});
    const progressItems = (await Progress.find({})).sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0));
    const reviews = (await Review.find({})).sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0));
    const quizAttempts = progressItems.filter((item) => item.itemType === "quiz" || item.quizId);
    const usersById = (await User.find({})).reduce((acc, user) => {
      acc[user._id] = user;
      return acc;
    }, {});
    const quizzesById = quizzes.reduce((acc, quiz) => {
      acc[quiz.quizId] = quiz;
      return acc;
    }, {});
    const coursesById = courses.reduce((acc, course) => {
      acc[course.courseId] = course;
      return acc;
    }, {});
    const studentAnalytics = await buildStudentAnalytics();

    const recentResults = quizAttempts
      .map((item) => {
        const user = usersById[item.userId];
        const quiz = quizzesById[item.quizId || item.referenceId] || null;
        const course = coursesById[item.courseId] || null;
        return {
          id: item._id,
          userName: user ? user.name : "Student",
          userEmail: user ? user.email : "",
          quizTitle: quiz ? quiz.title : item.title || "Quiz",
          courseTitle: course ? course.title : item.courseId,
          score: item.score || 0,
          completed: Boolean(item.completed),
          updatedAt: item.updatedAt || item.createdAt
        };
      })
      .slice(0, 10);

    const recentReviews = reviews
      .map((review) => {
        const user = usersById[review.userId];
        const course = coursesById[review.courseId];
        return {
          id: review._id,
          userName: user ? user.name : review.userName || "Student",
          courseTitle: course ? course.title : review.courseId,
          rating: review.rating,
          comment: review.comment,
          createdAt: review.createdAt
        };
      })
      .slice(0, 10);

    const audioCount = lessons.reduce((sum, lesson) => sum + ((lesson.audioItems || []).length || 0), 0);
    const materialCount = lessons.reduce((sum, lesson) => sum + ((lesson.materials || []).length || 0), 0);
    const caseStudyCount = lessons.reduce((sum, lesson) => sum + ((lesson.caseStudies || []).length || 0), 0);

    return res.json({
      counts: {
        courses: courses.length,
        lessons: lessons.length,
        quizzes: quizzes.length,
        quizAttempts: quizAttempts.length,
        reviews: reviews.length,
        students: studentAnalytics.length,
        audios: audioCount,
        materials: materialCount,
        caseStudies: caseStudyCount
      },
      recentResults,
      recentReviews,
      studentAnalytics: studentAnalytics.slice(0, 5)
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/student-analytics", adminAuth, async (_req, res) => {
  try {
    return res.json({ students: await buildStudentAnalytics() });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/users", adminAuth, async (_req, res) => {
  try {
    return res.json({ students: await buildManagedStudents() });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/users/:userId/block", adminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if ((user.role || "student") === "admin") {
      return res.status(403).json({ message: "Admin accounts cannot be blocked" });
    }

    const updated = await User.findByIdAndUpdate(userId, {
      accountStatus: "blocked",
      updatedAt: new Date()
    }, { new: true });

    return res.json({
      message: "User blocked",
      user: {
        id: updated._id,
        name: updated.name,
        email: updated.email,
        accountStatus: updated.accountStatus || "blocked"
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/users/:userId/approve", adminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if ((user.role || "student") === "admin") {
      return res.status(403).json({ message: "Admin account cannot be changed" });
    }

    const updated = await User.findByIdAndUpdate(userId, {
      accountStatus: "active",
      updatedAt: new Date()
    }, { new: true });

    return res.json({
      message: "Student approved successfully",
      user: {
        id: updated._id,
        name: updated.name,
        email: updated.email,
        accountStatus: updated.accountStatus || "active"
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/users/:userId/reject", adminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if ((user.role || "student") === "admin") {
      return res.status(403).json({ message: "Admin account cannot be changed" });
    }

    const updated = await User.findByIdAndUpdate(userId, {
      accountStatus: "blocked",
      updatedAt: new Date()
    }, { new: true });

    return res.json({
      message: "Student rejected",
      user: {
        id: updated._id,
        name: updated.name,
        email: updated.email,
        accountStatus: updated.accountStatus || "blocked"
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/users/:userId/unblock", adminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if ((user.role || "student") === "admin") {
      return res.status(403).json({ message: "Admin accounts do not use block status" });
    }

    const updated = await User.findByIdAndUpdate(userId, {
      accountStatus: "active",
      updatedAt: new Date()
    }, { new: true });

    return res.json({
      message: "User unblocked",
      user: {
        id: updated._id,
        name: updated.name,
        email: updated.email,
        accountStatus: updated.accountStatus || "active"
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/users/:userId/reset-password", adminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if ((user.role || "student") === "admin") {
      return res.status(403).json({ message: "Admin password is managed separately" });
    }

    const tempPassword = String(req.body?.password || "").trim() || createTemporaryPassword();
    const bcrypt = require("bcryptjs");
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await User.findByIdAndUpdate(userId, {
      passwordHash,
      password: undefined,
      resetPasswordToken: null,
      resetPasswordExpires: null,
      updatedAt: new Date()
    });

    return res.json({
      message: "Password reset successfully",
      tempPassword
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/users/:userId/impersonate", adminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if ((user.role || "student") === "admin") {
      return res.status(403).json({ message: "Admin account impersonation is not allowed" });
    }

    const token = jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role || "student",
        impersonatedBy: req.admin.email,
        impersonatedByRole: "admin"
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role || "student",
        accountStatus: user.accountStatus || "active"
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.delete("/admin/users/:userId", adminAuth, async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    if ((user.role || "student") === "admin") {
      return res.status(403).json({ message: "Admin accounts cannot be deleted here" });
    }

    await Promise.all([
      Progress.deleteMany({ userId }),
      Subscription.deleteMany({ userId }),
      Review.deleteMany({ userId }),
      AiChat.deleteMany({ userId }),
      PdfAccessRequest.deleteMany({ userId }),
      User.deleteOne({ _id: userId })
    ]);

    return res.json({ message: "User deleted permanently" });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/pdf-access-requests", adminAuth, async (_req, res) => {
  try {
    const requests = await PdfAccessRequest.find({});
    const usersById = (await User.find({})).reduce((acc, user) => {
      acc[user._id] = user;
      return acc;
    }, {});

    const items = requests
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .map((request) => {
        const user = usersById[request.userId];
        return {
          id: request._id,
          userId: request.userId,
          userName: user ? user.name : "Student",
          userEmail: user ? user.email : "",
          subjectKey: request.subjectKey,
          blockKey: request.blockKey,
          sectionName: request.sectionName,
          amount: Number(request.amount || 300),
          paymentMethod: request.paymentMethod || "easypaisa",
          easypaisaNumber: request.easypaisaNumber || "03327939323",
          easypaisaAccountName: request.easypaisaAccountName || "Muhammad Yousaf",
          paymentProof: request.paymentProof || "",
          status: request.status || "pending",
          adminNote: request.adminNote || "",
          reviewedBy: request.reviewedBy || "",
          reviewedAt: request.reviewedAt || null,
          createdAt: request.createdAt || null
        };
      });

    return res.json({ requests: items });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/pdf-access-requests/:requestId/approve", adminAuth, async (req, res) => {
  try {
    const requestId = String(req.params.requestId || "").trim();
    const request = await PdfAccessRequest.findOne({ _id: requestId });
    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }

    const updated = await PdfAccessRequest.findOneAndUpdate(
      { _id: requestId },
      {
        status: "approved",
        reviewedBy: req.admin.email || "admin",
        reviewedAt: new Date(),
        adminNote: String(req.body?.adminNote || "Approved").trim(),
        updatedAt: new Date()
      },
      { new: true }
    );

    return res.json({ message: "PDF access approved", request: updated });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/pdf-access-requests/:requestId/reject", adminAuth, async (req, res) => {
  try {
    const requestId = String(req.params.requestId || "").trim();
    const request = await PdfAccessRequest.findOne({ _id: requestId });
    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }

    const updated = await PdfAccessRequest.findOneAndUpdate(
      { _id: requestId },
      {
        status: "rejected",
        reviewedBy: req.admin.email || "admin",
        reviewedAt: new Date(),
        adminNote: String(req.body?.adminNote || "Rejected").trim(),
        updatedAt: new Date()
      },
      { new: true }
    );

    return res.json({ message: "PDF access request rejected", request: updated });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/academy/content", adminAuth, async (_req, res) => {
  try {
    const profile = await ensureAcademyProfile();
    const blocks = await SubjectContent.find({});

    return res.json({
      profile,
      blocks
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

router.post(
  "/admin/academy/block",
  adminAuth,
  contentUpload.fields([
    { name: "videoFiles", maxCount: 100 },
    { name: "noteFiles", maxCount: 100 },
    { name: "clinicalFiles", maxCount: 100 }
  ]),
  async (req, res) => {
    try {
      const subjectKey = String(req.body?.subjectKey || "").trim().toLowerCase();
      const blockKey = String(req.body?.blockKey || "").trim().toLowerCase();

      if (!subjectKey || !blockKey) {
        return res.status(400).json({ message: "subjectKey and blockKey are required" });
      }

      const id = `${subjectKey}_${blockKey}`;
      const contentAccessLevel = normalizeAccessLevel(req.body?.contentAccessLevel);
      const rawSectionName = String(req.body?.sectionName || "").trim();
      const sectionName = rawSectionName && rawSectionName !== "__block__" ? rawSectionName : "";
      const topics = splitValues(req.body?.topics);
      const noteText = String(req.body?.noteText || "").trim();
      const clinicalText = String(req.body?.clinicalText || "").trim();
      const videoItems = parseLineLinks(req.body?.videoLinks, contentAccessLevel);

      const uploadedVideos = (req.files?.videoFiles || []).map((file, index) => ({
        title: path.basename(file.originalname || `Video ${index + 1}`, path.extname(file.originalname || "")),
        url: `/static/uploads/${file.filename}`,
        accessLevel: contentAccessLevel,
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size || 0
      }));

      const noteResources = (req.files?.noteFiles || []).map((file, index) => createAssetRecord(file, "note", index, contentAccessLevel));
      const clinicalResources = (req.files?.clinicalFiles || []).map((file, index) => createAssetRecord(file, "clinical", index, contentAccessLevel));

      const existing = await SubjectContent.findOne({ id });
      const existingSections = Array.isArray(existing?.sections)
        ? existing.sections.map((section) => {
            const doc = section && typeof section.toObject === "function" ? section.toObject() : section;
            return {
              name: String(doc?.name || "").trim(),
              videoItems: sanitizeLinks(doc?.videoItems || []),
              noteText: String(doc?.noteText || "").trim(),
              noteResources: mergeUniqueLinks([], doc?.noteResources || []),
              clinicalText: String(doc?.clinicalText || "").trim(),
              clinicalResources: mergeUniqueLinks([], doc?.clinicalResources || [])
            };
          }).filter((section) => section.name)
        : [];

      let nextSections = existingSections;
      if (sectionName) {
        const lower = sectionName.toLowerCase();
        const currentSection = existingSections.find((section) => String(section.name || "").toLowerCase() === lower) || {};
        const updatedSection = {
          name: sectionName,
          videoItems: sanitizeLinks(mergeUniqueLinks(currentSection.videoItems, [...videoItems, ...uploadedVideos])),
          noteText: noteText || currentSection.noteText || "",
          noteResources: mergeUniqueLinks(currentSection.noteResources, noteResources),
          clinicalText: clinicalText || currentSection.clinicalText || "",
          clinicalResources: mergeUniqueLinks(currentSection.clinicalResources, clinicalResources)
        };

        nextSections = [
          ...existingSections.filter((section) => String(section.name || "").toLowerCase() !== lower),
          updatedSection
        ];
      }

      const next = await SubjectContent.findOneAndUpdate(
        { id },
        {
          id,
          subjectKey,
          blockKey,
          blockTitle: String(req.body?.blockTitle || existing?.blockTitle || blockKey).trim(),
          topics: sectionName
            ? mergeUniqueStrings(existing?.topics, [...topics, sectionName])
            : mergeUniqueStrings(existing?.topics, topics),
          sections: nextSections,
          videoItems: sectionName
            ? sanitizeLinks(existing?.videoItems || [])
            : sanitizeLinks(mergeUniqueLinks(existing?.videoItems, [...videoItems, ...uploadedVideos])),
          noteText: sectionName ? (existing?.noteText || "") : (noteText || existing?.noteText || ""),
          clinicalText: sectionName ? (existing?.clinicalText || "") : (clinicalText || existing?.clinicalText || ""),
          noteResources: sectionName
            ? mergeUniqueLinks([], existing?.noteResources || [])
            : mergeUniqueLinks(existing?.noteResources, noteResources),
          clinicalResources: sectionName
            ? mergeUniqueLinks([], existing?.clinicalResources || [])
            : mergeUniqueLinks(existing?.clinicalResources, clinicalResources)
        },
        { new: true, upsert: true }
      );

      return res.status(201).json({ block: next });
    } catch (err) {
      return res.status(500).json({ message: `Server error: ${err.message}` });
    }
  }
);

router.post(
  "/admin/academy/profile",
  adminAuth,
  contentUpload.fields([
    { name: "overviewBooksFiles", maxCount: 50 },
    { name: "overviewPremiumFiles", maxCount: 50 },
    { name: "overviewSlidesFiles", maxCount: 50 },
    { name: "overviewShortFiles", maxCount: 50 },
    { name: "overviewVideoFiles", maxCount: 50 }
  ]),
  async (req, res) => {
    try {
      const profile = await ensureAcademyProfile();
      const body = req.body || {};

      const aboutAcademyText = String(body.aboutAcademyText || profile.aboutAcademyText || "").trim();
      const contactNumbers = splitValues(body.contactNumbers);

      // Handle file uploads for overview sections
      const overviewBooksFiles = (req.files?.overviewBooksFiles || []).map((file, index) => createAssetRecord(file, "book", index));
      const overviewPremiumFiles = (req.files?.overviewPremiumFiles || []).map((file, index) => createAssetRecord(file, "premium_notes", index));
      const overviewSlidesFiles = (req.files?.overviewSlidesFiles || []).map((file, index) => createAssetRecord(file, "slides", index));
      const overviewShortFiles = (req.files?.overviewShortFiles || []).map((file, index) => createAssetRecord(file, "short_notes", index));
      const overviewVideoFiles = (req.files?.overviewVideoFiles || []).map((file, index) => {
        const asset = createAssetRecord(file, "video", index);
        return {
          title: asset.title,
          url: asset.fileUrl
        };
      });

      // Always merge with existing files so future uploads append instead of replacing prior content.
      const books = sanitizeLinks(mergeUniqueLinks(profile.generalOverview?.books, overviewBooksFiles));
      const premiumNotes = sanitizeLinks(mergeUniqueLinks(profile.generalOverview?.premiumNotes, overviewPremiumFiles));
      const importantSlides = sanitizeLinks(mergeUniqueLinks(profile.generalOverview?.importantSlides, overviewSlidesFiles));
      const shortNotes = sanitizeLinks(mergeUniqueLinks(profile.generalOverview?.shortNotes, overviewShortFiles));
      const manualVideos = String(body.overviewVideos || "").trim() ? parseLineLinks(body.overviewVideos) : [];
      const videos = sanitizeLinks(mergeUniqueLinks(profile.generalOverview?.videos, [...manualVideos, ...overviewVideoFiles]));
      const aboutNotes = sanitizeLinks(mergeUniqueLinks(profile.aboutUs?.notes, String(body.aboutNotes || "").trim() ? parseLineLinks(body.aboutNotes) : []));
      const aboutPdfResources = sanitizeLinks(mergeUniqueLinks(profile.aboutUs?.pdfResources, String(body.aboutPdfResources || "").trim() ? parseLineLinks(body.aboutPdfResources) : []));

      const updated = await AcademyProfile.findOneAndUpdate(
        { id: "academy_profile" },
        {
          id: "academy_profile",
          aboutAcademyText,
          generalOverview: {
            books,
            premiumNotes,
            importantSlides,
            shortNotes,
            videos
          },
          aboutUs: {
            profileImageUrl: String(body.profileImageUrl || profile.aboutUs?.profileImageUrl || "/static/images/favicon.png").trim(),
            introVideoUrl: String(body.introVideoUrl || profile.aboutUs?.introVideoUrl || "").trim(),
            notes: aboutNotes,
            pdfResources: aboutPdfResources,
            contactEmail: String(body.contactEmail || profile.aboutUs?.contactEmail || "").trim(),
            contactNumbers: contactNumbers.length ? contactNumbers : (Array.isArray(profile.aboutUs?.contactNumbers) ? profile.aboutUs.contactNumbers : []),
            socialLinks: {
              facebook: String(body.facebookUrl || profile.aboutUs?.socialLinks?.facebook || "").trim(),
              youtube: String(body.youtubeUrl || profile.aboutUs?.socialLinks?.youtube || "").trim(),
              instagram: String(body.instagramUrl || profile.aboutUs?.socialLinks?.instagram || "").trim(),
              linkedin: String(body.linkedinUrl || profile.aboutUs?.socialLinks?.linkedin || "").trim()
            }
          }
        },
        { new: true, upsert: true }
      );

      return res.status(201).json({ profile: updated });
    } catch (_err) {
      return res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/admin/lesson",
  adminAuth,
  contentUpload.fields([
    { name: "videoFiles", maxCount: 100 },
    { name: "audioFiles", maxCount: 100 },
    { name: "materialFiles", maxCount: 100 }
  ]),
  async (req, res) => {
    try {
      const { title, courseId, videoUrl, lessonId, summary, caseStudies } = req.body || {};
      const contentAccessLevel = normalizeAccessLevel(req.body?.contentAccessLevel);
      if (!title || !courseId) {
        return res.status(400).json({ message: "Title and courseId are required" });
      }

      const course = await Course.findOne({ courseId });
      if (!course) {
        return res.status(404).json({ message: "Course not found" });
      }

      const videoUrls = splitValues(videoUrl);
      const uploadedVideos = (req.files?.videoFiles || []).map((file, index) => createAssetRecord(file, "video", index, contentAccessLevel));
      const uploadedAudios = (req.files?.audioFiles || []).map((file, index) => createAssetRecord(file, "audio", index, contentAccessLevel));
      const uploadedMaterials = (req.files?.materialFiles || []).map((file, index) => createAssetRecord(file, "material", index, contentAccessLevel));
      const parsedCaseStudies = parseCaseStudies(caseStudies);
      const summaryText = String(summary || "").trim();

      const sources = [
        ...videoUrls.map((url) => ({ videoUrl: url, videoType: isYoutubeUrl(url) ? "youtube" : "upload" })),
        ...uploadedVideos.map((asset) => ({ videoUrl: asset.fileUrl, videoType: "upload", videoAsset: asset }))
      ];

      const hasContent = sources.length || uploadedAudios.length || uploadedMaterials.length || parsedCaseStudies.length || summaryText;
      if (!hasContent) {
        return res.status(400).json({ message: "Add at least one video, audio file, material, case study, or summary" });
      }

      if (!sources.length) {
        sources.push({ videoUrl: "", videoType: null });
      }

      const lessons = [];
      for (let index = 0; index < sources.length; index += 1) {
        const currentSource = sources[index];
        const currentLessonId = sources.length === 1
          ? (lessonId || `lesson_${normalizeId(title)}`)
          : `lesson_${normalizeId(title)}_${index + 1}`;
        const existingLesson = await Lesson.findOne({ lessonId: currentLessonId });
        const currentTitle = sources.length === 1 ? title : `${title} ${index + 1}`;
        const audioItems = mergeUniqueLinks(existingLesson?.audioItems, uploadedAudios);
        const materials = mergeUniqueLinks(existingLesson?.materials, uploadedMaterials);
        const caseStudyItems = parsedCaseStudies.length ? parsedCaseStudies : Array.isArray(existingLesson?.caseStudies) ? existingLesson.caseStudies : [];
        const videoValue = currentSource.videoUrl || existingLesson?.videoUrl || "";

        const lesson = await Lesson.findOneAndUpdate(
          { lessonId: currentLessonId },
          {
            lessonId: currentLessonId,
            courseId,
            title: currentTitle,
            accessLevel: contentAccessLevel,
            summary: summaryText || existingLesson?.summary || "",
            videoUrl: videoValue,
            videoType: videoValue ? (currentSource.videoType || existingLesson?.videoType || (isYoutubeUrl(videoValue) ? "youtube" : "upload")) : null,
            audioItems,
            materials,
            caseStudies: caseStudyItems,
            quizId: existingLesson?.quizId || `quiz_${normalizeId(currentLessonId)}`
          },
          { new: true, upsert: true }
        );

        lessons.push({
          id: lesson.lessonId,
          courseId: lesson.courseId,
          title: lesson.title,
          videoUrl: lesson.videoUrl,
          videoType: lesson.videoType || null,
          audioCount: (lesson.audioItems || []).length,
          materialCount: (lesson.materials || []).length,
          caseStudyCount: (lesson.caseStudies || []).length,
          quizId: lesson.quizId
        });
      }

      return res.status(201).json({
        lessons,
        message: lessons.length === 1 ? "Lesson saved successfully" : `${lessons.length} lessons created successfully`
      });
    } catch (err) {
      return res.status(500).json({ message: `Server error: ${err.message}` });
    }
  }
);

router.post("/admin/quiz", adminAuth, async (req, res) => {
  try {
    const { lessonId, title, questions } = req.body || {};
    if (!lessonId || !title || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ message: "lessonId, title, and questions are required" });
    }

    const lesson = await Lesson.findOne({ lessonId });
    if (!lesson) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    const quizId = lesson.quizId || `quiz_${normalizeId(lessonId)}`;
    const quiz = await Quiz.findOneAndUpdate(
      { quizId },
      { quizId, courseId: lesson.courseId, lessonId, title, questions },
      { new: true, upsert: true }
    );

    return res.status(201).json({
      quiz: {
        id: quiz.quizId,
        courseId: quiz.courseId,
        lessonId: quiz.lessonId,
        title: quiz.title,
        questions: quiz.questions
      }
    });
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

function parseQuizText(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let lessonTitle = "";
  const questions = [];
  let current = null;

  lines.forEach((line) => {
    if (line.toLowerCase().startsWith("lesson:")) {
      lessonTitle = line.split(":")[1].trim();
      return;
    }
    if (line.startsWith("Q:")) {
      if (current) {
        questions.push(current);
      }
      current = {
        id: `q${questions.length + 1}`,
        question: line.replace("Q:", "").trim(),
        options: [],
        correctAnswer: ""
      };
      return;
    }
    if (line.match(/^[A-D]:/)) {
      const option = line.substring(2).trim();
      if (current) {
        current.options.push(option);
      }
      return;
    }
    if (line.toLowerCase().startsWith("answer:")) {
      const letter = line.split(":")[1].trim().toUpperCase();
      const indexMap = { A: 0, B: 1, C: 2, D: 3 };
      const optionIndex = indexMap[letter];
      if (current && current.options[optionIndex]) {
        current.correctAnswer = current.options[optionIndex];
      }
    }
  });

  if (current) {
    questions.push(current);
  }

  return { lessonTitle, questions };
}

function parseQuizCsv(text) {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let lessonTitle = "";
  const questions = [];

  rows.forEach((row, index) => {
    const columns = row.split(",").map((value) => value.trim());

    if (columns[0] && columns[0].toLowerCase() === "lesson") {
      lessonTitle = columns[1] || lessonTitle;
      return;
    }
    if (index === 0 && /question/i.test(columns[0] || "")) {
      return;
    }
    if (columns.length >= 6) {
      const [question, optionA, optionB, optionC, optionD, answer] = columns;
      const options = [optionA, optionB, optionC, optionD].filter(Boolean);
      const answerMap = { A: 0, B: 1, C: 2, D: 3 };
      const normalizedAnswer = String(answer || "").trim().toUpperCase();
      const correctAnswer = Object.prototype.hasOwnProperty.call(answerMap, normalizedAnswer)
        ? options[answerMap[normalizedAnswer]] || ""
        : answer;

      if (question && options.length >= 2) {
        questions.push({
          id: `q${questions.length + 1}`,
          question,
          options,
          correctAnswer
        });
      }
    }
  });

  return { lessonTitle, questions };
}

router.post("/admin/quiz/upload", adminAuth, quizUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "File is required" });
    }

    const text = req.file.buffer.toString("utf-8");
    let parsed = parseQuizText(text);
    if (!parsed.questions.length) {
      parsed = parseQuizCsv(text);
    }

    let { lessonTitle, questions } = parsed;
    if (req.body.lessonTitle) {
      lessonTitle = req.body.lessonTitle;
    }

    if (!lessonTitle) {
      return res.status(400).json({ message: "Lesson title is missing" });
    }
    if (!questions.length) {
      return res.status(400).json({ message: "No questions found" });
    }

    let lesson = await Lesson.findOne({ title: lessonTitle });
    if (!lesson) {
      const courseId = "course_general";
      if (!await Course.findOne({ courseId })) {
        await Course.findOneAndUpdate(
          { courseId },
          { courseId, title: "General Course", description: "General lesson and quiz bank", category: "General", curriculumTags: ["General"] },
          { new: true, upsert: true }
        );
      }

      const newLessonId = `lesson_${normalizeId(lessonTitle)}`;
      lesson = await Lesson.findOneAndUpdate(
        { lessonId: newLessonId },
        {
          lessonId: newLessonId,
          courseId,
          title: lessonTitle,
          summary: "Quiz-only lesson created from bulk upload.",
          videoUrl: "",
          videoType: null,
          audioItems: [],
          materials: [],
          caseStudies: [],
          quizId: `quiz_${normalizeId(newLessonId)}`
        },
        { new: true, upsert: true }
      );
    }

    const quizId = lesson.quizId || `quiz_${normalizeId(lesson.lessonId)}`;
    const quiz = await Quiz.findOneAndUpdate(
      { quizId },
      { quizId, courseId: lesson.courseId, lessonId: lesson.lessonId, title: lessonTitle, questions },
      { new: true, upsert: true }
    );

    return res.status(201).json({
      quiz: {
        id: quiz.quizId,
        courseId: quiz.courseId,
        lessonId: quiz.lessonId,
        title: quiz.title,
        questions: quiz.questions
      }
    });
  } catch (err) {
    return res.status(500).json({ message: `Server error: ${err.message}` });
  }
});

router.get("/quiz", async (req, res) => {
  try {
    const { lessonId } = req.query;
    if (!lessonId) {
      return res.status(400).json({ message: "lessonId is required" });
    }

    const quiz = await Quiz.findOne({ lessonId });
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
  } catch (_err) {
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
