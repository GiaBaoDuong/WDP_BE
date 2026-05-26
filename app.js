require("dotenv").config();
const createError = require("http-errors");
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const logger = require("morgan");
const mongoose = require("mongoose");
const session = require("express-session");
const User = require("./models/User");

const app = express();

// Connect to MongoDB
const uri = process.env.MONGODB_URI;

mongoose
  .connect(uri)
  .then(async () => {
    console.log("✅ MongoDB connected successfully");
    console.log("📊 Database:", uri);

    // Init collections
    await Promise.all([
      User.createCollection(),
    ]);

    console.log("📦 Collections initialized: user");

    const port = process.env.PORT || 3000;
    console.log(`🚀 App running at: http://localhost:${port}`);
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

// View engine setup
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// Middleware
app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Session setup
app.use(
  session({
    secret: process.env.JWT_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }),
);

// Import routes
const authRouter = require("./routes/auth");

// Register routes
app.use("/auth", authRouter);

// Welcome route
app.get("/", (req, res) => {
  res.redirect("/auth/login");
});

// Catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// Error handler
app.use(function (err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "development" ? err : {};

  res.status(err.status || 500);
  res.json({
    success: false,
    message: err.message,
    error: req.app.get("env") === "development" ? err : {},
  });
});

module.exports = app;

