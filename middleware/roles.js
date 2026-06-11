const { ROLES } = require("../utils/constants");
const { AppError } = require("./errorHandler");

const requireRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError("Authentication required", 401));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(
          `Access denied. Required roles: ${allowedRoles.join(", ")}`,
          403
        )
      );
    }
    next();
  };
};

const requireMangaka = requireRoles(ROLES.MANGAKA);
const requireAssistant = requireRoles(ROLES.ASSISTANT);
const requireTE = requireRoles(ROLES.EDITOR);
const requireEB = requireRoles(ROLES.EB);
const requireReader = requireRoles(ROLES.READER);
const requireAdmin = requireRoles(ROLES.ADMIN);
const requireMangakaOrAssistant = requireRoles(ROLES.MANGAKA, ROLES.ASSISTANT);
const requireMangakaOrTE = requireRoles(ROLES.MANGAKA, ROLES.EDITOR);
const requireTEOrEB = requireRoles(ROLES.EDITOR, ROLES.EB);
const requireMangakaOrTEOrEB = requireRoles(ROLES.MANGAKA, ROLES.EDITOR, ROLES.EB);
const requireAdminOrEB = requireRoles(ROLES.ADMIN, ROLES.EB);

module.exports = {
  requireRoles,
  requireMangaka,
  requireAssistant,
  requireTE,
  requireEB,
  requireReader,
  requireAdmin,
  requireMangakaOrAssistant,
  requireMangakaOrTE,
  requireTEOrEB,
  requireMangakaOrTEOrEB,
  requireAdminOrEB,
};
