const express = require("express");
const authMiddleware = require("../middleware/auth");
const { requireRole } = require("../middleware/routes/requireRole");
const { MangaSeries } = require("../models/MangaSeries");
const SeriesDraftFile = require("../models/SeriesDraftFile");
const { EBVote } = require("../models/EBVote");
const ReaderVote = require("../models/ReaderVote");

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("EB"));

// ─── 1. Xem danh sách series chờ EB bình chọn ────────────────────────────────
router.get("/pending-vote", async (req, res) => {
  try {
    const eb_user_id = req.user.nameid;

    const seriesList = await MangaSeries.find({ status: "Pending_EB" })
      .populate("mangaka_id", "username full_name")
      .populate("editor_id", "username full_name")
      .sort({ updated_at: 1 });

    const seriesWithVotes = await Promise.all(
      seriesList.map(async (series) => {
        const votes = await EBVote.find({ series_id: series._id }).populate(
          "eb_user_id",
          "username full_name"
        );
        const myVote = votes.find(
          (v) => v.eb_user_id._id.toString() === eb_user_id
        );
        const approvedCount = votes.filter(
          (v) => v.vote_status === "Approved"
        ).length;

        return {
          ...series.toJSON(),
          total_votes: votes.length,
          approved_count: approvedCount,
          my_vote: myVote ? myVote.vote_status : null,
          votes,
        };
      })
    );

    return res.status(200).json({
      success: true,
      count: seriesList.length,
      data: seriesWithVotes,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching pending series",
      error: error.message,
    });
  }
});

// ─── 2. Xem chi tiết series trước khi vote ───────────────────────────────────
router.get("/series/:seriesId/review", async (req, res) => {
  try {
    const { seriesId } = req.params;

    const series = await MangaSeries.findById(seriesId)
      .populate("mangaka_id", "username full_name")
      .populate("editor_id", "username full_name");

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    const drafts = await SeriesDraftFile.find({ series_id: seriesId }).sort({
      page_number: 1,
    });

    const votes = await EBVote.find({ series_id: seriesId }).populate(
      "eb_user_id",
      "username full_name"
    );

    return res.status(200).json({
      success: true,
      data: {
        ...series.toJSON(),
        drafts,
        votes,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching series for EB review",
      error: error.message,
    });
  }
});

// ─── 3. EB bỏ phiếu cho series ──────────────────────────────────────────────
router.post("/series/:seriesId/vote", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const eb_user_id = req.user.nameid;
    const { vote_status, comment } = req.body;

    if (!["Approved", "Rejected"].includes(vote_status)) {
      return res.status(400).json({
        success: false,
        message: "vote_status must be 'Approved' or 'Rejected'",
      });
    }

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (series.status !== "Pending_EB") {
      return res.status(400).json({
        success: false,
        message: `Cannot vote on series with status '${series.status}'`,
      });
    }

    const existingVote = await EBVote.findOne({
      series_id: seriesId,
      eb_user_id,
    });

    if (existingVote) {
      existingVote.vote_status = vote_status;
      existingVote.comment = comment || "";
      await existingVote.save();

      return res.status(200).json({
        success: true,
        message: "Your vote has been updated",
        data: existingVote,
      });
    }

    const vote = await EBVote.create({
      series_id: seriesId,
      eb_user_id,
      vote_status,
      comment: comment || "",
    });

    const allVotes = await EBVote.find({ series_id: seriesId });
    const totalEBAccounts = await require("../models/User").countDocuments({
      role: "EB",
    });
    const approvedVotes = allVotes.filter(
      (v) => v.vote_status === "Approved"
    ).length;
    const rejectedVotes = allVotes.filter(
      (v) => v.vote_status === "Rejected"
    ).length;

    if (approvedVotes > totalEBAccounts / 2) {
      series.status = "Published_Weekly";
      series.publish_schedule = "Weekly";
      await series.save();

      return res.status(200).json({
        success: true,
        message: `Vote recorded. Series '${series.title}' has been APPROVED for weekly publication!`,
        data: {
          vote,
          series_status: series.status,
          total_votes: allVotes.length,
          approved_count: approvedVotes,
          rejected_count: rejectedVotes,
        },
      });
    }

    if (rejectedVotes > totalEBAccounts / 2) {
      series.status = "Dropped";
      await series.save();

      return res.status(200).json({
        success: true,
        message: `Vote recorded. Series '${series.title}' has been REJECTED.`,
        data: {
          vote,
          series_status: series.status,
          total_votes: allVotes.length,
          approved_count: approvedVotes,
          rejected_count: rejectedVotes,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Your vote has been recorded",
      data: {
        vote,
        total_votes: allVotes.length,
        approved_count: approvedVotes,
        rejected_count: rejectedVotes,
        awaiting_more_votes: true,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "You have already voted for this series",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Error recording vote",
      error: error.message,
    });
  }
});

// ─── 4. EB chọn lịch phát hành sau khi duyệt ────────────────────────────────
router.patch("/series/:seriesId/schedule", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const eb_user_id = req.user.nameid;
    const { publish_schedule } = req.body;

    if (!["Weekly", "Monthly"].includes(publish_schedule)) {
      return res.status(400).json({
        success: false,
        message: "publish_schedule must be 'Weekly' or 'Monthly'",
      });
    }

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (
      series.status !== "Published_Weekly" &&
      series.status !== "Published_Monthly"
    ) {
      return res.status(400).json({
        success: false,
        message: `Cannot change schedule for series with status '${series.status}'`,
      });
    }

    series.publish_schedule = publish_schedule;
    series.status =
      publish_schedule === "Monthly"
        ? "Published_Monthly"
        : "Published_Weekly";
    await series.save();

    return res.status(200).json({
      success: true,
      message: `Series scheduled for ${publish_schedule.toLowerCase()} publication`,
      data: series,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error updating schedule",
      error: error.message,
    });
  }
});

// ─── 5. EB nhập dữ liệu bình chọn từ độc giả ────────────────────────────────
router.post("/reader-votes", async (req, res) => {
  try {
    const imported_by = req.user.nameid;
    const { series_id, issue_period, vote_count } = req.body;

    if (!series_id || !issue_period || vote_count === undefined) {
      return res.status(400).json({
        success: false,
        message: "series_id, issue_period, and vote_count are required",
      });
    }

    const series = await MangaSeries.findById(series_id);
    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    const existingVote = await ReaderVote.findOne({
      series_id,
      issue_period,
    });

    let voteRecord;
    if (existingVote) {
      existingVote.vote_count = vote_count;
      existingVote.imported_by = imported_by;
      voteRecord = await existingVote.save();
    } else {
      voteRecord = await ReaderVote.create({
        series_id,
        issue_period,
        vote_count,
        imported_by,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Reader vote data recorded successfully",
      data: voteRecord,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error recording reader votes",
      error: error.message,
    });
  }
});

// ─── 6. EB xem bảng xếp hạng theo kỳ phát hành ─────────────────────────────
router.get("/rankings", async (req, res) => {
  try {
    const { issue_period } = req.query;

    if (!issue_period) {
      return res.status(400).json({
        success: false,
        message: "issue_period query parameter is required",
      });
    }

    const votes = await ReaderVote.find({ issue_period })
      .populate({
        path: "series_id",
        populate: { path: "mangaka_id", select: "username full_name" },
      })
      .sort({ vote_count: -1 });

    const rankedData = votes.map((v, index) => ({
      rank: index + 1,
      series: v.series_id,
      vote_count: v.vote_count,
    }));

    return res.status(200).json({
      success: true,
      issue_period,
      total_series: rankedData.length,
      data: rankedData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching rankings",
      error: error.message,
    });
  }
});

// ─── 7. EB quyết định hủy series ─────────────────────────────────────────────
router.patch("/series/:seriesId/drop", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const { comment } = req.body;

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (!["Published_Weekly", "Published_Monthly"].includes(series.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot drop series with status '${series.status}'`,
      });
    }

    series.status = "Dropped";
    await series.save();

    return res.status(200).json({
      success: true,
      message: `Series '${series.title}' has been dropped`,
      data: series,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error dropping series",
      error: error.message,
    });
  }
});

// ─── 8. Chuyển đổi lịch phát hành Weekly ↔ Monthly ───────────────────────────
router.patch("/series/:seriesId/convert-schedule", async (req, res) => {
  try {
    const { seriesId } = req.params;
    const { new_schedule } = req.body;

    if (!["Weekly", "Monthly"].includes(new_schedule)) {
      return res.status(400).json({
        success: false,
        message: "new_schedule must be 'Weekly' or 'Monthly'",
      });
    }

    const series = await MangaSeries.findById(seriesId);

    if (!series) {
      return res.status(404).json({
        success: false,
        message: "Series not found",
      });
    }

    if (!["Published_Weekly", "Published_Monthly"].includes(series.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot convert schedule for series with status '${series.status}'`,
      });
    }

    const oldSchedule = series.publish_schedule;
    series.publish_schedule = new_schedule;
    series.status =
      new_schedule === "Monthly"
        ? "Published_Monthly"
        : "Published_Weekly";
    await series.save();

    return res.status(200).json({
      success: true,
      message: `Series schedule converted from ${oldSchedule} to ${new_schedule}`,
      data: series,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error converting schedule",
      error: error.message,
    });
  }
});

module.exports = router;
