const express = require("express");
const authMiddleware = require("../middleware/auth");
const { requireRole } = require("../middleware/routes/requireRole");
const { MangaSeries } = require("../models/MangaSeries");
const ReaderVote = require("../models/ReaderVote");

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole("Mangaka", "Assistant", "Editor", "EB"));

// ─── 1. Xem tất cả series đã xuất bản ──────────────────────────────────────
router.get("/published", async (req, res) => {
  try {
    const { schedule, page = 1, limit = 20 } = req.query;

    const filter = {
      status: { $in: ["Published_Weekly", "Published_Monthly"] },
    };
    if (schedule) {
      filter.publish_schedule = schedule;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const seriesList = await MangaSeries.find(filter)
      .populate("mangaka_id", "username full_name")
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await MangaSeries.countDocuments(filter);

    return res.status(200).json({
      success: true,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
      data: seriesList,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching published series",
      error: error.message,
    });
  }
});

// ─── 2. Xem bảng xếp hạng theo kỳ phát hành ─────────────────────────────────
router.get("/rankings/:issue_period", async (req, res) => {
  try {
    const { issue_period } = req.params;

    const votes = await ReaderVote.find({ issue_period })
      .populate({
        path: "series_id",
        populate: { path: "mangaka_id", select: "username full_name" },
      })
      .sort({ vote_count: -1 });

    if (votes.length === 0) {
      return res.status(200).json({
        success: true,
        issue_period,
        total_series: 0,
        data: [],
        message: "No ranking data for this period yet",
      });
    }

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

// ─── 3. Mangaka xem thứ hạng series của mình ─────────────────────────────────
router.get("/my-rankings", async (req, res) => {
  try {
    const mangaka_id = req.user.nameid;

    const mySeries = await MangaSeries.find({
      mangaka_id,
      status: { $in: ["Published_Weekly", "Published_Monthly"] },
    }).sort({ created_at: -1 });

    if (mySeries.length === 0) {
      return res.status(200).json({
        success: true,
        message: "You have no published series",
        data: [],
      });
    }

    const seriesIds = mySeries.map((s) => s._id);

    const latestPeriod = await ReaderVote.findOne()
      .sort({ created_at: -1 })
      .select("issue_period");

    if (!latestPeriod) {
      return res.status(200).json({
        success: true,
        message: "No ranking data available yet",
        data: mySeries.map((s) => ({
          series: s,
          rank: null,
          vote_count: 0,
        })),
      });
    }

    const votes = await ReaderVote.find({
      series_id: { $in: seriesIds },
      issue_period: latestPeriod.issue_period,
    }).sort({ vote_count: -1 });

    const allVotesForPeriod = await ReaderVote.find({
      issue_period: latestPeriod.issue_period,
    }).sort({ vote_count: -1 });

    const ranked = allVotesForPeriod.map((v, i) => ({
      series_id: v.series_id,
      rank: i + 1,
    }));

    const result = mySeries.map((s) => {
      const voteData = votes.find(
        (v) => v.series_id.toString() === s._id.toString()
      );
      const rankEntry = ranked.find(
        (r) => r.series_id.toString() === s._id.toString()
      );
      return {
        series: s,
        rank: rankEntry ? rankEntry.rank : null,
        vote_count: voteData ? voteData.vote_count : 0,
        issue_period: latestPeriod.issue_period,
      };
    });

    result.sort((a, b) => {
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    });

    return res.status(200).json({
      success: true,
      issue_period: latestPeriod.issue_period,
      data: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching your rankings",
      error: error.message,
    });
  }
});

module.exports = router;
