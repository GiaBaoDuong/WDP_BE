// scripts/test-rubric-suggest.js
// Test các case edge của getSuggestedRubricForSeries
const {
  getSuggestedRubricForSeries,
  findFamilyForGenre,
  normalizeGenreKey,
  validateAgeRating,
  validateSeriesForRubric,
  getAllFamiliesForGenres,
} = require("../utils/ebScoringRubric");

const testCases = [
  {
    name: "1. Exact match — single genre, exact age",
    series: { genre: ["Hành Động"], age_rating: "Teens 13+" },
    expectFamily: "Action-Adventure",
    expectSuggested: true,
  },
  {
    name: "2. Case-insensitive — lowercase genre",
    series: { genre: ["hành động"], age_rating: "Teens 13+" },
    expectFamily: "Action-Adventure",
    expectSuggested: true,
  },
  {
    name: "3. Multi-genre — 2 families match",
    series: { genre: ["Hành Động", "Lãng Mạn"], age_rating: "Mature 17+" },
    expectFamily: "Action-Adventure",   // primary = first in array
    expectSuggested: true,
    expectCrossFamily: "Romance-Lifestyle",
  },
  {
    name: "4. Unmatched genre — falls back to default",
    series: { genre: ["Unknown Genre XYZ"], age_rating: "All ages" },
    expectFamily: "__default__",
    expectSuggested: false,
  },
  {
    name: "5. No genre — error",
    series: { genre: [], age_rating: "All ages" },
    expectFamily: "__default__",
    expectSuggested: false,
  },
  {
    name: "6. Invalid age_rating — error with suggestion",
    series: { genre: ["Hài Hước"], age_rating: "13+" },
    expectFamily: "__default__",
    expectSuggested: false,
  },
  {
    name: "7. Family × age combo rejected — Horror × All ages (null)",
    series: { genre: ["Kinh Dị"], age_rating: "All ages" },
    expectFamily: "__default__",
    expectSuggested: false,
  },
  {
    name: "8. Multi-genre — Romance + Drama slice-of-life",
    series: { genre: ["Lãng Mạn", "Slice of life"], age_rating: "Teens 13+" },
    expectFamily: "Romance-Lifestyle",
    expectSuggested: true,
    expectCrossFamily: "Drama-SliceOfLife",
  },
  {
    name: "9. Family with no valid age for the given — fallback",
    series: { genre: ["Mature"], age_rating: "All ages" },
    expectFamily: "__default__",
    expectSuggested: false,
  },
];

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  console.log(`\n──── ${tc.name} ────`);
  console.log(`  Input:`, JSON.stringify(tc.series));

  const result = getSuggestedRubricForSeries(tc.series);

  console.log(`  Family: ${result.family}`);
  console.log(`  Suggested: ${result.suggested}`);
  if (!result.suggested) console.log(`  Reason: ${result.result_reason || result.reason}`);
  console.log(`  Same-family alts: ${(result.same_family_alternatives || []).length}`);
  console.log(`  Cross-family alts: ${(result.cross_family_alternatives || []).length}`);

  const crossFamilyIds = (result.cross_family_alternatives || []).map((r) => r.family);
  const ok =
    result.family === tc.expectFamily &&
    result.suggested === tc.expectSuggested &&
    (!tc.expectCrossFamily || crossFamilyIds.includes(tc.expectCrossFamily));

  if (ok) {
    passed++;
    console.log(`  ✅ PASS`);
  } else {
    failed++;
    console.log(`  ❌ FAIL — expected family=${tc.expectFamily}, suggested=${tc.expectSuggested}`);
  }
}

console.log(`\n──── Tests: ${passed} passed, ${failed} failed ────`);

// Helper unit tests
console.log(`\n──── Helper tests ────`);
const helperTests = [
  ["findFamilyForGenre('Hành Động')", findFamilyForGenre("Hành Động").family, "Action-Adventure"],
  ["findFamilyForGenre('hành động')", findFamilyForGenre("hành động").family, "Action-Adventure"],
  ["findFamilyForGenre('Slice of life')", findFamilyForGenre("Slice of life").family, "Drama-SliceOfLife"],
  ["findFamilyForGenre('  Hành Động  ')", findFamilyForGenre("  Hành Động  ").family, "Action-Adventure"],
  ["findFamilyForGenre('XYZ')", findFamilyForGenre("XYZ").family, null],
  ["normalizeGenreKey('  HÀNH ĐỘNG  ')", normalizeGenreKey("  HÀNH ĐỘNG  "), "hành động"],
  ["validateAgeRating('Teens 13+')", validateAgeRating("Teens 13+").normalized, "Teens 13+"],
  ["validateAgeRating('13+')", validateAgeRating("13+").suggested, "Teens 13+"],
  ["validateAgeRating('mature 17+')", validateAgeRating("mature 17+").normalized, "Mature 17+"],
  ["getAllFamiliesForGenres(['Hành Động','Lãng Mạn','hành động'])",
    JSON.stringify(getAllFamiliesForGenres(["Hành Động", "Lãng Mạn", "hành động"]).families),
    JSON.stringify(["Action-Adventure", "Romance-Lifestyle"])],
];

for (const [label, actual, expected] of helperTests) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✅" : "❌"} ${label} = ${JSON.stringify(actual)} (expect ${JSON.stringify(expected)})`);
}

process.exit(failed === 0 ? 0 : 1);
