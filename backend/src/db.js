const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "../data");

// Helper to read JSON file
function readData(filename) {
    try {
        const filePath = path.join(dataDir, filename);
        const data = fs.readFileSync(filePath, "utf8");
        return JSON.parse(data);
    } catch (err) {
        console.error(`Error reading ${filename}:`, err);
        return [];
    }
}

// Helper to write JSON file
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

// Helper to generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// User operations
const User = {
    find: (query = {}) => {
        const users = readData("users.json");
        if (Object.keys(query).length === 0) return users;

        return users.filter(user => {
            return Object.entries(query).every(([key, value]) => user[key] === value);
        });
    },

    findOne: (query) => {
        const users = User.find(query);
        return users[0] || null;
    },

    create: (userData) => {
        const users = readData("users.json");
        const newUser = {
            _id: generateId(),
            ...userData,
            createdAt: new Date().toISOString()
        };
        users.push(newUser);
        writeData("users.json", users);
        return newUser;
    },

    findByIdAndUpdate: (id, updateData) => {
        const users = readData("users.json");
        const index = users.findIndex(u => u._id === id);
        if (index === -1) return null;

        users[index] = { ...users[index], ...updateData };
        writeData("users.json", users);
        return users[index];
    },

    findByIdAndDelete: (id) => {
        const users = readData("users.json");
        const filtered = users.filter(u => u._id !== id);
        writeData("users.json", filtered);
        return true;
    }
};

// Course operations
const Course = {
    find: () => readData("courses.json"),

    create: (courseData) => {
        const courses = readData("courses.json");
        const newCourse = {
            _id: generateId(),
            courseId: courseData.courseId || generateId(),
            ...courseData,
            createdAt: new Date().toISOString()
        };
        courses.push(newCourse);
        writeData("courses.json", courses);
        return newCourse;
    },

    countDocuments: (query = {}) => {
        const courses = readData("courses.json");
        if (Object.keys(query).length === 0) return courses.length;

        return courses.filter(course => {
            return Object.entries(query).every(([key, value]) => course[key] === value);
        }).length;
    }
};

// Lesson operations
const Lesson = {
    find: (query = {}) => {
        const lessons = readData("lessons.json");
        if (Object.keys(query).length === 0) return lessons;

        return lessons.filter(lesson => {
            return Object.entries(query).every(([key, value]) => lesson[key] === value);
        });
    },

    create: (lessonData) => {
        const lessons = readData("lessons.json");
        const newLesson = {
            _id: generateId(),
            id: lessonData.id || generateId(),
            ...lessonData,
            createdAt: new Date().toISOString()
        };
        lessons.push(newLesson);
        writeData("lessons.json", lessons);
        return newLesson;
    },

    countDocuments: (query = {}) => {
        return Lesson.find(query).length;
    }
};

// Quiz operations
const Quiz = {
    find: (query = {}) => {
        const quizzes = readData("quizzes.json");
        if (Object.keys(query).length === 0) return quizzes;

        return quizzes.filter(quiz => {
            return Object.entries(query).every(([key, value]) => quiz[key] === value);
        });
    },

    create: (quizData) => {
        const quizzes = readData("quizzes.json");
        const newQuiz = {
            _id: generateId(),
            id: quizData.id || generateId(),
            ...quizData,
            createdAt: new Date().toISOString()
        };
        quizzes.push(newQuiz);
        writeData("quizzes.json", quizzes);
        return newQuiz;
    },

    countDocuments: (query = {}) => {
        return Quiz.find(query).length;
    }
};

// Progress operations
const Progress = {
    find: (query = {}) => {
        const progress = readData("progress.json");
        if (Object.keys(query).length === 0) return progress;

        return progress.filter(p => {
            return Object.entries(query).every(([key, value]) => p[key] === value);
        });
    },

    create: (progressData) => {
        const progress = readData("progress.json");
        const newProgress = {
            _id: generateId(),
            ...progressData,
            createdAt: new Date().toISOString()
        };
        progress.push(newProgress);
        writeData("progress.json", progress);
        return newProgress;
    }
};

// Contact operations
const Contact = {
    create: (contactData) => {
        const contacts = readData("contacts.json");
        const newContact = {
            _id: generateId(),
            ...contactData,
            createdAt: new Date().toISOString()
        };
        contacts.push(newContact);
        writeData("contacts.json", contacts);
        return newContact;
    }
};

module.exports = {
    User,
    Course,
    Lesson,
    Quiz,
    Progress,
    Contact
};
