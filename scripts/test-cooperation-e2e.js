// Test end-to-end flow: gửi hire request → xem cooperation có series_id không
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Build a minimal app (giống app.js nhưng KHÔNG gọi mongoose.connect/process.exit)
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const http = require("http");
const { initSocket } = require("../config/socket");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use("/cooperation-requests", require("../routes/cooperations"));
app.use("/chapters", require("../routes/chapters"));
app.use("/tasks", require("../routes/tasks"));

// Error handler
app.use(function (err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({ success: false, message: err.message });
});

const User = require("../models/User");
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const Page = require("../models/Page");
const CooperationRequest = require("../models/CooperationRequest");
const Cooperation = require("../models/Cooperation");
const Task = require("../models/Task");

function token(userId, role) {
  return jwt.sign({ nameid: userId, role }, process.env.JWT_SECRET);
}

(async () => {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  // Tạo 2 user: 1 Mangaka + 1 Assistant
  const mangaka = await User.create({
    username: "manga1",
    password: "pass1234",
    full_name: "Manga One",
    email: "m1@x.com",
    role: "Mangaka",
  });
  const assistant = await User.create({
    username: "asst1",
    password: "pass1234",
    full_name: "Asst One",
    email: "a1@x.com",
    role: "Assistant",
  });

  const series = await Series.create({
    name: "Test Series",
    author_id: mangaka._id,
  });

  const chapter = await Chapter.create({
    series_id: series._id,
    chapter_number: 1,
    title: "Ch 1",
    submitted_by: mangaka._id,
    status: "draft",
  });

  const page = await Page.create({
    chapter_id: chapter._id,
    page_number: 1,
    original_image_url: "/uploads/test.png",
    uploaded_by: mangaka._id,
  });

  const mangakaToken = token(mangaka._id.toString(), "Mangaka");
  const assistantToken = token(assistant._id.toString(), "Assistant");

  console.log("\n========== TEST 1: FE gửi hire request KHÔNG truyền series_id ==========");
  const req1 = await request(app)
    .post("/cooperation-requests/requests")
    .set("Authorization", `Bearer ${mangakaToken}`)
    .send({ assistant_id: assistant._id.toString(), message: "Let's collab" });
  console.log(`  Status: ${req1.status}`);
  console.log(`  Body:`, JSON.stringify(req1.body, null, 2));
  const request1 = req1.body.data;
  console.log(`  series_id trong request: ${request1?.series_id}`);

  console.log("\n========== TEST 2: FE gửi hire request CÓ truyền series_id ==========");
  const req2 = await request(app)
    .post("/cooperation-requests/requests")
    .set("Authorization", `Bearer ${mangakaToken}`)
    .send({
      assistant_id: assistant._id.toString(),
      series_id: series._id.toString(),
      message: "For this series",
    });
  console.log(`  Status: ${req2.status}`);
  console.log(`  series_id trong request: ${req2.body.data?.series_id}`);

  console.log("\n========== TEST 3: Assistant chấp nhận hợp tác ==========");
  // Duyệt qua flow: accept-meet → accept-cooperation
  const meet = await request(app)
    .post(`/cooperation-requests/requests/${request1._id}/accept-meet`)
    .set("Authorization", `Bearer ${assistantToken}`)
    .send();
  console.log(`  accept-meet status: ${meet.status}`);

  const accept = await request(app)
    .post(`/cooperation-requests/requests/${request1._id}/accept-cooperation`)
    .set("Authorization", `Bearer ${assistantToken}`)
    .send();
  console.log(`  accept-cooperation status: ${accept.status}`);
  console.log(`  cooperation.series_id: ${accept.body.data?.cooperation?.series_id}`);

  console.log("\n========== TEST 4: Cooperation thật trong DB ==========");
  const allCoop = await Cooperation.find({}).lean();
  for (const c of allCoop) {
    console.log(`  _id=${c._id} mangaka=${c.mangaka_id} assistant=${c.assistant_id} series_id=${c.series_id} agreed_at=${c.agreed_at}`);
  }

  console.log("\n========== TEST 5: POST /tasks với cooperation series_id=null ==========");
  const task1 = await request(app)
    .post("/tasks")
    .set("Authorization", `Bearer ${mangakaToken}`)
    .send({
      page_id: page._id.toString(),
      assigned_to: assistant._id.toString(),
      work_type: "background",
      region: { x: 0, y: 0, width: 100, height: 100 },
      description: "Test",
      price: 100,
    });
  console.log(`  Status: ${task1.status}`);
  console.log(`  Body:`, JSON.stringify(task1.body, null, 2));

  await mongoose.disconnect();
  await mem.stop();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
