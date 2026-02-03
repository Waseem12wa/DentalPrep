const mongoose = require("mongoose");

const quizQuestionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    question: { type: String, required: true },
    options: [{ type: String, required: true }],
    correctAnswer: { type: String, required: true }
  },
  { _id: false }
);

const quizSchema = new mongoose.Schema(
  {
    quizId: { type: String, required: true, unique: true },
    courseId: { type: String, required: true },
    lessonId: { type: String, required: true },
    title: { type: String, required: true },
    questions: [quizQuestionSchema]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Quiz", quizSchema);
