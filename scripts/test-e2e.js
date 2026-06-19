// scripts/test-e2e.js — chạy 1 phát duy nhất: register→login→create series→upload chapter→verify assistant nhận đủ
const http = require("http");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const BASE = `http://localhost:${process.env.PORT || 3000}`;

// Ảnh PNG 1x1 base64
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==";
const tmpImg = path.join(__dirname, "_e2e.png");
fs.writeFileSync(tmpImg, Buffer.from(PNG_B64, "base64"));

let pass = 0, fail = 0;
const log = (ok, msg) => { console.log(`${ok ? "[OK]  " : "[FAIL]"} ${msg}`); if (ok) pass++; else fail++; };

function req(method, urlPath, { token, json, multipart, file } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const Boundary = "----E2E" + Date.now();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    let body;
    if (multipart) {
      headers["Content-Type"] = `multipart/form-data; boundary=${Boundary}`;
      const parts = [];
      const add = (name, val) => {
        parts.push(Buffer.from(`--${Boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
      };
      for (const [k, v] of Object.entries(multipart.fields || {})) add(k, v);
      if (file) {
        parts.push(Buffer.from(`--${Boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`));
        parts.push(fs.readFileSync(file.path));
        parts.push(Buffer.from(`\r\n`));
      }
      parts.push(Buffer.from(`--${Boundary}--\r\n`));
      body = Buffer.concat(parts);
    } else if (json) {
      headers["Content-Type"] = "application/json";
      body = Buffer.from(JSON.stringify(json));
    }
    if (body) headers["Content-Length"] = body.length;

    const r = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let ch = [];
        res.on("data", (c) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString();
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, data: null, raw }); }
        });
      });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tag = `e2e_${Date.now()}`;
  const MG = { username: `${tag}_mg`, password: "test123456", full_name: "MG", email: `${tag}_mg@x.com`, phoneNumber: "0901", role: "Mangaka" };
  const AS = { username: `${tag}_as`, password: "test123456", full_name: "AS", email: `${tag}_as@x.com`, phoneNumber: "0902", role: "Assistant" };

  // 1) Register
  for (const [name, u] of [["Mangaka", MG], ["Assistant", AS]]) {
    const r = await req("POST", "/auth/register", { json: u });
    log([201, 409].includes(r.status), `Register ${name} (${r.status})`);
  }

  // 2) Login
  const mgR = await req("POST", "/auth/login", { json: { username: MG.username, password: MG.password } });
  const asR = await req("POST", "/auth/login", { json: { username: AS.username, password: AS.password } });
  log(mgR.status === 200 && mgR.data.token, `Login Mangaka → token ok`);
  log(asR.status === 200 && asR.data.token, `Login Assistant → token ok`);
  const mgToken = mgR.data.token;
  const asToken = asR.data.token;
  const asId = asR.data.user.userId;

  // 3) Mangaka tạo series
  const seriesR = await req("POST", "/series", { json: { name: `${tag}_series`, description: "test" }, token: mgToken });
  log(seriesR.status === 201 && seriesR.data.data?._id, `POST /series → ${seriesR.data.data?._id}`);
  const seriesId = seriesR.data.data._id;

  // 4) POST /chapters multipart — 1 lần tạo chapter + 1 page + 1 task + 1 note
  const chR = await req("POST", "/chapters", {
    token: mgToken,
    multipart: {
      fields: {
        series_id: seriesId,
        chapter_number: "1",
        title: "Ch1",
        "pages[0].note": "tô shading khuôn mặt",
        "pages[0].work_type": "shading",
        "pages[0].assigned_to": asId,
        "pages[0].x": "10",
        "pages[0].y": "20",
        "pages[0].w": "30",
        "pages[0].h": "40",
      },
    },
    file: { field: "pages", path: tmpImg },
  });
  log(chR.status === 201, `POST /chapters (multipart) → ${chR.status}`);
  if (chR.status !== 201) { console.log(JSON.stringify(chR.data, null, 2)); return; }
  const chapterId = chR.data.data._id;
  const pageId = chR.data.pages?.[0]?._id;
  const taskId = chR.data.tasks?.[0]?._id;
  log(!!pageId, `Page created: ${pageId}`);
  log(!!taskId, `Task created: ${taskId}`);
  log(!!chR.data.pages?.[0]?.original_image_url?.startsWith("https://res.cloudinary.com/"), `Page.original_image_url = ${chR.data.pages?.[0]?.original_image_url?.slice(0, 60)}...`);

  // 5) Assistant GET /tasks/my-assignments
  const listR = await req("GET", "/tasks/my-assignments", { token: asToken });
  const myTask = listR.data.data?.find((t) => t._id === taskId);
  log(!!myTask, `GET /tasks/my-assignments có task của assistant (total=${listR.data.data?.length})`);
  log(!!myTask?.page_id?.original_image_url, `  → page.original_image_url có: ${myTask?.page_id?.original_image_url?.slice(0, 60)}...`);
  log(myTask?.region?.x === 10 && myTask?.region?.y === 20 && myTask?.region?.width === 30 && myTask?.region?.height === 40, `  → region = ${JSON.stringify(myTask?.region)}`);
  log(myTask?.note_ids?.[0]?.text === "tô shading khuôn mặt", `  → note.text = "${myTask?.note_ids?.[0]?.text}"`);
  log(myTask?.note_ids?.[0]?.x === 10, `  → note.x = ${myTask?.note_ids?.[0]?.x}`);

  // 6) GET /tasks/:id
  const detailR = await req("GET", `/tasks/${taskId}`, { token: asToken });
  log(detailR.status === 200, `GET /tasks/${taskId} → 200`);
  log(!!detailR.data.data?.page_id?.original_image_url, `  detail.page.original_image_url OK`);

  // 7) GET /chapters/:id
  const chDetailR = await req("GET", `/chapters/${chapterId}`, { token: asToken });
  const pageInChapter = chDetailR.data.data?.pages?.[0];
  log(!!pageInChapter, `GET /chapters/:id có page`);
  log(!!pageInChapter?.original_image_url, `  page.original_image_url OK`);
  log(pageInChapter?.tasks?.[0]?._id === taskId, `  page.tasks[0]._id = ${pageInChapter?.tasks?.[0]?._id} (match)`);
  log(!!pageInChapter?.tasks?.[0]?.note_ids?.[0]?.text, `  page.tasks[0].note_ids[0].text OK`);

  // 8) Verify URL ảnh accessible
  const url = pageInChapter?.original_image_url || myTask?.page_id?.original_image_url;
  await new Promise((resolve) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, path: u.pathname, method: "HEAD" }, (res) => {
      log(res.statusCode === 200, `HEAD image_url → HTTP ${res.statusCode}`);
      resolve();
    });
    r.on("error", () => { log(false, "HEAD image_url failed"); resolve(); });
    r.end();
  });

  console.log(`\n=== TỔNG: ${pass} pass / ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
