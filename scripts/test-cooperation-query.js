// Mock cooperation query test — không cần MongoDB
const mongoose = require("mongoose");

// Tạo mock Cooperation collection có sẵn docs
const docs = [
  {
    _id: "c1",
    mangaka_id: { toString: () => "M1" },
    assistant_id: { toString: () => "A1" },
    agreed_at: new Date("2026-06-01"),
    series_id: null,
  },
  {
    _id: "c2",
    mangaka_id: { toString: () => "M1" },
    assistant_id: { toString: () => "A2" },
    agreed_at: new Date("2026-06-01"),
    series_id: { toString: () => "S1" },
  },
];

function findOne(query) {
  return Promise.resolve(docs.find((d) => {
    if (query.mangaka_id !== d.mangaka_id.toString()) return false;
    if (query.assistant_id !== d.assistant_id.toString()) return false;
    if (!query.agreed_at || query.agreed_at.$ne === undefined) return false;
    const hasAgreed = d.agreed_at !== null && d.agreed_at !== undefined;
    if (query.agreed_at.$ne !== null && hasAgreed === false) return false;
    if (!query.$or) return true;
    return query.$or.some((cond) => {
      if ("series_id" in cond) {
        if (cond.series_id === null) {
          return d.series_id === null;
        }
        return d.series_id && d.series_id.toString() === cond.series_id;
      }
      return false;
    });
  }) || null);
}

async function testCase(name, mangakaId, assistantId, chapterSeriesId, expectedId) {
  const cooperation = await findOne({
    mangaka_id: mangakaId,
    assistant_id: assistantId,
    agreed_at: { $ne: null },
    $or: [
      { series_id: chapterSeriesId },
      { series_id: null },
    ],
  });
  const got = cooperation ? cooperation._id : null;
  const ok = got === expectedId;
  console.log(`${ok ? "✅" : "❌"} ${name}`);
  console.log(`     expected: ${expectedId} | got: ${got}`);
  return ok;
}

(async () => {
  let pass = 0, fail = 0;
  const cases = [
    ["Cooperation toàn cục (series_id=null) match chapter ở series khác", "M1", "A1", "S99", "c1"],
    ["Cooperation cụ thể series S1 match chapter ở S1", "M1", "A2", "S1", "c2"],
    ["Cooperation cụ thể series S1 KHÔNG match chapter ở S2", "M1", "A2", "S2", null],
    ["Mangaka khác — không có cooperation", "M99", "A1", "S1", null],
    ["Assistant khác — không có cooperation", "M1", "A99", "S1", null],
  ];
  for (const [name, m, a, s, exp] of cases) {
    const ok = await testCase(name, m, a, s, exp);
    ok ? pass++ : fail++;
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})();
