const mongoose = require("mongoose");

const lessonSchema = new mongoose.Schema(
  {
    lessonId: { type: String, required: true, unique: true },
    courseId: { type: String, required: true },
    title: { type: String, required: true },
    videoUrl: { type: String, required: true },
    quizId: { type: String, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Lesson", lessonSchema);
