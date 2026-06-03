const authMiddleware = require("../auth");
const User = require("../../models/User");

const ROLES = ["Mangaka", "Assistant", "Editor", "EB"];

const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.nameid) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const user = await User.findById(req.user.nameid);

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Required role: ${allowedRoles.join(" or ")}`,
        });
      }

      req.currentUser = user;
      next();
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Authorization error",
        error: error.message,
      });
    }
  };
};

module.exports = {
  requireRole,
  ROLES,
};
