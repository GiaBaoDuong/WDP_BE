const pickFields = (obj, fields) => {
  return fields.reduce((acc, field) => {
    if (obj[field] !== undefined) acc[field] = obj[field];
    return acc;
  }, {});
};

const buildUserResponse = (user) => ({
  userId: user._id,
  accountId: user._id,
  username: user.username,
  email: user.email,
  fullName: user.full_name,
  role: user.role,
  isProMember: user.is_pro_member || false,
  avatarUrl: user.avatar_url || "",
  proExpiredAt: user.pro_expired_at || null,
});

const getCurrentPeriod = () => {
  const now = new Date();
  const year = now.getFullYear();
  const week = getWeekNumber(now);
  return `${year}-W${String(week).padStart(2, "0")}`;
};

const getWeekNumber = (date) => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
};

const buildNotification = (userId, type, title, message, meta = {}) => ({
  user_id: userId,
  type,
  title,
  message,
  is_read: false,
  meta,
});

module.exports = { pickFields, buildUserResponse, getCurrentPeriod, buildNotification };
