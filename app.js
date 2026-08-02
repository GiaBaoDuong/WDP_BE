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
const { formatCoinResponse } = require("./utils/coinUnit");

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
      "wallets", "wallettransactions", "coinpackages",
      "payments", "purchasedchapters", "revenues", "withdrawals",
    ];
    await Promise.all(collections.map((c) => mongoose.connection.db.createCollection(c).catch(() => {})));
    console.log("Collections initialized");

    // Seed default CoinPackages nếu collection rỗng
    const CoinPackage = require("./models/CoinPackage");
    const existingCount = await CoinPackage.countDocuments();
    if (existingCount === 0) {
      const defaults = [
        { name: "Gói 200 Coin", price_vnd: 20000, coin_amount: 20000, bonus_coin: 0, sort_order: 1, is_active: true },
        { name: "Gói 520 Coin", price_vnd: 50000, coin_amount: 50000, bonus_coin: 2000, sort_order: 2, is_active: true },
        { name: "Gói 1.100 Coin", price_vnd: 100000, coin_amount: 100000, bonus_coin: 10000, sort_order: 3, is_active: true },
      ];
      // Tính total_coin trước khi insert (insertMany không chạy pre-save)
      const docs = defaults.map((d) => ({
        ...d,
        description: d.description || "",
        total_coin: d.coin_amount + (d.bonus_coin || 0),
      }));
      await CoinPackage.insertMany(docs);
      console.log("[Seed] Inserted " + docs.length + " default CoinPackages");
    }
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
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(formatCoinResponse(body));
  next();
});
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

// ─── Monetization / Payment routes ───────────────────────────────────────────
app.use("/payments", require("./routes/payments"));
app.use("/wallet", require("./routes/wallets"));
app.use("/withdrawals", require("./routes/withdrawals"));
app.use("/profile", require("./routes/profile"));
app.use("/dashboard", require("./routes/dashboard"));

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
