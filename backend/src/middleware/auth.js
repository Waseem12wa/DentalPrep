const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { User } = require("../db");

    User.findById(decoded.id)
      .then((user) => {
        if (!user) {
          return res.status(401).json({ message: "Invalid token" });
        }

        const accountStatus = user.accountStatus || "pending";
        if (accountStatus !== "active") {
          return res.status(403).json({
            message: accountStatus === "pending"
              ? "Your account is pending admin approval."
              : "Your account is blocked. Contact admin."
          });
        }

        req.user = decoded;
        req.userRecord = user;
        return next();
      })
      .catch(() => res.status(500).json({ message: "Server error" }));
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

module.exports = authMiddleware;
