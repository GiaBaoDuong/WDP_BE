// utils/ebScoringRubric.js
// ─────────────────────────────────────────────────────────────────────────────
// EB Dynamic Evaluation Matrix — Weight System + Age Safety Gate
//
// Design decisions:
//   1. Scope: Chỉ áp dụng cho first review (series debut)
//   2. Age Safety Gate: FAIL → trả về 400 error ngay, không lưu
//   3. Weight: Cố định các mức 5%–30%, tổng mỗi rubric = 100%
//   4. Extension criteria: Thêm khi genre family cần
//   5. Scoring: Age Safety = PASS/FAIL  |  Criteria = 1–5 (step 0.5)
//   6. Multi-genre: EB chọn rubric tại thời điểm chấm
// ─────────────────────────────────────────────────────────────────────────────

// ─── Age Ratings ─────────────────────────────────────────────────────────────
const AGE_RATINGS = ["All ages", "Teens 13+", "Mature 17+", "Adults Only 18+"];

// ─── Core Criteria Keys ───────────────────────────────────────────────────────
const CORE_CRITERIA_KEYS = [
  "story_dialogue",
  "art_design",
  "panel_camera",
  "pacing_climax",
  "color",
];

const CORE_CRITERIA_LABELS = {
  story_dialogue: "Cốt truyện & Lời thoại",
  art_design:     "Nét vẽ & Tạo hình",
  panel_camera:   "Phân khung & Góc máy",
  pacing_climax:  "Nhịp độ & Cao trào",
  color:          "Đổ màu & Phối màu",
};

// ─── Extension Criteria Definitions ───────────────────────────────────────────
const EXTENSION_CRITERIA = {
  character_development: {
    key:         "character_development",
    label:       "Phát triển nhân vật",
    label_en:    "Character Development",
    description: "Độ sâu nhân vật, character arc, sự kết nối với khán giả",
    for_families: ["Romance-Lifestyle", "Drama-SliceOfLife"],
  },
  atmosphere: {
    key:         "atmosphere",
    label:       "Bầu không khí",
    label_en:    "Atmosphere",
    description: "Khả năng tạo không khí phù hợp thể loại (rợn gáy, căng thẳng...)",
    for_families: ["Horror-Suspense"],
  },
  action_choreography: {
    key:         "action_choreography",
    label:       "Triển khai hành động",
    label_en:    "Action Choreography",
    description: "Chất lượng cảnh chiến đấu, choreography, impact frames",
    for_families: ["Action-Adventure"],
  },
  comedy_timing: {
    key:         "comedy_timing",
    label:       "Timing hài & Tính giải trí",
    label_en:    "Comedy Timing",
    description: "Nhịp hài, miếng hài (gags), tính giải trí tổng thể",
    for_families: ["Comedy"],
  },
  world_building: {
    key:         "world_building",
    label:       "Xây dựng thế giới",
    label_en:    "World Building",
    description: "Độ phong phú và logic của thế giới quan, hệ thống quy tắc",
    for_families: ["Fantasy-SciFi", "Action-Adventure"],
  },
  educational_value: {
    key:         "educational_value",
    label:       "Giá trị giáo dục",
    label_en:    "Educational Value",
    description: "Tính chính xác thông tin, khả năng truyền tải kiến thức",
    for_families: ["Romance-Lifestyle", "Drama-SliceOfLife"],
  },
  emotional_resonance: {
    key:         "emotional_resonance",
    label:       "Cộng hưởng cảm xúc",
    label_en:    "Emotional Resonance",
    description: "Khả năng tạo cảm xúc thật sự với khán giả",
    for_families: ["Drama-SliceOfLife", "Romance-Lifestyle", "Horror-Suspense"],
  },
};

// ─── Genre → Family Mapping ───────────────────────────────────────────────────
const GENRE_TO_FAMILY = {
  // Action-Adventure
  "Hành Động": "Action-Adventure",
  "Phiêu Lưu": "Action-Adventure",
  "Võ Thuật":  "Action-Adventure",
  "Hầm Ngục":  "Action-Adventure",
  "Săn Bắn":   "Action-Adventure",
  "Leo Tháp":  "Action-Adventure",
  "Bạo Lực":   "Action-Adventure",
  // Romance-Lifestyle
  "Lãng Mạn":    "Romance-Lifestyle",
  "Ngôn Tình":   "Romance-Lifestyle",
  "Nữ Cường":    "Romance-Lifestyle",
  "Gender Bender": "Romance-Lifestyle",
  "Học Đường":  "Romance-Lifestyle",
  // Drama-SliceOfLife
  "Drama":       "Drama-SliceOfLife",
  "Bi Kịch":    "Drama-SliceOfLife",
  "Josei":      "Drama-SliceOfLife",
  "Shoujo":     "Drama-SliceOfLife",
  "Manhwa":     "Drama-SliceOfLife",
  "Manhua":     "Drama-SliceOfLife",
  "Slice of life": "Drama-SliceOfLife",
  "Nấu Ăn":     "Drama-SliceOfLife",
  "Thể Thao":   "Drama-SliceOfLife",
  "Lịch Sử":    "Drama-SliceOfLife",
  // Horror-Suspense
  "Kinh Dị":    "Horror-Suspense",
  "Huyền Bí":   "Horror-Suspense",
  "Siêu Nhiên": "Horror-Suspense",
  // Comedy
  "Hài Hước":   "Comedy",
  "Ecchi":      "Comedy",
  // Fantasy-SciFi
  "Isekai":      "Fantasy-SciFi",
  "Trùng Sinh": "Fantasy-SciFi",
  "Game":        "Fantasy-SciFi",
  "Viễn Tưởng": "Fantasy-SciFi",
  "Khoa Học":   "Fantasy-SciFi",
  // Art-Heavy
  "Anime":     "Art-Heavy",
  "Manga":     "Art-Heavy",
  "Webtoons":  "Art-Heavy",
  "Truyện Màu": "Art-Heavy",
  "One Shot":  "Art-Heavy",
  "Shounen":   "Art-Heavy",
  // Mature-Adult
  "Mature":              "Mature-Adult",
  "Người Lớn":           "Mature-Adult",
  "Ngôn Từ Nhạy Cảm":   "Mature-Adult",
  "Doujinshi":           "Mature-Adult",
  "Harem":               "Mature-Adult",
  "Boylove":             "Mature-Adult",
  "Murim":               "Mature-Adult",
  "Ngôn Tình":           "Mature-Adult",
};

// ─── Age Safety Rules ─────────────────────────────────────────────────────────
// content_level: 0 = clean, 1 = mild, 2 = moderate, 3 = severe
// Vi phạm khi content_level > rule.max
const AGE_SAFETY_RULES = {
  "All ages": {
    max_violence:           0,  // không cartoon violence
    max_fear:               0,
    max_profanity:          0,
    max_nudity:             0,
    max_danger_simulation:   0,
    notes: "Tuyệt đối không: bạo lực, sợ hãi, tục tĩu, nguy hiểm mô phỏng",
  },
  "Teens 13+": {
    max_violence:           1,  // cartoon violence OK
    max_fear:               1,  // nhẹ
    max_profanity:          1,  // damn, hell
    max_nudity:             0,
    max_danger_simulation:  1,
    notes: "Cartoon violence nhẹ; ngôn từ tục nhẹ; không nội dung nhạy cảm",
  },
  "Mature 17+": {
    max_violence:           2,  // mild blood OK
    max_fear:               2,
    max_profanity:          2,
    max_nudity:             1,  // implied OK
    max_danger_simulation:  2,
    notes: "Bạo lực nhẹ có máu; implied nhạy cảm; có warning rõ ràng",
  },
  "Adults Only 18+": {
    max_violence:           3,  // graphic OK
    max_fear:               3,
    max_profanity:          3,
    max_nudity:             3,
    max_danger_simulation:  3,
    notes: "Explicit OK với nhãn cảnh báo rõ ràng",
  },
};

const SAFETY_LEVELS = {
  0: "Không vi phạm",
  1: "Vi phạm nhẹ",
  2: "Vi phạm vừa",
  3: "Vi phạm nặng",
};

// ─── Weight Matrix: Genre Family × Age Rating ─────────────────────────────────
// Format mỗi ô: { story, art, panel, pacing, color, extension, extWeight }
// extension = null → không có extension
// null → không phù hợp / không accept submission

const WEIGHT_MATRIX = {
  "Action-Adventure": {
    "All ages":       { story: 15, art: 20, panel: 15, pacing: 25, color: 15, extension: null,       extWeight: 0  },
    "Teens 13+":      { story: 20, art: 20, panel: 20, pacing: 25, color: 15, extension: null,       extWeight: 0  },
    "Mature 17+":    { story: 20, art: 20, panel: 20, pacing: 20, color: 20, extension: null,       extWeight: 0  },
    "Adults Only 18+":{ story: 20, art: 15, panel: 20, pacing: 20, color: 15, extension: null,       extWeight: 0  },
  },
  "Romance-Lifestyle": {
    "All ages":       { story: 20, art: 15, panel: 10, pacing: 20, color: 10, extension: "character_development", extWeight: 25 },
    "Teens 13+":      { story: 25, art: 15, panel: 10, pacing: 15, color: 10, extension: "character_development", extWeight: 25 },
    "Mature 17+":    { story: 25, art: 15, panel: 10, pacing: 10, color: 15, extension: "character_development", extWeight: 25 },
    "Adults Only 18+":{ story: 20, art: 15, panel: 10, pacing: 10, color: 20, extension: "character_development", extWeight: 25 },
  },
  "Drama-SliceOfLife": {
    "All ages":       { story: 20, art: 20, panel: 10, pacing: 15, color: 15, extension: "character_development", extWeight: 20 },
    "Teens 13+":      { story: 25, art: 15, panel: 10, pacing: 15, color: 10, extension: "character_development", extWeight: 25 },
    "Mature 17+":    { story: 25, art: 15, panel: 10, pacing: 10, color: 15, extension: "character_development", extWeight: 25 },
    "Adults Only 18+":{ story: 20, art: 15, panel: 10, pacing: 10, color: 20, extension: "emotional_resonance",     extWeight: 25 },
  },
  "Horror-Suspense": {
    "All ages":       null, // Không phù hợp
    "Teens 13+":      { story: 20, art: 15, panel: 15, pacing: 20, color: 10, extension: "atmosphere",             extWeight: 20 },
    "Mature 17+":    { story: 15, art: 15, panel: 15, pacing: 20, color: 10, extension: "atmosphere",             extWeight: 25 },
    "Adults Only 18+":{ story: 15, art: 15, panel: 15, pacing: 20, color: 10, extension: "atmosphere",             extWeight: 25 },
  },
  "Comedy": {
    "All ages":       { story: 15, art: 15, panel: 15, pacing: 15, color: 15, extension: "comedy_timing",           extWeight: 25 },
    "Teens 13+":      { story: 20, art: 15, panel: 15, pacing: 15, color: 10, extension: "comedy_timing",           extWeight: 25 },
    "Mature 17+":    { story: 20, art: 15, panel: 15, pacing: 15, color: 10, extension: "comedy_timing",           extWeight: 25 },
    "Adults Only 18+":{ story: 20, art: 15, panel: 15, pacing: 15, color: 10, extension: "comedy_timing",           extWeight: 25 },
  },
  "Fantasy-SciFi": {
    "All ages":       { story: 15, art: 20, panel: 15, pacing: 25, color: 10, extension: "world_building",          extWeight: 15 },
    "Teens 13+":      { story: 20, art: 20, panel: 15, pacing: 25, color: 10, extension: "world_building",          extWeight: 10 },
    "Mature 17+":    { story: 20, art: 20, panel: 15, pacing: 20, color: 10, extension: "world_building",          extWeight: 15 },
    "Adults Only 18+":{ story: 20, art: 15, panel: 15, pacing: 20, color: 15, extension: "world_building",          extWeight: 15 },
  },
  "Art-Heavy": {
    "All ages":       { story: 10, art: 25, panel: 15, pacing: 15, color: 25, extension: null,                     extWeight: 0  },
    "Teens 13+":      { story: 15, art: 25, panel: 15, pacing: 15, color: 20, extension: null,                     extWeight: 0  },
    "Mature 17+":    { story: 15, art: 25, panel: 15, pacing: 15, color: 20, extension: null,                     extWeight: 0  },
    "Adults Only 18+":{ story: 15, art: 25, panel: 15, pacing: 15, color: 20, extension: null,                     extWeight: 0  },
  },
  "Mature-Adult": {
    "All ages":       null,
    "Teens 13+":      null,
    "Mature 17+":    { story: 20, art: 15, panel: 15, pacing: 20, color: 15, extension: "emotional_resonance",     extWeight: 15 },
    "Adults Only 18+":{ story: 25, art: 15, panel: 10, pacing: 15, color: 20, extension: "emotional_resonance",     extWeight: 15 },
  },
};

// ─── Get Genre Family ─────────────────────────────────────────────────────────
function getGenreFamily(genre) {
  return GENRE_TO_FAMILY[genre] || null;
}

// ─── Get All Families ─────────────────────────────────────────────────────────
function getAllFamilies() {
  return Object.keys(WEIGHT_MATRIX);
}

// ─── Build Rubric ID ──────────────────────────────────────────────────────────
function buildRubricId(family, ageRating) {
  return `${family}|${ageRating}`.toLowerCase().replace(/\s+/g, "_");
}

// ─── Parse Rubric ID ──────────────────────────────────────────────────────────
function parseRubricId(rubricId) {
  // Format: "genre_family|age_rating" e.g. "action-adventure|teens_13+"
  const parts = (rubricId || "").split("|");
  if (parts.length !== 2) return null;

  // Convert family: "action-adventure" → "Action-Adventure"
  // Split on both _ and - to handle hyphenated family names
  const family = parts[0]
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("-");

  // Normalize age rating key
  const ageMap = {
    "all_ages":         "All ages",
    "teens_13+":       "Teens 13+",
    "mature_17+":      "Mature 17+",
    "adults_only_18+": "Adults Only 18+",
  };
  const key = parts[1].toLowerCase();
  const normalizedAge = ageMap[key];

  if (!normalizedAge) return null;

  return { family, age_rating: normalizedAge };
}

// ─── Get Rubric by ID ─────────────────────────────────────────────────────────
function getRubricById(rubricId) {
  const parsed = parseRubricId(rubricId);
  if (!parsed) return null;

  const entry = WEIGHT_MATRIX[parsed.family]?.[parsed.age_rating];
  if (!entry) return null;

  return buildRubricEntry(parsed.family, parsed.age_rating, entry);
}

// ─── Build Rubric Entry from Matrix Cell ─────────────────────────────────────
function buildRubricEntry(family, ageRating, entry) {
  const extDef = entry.extension ? EXTENSION_CRITERIA[entry.extension] : null;

  const weights = {
    story_dialogue: entry.story,
    art_design:     entry.art,
    panel_camera:   entry.panel,
    pacing_climax:  entry.pacing,
    color:          entry.color,
  };

  const criteria = [
    { key: "story_dialogue",  label: CORE_CRITERIA_LABELS.story_dialogue,  weight: entry.story,  order: 1 },
    { key: "art_design",      label: CORE_CRITERIA_LABELS.art_design,      weight: entry.art,     order: 2 },
    { key: "panel_camera",    label: CORE_CRITERIA_LABELS.panel_camera,    weight: entry.panel,   order: 3 },
    { key: "pacing_climax",   label: CORE_CRITERIA_LABELS.pacing_climax,   weight: entry.pacing,  order: 4 },
    { key: "color",           label: CORE_CRITERIA_LABELS.color,            weight: entry.color,   order: 5 },
  ];

  if (extDef && entry.extWeight > 0) {
    weights[extDef.key] = entry.extWeight;
    criteria.push({
      key:         extDef.key,
      label:       extDef.label,
      description: extDef.description,
      weight:      entry.extWeight,
      order:       6,
    });
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  return {
    id:           buildRubricId(family, ageRating),
    family,
    age_rating:   ageRating,
    weights,
    criteria,
    total_weight: totalWeight,
    has_extension: !!extDef,
    extension:    extDef
      ? { key: extDef.key, label: extDef.label, description: extDef.description }
      : null,
  };
}

// ─── Get Default Rubric (equal weights) ───────────────────────────────────────
function getDefaultRubric() {
  const entry = { story: 20, art: 20, panel: 20, pacing: 20, color: 20, extension: null, extWeight: 0 };
  return buildRubricEntry("__default__", "All ages", entry);
}

// ─── Get Suggested Rubric for a Series ───────────────────────────────────────
function getSuggestedRubricForSeries(series) {
  const primaryGenre = series.genre && series.genre.length > 0 ? series.genre[0] : null;
  const age_rating = series.age_rating || "All ages";

  if (!primaryGenre) {
    return { ...getDefaultRubric(), suggested: false, reason: "Không có genre" };
  }

  const family = GENRE_TO_FAMILY[primaryGenre];
  if (!family) {
    return { ...getDefaultRubric(), suggested: false, reason: `Genre "${primaryGenre}" không có trong ma trận` };
  }

  const entry = WEIGHT_MATRIX[family]?.[age_rating];
  if (!entry) {
    // Genre × Age không hợp lệ → fallback default
    return {
      ...getDefaultRubric(),
      suggested: false,
      reason: `Genre "${primaryGenre}" không phù hợp với "${age_rating}". Vui lòng chọn rubric khác.`,
    };
  }

  const rubric = buildRubricEntry(family, age_rating, entry);
  return {
    ...rubric,
    suggested: true,
    source_genre: primaryGenre,
    source_family: family,
  };
}

// ─── List All Rubrics ─────────────────────────────────────────────────────────
function listAllRubrics() {
  const rubrics = [];
  for (const [family, ages] of Object.entries(WEIGHT_MATRIX)) {
    for (const [ageRating, entry] of Object.entries(ages)) {
      if (!entry) continue;
      rubrics.push(buildRubricEntry(family, ageRating, entry));
    }
  }
  return rubrics;
}

// ─── List Rubrics for a Family ────────────────────────────────────────────────
function listRubricsForFamily(family) {
  const ages = WEIGHT_MATRIX[family];
  if (!ages) return [];

  return Object.entries(ages)
    .filter(([, entry]) => entry !== null)
    .map(([ageRating, entry]) => buildRubricEntry(family, ageRating, entry));
}

// ─── Age Safety Check ─────────────────────────────────────────────────────────
// contentLevels: { violence, fear, profanity, nudity, danger_simulation }
// ageRating: từ rubric (series.age_rating)
// Returns: { passed: boolean, violations: [], severity: string, highestLevel: number }
function checkAgeSafety(contentLevels, ageRating) {
  const rules = AGE_SAFETY_RULES[ageRating] || AGE_SAFETY_RULES["All ages"];

  const fields = [
    { key: "violence",           label: "Bạo lực",            max: rules.max_violence },
    { key: "fear",                label: "Nội dung sợ hãi",    max: rules.max_fear },
    { key: "profanity",           label: "Ngôn từ tục tĩu",    max: rules.max_profanity },
    { key: "nudity",             label: "Nội dung nhạy cảm",  max: rules.max_nudity },
    { key: "danger_simulation",   label: "Nguy hiểm mô phỏng",max: rules.max_danger_simulation },
  ];

  const violations = [];
  let highestLevel = 0;

  for (const field of fields) {
    const level = Math.max(0, Math.min(3, contentLevels?.[field.key] ?? 0));
    if (level > field.max) {
      violations.push({
        field:         field.key,
        label:         field.label,
        actual_level:  level,
        max_allowed:   field.max,
        age_rating:    ageRating,
        message:       `${field.label} mức ${level} (tối đa ${field.max}) cho "${ageRating}" — Vi phạm!`,
      });
      highestLevel = Math.max(highestLevel, level);
    }
  }

  return {
    passed:        violations.length === 0,
    violations,
    severity:      SAFETY_LEVELS[highestLevel] || "Không vi phạm",
    highest_level: highestLevel,
    rules_note:    rules.notes,
    age_rating:    ageRating,
  };
}

// ─── Validate Content Levels ─────────────────────────────────────────────────
function validateContentLevels(contentLevels) {
  const fields = ["violence", "fear", "profanity", "nudity", "danger_simulation"];
  const errors = [];

  for (const field of fields) {
    const val = contentLevels?.[field];
    if (val !== undefined && (typeof val !== "number" || val < 0 || val > 3)) {
      errors.push(`${field} phải là số 0–3`);
    }
  }

  return {
    valid:   errors.length === 0,
    errors,
  };
}

// ─── Compute Weighted Council Average ─────────────────────────────────────────
// memberScores: [{ scores: { key: value } }]
// weights: { key: weightPercent }
// Returns: weighted average (0–5)
function computeWeightedCouncilAverage(memberScores, weights) {
  if (!memberScores || memberScores.length === 0) return 0;
  if (!weights || Object.keys(weights).length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const avgScore = memberScores.reduce(
      (acc, m) => acc + (m.scores?.[key] || 0),
      0
    ) / memberScores.length;

    weightedSum += avgScore * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return Math.round((weightedSum / totalWeight) * 100) / 100;
}

// ─── Compute Individual Member Weighted Score ─────────────────────────────────
function computeMemberWeightedScore(scores, weights) {
  if (!scores || !weights) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    weightedSum += (scores[key] || 0) * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return Math.round((weightedSum / totalWeight) * 100) / 100;
}

// ─── Normalize Old-format Scores (backward compatibility) ───────────────────
// Khi evaluation không có rubric (data cũ): dùng equal weights = 20% mỗi criteria
function normalizeScoresToWeights(scores) {
  const keys = Object.keys(scores || {});
  if (keys.length === 0) return {};
  const equalWeight = Math.round(100 / keys.length);
  const weights = {};
  for (const key of keys) {
    weights[key] = equalWeight;
  }
  return weights;
}

// ─── Get Age Safety Field Labels ──────────────────────────────────────────────
const AGE_SAFETY_FIELDS = [
  { key: "violence",          label: "Bạo lực",            description: "Mức độ bạo lực trong nội dung" },
  { key: "fear",               label: "Nội dung sợ hãi",    description: "Mức độ gây sợ hãi" },
  { key: "profanity",          label: "Ngôn từ tục tĩu",    description: "Mức độ tục tĩu" },
  { key: "nudity",             label: "Nội dung nhạy cảm",  description: "Mức độ nhạy cảm/nóng bỏng" },
  { key: "danger_simulation",  label: "Nguy hiểm mô phỏng",description: "Hành vi nguy hiểm mô phỏng được" },
];

const AGE_SAFETY_LEVELS = [
  { value: 0, label: "Không", description: "Không có nội dung này" },
  { value: 1, label: "Nhẹ",  description: "Mức nhẹ, phù hợp độ tuổi" },
  { value: 2, label: "Vừa",  description: "Mức vừa phải" },
  { value: 3, label: "Nặng", description: "Mức nặng, cần cảnh báo" },
];

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = {
  AGE_RATINGS,
  CORE_CRITERIA_KEYS,
  CORE_CRITERIA_LABELS,
  EXTENSION_CRITERIA,
  GENRE_TO_FAMILY,
  WEIGHT_MATRIX,
  AGE_SAFETY_RULES,
  SAFETY_LEVELS,
  AGE_SAFETY_FIELDS,
  AGE_SAFETY_LEVELS,

  // Functions
  getGenreFamily,
  getAllFamilies,
  buildRubricId,
  parseRubricId,
  getRubricById,
  buildRubricEntry,
  getDefaultRubric,
  getSuggestedRubricForSeries,
  listAllRubrics,
  listRubricsForFamily,
  checkAgeSafety,
  validateContentLevels,
  computeWeightedCouncilAverage,
  computeMemberWeightedScore,
  normalizeScoresToWeights,
};
