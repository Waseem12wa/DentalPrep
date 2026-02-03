const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    plan: { type: String, required: true },
    status: { type: String, default: "active" },
    startedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Subscription", subscriptionSchema);
