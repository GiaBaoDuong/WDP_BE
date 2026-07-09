const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal server error";

  console.error(`[${statusCode}] ${message}`, {
    method: req.method,
    url: req.originalUrl,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });

  if (process.env.NODE_ENV === "development") {
    console.error(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(err.data && { data: err.data }),
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {object|null} [data=null] - Dữ liệu bổ sung trả kèm response (vd: missing_task_ids)
   */
  constructor(message, statusCode, data = null) {
    super(message);
    this.statusCode = statusCode;
    this.data = data;
  }
}

module.exports = { errorHandler, AppError };
