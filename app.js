require("dotenv").config();
const createError = require("http-errors");
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const logger = require("morgan");
const mongoose = require("mongoose");
const session = require("express-session");
const User = require("./models/User");
const { MangaSeries } = require("./models/MangaSeries");
const SeriesDraftFile = require("./models/SeriesDraftFile");
const { EBVote } = require("./models/EBVote");
const ReaderVote = require("./models/ReaderVote");
const { Chapter } = require("./models/Chapter");
const { MangaPage } = require("./models/MangaPage");
const { AssistantTask } = require("./models/AssistantTask");
const { EditorFeedback } = require("./models/EditorFeedback");
const { PageNote } = require("./models/PageNote");

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
      MangaSeries.createCollection(),
      SeriesDraftFile.createCollection(),
      EBVote.createCollection(),
      ReaderVote.createCollection(),
      Chapter.createCollection(),
      MangaPage.createCollection(),
      AssistantTask.createCollection(),
      EditorFeedback.createCollection(),
      PageNote.createCollection(),
    ]);

    console.log("📦 Collections initialized: user, mangaSeries, seriesDraftFiles, ebVotes, readerVotes, chapters, mangaPages, pageNotes, assistantTasks, editorFeedbacks");

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
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

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
const mangakaRouter = require("./routes/mangaka");
const editorRouter = require("./routes/editor");
const ebRouter = require("./routes/eb");
const readerRouter = require("./routes/reader");

// Register routes
app.use("/auth", authRouter);
app.use("/mangaka", mangakaRouter);
app.use("/editor", editorRouter);
app.use("/eb", ebRouter);
app.use("/reader", readerRouter);

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

