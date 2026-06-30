/**
 * Migration: Cleanup duplicate tasks cùng page_id trong cùng chapter
 *
 * Trước khi có archive logic, mỗi lần Mangaka bấm "Gửi cả chapter" (PATCH /chapters/:id
 * action: submit) có thể tạo thêm task mới mà KHÔNG archive task cũ → 1 page có
 * nhiều task cùng page_id, khác status (vd: 1 approved vòng 1 + 1 pending vòng 2).
 *
 * Triệu chứng: UI Mangaka hiển thị 2 dòng "Trang X", 2 task khác id, khác status.
 *
 * Script này quét collection "tasks", nhóm theo (chapter_id, page_id), archive
 * (chuyển status → "archived") tất cả task trừ task có status "cao nhất" theo
 * thứ tự ưu tiên:
 *   revision > in_progress > pending > approved > submitted > in_review
 *
 * CHẠY SAU KHI đã chạy migrate-tasks-archived-status.js (để enum status hợp lệ).
 *
 * Run: node scripts/migrate-tasks-dedupe-page.js
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const Task = require("../models/Task");

// Ưu tiên: status càng "đang xử lý" càng cao → giữ lại task đang active
// Task "approved" / "submitted" / "in_review" đã qua xử lý → archive nếu bị trùng
const STATUS_PRIORITY = {
  revision: 5,
  in_progress: 4,
  pending: 3,
  approved: 2,
  submitted: 1,
  in_review: 0,
};

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("[migrate-tasks-dedupe-page] Connected to MongoDB");

    // Lấy tất cả task chưa archive, nhóm theo (chapter_id, page_id)
    const allTasks = await Task.find({ status: { $ne: "archived" } })
      .select("_id chapter_id page_id status createdAt")
      .lean();

    console.log(
      `[migrate-tasks-dedupe-page] Total non-archived tasks: ${allTasks.length}`
    );

    // Group: key = `${chapter_id}_${page_id}` → array of tasks
    const groupMap = new Map();
    for (const t of allTasks) {
      const key = `${t.chapter_id}_${t.page_id}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(t);
    }

    // Lọc các nhóm có > 1 task (duplicate)
    const duplicateGroups = [];
    for (const [key, tasks] of groupMap.entries()) {
      if (tasks.length > 1) duplicateGroups.push({ key, tasks });
    }

    console.log(
      `[migrate-tasks-dedupe-page] Found ${duplicateGroups.length} page(s) with duplicate tasks`
    );

    if (duplicateGroups.length === 0) {
      console.log("[migrate-tasks-dedupe-page] No duplicates to clean. Done.");
      await mongoose.disconnect();
      process.exit(0);
    }

    // Tìm task cần archive: trong mỗi nhóm, giữ task có status priority cao nhất
    // (nếu tie → giữ task createdAt mới nhất), archive phần còn lại.
    const taskIdsToArchive = [];
    const detailLog = [];

    for (const { key, tasks } of duplicateGroups) {
      // Sắp xếp: priority cao nhất lên đầu; tie → createdAt mới hơn lên đầu
      const sorted = [...tasks].sort((a, b) => {
        const pa = STATUS_PRIORITY[a.status] ?? -1;
        const pb = STATUS_PRIORITY[b.status] ?? -1;
        if (pb !== pa) return pb - pa;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

      const keep = sorted[0];
      const archiveList = sorted.slice(1);

      archiveList.forEach((t) => taskIdsToArchive.push(t._id));

      detailLog.push({
        key,
        keep: { _id: keep._id, status: keep.status, createdAt: keep.createdAt },
        archive: archiveList.map((t) => ({
          _id: t._id,
          status: t.status,
          createdAt: t.createdAt,
        })),
      });
    }

    // In preview trước khi archive
    console.log("\n[migrate-tasks-dedupe-page] PREVIEW (sẽ archive các task sau):");
    detailLog.forEach((d) => {
      console.log(`  ${d.key}:`);
      console.log(
        `    KEEP: #${d.keep._id.toString().slice(-6)} [${d.keep.status}]`
      );
      d.archive.forEach((a) => {
        console.log(
          `    ARCHIVE: #${a._id.toString().slice(-6)} [${a.status}]`
        );
      });
    });

    // Archive hàng loạt
    const archiveResult = await Task.updateMany(
      { _id: { $in: taskIdsToArchive } },
      { $set: { status: "archived" } }
    );

    console.log(
      `\n[migrate-tasks-dedupe-page] Archive result: matched ${archiveResult.matchedCount}, modified ${archiveResult.modifiedCount}`
    );

    // Sanity check: đếm duplicate còn lại
    const afterTasks = await Task.find({ status: { $ne: "archived" } })
      .select("chapter_id page_id")
      .lean();
    const afterGroupMap = new Map();
    for (const t of afterTasks) {
      const k = `${t.chapter_id}_${t.page_id}`;
      afterGroupMap.set(k, (afterGroupMap.get(k) || 0) + 1);
    }
    const remainingDup = Array.from(afterGroupMap.values()).filter(
      (count) => count > 1
    ).length;
    console.log(
      `[migrate-tasks-dedupe-page] Remaining duplicate pages: ${remainingDup}`
    );

    await mongoose.disconnect();
    console.log("[migrate-tasks-dedupe-page] Done");
    process.exit(0);
  } catch (err) {
    console.error("[migrate-tasks-dedupe-page] Failed:", err);
    process.exit(1);
  }
})();
