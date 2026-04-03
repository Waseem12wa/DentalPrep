const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://Waseem:1234@cluster0.zgbbo9e.mongodb.net/dentalprep?retryWrites=true&w=majority";

// Connect to MongoDB
mongoose.connect(MONGO_URI)
.then(() => console.log("✓ MongoDB Connected Successfully"))
.catch((err) => {
    console.error("✗ MongoDB Connection Error:", err.message);
    console.error("Check backend/.env MONGO_URI, Atlas database user credentials, and Network Access IP allowlist.");
    process.exit(1);
});

// ===== SCHEMAS =====

// User Schema
const userSchema = new mongoose.Schema({
    _id: String,
    name: String,
    email: { type: String, unique: true, sparse: true },
    passwordHash: String,
    password: String,
    verificationToken: String,
    isVerified: { type: Boolean, default: false },
    accountStatus: { type: String, enum: ["pending", "active", "blocked"], default: "pending" },
    role: { type: String, enum: ["admin", "student", "teacher"], default: "student" },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "users" });

// Course Schema
const courseSchema = new mongoose.Schema({
    courseId: { type: String, unique: true },
    title: String,
    description: String,
    category: String,
    curriculumTags: [String],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "courses" });

// Lesson Schema
const lessonSchema = new mongoose.Schema({
    lessonId: { type: String, unique: true },
    courseId: String,
    title: String,
    accessLevel: { type: String, enum: ["free", "paid"], default: "free" },
    summary: String,
    videoUrl: String,
    videoType: String,
    audioItems: [mongoose.Schema.Types.Mixed],
    materials: [mongoose.Schema.Types.Mixed],
    caseStudies: [mongoose.Schema.Types.Mixed],
    quizId: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "lessons" });

// Quiz Schema
const quizSchema = new mongoose.Schema({
    quizId: { type: String, unique: true },
    courseId: String,
    lessonId: String,
    title: String,
    questions: [mongoose.Schema.Types.Mixed],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "quizzes" });

// Progress Schema
const progressSchema = new mongoose.Schema({
    _id: String,
    userId: String,
    courseId: String,
    videoId: String,
    lessonId: String,
    quizId: String,
    itemType: { type: String, enum: ["lesson", "quiz"], default: "lesson" },
    referenceId: String,
    title: String,
    completed: { type: Boolean, default: false },
    status: { type: String, enum: ["started", "completed", "reviewed"], default: "started" },
    score: Number,
    completedAt: Date,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "progress" });

// Contact Schema
const contactSchema = new mongoose.Schema({
    _id: String,
    name: String,
    email: String,
    subject: String,
    message: String,
    source: String,
    status: { type: String, default: "unread" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "contacts" });

// Subscription Schema
const subscriptionSchema = new mongoose.Schema({
    _id: String,
    userId: String,
    plan: { type: String, enum: ["free", "monthly", "annual", "premium", "pro"], default: "free" },
    status: { type: String, enum: ["active", "inactive", "cancelled"], default: "active" },
    paymentId: String,
    startedAt: { type: Date, default: Date.now },
    expiresAt: Date,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "subscriptions" });

// Review Schema
const reviewSchema = new mongoose.Schema({
    _id: String,
    courseId: String,
    userId: String,
    userName: String,
    rating: Number,
    comment: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "reviews" });

// AI Chat Schema
const aiChatSchema = new mongoose.Schema({
    _id: String,
    userId: String,
    courseId: String,
    lessonId: String,
    prompt: String,
    response: String,
    sourceTitles: [String],
    messages: [mongoose.Schema.Types.Mixed],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "ai_chats" });

// Subject Content Schema - For storing Block content with sections
const subjectContentSchema = new mongoose.Schema({
    id: String,
    subjectKey: String,
    blockKey: String,
    blockTitle: String,
    topics: [String],
    sections: [
        {
            name: String,
            videoItems: [mongoose.Schema.Types.Mixed],
            noteText: String,
            noteResources: [mongoose.Schema.Types.Mixed],
            clinicalText: String,
            clinicalResources: [mongoose.Schema.Types.Mixed]
        }
    ],
    videoItems: [mongoose.Schema.Types.Mixed],
    noteText: String,
    noteResources: [mongoose.Schema.Types.Mixed],
    clinicalText: String,
    clinicalResources: [mongoose.Schema.Types.Mixed],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "subject_content" });

// Academy Profile Schema
const academyProfileSchema = new mongoose.Schema({
    id: String,
    aboutAcademyText: String,
    generalOverview: {
        books: [mongoose.Schema.Types.Mixed],
        premiumNotes: [mongoose.Schema.Types.Mixed],
        importantSlides: [mongoose.Schema.Types.Mixed],
        shortNotes: [mongoose.Schema.Types.Mixed],
        videos: [mongoose.Schema.Types.Mixed]
    },
    aboutUs: {
        profileImageUrl: String,
        introVideoUrl: String,
        notes: [mongoose.Schema.Types.Mixed],
        pdfResources: [mongoose.Schema.Types.Mixed],
        contactEmail: String,
        contactNumbers: [String],
        socialLinks: {
            facebook: String,
            youtube: String,
            instagram: String,
            linkedin: String
        }
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "academy_profile" });

// PDF Access Payment Request Schema
const pdfAccessRequestSchema = new mongoose.Schema({
    _id: String,
    userId: String,
    subjectKey: String,
    blockKey: String,
    sectionName: String,
    amount: { type: Number, default: 300 },
    paymentMethod: { type: String, default: "easypaisa" },
    easypaisaNumber: String,
    easypaisaAccountName: String,
    paymentProof: String,
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    reviewedBy: String,
    reviewedAt: Date,
    adminNote: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { collection: "pdf_access_requests" });

// ===== MODELS =====

const User = mongoose.model("User", userSchema);
const Course = mongoose.model("Course", courseSchema);
const Lesson = mongoose.model("Lesson", lessonSchema);
const Quiz = mongoose.model("Quiz", quizSchema);
const Progress = mongoose.model("Progress", progressSchema);
const Contact = mongoose.model("Contact", contactSchema);
const Subscription = mongoose.model("Subscription", subscriptionSchema);
const Review = mongoose.model("Review", reviewSchema);
const AiChat = mongoose.model("AiChat", aiChatSchema);
const SubjectContent = mongoose.model("SubjectContent", subjectContentSchema);
const AcademyProfile = mongoose.model("AcademyProfile", academyProfileSchema);
const PdfAccessRequest = mongoose.model("PdfAccessRequest", pdfAccessRequestSchema);

// ===== HELPER FUNCTIONS =====

function generateId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// For backward compatibility with existing code that uses these functions
function readData(filename) {
    console.warn(`readData() is deprecated. Use Mongoose models directly.`);
    return [];
}

function writeData(filename, data) {
    console.warn(`writeData() is deprecated. Use Mongoose models directly.`);
    return true;
}

// ===== EXPORTS =====

module.exports = {
    User,
    Course,
    Lesson,
    Quiz,
    Progress,
    Contact,
    Subscription,
    Review,
    AiChat,
    SubjectContent,
    AcademyProfile,
    PdfAccessRequest,
    readData,
    writeData,
    generateId,
    mongoose,
    MONGO_URI
};
