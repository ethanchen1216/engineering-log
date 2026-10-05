// 本機 UI 測試伺服器：未修改的 index.html ＋ 真正的 Worker（Firestore 模式）＋ 模擬的 Firestore / Sheets
// 用法：node tests/dev-server.js [port]   → 開啟 http://localhost:<port>/
// 測試 PIN：主管 222222、師傅 111111（只存在於本機模擬環境）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";
import { createWorld, todayTaipei } from "./helpers/world.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 8765;
const ORIGIN = `http://localhost:${PORT}`;

const world = await createWorld({
  provider: "gas",
  seed: [
    { id: "ID_TODAY", project: "A棟新建工程", date: todayTaipei(), workType: "鋼筋、水電", workerCount: "鋼筋:3人、水電:2人", content: "今天的日誌" },
    { id: "ID_SEP", project: "A棟新建工程", date: "2026-09-15", workType: "鋼筋", workerCount: "鋼筋:5人", content: "九月" },
    { id: "ID_MUD", project: "B棟裝修", date: "2026-09-20", workCategory: "裝修", workType: "泥作/貼磚、泥作/打底、油漆", workerCount: "泥作/貼磚:2人、泥作/打底:1人、油漆:4人", content: "" },
  ],
});
world.env.ALLOWED_ORIGINS = ORIGIN;
const admin = await world.login("admin");
await world.call("POST", "/admin/migrate", { token: admin });
world.env.DATA_PROVIDER = "firestore";
globalThis.__world = world;

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace(/const API_BASE = "[^"]+"/, `const API_BASE = "${ORIGIN}/api"`);

http.createServer(async (req, res) => {
  if (!req.url.startsWith("/api/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (req.url === "/api/__state") {
    // 測試用：查看 Firestore 與 Sheets 目前內容
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      firestore: world.fs.list("dailyLogs").map(([n, d]) => ({ id: n.split("/").pop(), content: d.fields.content.stringValue, workerCount: d.fields.workerCount.stringValue })),
      queue: world.fs.list("backupQueue").length,
      sheets: world.gas.sheets.map(s => ({ name: s.name, rows: s.getDataRange().getValues().slice(1).map(r => ({ id: String(r[7]), content: String(r[6]), version: r[9] || 0 })) })),
    }));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`https://worker.test${req.url.slice(4)}`, {
    method: req.method,
    headers: { ...req.headers },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
  const response = await worker.fetch(request, world.env, world.ctx());
  await world.flush();
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`UI test server: ${ORIGIN}/  (Firestore 模式，主管 222222、師傅 111111)`));
