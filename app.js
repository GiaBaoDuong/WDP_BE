require("dotenv").config();
const createError = require("http-errors");
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const logger = require("morgan");
const mongoose = require("mongoose");
const http = require("http");
const cors = require("cors");
const { initSocket } = require("./config/socket");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");

const app = express();
const server = http.createServer(app);

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  process.env.FRONTEND_DEV_URL,
  process.env.FRONTEND_PROD_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    console.log("[CORS DEBUG] origin received:", origin);
    console.log("[CORS DEBUG] allowedOrigins:", allowedOrigins);
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS policy`));
    }
  },
  credentials: true,
  exposedHeaders: ["Authorization"],
  allowedHeaders: ["Authorization", "Content-Type"],
}));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
initSocket(server);

// ─── MongoDB ─────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("MongoDB connected to Atlas cluster");

    const collections = [
      "users", "series", "chapters", "pages", "tasks",
      "cooperationrequests", "cooperations", "tereviews",
      "ebevaluations", "votes", "notifications", "pagenotes", "otps",
    ];
    await Promise.all(collections.map((c) => mongoose.connection.db.createCollection(c).catch(() => {})));
    console.log("Collections initialized");
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use("/uploads", express.static(path.join(__dirname, "public/uploads")));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/auth", require("./routes/auth"));
app.use("/notifications", require("./routes/notifications"));
app.use("/series", require("./routes/series"));
app.use("/chapters", require("./routes/chapters"));
app.use("/tasks", require("./routes/tasks"));
app.use("/submissions", require("./routes/submissions"));
app.use("/cooperation-requests", require("./routes/cooperations"));
app.use("/te-reviews", require("./routes/teReviews"));
app.use("/eb-evaluations", require("./routes/ebEvaluations"));
app.use("/reader", require("./routes/readers"));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Swagger UI
app.use("/swagger", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: ".swagger-ui .topbar { display: none }",
  customSiteTitle: "WDP Manga API Docs",
}));

// ─── Error Handling ────────────────────────────────────────────────────────────
app.use(function (req, res, next) {
  next(createError(404));
});

app.use(function (err, req, res, next) {
  res.status(err.status || 500).json({
    success: false,
    message: err.message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
module.exports = { app, server };
