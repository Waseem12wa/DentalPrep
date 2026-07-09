const jwt = require("jsonwebtoken");

// In-memory cache for user auth lookups. Eliminates a DB query on every API
// request. TTL is short (30s) so status changes (blocked/approved) propagate
// quickly. keyed by userId.
const AUTH_CACHE_TTL_MS = 30 * 1000;
const authCache = new Map();

const AUTH_CACHE_SENTINEL = "__NO_ENTRY__";

function getCachedUser(userId) {
  const entry = authCache.get(userId);
  if (!entry) return AUTH_CACHE_SENTINEL;
  if (Date.now() - entry.ts > AUTH_CACHE_TTL_MS) {
    authCache.delete(userId);
    return AUTH_CACHE_SENTINEL;
  }
  return entry.user;
}

function setCachedUser(userId, user) {
  authCache.set(userId, { user, ts: Date.now() });
  // Prevent unbounded growth
  if (authCache.size > 500) {
    const oldestKey = authCache.keys().next().value;
    authCache.delete(oldestKey);
  }
}

function invalidateUserCache(userId) {
  authCache.delete(userId);
}

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { User } = require("../db");

    // Check cache first to skip DB query
    const cached = getCachedUser(decoded.id);
    if (cached !== AUTH_CACHE_SENTINEL) {
      if (!cached) {
        return res.status(401).json({ message: "Invalid token" });
      }
      const accountStatus = cached.accountStatus || "pending";
      if (accountStatus !== "active") {
        return res.status(403).json({
          message: accountStatus === "pending"
            ? "Your account is pending admin approval."
            : "Your account is blocked. Contact admin."
        });
      }
      req.user = decoded;
      req.userRecord = cached;
      return next();
    }

    User.findById(decoded.id)
      .lean()
      .then((user) => {
        setCachedUser(decoded.id, user);

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
module.exports.invalidateUserCache = invalidateUserCache;
