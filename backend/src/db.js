const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "../data");

function readData(filename) {
    try {
        const filePath = path.join(dataDir, filename);
        if (!fs.existsSync(filePath)) {
            return [];
        }
        const raw = fs.readFileSync(filePath, "utf8");
        return raw ? JSON.parse(raw) : [];
    } catch (err) {
        console.error(`Error reading ${filename}:`, err);
        return [];
    }
}

function writeData(filename, data) {
    try {
        const filePath = path.join(dataDir, filename);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        console.error(`Error writing ${filename}:`, err);
        return false;
    }
}

function generateId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function matchesQuery(record, query = {}) {
    return Object.entries(query).every(([key, expected]) => {
        const actual = record[key];

        if (expected && typeof expected === "object" && !Array.isArray(expected)) {
            if (Object.prototype.hasOwnProperty.call(expected, "$gt")) {
                return actual > expected.$gt;
            }
            if (Object.prototype.hasOwnProperty.call(expected, "$gte")) {
                return actual >= expected.$gte;
            }
            if (Object.prototype.hasOwnProperty.call(expected, "$lt")) {
                return actual < expected.$lt;
            }
            if (Object.prototype.hasOwnProperty.call(expected, "$lte")) {
                return actual <= expected.$lte;
            }
            if (Object.prototype.hasOwnProperty.call(expected, "$in")) {
                return expected.$in.includes(actual);
            }
        }

        return actual === expected;
    });
}

function createCollection(filename, options = {}) {
    const idField = options.idField || "_id";

    const collection = {
        readAll() {
            return readData(filename);
        },

        find(query = {}) {
            return this.readAll().filter((record) => matchesQuery(record, query));
        },

        findOne(query = {}) {
            return this.find(query)[0] || null;
        },

        findById(id) {
            return this.findOne({ [idField]: id });
        },

        create(payload) {
            const items = this.readAll();
            const now = new Date().toISOString();
            const nextRecord = {
                _id: payload._id || generateId(),
                ...payload,
                createdAt: payload.createdAt || now,
                updatedAt: payload.updatedAt || now
            };

            if (!nextRecord[idField]) {
                nextRecord[idField] = nextRecord._id;
            }

            items.push(nextRecord);
            writeData(filename, items);
            return nextRecord;
        },

        findOneAndUpdate(query, update, optionsArg = {}) {
            const items = this.readAll();
            const index = items.findIndex((record) => matchesQuery(record, query));
            const now = new Date().toISOString();

            if (index !== -1) {
                items[index] = {
                    ...items[index],
                    ...update,
                    updatedAt: now
                };
                writeData(filename, items);
                return items[index];
            }

            if (!optionsArg.upsert) {
                return null;
            }

            const created = {
                _id: generateId(),
                ...query,
                ...update,
                createdAt: now,
                updatedAt: now
            };

            if (!created[idField]) {
                created[idField] = created._id;
            }

            items.push(created);
            writeData(filename, items);
            return created;
        },

        findByIdAndUpdate(id, update) {
            return this.findOneAndUpdate({ [idField]: id }, update, { upsert: false });
        },

        findByIdAndDelete(id) {
            const items = this.readAll();
            const filtered = items.filter((record) => record[idField] !== id);
            writeData(filename, filtered);
            return items.length !== filtered.length;
        },

        countDocuments(query = {}) {
            return this.find(query).length;
        }
    };

    return collection;
}

const User = createCollection("users.json", { idField: "_id" });
const Course = createCollection("courses.json", { idField: "courseId" });
const Lesson = createCollection("lessons.json", { idField: "lessonId" });
const Quiz = createCollection("quizzes.json", { idField: "quizId" });
const Progress = createCollection("progress.json", { idField: "_id" });
const Contact = createCollection("contacts.json", { idField: "_id" });
const Subscription = createCollection("subscriptions.json", { idField: "_id" });
const Review = createCollection("reviews.json", { idField: "_id" });
const AiChat = createCollection("ai_chats.json", { idField: "_id" });
const SubjectContent = createCollection("subject_content.json", { idField: "id" });
const AcademyProfile = createCollection("academy_profile.json", { idField: "id" });

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
    readData,
    writeData,
    generateId
};
