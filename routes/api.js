const express = require("express");
const authMiddleware = require("../middleware/auth");
const router = express.Router();
const Nation = require("../models/Nations");

router.use(authMiddleware);

// GET ALL
router.get("/", async (req, res) => {
  try {
    const nations = await Nation.find().sort({ nationName: 1 });

    res.json({
      success: true,
      count: nations.length,
      data: nations,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching nations",
      error: error.message,
    });
  }
});

// GET BY ID
router.get("/:id", async (req, res) => {
  try {
    const nation = await Nation.findById(req.params.id);

    if (!nation) {
      return res.status(404).json({
        success: false,
        message: "Nation not found",
      });
    }

    res.json({
      success: true,
      data: nation,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching nation",
      error: error.message,
    });
  }
});

// CREATE
router.post("/", async (req, res) => {
  try {
    const { nationName, continent } = req.body;

    if (!nationName || !continent) {
      return res.status(400).json({
        success: false,
        message: "Please provide both nationName and continent",
      });
    }

    const existingNation = await Nation.findOne({ nationName });
    if (existingNation) {
      return res.status(400).json({
        success: false,
        message: "Nation with this name already exists",
      });
    }

    const nation = new Nation({
      nationName,
      continent,
    });

    const savedNation = await nation.save();

    res.status(201).json({
      success: true,
      message: "Nation created successfully",
      data: savedNation,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Error creating nation",
      error: error.message,
    });
  }
});

// UPDATE
router.put("/:id", async (req, res) => {
  try {
    const { nationName, continent } = req.body;

    const nation = await Nation.findById(req.params.id);
    if (!nation) {
      return res.status(404).json({
        success: false,
        message: "Nation not found",
      });
    }

    if (nationName) nation.nationName = nationName;
    if (continent) nation.continent = continent;

    const updatedNation = await nation.save();

    res.json({
      success: true,
      message: "Nation updated successfully",
      data: updatedNation,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Error updating nation",
      error: error.message,
    });
  }
});

// DELETE
router.delete("/:id", async (req, res) => {
  try {
    const nation = await Nation.findById(req.params.id);
    if (!nation) {
      return res.status(404).json({
        success: false,
        message: "Nation not found",
      });
    }

    const nationCount = await Nation.countDocuments({ nation: req.params.id });

    if (nationCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete nation because it has nationCount associated nation(s). Please delete the nations first.`,
        nationCount: nationCount,
      });
    }

    await Nation.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Nation deleted successfully",
      deletedNation: nation,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting nation",
      error: error.message,
    });
  }
});

module.exports = router;