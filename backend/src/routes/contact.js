const express = require("express");
const ContactMessage = require("../models/ContactMessage");

const router = express.Router();

router.post("/contact", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const saved = await ContactMessage.create({
      name,
      email,
      subject,
      message,
      source: "web"
    });

    return res.status(201).json({
      message: "Thanks! Your message has been received.",
      id: saved._id
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
