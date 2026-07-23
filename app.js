require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
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
  process.env.BACKEND_URL,
  "https://wdp-be-a2qb.onrender.com",
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
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
  .connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .then(async () => {
    console.log("MongoDB connected to Atlas cluster");

    const collections = [
      "users", "series", "chapters", "pages", "tasks",
      "cooperationrequests", "cooperations", "tereviews",
      "ebevaluations", "votes", "notifications", "pagenotes", "otps",
      "comments", "readinghistories",
      "notificationsubscriptions", "followauthors",
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
app.use("/follow-author", require("./routes/followAuthor"));
app.use("/authors", require("./routes/authors"));
app.use("/series", require("./routes/series"));
app.use("/chapters", require("./routes/chapters"));
app.use("/chapters", require("./routes/pageLayers"));
app.use("/tasks", require("./routes/tasks"));
app.use("/submissions", require("./routes/submissions"));
app.use("/cooperation-requests", require("./routes/cooperations"));
app.use("/te-reviews", require("./routes/teReviews"));
app.use("/eb-evaluations", require("./routes/ebEvaluations"));
app.use("/eb-scores", require("./routes/ebScores"));
app.use("/reader", require("./routes/readers"));
app.use("/mangaka", require("./routes/mangakas"));
app.use("/authors", require("./routes/authors"));
app.use("/comments", require("./routes/comments"));
app.use("/votes", require("./routes/votes"));
app.use("/admin", require("./routes/admin"));

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
  if (err.message && err.message.includes("not allowed by CORS")) {
    return res.status(403).json({ success: false, message: err.message });
  }
  const statusCode = err.statusCode || err.status || 500;

  res.status(statusCode).json({
    success: false,
    message: err.message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
module.exports = { app, server };
