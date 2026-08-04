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
  // ─── Romance-Lifestyle ────────────────────────────────────────────────────
  character_development: {
    key:         "character_development",
    label:       "Phát triển nhân vật",
    label_en:    "Character Development",
    description: "Độ sâu nhân vật, character arc, sự kết nối với khán giả",
    for_families: ["Romance-Lifestyle", "Drama-SliceOfLife"],
  },
  emotional_resonance: {
    key:         "emotional_resonance",
    label:       "Cộng hưởng cảm xúc",
    label_en:    "Emotional Resonance",
    description: "Khả năng tạo cảm xúc thật sự với khán giả",
    for_families: ["Drama-SliceOfLife", "Romance-Lifestyle", "Horror-Suspense", "Mature-Adult"],
  },
  romantic_tension: {
    key:         "romantic_tension",
    label:       "Bầu không khí lãng mạn",
    label_en:    "Romantic Tension",
    description: "Chemistry, sự căng thẳng lãng mạn, buildup giữa các nhân vật",
    for_families: ["Romance-Lifestyle"],
  },
  educational_value: {
    key:         "educational_value",
    label:       "Giá trị giáo dục",
    label_en:    "Educational Value",
    description: "Kiến thức đời sống, nấu ăn, thể thao, tính chính xác thông tin",
    for_families: ["Romance-Lifestyle", "Drama-SliceOfLife"],
  },

  // ─── Horror-Suspense ───────────────────────────────────────────────────────
  atmosphere: {
    key:         "atmosphere",
    label:       "Bầu không khí",
    label_en:    "Atmosphere",
    description: "Khả năng tạo không khí phù hợp thể loại (rợn gáy, căng thẳng...)",
    for_families: ["Horror-Suspense"],
  },
  pacing_horror: {
    key:         "pacing_horror",
    label:       "Nhịp độ kinh dị",
    label_en:    "Horror Pacing",
    description: "Buildup, payoff, timing jumpscare, kiểm soát nhịp gây sợ",
    for_families: ["Horror-Suspense"],
  },
  mystery_setup: {
    key:         "mystery_setup",
    label:       "Xây dựng bí ẩn",
    label_en:    "Mystery Setup",
    description: "Plot twists, clues, intrigue, khả năng giữ bí mật",
    for_families: ["Horror-Suspense", "Fantasy-SciFi"],
  },
  fear_impact: {
    key:         "fear_impact",
    label:       "Tác động gây sợ",
    label_en:    "Fear Impact",
    description: "Hiệu quả gây sợ thực tế, điểm rơi cảm xúc",
    for_families: ["Horror-Suspense"],
  },

  // ─── Action-Adventure ──────────────────────────────────────────────────────
  action_choreography: {
    key:         "action_choreography",
    label:       "Triển khai hành động",
    label_en:    "Action Choreography",
    description: "Chất lượng cảnh chiến đấu, choreography, impact frames",
    for_families: ["Action-Adventure"],
  },
  world_building: {
    key:         "world_building",
    label:       "Xây dựng thế giới",
    label_en:    "World Building",
    description: "Độ phong phú và logic của thế giới quan, hệ thống quy tắc",
    for_families: ["Fantasy-SciFi", "Action-Adventure"],
  },
  stakes_tension: {
    key:         "stakes_tension",
    label:       "Mức độ căng thẳng",
    label_en:    "Stakes & Tension",
    description: "Tạo hồi hộp, high stakes, cliffhanger, consequences",
    for_families: ["Action-Adventure", "Fantasy-SciFi"],
  },
  fight_impact: {
    key:         "fight_impact",
    label:       "Hiệu ứng chiến đấu",
    label_en:    "Fight Scene Impact",
    description: "Splash pages, speed lines, visual impact, dynamism",
    for_families: ["Action-Adventure"],
  },

  // ─── Comedy ───────────────────────────────────────────────────────────────
  comedy_timing: {
    key:         "comedy_timing",
    label:       "Timing hài & Tính giải trí",
    label_en:    "Comedy Timing",
    description: "Nhịp hài, miếng hài (gags), tính giải trí tổng thể",
    for_families: ["Comedy"],
  },
  comedy_originality: {
    key:         "comedy_originality",
    label:       "Tính độc đáo hài",
    label_en:    "Comedy Originality",
    description: "Ý tưởng mới, không cliché, unexpected humor",
    for_families: ["Comedy"],
  },
  character_comedy: {
    key:         "character_comedy",
    label:       "Hài kịch nhân vật",
    label_en:    "Character Comedy",
    description: "Nhân vật hài hước, running gags, comedic archetypes",
    for_families: ["Comedy"],
  },
  wordplay_translation: {
    key:         "wordplay_translation",
    label:       "Chơi chữ & Dịch thuật",
    label_en:    "Wordplay & Translation",
    description: "Quality translation, puns, double meanings, cultural jokes",
    for_families: ["Comedy"],
  },

  // ─── Fantasy-SciFi ─────────────────────────────────────────────────────────
  magic_system: {
    key:         "magic_system",
    label:       "Hệ thống phép thuật",
    label_en:    "Magic/Ability System",
    description: "Rõ ràng, thú vị, balanced, creative limitations",
    for_families: ["Fantasy-SciFi"],
  },
  technology_logic: {
    key:         "technology_logic",
    label:       "Yếu tố khoa học",
    label_en:    "Technology & Logic",
    description: "Accuracy, futuristic logic, internal consistency",
    for_families: ["Fantasy-SciFi"],
  },
  mythology_lore: {
    key:         "mythology_lore",
    label:       "Thần thoại & Lore",
    label_en:    "Mythology & Lore",
    description: "Độ sâu thế giới quan, Easter eggs, lore consistency",
    for_families: ["Fantasy-SciFi"],
  },

  // ─── Drama-SliceOfLife ─────────────────────────────────────────────────────
  narrative_depth: {
    key:         "narrative_depth",
    label:       "Chiều sâu câu chuyện",
    label_en:    "Narrative Depth",
    description: "Thông điệp, ý nghĩa ẩn, underlying themes",
    for_families: ["Drama-SliceOfLife"],
  },
  relatability: {
    key:         "relatability",
    label:       "Tính liên quan",
    label_en:    "Relatability",
    description: "Gần gũi, thực tế, đời thường, everyday appeal",
    for_families: ["Drama-SliceOfLife"],
  },

  // ─── Art-Heavy ─────────────────────────────────────────────────────────────
  line_quality: {
    key:         "line_quality",
    label:       "Chất lượng nét vẽ",
    label_en:    "Line Quality",
    description: "Độ mượt, độ đậm, consistency, clean lines",
    for_families: ["Art-Heavy"],
  },
  color_harmony: {
    key:         "color_harmony",
    label:       "Hài hòa màu sắc",
    label_en:    "Color Harmony",
    description: "Phối màu, shading, lighting, color theory",
    for_families: ["Art-Heavy"],
  },
  splash_pages: {
    key:         "splash_pages",
    label:       "Trang đặc biệt",
    label_en:    "Splash Pages",
    description: "Chất lượng trang nổi bật, dramatic spreads",
    for_families: ["Art-Heavy", "Action-Adventure"],
  },
  visual_expression: {
    key:         "visual_expression",
    label:       "Biểu đạt hình ảnh",
    label_en:    "Visual Expression",
    description: "Kể chuyện không cần lời, visual storytelling",
    for_families: ["Art-Heavy", "Horror-Suspense"],
  },

  // ─── Mature-Adult ─────────────────────────────────────────────────────────
  maturity_handling: {
    key:         "maturity_handling",
    label:       "Xử lý nội dung trưởng thành",
    label_en:    "Maturity Handling",
    description: "Tasteful, artistic intent, không gratuitous",
    for_families: ["Mature-Adult"],
  },
  character_complexity: {
    key:         "character_complexity",
    label:       "Phức tạp nhân vật",
    label_en:    "Character Complexity",
    description: "Anti-hero, morally gray, nuanced characters",
    for_families: ["Mature-Adult"],
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
// Format mỗi ô: { story, art, panel, pacing, color, extensions: [] }
// extensions: mảng { key, weight } cho các extension criteria
// null → không phù hợp / không accept submission

const WEIGHT_MATRIX = {
  "Action-Adventure": {
    "All ages":       { story: 15, art: 20, panel: 15, pacing: 25, color: 15, extensions: [
      { key: "world_building",     weight: 10 },
      { key: "stakes_tension",     weight: 10 },
    ]},
    "Teens 13+":      { story: 20, art: 20, panel: 20, pacing: 25, color: 15, extensions: [
      { key: "action_choreography", weight: 15 },
      { key: "world_building",     weight: 10 },
      { key: "stakes_tension",     weight: 10 },
    ]},
    "Mature 17+":    { story: 20, art: 20, panel: 20, pacing: 20, color: 20, extensions: [
      { key: "action_choreography", weight: 15 },
      { key: "fight_impact",        weight: 10 },
      { key: "stakes_tension",      weight: 10 },
    ]},
    "Adults Only 18+":{ story: 20, art: 15, panel: 20, pacing: 20, color: 15, extensions: [
      { key: "action_choreography", weight: 15 },
      { key: "fight_impact",        weight: 10 },
      { key: "world_building",      weight: 10 },
      { key: "stakes_tension",      weight: 10 },
    ]},
  },
  "Romance-Lifestyle": {
    "All ages":       { story: 20, art: 15, panel: 10, pacing: 20, color: 10, extensions: [
      { key: "character_development", weight: 15 },
      { key: "emotional_resonance",  weight: 10 },
    ]},
    "Teens 13+":      { story: 25, art: 15, panel: 10, pacing: 15, color: 10, extensions: [
      { key: "character_development", weight: 15 },
      { key: "emotional_resonance",  weight: 10 },
      { key: "romantic_tension",     weight: 10 },
    ]},
    "Mature 17+":    { story: 25, art: 15, panel: 10, pacing: 10, color: 15, extensions: [
      { key: "character_development", weight: 15 },
      { key: "emotional_resonance",  weight: 15 },
      { key: "romantic_tension",     weight: 10 },
    ]},
    "Adults Only 18+":{ story: 20, art: 15, panel: 10, pacing: 10, color: 20, extensions: [
      { key: "character_development", weight: 15 },
      { key: "emotional_resonance",  weight: 15 },
      { key: "romantic_tension",     weight: 15 },
    ]},
  },
  "Drama-SliceOfLife": {
    "All ages":       { story: 20, art: 20, panel: 10, pacing: 15, color: 15, extensions: [
      { key: "character_development", weight: 10 },
      { key: "emotional_resonance",  weight: 10 },
    ]},
    "Teens 13+":      { story: 25, art: 15, panel: 10, pacing: 15, color: 10, extensions: [
      { key: "character_development", weight: 15 },
      { key: "emotional_resonance",  weight: 10 },
      { key: "relatability",          weight: 10 },
    ]},
    "Mature 17+":    { story: 25, art: 15, panel: 10, pacing: 10, color: 15, extensions: [
      { key: "character_development", weight: 15 },
      { key: "emotional_resonance",  weight: 15 },
      { key: "narrative_depth",       weight: 10 },
    ]},
    "Adults Only 18+":{ story: 20, art: 15, panel: 10, pacing: 10, color: 20, extensions: [
      { key: "character_development", weight: 15 },
      { key: "emotional_resonance",  weight: 20 },
      { key: "narrative_depth",       weight: 10 },
    ]},
  },
  "Horror-Suspense": {
    "All ages":       null, // Không phù hợp
    "Teens 13+":      { story: 20, art: 15, panel: 15, pacing: 20, color: 10, extensions: [
      { key: "atmosphere",       weight: 10 },
      { key: "pacing_horror",   weight: 10 },
    ]},
    "Mature 17+":    { story: 15, art: 15, panel: 15, pacing: 20, color: 10, extensions: [
      { key: "atmosphere",       weight: 15 },
      { key: "pacing_horror",   weight: 10 },
      { key: "mystery_setup",   weight: 10 },
    ]},
    "Adults Only 18+":{ story: 15, art: 15, panel: 15, pacing: 20, color: 10, extensions: [
      { key: "atmosphere",       weight: 15 },
      { key: "fear_impact",      weight: 10 },
      { key: "pacing_horror",   weight: 10 },
      { key: "mystery_setup",   weight: 10 },
    ]},
  },
  "Comedy": {
    "All ages":       { story: 15, art: 15, panel: 15, pacing: 15, color: 15, extensions: [
      { key: "comedy_timing",        weight: 15 },
      { key: "comedy_originality",   weight: 10 },
    ]},
    "Teens 13+":      { story: 20, art: 15, panel: 15, pacing: 15, color: 10, extensions: [
      { key: "comedy_timing",        weight: 15 },
      { key: "comedy_originality",  weight: 10 },
      { key: "character_comedy",    weight: 10 },
    ]},
    "Mature 17+":    { story: 20, art: 15, panel: 15, pacing: 15, color: 10, extensions: [
      { key: "comedy_timing",        weight: 15 },
      { key: "comedy_originality",  weight: 10 },
      { key: "wordplay_translation",weight: 10 },
    ]},
    "Adults Only 18+":{ story: 20, art: 15, panel: 15, pacing: 15, color: 10, extensions: [
      { key: "comedy_timing",        weight: 15 },
      { key: "comedy_originality",  weight: 10 },
      { key: "character_comedy",    weight: 10 },
      { key: "wordplay_translation",weight: 10 },
    ]},
  },
  "Fantasy-SciFi": {
    "All ages":       { story: 15, art: 20, panel: 15, pacing: 25, color: 10, extensions: [
      { key: "world_building",      weight: 10 },
      { key: "mystery_setup",      weight: 5 },
    ]},
    "Teens 13+":      { story: 20, art: 20, panel: 15, pacing: 25, color: 10, extensions: [
      { key: "world_building",      weight: 10 },
      { key: "stakes_tension",      weight: 10 },
      { key: "mythology_lore",      weight: 5 },
    ]},
    "Mature 17+":    { story: 20, art: 20, panel: 15, pacing: 20, color: 10, extensions: [
      { key: "world_building",      weight: 10 },
      { key: "magic_system",       weight: 10 },
      { key: "stakes_tension",     weight: 10 },
    ]},
    "Adults Only 18+":{ story: 20, art: 15, panel: 15, pacing: 20, color: 15, extensions: [
      { key: "world_building",      weight: 10 },
      { key: "magic_system",       weight: 10 },
      { key: "technology_logic",   weight: 10 },
      { key: "mythology_lore",     weight: 5 },
    ]},
  },
  "Art-Heavy": {
    "All ages":       { story: 10, art: 25, panel: 15, pacing: 15, color: 25, extensions: [
      { key: "line_quality",         weight: 10 },
    ]},
    "Teens 13+":      { story: 15, art: 25, panel: 15, pacing: 15, color: 20, extensions: [
      { key: "line_quality",         weight: 10 },
      { key: "color_harmony",        weight: 5 },
    ]},
    "Mature 17+":    { story: 15, art: 25, panel: 15, pacing: 15, color: 20, extensions: [
      { key: "line_quality",         weight: 10 },
      { key: "color_harmony",        weight: 5 },
      { key: "splash_pages",        weight: 5 },
    ]},
    "Adults Only 18+":{ story: 15, art: 25, panel: 15, pacing: 15, color: 20, extensions: [
      { key: "line_quality",         weight: 10 },
      { key: "color_harmony",        weight: 5 },
      { key: "splash_pages",        weight: 5 },
      { key: "visual_expression",   weight: 5 },
    ]},
  },
  "Mature-Adult": {
    "All ages":       null,
    "Teens 13+":      null,
    "Mature 17+":    { story: 20, art: 15, panel: 15, pacing: 20, color: 15, extensions: [
      { key: "emotional_resonance",   weight: 10 },
      { key: "maturity_handling",    weight: 5 },
    ]},
    "Adults Only 18+":{ story: 25, art: 15, panel: 10, pacing: 15, color: 20, extensions: [
      { key: "emotional_resonance",   weight: 15 },
      { key: "character_complexity", weight: 10 },
      { key: "maturity_handling",    weight: 5 },
    ]},
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

  // Xử lý extensions (mảng thay vì 1 extension)
  const extensions = [];
  if (entry.extensions && entry.extensions.length > 0) {
    entry.extensions.forEach((ext, index) => {
      const extDef = EXTENSION_CRITERIA[ext.key];
      if (extDef && ext.weight > 0) {
        weights[ext.key] = ext.weight;
        criteria.push({
          key:         extDef.key,
          label:       extDef.label,
          description: extDef.description,
          weight:      ext.weight,
          order:       6 + index,
        });
        extensions.push({
          key:         extDef.key,
          label:       extDef.label,
          description: extDef.description,
          weight:      ext.weight,
        });
      }
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
    has_extensions: extensions.length > 0,
    extensions,
  };
}

// ─── Get Default Rubric (equal weights) ───────────────────────────────────────
function getDefaultRubric() {
  const entry = { story: 20, art: 20, panel: 20, pacing: 20, color: 20, extensions: [] };
  return buildRubricEntry("__default__", "All ages", entry);
}

// ─── Normalize genre key (trim + lowercase) ───────────────────────────────────
function normalizeGenreKey(genre) {
  if (typeof genre !== "string") return "";
  return genre.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Find family for a single genre (case-insensitive + trim) ─────────────────
// Returns { family, matched_genre } — matched_genre là key gốc đã matched
function findFamilyForGenre(genre) {
  if (typeof genre !== "string" || !genre.trim()) {
    return { family: null, matched_genre: null, normalized: "" };
  }
  const original = genre.trim();

  // 1. Exact match (nhanh nhất, tránh overhead)
  if (GENRE_TO_FAMILY[original]) {
    return { family: GENRE_TO_FAMILY[original], matched_genre: original, normalized: normalizeGenreKey(original) };
  }

  // 2. Case-insensitive match (handle "hành động" vs "Hành Động")
  const normalized = normalizeGenreKey(original);
  for (const [key, family] of Object.entries(GENRE_TO_FAMILY)) {
    if (normalizeGenreKey(key) === normalized) {
      return { family, matched_genre: key, normalized };
    }
  }

  return { family: null, matched_genre: null, normalized };
}

// ─── Resolve all families from multi-genre array ──────────────────────────────
// Multi-genre: 1 series có thể thuộc nhiều families (vd ["Hành Động", "Lãng Mạn"])
// Returns unique families theo thứ tự gặp trong input.
function getAllFamiliesForGenres(genres) {
  if (!Array.isArray(genres) || genres.length === 0) return [];

  const seen = new Set();
  const families = [];
  const mapping = [];

  for (const g of genres) {
    const { family, matched_genre, normalized } = findFamilyForGenre(g);
    mapping.push({
      input_genre:    g,
      matched_genre:  matched_genre,
      normalized,
      family,
    });
    if (family && !seen.has(family)) {
      seen.add(family);
      families.push(family);
    }
  }

  return { families, mapping };
}

// ─── Validate age rating value ─────────────────────────────────────────────────
// Returns { valid, normalized, suggested } 
// normalized: key chuẩn trong WEIGHT_MATRIX nếu match
function validateAgeRating(ageRating) {
  if (typeof ageRating !== "string" || !ageRating.trim()) {
    return { valid: false, normalized: null, suggested: "All ages" };
  }
  const trimmed = ageRating.trim();

  // Exact match
  if (WEIGHT_MATRIX_AGE_KEYS.includes(trimmed)) {
    return { valid: true, normalized: trimmed, suggested: trimmed };
  }

  // Case-insensitive match
  const normalized = trimmed.toLowerCase();
  for (const key of WEIGHT_MATRIX_AGE_KEYS) {
    if (key.toLowerCase() === normalized) {
      return { valid: true, normalized: key, suggested: key };
    }
  }

  // Common abbreviations / variations
  const VARIANTS = {
    "all":          "All ages",
    "13+":          "Teens 13+",
    "teen":         "Teens 13+",
    "teens":        "Teens 13+",
    "17+":          "Mature 17+",
    "mature":       "Mature 17+",
    "18+":          "Adults Only 18+",
    "adults":       "Adults Only 18+",
    "adult":        "Adults Only 18+",
  };
  for (const [variant, canonical] of Object.entries(VARIANTS)) {
    if (normalized === variant || normalized === variant.replace(/\s+/g, "_") || normalized === variant.replace(/\+/g, "")) {
      return { valid: false, normalized: null, suggested: canonical };
    }
  }

  return { valid: false, normalized: null, suggested: "All ages" };
}

// Computed once at module load — keys ở tất cả age_ratings trong matrix
const WEIGHT_MATRIX_AGE_KEYS = Array.from(
  new Set(
    Object.values(WEIGHT_MATRIX).flatMap((ages) => Object.keys(ages))
  )
);

// ─── Validate series for rubric suggestion ────────────────────────────────────
// Returns { valid, errors[], warnings[], can_suggest, normalized: {...} }
function validateSeriesForRubric(series) {
  const errors = [];
  const warnings = [];
  const normalized = {
    raw_genres:      Array.isArray(series?.genre) ? series.genre : [],
    raw_age_rating:  series?.age_rating || null,
    matched_genres:  [],
    matched_families: [],
    unmatched_genres: [],
    normalized_age_rating: null,
  };

  // 1. Validate genre
  if (!Array.isArray(series?.genre) || series.genre.length === 0) {
    errors.push({
      code:    "NO_GENRE",
      message: "Series chưa có genre — BE không thể gợi ý rubric theo thể loại.",
    });
  } else {
    for (const g of series.genre) {
      const { family, matched_genre, normalized: gNorm } = findFamilyForGenre(g);
      if (family) {
        normalized.matched_genres.push({ input: g, matched: matched_genre, family });
        if (!normalized.matched_families.includes(family)) {
          normalized.matched_families.push(family);
        }
      } else {
        normalized.unmatched_genres.push({ input: g, normalized: gNorm });
      }
    }

    if (normalized.matched_families.length === 0) {
      errors.push({
        code:    "NO_MATCHING_FAMILY",
        message: `Không genre nào khớp với ma trận rubric: ${normalized.unmatched_genres.map((u) => u.input).join(", ")}`,
      });
    } else if (normalized.unmatched_genres.length > 0) {
      warnings.push({
        code:    "PARTIAL_GENRE_MATCH",
        message: `Một số genre chưa có trong ma trận: ${normalized.unmatched_genres.map((u) => u.input).join(", ")}. Sẽ dùng các genre còn lại.`,
        unmatched: normalized.unmatched_genres,
      });
    }
  }

  // 2. Validate age_rating
  const ageCheck = validateAgeRating(series?.age_rating);
  if (!ageCheck.valid) {
    errors.push({
      code:    "INVALID_AGE_RATING",
      message: `age_rating "${series?.age_rating}" không hợp lệ. Gợi ý dùng: "${ageCheck.suggested}".`,
      suggested: ageCheck.suggested,
    });
  } else if (ageCheck.normalized !== series?.age_rating) {
    warnings.push({
      code:    "AGE_RATING_NORMALIZED",
      message: `age_rating "${series?.age_rating}" đã được chuẩn hóa thành "${ageCheck.normalized}".`,
    });
  }
  normalized.normalized_age_rating = ageCheck.normalized;

  // 3. Validate family × age_rating combination
  if (normalized.matched_families.length > 0 && ageCheck.normalized) {
    const invalidCombos = [];
    for (const fam of normalized.matched_families) {
      const entry = WEIGHT_MATRIX[fam]?.[ageCheck.normalized];
      if (!entry) {
        invalidCombos.push({ family: fam, age_rating: ageCheck.normalized });
      }
    }
    if (invalidCombos.length === normalized.matched_families.length) {
      // All families × age_rating đều null → không accept submission
      errors.push({
        code:    "ALL_FAMILIES_UNSUPPORTED_FOR_AGE",
        message: `Không family nào trong [${normalized.matched_families.join(", ")}] hỗ trợ age_rating "${ageCheck.normalized}". EB cần chọn rubric khác.`,
        invalid_combinations: invalidCombos,
      });
    }
  }

  return {
    valid:        errors.length === 0,
    can_suggest:  errors.length === 0,
    errors,
    warnings,
    normalized,
  };
}

// ─── Get Suggested Rubric for a Series ───────────────────────────────────────
function getSuggestedRubricForSeries(series) {
  const validation = validateSeriesForRubric(series);

  // Không thể gợi ý → fallback default + reason
  if (!validation.can_suggest) {
    const primaryError = validation.errors[0];
    return {
      ...getDefaultRubric(),
      suggested: false,
      reason: primaryError.message,
      validation,
    };
  }

  const { matched_families, normalized_age_rating, raw_genres } = validation.normalized;

  // Primary suggestion: family[0] × age_rating
  const primaryFamily = matched_families[0];
  const primaryEntry = WEIGHT_MATRIX[primaryFamily]?.[normalized_age_rating];

  if (!primaryEntry) {
    // Family đầu hợp lệ nhưng age không khớp → fallback default
    return {
      ...getDefaultRubric(),
      suggested: false,
      reason: `Family "${primaryFamily}" không hỗ trợ age_rating "${normalized_age_rating}"`,
      validation,
    };
  }

  const primaryRubric = buildRubricEntry(primaryFamily, normalized_age_rating, primaryEntry);

  // Same-family alternatives: cùng family, các age_rating khác
  const sameFamilyAlternatives = listRubricsForFamily(primaryFamily)
    .filter((r) => r.id !== primaryRubric.id);

  // Cross-family alternatives: các family khác × cùng age_rating
  const crossFamilyAlternatives = [];
  for (const fam of matched_families.slice(1)) {
    const entry = WEIGHT_MATRIX[fam]?.[normalized_age_rating];
    if (entry) {
      crossFamilyAlternatives.push(buildRubricEntry(fam, normalized_age_rating, entry));
    }
  }

  return {
    ...primaryRubric,
    suggested: true,
    source_genres:    raw_genres,
    source_family:   primaryFamily,
    same_family_alternatives:    sameFamilyAlternatives,
    cross_family_alternatives:   crossFamilyAlternatives,
    validation,
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
  normalizeGenreKey,
  findFamilyForGenre,
  getAllFamiliesForGenres,
  validateAgeRating,
  validateSeriesForRubric,
  checkAgeSafety,
  validateContentLevels,
  computeWeightedCouncilAverage,
  computeMemberWeightedScore,
  normalizeScoresToWeights,
};
