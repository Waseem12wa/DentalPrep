const mongoose = require("mongoose");

const progressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    courseId: { type: String, required: true },
    videoId: { type: String, required: true },
    completed: { type: Boolean, default: false },
    score: { type: Number, default: 0 }
  },
  { timestamps: true }
);

progressSchema.index({ userId: 1, courseId: 1, videoId: 1 }, { unique: true });

module.exports = mongoose.model("Progress", progressSchema);
