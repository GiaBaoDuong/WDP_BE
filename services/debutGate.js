/**
 * Debut Gate — kiểm soát việc submit chapter + chấm điểm cho series mới.
 *
 * Rule nghiệp vụ (luồng 1 — debut):
 *  - Series mới (chưa EB chấm + chưa confirm-publish) chỉ được phép:
 *      1) Mangaka tạo nhiều chapter nháp (gate không chặn ở POST /chapters).
 *      2) Chỉ được submit đúng 1 chapter (chapter đầu) cho TE.
 *      3) TE chỉ forward đúng 1 chapter sang EB để chấm.
 *      4) EB chỉ chấm đúng 1 chapter (chapter đầu) của series.
 *
 *  - Sau khi EB evaluate pass + confirm-publish → gate mở → cho phép submit/chấm chapter tiếp theo.
 *
 *  - Series legacy (đã `published` hoặc có cờ `legacy_unlocked = true`) coi như unlocked.
 *  - KHÔNG dùng "≥2 chapters tồn tại" làm legacy condition (sai logic flow 1).
 */
const Series = require("../models/Series");
const Chapter = require("../models/Chapter");
const EBEvaluation = require("../models/EBEvaluation");
const { SERIES_STATUS, CHAPTER_STATUS } = require("../utils/constants");

/**
 * Check xem series đã "unlocked" (qua debut gate) hay chưa.
 * Điều kiện unlock:
 *  1) EB đã chấm và series.eb_evaluation_id được set + status ∈ {approved_by_EB, approved, published}
 *  2) publication_schedule đã được set (EB đã chọn lịch)
 *  3) scheduled_publish_at đã được set (EB đã confirm-publish)
 *
 * Lưu ý:
 *  - `eb_evaluation_id` được set ngay khi EB chấm tại routes/ebEvaluations.js.
 *  - `publication_schedule` được set tại /eb-evaluations/series/:id/evaluate (khi result=approved).
 *  - `scheduled_publish_at` CHỈ được set tại /eb-evaluations/series/:id/confirm-publish.
 *  → Check đủ 3 field = đã qua debut gate.
 */
function isSeriesUnlocked(series) {
  if (!series) return false;
  const ebEvaluated =
    series.eb_evaluation_id != null &&
    ["approved_by_EB", "approved", "published"].includes(series.status);
  const publishConfirmed =
    series.publication_schedule != null && series.scheduled_publish_at != null;
  return ebEvaluated && publishConfirmed;
}

/**
 * Legacy exemption: series cũ đã published (đã qua hết vòng đời debut) → coi như unlocked.
 *
 * Lưu ý quan trọng (sau khi sửa bug luồng 1):
 *  - KHÔNG dùng rule "≥2 chapters tồn tại" để bypass gate. Rule này sai vì:
 *      + Mangaka có thể tạo sẵn nhiều chapter nháp trước khi submit chapter đầu
 *      + Nếu 2+ chapter tồn tại → bypass → cho submit nhiều chapter → sai flow 1.
 *  - Rule "≥2 chapters" thuộc về flow 2 (sau khi series unlocked rồi), không phải flow 1.
 *  - Flow 1 chỉ quan tâm: series đã published (legacy chắc chắn) HOẶC đã qua gate (isSeriesUnlocked).
 *  - Nếu cần grandfather series cũ chưa published nhưng đã có nhiều chapter từ trước rule debut gate,
 *    hãy set cờ `series.legacy_unlocked = true` qua migration script.
 */
async function isLegacyUnlocked(series) {
  if (!series) return false;
  if (series.status === SERIES_STATUS.PUBLISHED) return true;
  // Cho phép grandfather thủ công qua flag (nếu đã set trong DB)
  if (series.legacy_unlocked === true) return true;
  return false;
}

/**
 * Check xem series có đang bị khóa khỏi việc chấm chapter tiếp theo của EB hay không.
 *
 * Logic:
 *  - Legacy unlocked → không khóa.
 *  - Series đã qua debut gate (isSeriesUnlocked) → không khóa.
 *  - Series đã có EBEvaluation với chapter_id != null và result ∈ {approved, rejected, revision}
 *    → EB đã chấm ít nhất 1 chapter của series → khóa.
 *  - Còn lại: chưa chấm chapter nào, gate vẫn mở (cho phép tạo + chấm chapter đầu tiên).
 */
async function isSeriesLockedForEBChapterReview(seriesId) {
  const series = await Series.findById(seriesId).lean();
  if (!series) return { locked: false, reason: null, series: null };

  if (await isLegacyUnlocked(series)) {
    return { locked: false, reason: null, series };
  }

  if (isSeriesUnlocked(series)) {
    return { locked: false, reason: null, series };
  }

  // Đếm số chapter EB đã chấm có kết quả trong series này
  const evaluatedChapterCount = await EBEvaluation.countDocuments({
    series_id: series._id,
    chapter_id: { $exists: true, $ne: null },
    result: { $in: ["approved", "rejected", "revision"] },
  });

  if (evaluatedChapterCount > 0) {
    return {
      locked: true,
      reason: "EB_ALREADY_EVALUATED_CHAPTER",
      series,
      evaluatedChapterCount,
    };
  }

  return { locked: false, reason: null, series };
}

/**
 * Build block `debut_gate` cho response series (FE dùng để disable nút submit chapter).
 *
 * Lưu ý (luồng 1):
 *  - Mangaka ĐƯỢC tạo nhiều chapter cho series mới → `can_create_next_chapter` luôn true.
 *  - Gate ở submit-to-te: chỉ cho submit 1 chapter (chapter đầu) khi series locked.
 *  - FE dùng các field `can_submit_first_chapter` / `can_submit_more_chapters`
 *    để quyết định hiển thị nút "Gửi cho TE" cho chapter nào.
 *
 * QUAN TRỌNG: `current_submitted_chapter_count` chỉ đếm chapter ĐÃ QUA CỔNG submit-to-te
 * (status ∈ pending_TE / pending_EB / EB_revision / approved_by_EB / published / TE_revision).
 * KHÔNG tính `submitted_by_assistant` vì status này chỉ là "Assistant đã nộp, chờ Mangaka duyệt",
 * CHƯA qua cổng submit-to-te. Nếu tính nhầm sẽ block khi chapter chưa từng submit.
 *
 * @param {Object} series - Series doc (lean hoặc đầy đủ)
 * @returns {Promise<Object>} block debut_gate
 */
async function buildDebutGate(series) {
  if (!series) return null;

  const legacyUnlocked = await isLegacyUnlocked(series);
  const unlocked = isSeriesUnlocked(series);
  const isUnlocked = legacyUnlocked || unlocked;

  const chapterCount = await Chapter.countDocuments({ series_id: series._id });
  // Đếm số chapter ĐÃ QUA CỔNG submit-to-te (Mangaka → TE → EB → published).
  // Status "submitted_by_assistant" KHÔNG tính — chỉ là Assistant nộp bài cho Mangaka duyệt,
  // chưa qua cổng submit-to-te. Gate chỉ tính những status sau khi chapter đã được Mangaka submit.
  const submittedCount = await Chapter.countDocuments({
    series_id: series._id,
    status: {
      $in: [
        CHAPTER_STATUS.PENDING_TE,
        CHAPTER_STATUS.PENDING_EB,
        CHAPTER_STATUS.APPROVED_BY_EB,
        CHAPTER_STATUS.PUBLISHED,
      ],
    },
  });

  if (isUnlocked) {
    return {
      locked: false,
      // Gate chỉ chặn ở submit-to-te, không còn chặn ở POST /chapters
      can_create_next_chapter: true,
      // Không giới hạn số chapter được submit
      can_submit_more_chapters: true,
      max_submitted_chapters_allowed: null,
      current_submitted_chapter_count: submittedCount,
      current_chapter_count: chapterCount,
      reasons: [],
    };
  }

  // Series locked — gate debut ở submit-to-te
  return {
    locked: true,
    // Mangaka vẫn được tạo chapter mới (gate không còn chặn ở POST /chapters)
    can_create_next_chapter: true,
    // Nhưng chỉ submit được chapter đầu tiên
    can_submit_more_chapters: submittedCount < 1,
    max_submitted_chapters_allowed: 1,
    current_submitted_chapter_count: submittedCount,
    current_chapter_count: chapterCount,
    reasons: ["DEBUT_GATE_LOCKED"],
  };
}

/**
 * Check xem có thể submit chapter lên TE ở giai đoạn debut không
 * (gate ở POST /chapters/:chapterId/submit-to-te — luồng 1).
 *
 * Lưu ý: Mangaka vẫn được tạo nhiều chapter cho series mới (gate không còn chặn ở POST /chapters).
 * Gate chuyển sang chặn ở submit-to-te: chỉ cho submit chapter có chapter_number NHỎ NHẤT
 * trong số các chapter chưa được submit (status ∈ draft/approved_by_mangaka/TE_revision/review).
 *
 * Rule:
 *  - Series unlocked (legacy hoặc qua debut gate) → luôn cho submit.
 *  - Series đang trong giai đoạn debut (locked):
 *      + Nếu series bị `rejected` hoặc `revision` (do EB Age Safety fail hoặc chấm điểm thấp)
 *        → cho phép resubmit chapter để Mangaka sửa và gửi lại.
 *      + Nếu chưa có chapter nào được submit → cho submit bất kỳ chapter nào (kỳ vọng chapter 1).
 *      + Sau khi EB confirm-publish → unlock → cho submit chapter 2+.
 *
 * Logic đơn giản: chỉ cho submit chapter đầu tiên (chapter_number nhỏ nhất trong các chapter
 * hiện có của series) nếu series chưa có chapter nào từng được submit.
 */
async function canSubmitChapterToTE({ series, chapterNumber }) {
  if (!series) {
    return { allowed: false, code: "SERIES_NOT_FOUND", message: "Series không tồn tại" };
  }

  // Legacy hoặc unlocked → luôn cho submit
  if (await isLegacyUnlocked(series)) {
    return { allowed: true };
  }
  if (isSeriesUnlocked(series)) {
    return { allowed: true };
  }

  // Series bị EB từ chối (Age Safety fail hoặc điểm thấp) → cho phép resubmit
  // Sau khi Mangaka sửa xong + gửi Assistant + duyệt task → được phép submit lại cho TE
  if (series.status === SERIES_STATUS.REJECTED || series.status === SERIES_STATUS.REVISION) {
    return { allowed: true, code: "RESUBMIT_AFTER_EB_REJECTION" };
  }

  // Series đang locked — đếm số chapter đã từng được submit lên TE/EB
  // Status đã submit = đã qua cổng Mangaka→TE (chỉ những status sau khi submit chứ không phải trước submit).
  const submittedCount = await Chapter.countDocuments({
    series_id: series._id,
    status: {
      $in: [
        CHAPTER_STATUS.PENDING_TE,
        CHAPTER_STATUS.PENDING_EB,
        CHAPTER_STATUS.APPROVED_BY_EB,
        CHAPTER_STATUS.PUBLISHED,
      ],
    },
  });

  if (submittedCount === 0) {
    // Chưa có chapter nào được submit → cho submit chapter đầu tiên (kỳ vọng chapter 1)
    return { allowed: true };
  }

  // Đã có 1 chapter được submit → sau đó không cho submit thêm chapter nào
  // cho đến khi series được confirm-publish.
  return {
    allowed: false,
    code: "DEBUT_SUBMIT_LOCKED",
    message:
      "Series đang trong giai đoạn debut. Chỉ được submit đúng 1 chapter (chapter đầu) cho TE. Sau khi EB confirm-publish sẽ mở khóa submit chapter tiếp theo.",
    data: {
      series_id: series._id,
      allowed_max_submitted_chapters: 1,
      current_submitted_count: submittedCount,
      unlock_requirements: {
        eb_evaluated: false,
        publish_confirmed: false,
        missing_step:
          "EB must call POST /eb-evaluations/series/:seriesId/confirm-publish to unlock further chapter submissions.",
      },
    },
  };
}

/**
 * (Deprecated — gate đã chuyển sang submit-to-te, không còn chặn ở POST /chapters)
 * Check xem có thể tạo chapter mới cho series không.
 *
 * Rule hiện tại (luồng 1):
 *  - Mangaka ĐƯỢC tạo nhiều chapter (gate không còn chặn ở POST /chapters).
 *  - Gate chuyển sang submit-to-te: chỉ submit được chapter 1 khi series locked.
 *
 * Hàm này giữ lại để tương thích ngược (luôn trả về allowed=true cho series tồn tại).
 */
async function canCreateChapter({ series }) {
  if (!series) {
    return { allowed: false, code: "SERIES_NOT_FOUND", message: "Series không tồn tại" };
  }
  return { allowed: true };
}

/**
 * Helper: build payload lỗi EB_DUPLICATE_CHAPTER_LOCKED cho các endpoint chặn TE/EB.
 */
function buildEBChapterLockError({ series, reason, extra = {} }) {
  return {
    allowed: false,
    code: "EB_DUPLICATE_CHAPTER_LOCKED",
    message:
      reason ||
      "EB đã chấm 1 chapter của series này. Series phải được confirm-publish trước khi chấm chapter tiếp theo.",
    data: {
      series_id: series ? series._id : null,
      ...extra,
    },
  };
}

module.exports = {
  isSeriesUnlocked,
  isLegacyUnlocked,
  isSeriesLockedForEBChapterReview,
  buildDebutGate,
  canCreateChapter,
  canSubmitChapterToTE,
  buildEBChapterLockError,
};
