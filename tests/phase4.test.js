// Phase 4 回歸測試：node --test tests/
// 真正的 Worker（worker/src）與 GAS（google-apps-script.js）程式碼，搭配模擬的 Sheets / Firestore REST / Durable Object
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld, todayTaipei } from "./helpers/world.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIELDS = ["id", "date", "project", "weather", "workCategory", "workType", "workerCount", "content", "ts"];
const TODAY = todayTaipei();
const SEED = [
  { id: "ID_TODAY", project: "A棟新建工程", date: TODAY, workType: "鋼筋、水電", workerCount: "鋼筋:3人、水電:2人", content: "今天的日誌" },
  { id: "ID_SEP", project: "A棟新建工程", date: "2026-09-15", workType: "鋼筋", workerCount: "鋼筋:5人", content: "九月" },
  { id: "ID_MUD", project: "B棟裝修", date: "2026-09-20", workCategory: "裝修", workType: "泥作/貼磚、泥作/打底、油漆", workerCount: "泥作/貼磚:2人、泥作/打底:1人、油漆:4人", content: "" },
  { id: "ID_SPECIAL", project: "B棟裝修", date: "2026-09-21", workType: "雜項", workerCount: "雜項", content: '特殊字元 <b>"引號"</b>\n第二行' },
];
const sortById = arr => [...arr].sort((a, b) => a.id.localeCompare(b.id));
const ids = arr => arr.map(l => l.id).sort();

async function migratedWorld(extraSeed = []) {
  const w = await createWorld({ provider: "gas", seed: [...SEED, ...extraSeed] });
  const admin = await w.login("admin");
  const r = await w.call("POST", "/admin/migrate", { token: admin });
  assert.equal(r.body.success, true, JSON.stringify(r.body));
  w.env.DATA_PROVIDER = "firestore";
  return { w, admin, worker: await w.login("worker"), report: r.body.data };
}

function sheetRow(w, project, id) {
  const rows = w.gas.sheetRows(project) || [];
  return rows.find(r => String(r[7]) === id) || null;
}

// ── 遷移 ──
test("migration dry run：只分析、不寫入 Firestore", async () => {
  const w = await createWorld({ provider: "gas", seed: SEED });
  const admin = await w.login("admin");
  const r = await w.call("POST", "/admin/migrate?dryRun=1", { token: admin });
  assert.equal(r.body.success, true);
  const rep = r.body.data;
  assert.equal(rep.dryRun, true);
  assert.equal(rep.sheetsTotal, 4);
  assert.equal(rep.valid, 4);
  assert.equal(rep.inserted, 4);
  assert.equal(w.fs.list("dailyLogs").length, 0);
});

test("migration：未開啟時拒絕；firestore 模式下拒絕寫入（dry run 仍可執行）", async () => {
  const off = await createWorld({ provider: "gas", migration: "false", seed: SEED });
  const r1 = await off.call("POST", "/admin/migrate", { token: await off.login("admin") });
  assert.equal(r1.body.error, "FORBIDDEN");

  const live = await createWorld({ provider: "firestore", seed: SEED });
  const admin = await live.login("admin");
  const r2 = await live.call("POST", "/admin/migrate", { token: admin });
  assert.equal(r2.body.error, "BAD_REQUEST");
  const r3 = await live.call("POST", "/admin/migrate?dryRun=1", { token: admin });
  assert.equal(r3.body.success, true);

  const r4 = await live.call("POST", "/admin/migrate?dryRun=1", { token: await live.login("worker") });
  assert.equal(r4.body.error, "FORBIDDEN");
});

test("migration：原始 ID、idempotent、ts / workerCount / workType 原樣保留、100% MATCH", async () => {
  const { w, admin, report } = await migratedWorld();
  assert.equal(report.inserted, 4);
  const doc = w.fs.get("dailyLogs/ID_MUD").fields;
  assert.equal(doc.workerCount.stringValue, "泥作/貼磚:2人、泥作/打底:1人、油漆:4人");
  assert.equal(doc.workType.stringValue, "泥作/貼磚、泥作/打底、油漆");
  assert.equal(doc.ts.stringValue, "2026-09-20");
  assert.equal(doc.date.stringValue, "2026-09-20");
  assert.equal(doc.createdAt.timestampValue, "2026-09-01T02:00:00.000Z");

  w.env.DATA_PROVIDER = "gas";
  const again = await w.call("POST", "/admin/migrate", { token: admin });
  assert.deepEqual([again.body.data.inserted, again.body.data.updated, again.body.data.unchanged], [0, 0, 4]);

  const cmp = (await w.call("GET", "/admin/compare", { token: admin })).body.data;
  assert.equal(cmp.allMatch, true, JSON.stringify(cmp));
  assert.equal(cmp.MATCH, 4);
});

test("migration：回報缺少 ID、重複 ID、無效日期、儲存格型態警告；未 100% 不算一致", async () => {
  const w = await createWorld({
    provider: "gas",
    seed: [
      ...SEED,
      { id: "", project: "C棟", date: "2026-09-01", content: "沒有 ID" },
      { id: "ID_DUP", project: "C棟", date: "2026-09-02" },
      { id: "ID_DUP", project: "C棟", date: "2026-09-03" },
      { id: "ID_BADDATE", project: "C棟", date: "待定" },
      { id: "ID_NUM", project: "C棟", date: "2026-09-04", content: "50" },
    ],
  });
  const admin = await w.login("admin");
  const rep = (await w.call("POST", "/admin/migrate", { token: admin })).body.data;
  assert.equal(rep.missingId.length, 1);
  assert.equal(rep.duplicates.length, 2);
  assert.deepEqual(rep.invalid.map(i => [i.id, i.reasons]), [["ID_BADDATE", ["INVALID_DATE"]]]);
  assert.ok(rep.warnings.some(x => x.id === "ID_NUM" && x.warning.includes("G 備註 = number")));
  assert.equal(rep.inserted, 5);
  const cmp = (await w.call("GET", "/admin/compare", { token: admin })).body.data;
  assert.equal(cmp.allMatch, false);
});

// ── API 相容 ──
test("API 相容：GAS 與 Firestore 的 GET 回應完全相同（9 個欄位）", async () => {
  const { w, admin } = await migratedWorld();
  const fsLogs = (await w.call("GET", "/logs", { token: admin })).body.data;
  w.env.DATA_PROVIDER = "gas";
  const gasLogs = (await w.call("GET", "/logs", { token: admin })).body.data;
  assert.deepEqual(sortById(fsLogs), sortById(gasLogs));
  for (const l of fsLogs) {
    assert.deepEqual(Object.keys(l), FIELDS);
    assert.equal(l.ts, l.date);
  }
  assert.equal(fsLogs.find(l => l.id === "ID_TODAY").workerCount, "鋼筋:3人、水電:2人");
});

test("API 相容：新增時 workerCount 轉換結果與 GAS 完全相同", async () => {
  const body = {
    id: "ID_PARITY", date: TODAY, project: "P", weather: "晴天", workCategory: "裝修",
    workType: "泥作/貼磚、雜項、油漆", workerCount: JSON.stringify({ "泥作/貼磚": "2", 雜項: "", 油漆: "0" }), content: "c",
  };
  const g = await createWorld({ provider: "gas" });
  const viaGas = (await g.call("POST", "/logs", { token: await g.login("admin"), body })).body.data;
  const f = await createWorld({ provider: "firestore" });
  const viaFs = (await f.call("POST", "/logs", { token: await f.login("admin"), body })).body.data;
  assert.deepEqual(viaFs, viaGas);
  assert.equal(viaFs.workerCount, "泥作/貼磚:2人、雜項、油漆:0人");
});

test("前端相容：index.html 的 parseWorkerCount 可解析 Firestore 回應", async () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const src = html.match(/function parseWorkerCount\(raw\) \{[\s\S]*?\n {8}return counts;\n {4}\}/)[0];
  const parseWorkerCount = new Function(`${src}; return parseWorkerCount;`)();
  const { w, admin } = await migratedWorld();
  const logs = (await w.call("GET", "/logs", { token: admin })).body.data;
  assert.deepEqual(parseWorkerCount(logs.find(l => l.id === "ID_MUD").workerCount), { "泥作/貼磚": "2", "泥作/打底": "1", 油漆: "4" });
  assert.deepEqual(parseWorkerCount(logs.find(l => l.id === "ID_SPECIAL").workerCount), {});
});

test("GET 查詢參數：project / date / startDate / endDate / limit，與 GAS 結果相同", async () => {
  const { w, admin } = await migratedWorld();
  const q = async qs => (await w.call("GET", `/logs${qs}`, { token: admin })).body;
  const cases = {
    "?project=B棟裝修": ["ID_MUD", "ID_SPECIAL"],
    "?date=2026-09-15": ["ID_SEP"],
    "?startDate=2026-09-16&endDate=2026-09-30": ["ID_MUD", "ID_SPECIAL"],
    "?project=A棟新建工程&startDate=2026-09-01": ["ID_SEP", "ID_TODAY"],
    "?project=A棟新建工程&date=2026-09-15": ["ID_SEP"],
    "?limit=1": ["ID_TODAY"],
  };
  for (const [qs, expected] of Object.entries(cases)) {
    const fsRes = await q(encodeURI(qs));
    assert.deepEqual(ids(fsRes.data), expected, qs);
    w.env.DATA_PROVIDER = "gas";
    assert.deepEqual(ids((await q(encodeURI(qs))).data), expected, `gas ${qs}`);
    w.env.DATA_PROVIDER = "firestore";
  }
  for (const bad of ["?date=2026/09/15", "?date=2026-09-15&startDate=2026-09-01", "?startDate=2026-10-01&endDate=2026-09-01", "?limit=0", "?limit=abc"]) {
    assert.equal((await q(bad)).error, "BAD_REQUEST", bad);
  }
});

// ── CRUD 與權限 ──
test("create：9 個欄位、與 backupQueue 原子寫入、背景同步到 Sheets（含版本）", async () => {
  const { w, worker } = await migratedWorld();
  const log = w.newLog({ project: "新專案" });
  const r = await w.call("POST", "/logs", { token: worker, body: log });
  assert.equal(r.body.success, true);
  assert.deepEqual(Object.keys(r.body.data), FIELDS);
  assert.equal(r.body.data.workerCount, "鋼筋:3人、水電:2人");
  assert.equal(r.body.data.ts, log.date);
  const doc = w.fs.get(`dailyLogs/${log.id}`).fields;
  assert.equal(doc.createdBy.stringValue, "pin:worker");
  assert.ok(w.fs.get(`backupQueue/${log.id}`), "backupQueue 應與資料同時寫入");
  await w.flush();
  assert.equal(w.fs.get(`backupQueue/${log.id}`), null);
  const row = sheetRow(w, "新專案", log.id);
  assert.equal(row[5], "鋼筋:3人、水電:2人");
  assert.equal(row[9], Date.parse(doc.updatedAt.timestampValue));
});

test("update：師傅當天可改、非當天與偷改日期被拒、主管可改、NOT_FOUND、CONFLICT", async () => {
  const { w, admin, worker } = await migratedWorld();
  const body = (date, content) => ({ date, project: "A棟新建工程", weather: "晴天", workCategory: "結構", workType: "鋼筋", workerCount: '{"鋼筋":"7"}', content });

  const ok = await w.call("PUT", "/logs/ID_TODAY", { token: worker, body: body(TODAY, "師傅改") });
  assert.equal(ok.body.data.workerCount, "鋼筋:7人");

  const old = await w.call("PUT", "/logs/ID_SEP", { token: worker, body: body("2026-09-15", "x") });
  assert.deepEqual([old.status, old.body.error, old.body.message], [403, "FORBIDDEN", "師傅只能修改當天的日誌"]);
  const trick = await w.call("PUT", "/logs/ID_SEP", { token: worker, body: body(TODAY, "偷改日期") });
  assert.equal(trick.body.error, "FORBIDDEN");
  assert.equal(w.fs.get("dailyLogs/ID_SEP").fields.content.stringValue, "九月");

  const before = w.fs.get("dailyLogs/ID_SEP").fields.createdAt.timestampValue;
  const adminOk = await w.call("PUT", "/logs/ID_SEP", { token: admin, body: body("2026-09-15", "主管改") });
  assert.equal(adminOk.body.data.content, "主管改");
  assert.equal(w.fs.get("dailyLogs/ID_SEP").fields.createdAt.timestampValue, before, "createdAt 不可被修改");

  const nf = await w.call("PUT", "/logs/ID_NONE", { token: admin, body: body(TODAY, "x") });
  assert.deepEqual([nf.status, nf.body.error, nf.body.message], [404, "NOT_FOUND", "找不到此筆日誌，可能已被刪除，請重新整理"]);

  w.fs.beforeCommit = () => w.fs.put("dailyLogs/ID_TODAY", w.fs.get("dailyLogs/ID_TODAY").fields); // 別人剛好先改了
  const conflict = await w.call("PUT", "/logs/ID_TODAY", { token: admin, body: body(TODAY, "同時修改") });
  assert.deepEqual([conflict.status, conflict.body.error], [409, "CONFLICT"]);
});

test("delete：師傅被拒、主管成功並同步刪除 Sheets 列、NOT_FOUND", async () => {
  const { w, admin, worker } = await migratedWorld();
  assert.equal((await w.call("DELETE", "/logs/ID_SEP?project=A棟新建工程", { token: worker })).body.error, "FORBIDDEN");
  const r = await w.call("DELETE", "/logs/ID_SEP?project=A棟新建工程", { token: admin });
  assert.deepEqual(r.body, { success: true, data: null });
  await w.flush();
  assert.equal(w.fs.get("dailyLogs/ID_SEP"), null);
  assert.equal(sheetRow(w, "A棟新建工程", "ID_SEP"), null);
  const nf = await w.call("DELETE", "/logs/ID_SEP", { token: admin });
  assert.deepEqual([nf.body.error, nf.body.message], ["NOT_FOUND", "找不到此筆日誌，可能已被刪除"]);
});

test("deleteProject：deleted + deletedCount、超過 250 筆分批、刪除後 Sheets 工作表移除", async () => {
  const { w, admin, worker } = await migratedWorld();
  w.dropBackground = true;
  for (let i = 0; i < 260; i++) {
    await w.call("POST", "/logs", { token: admin, body: w.newLog({ id: `ID_BULK_${i}`, project: "大量專案", date: "2026-09-10" }) });
  }
  await w.call("POST", "/admin/backup/retry", { token: admin });
  await w.call("POST", "/admin/backup/retry", { token: admin });
  assert.equal(w.gas.sheetRows("大量專案").length, 260);
  w.dropBackground = false;

  assert.equal((await w.call("DELETE", `/projects/${encodeURIComponent("大量專案")}`, { token: worker })).body.error, "FORBIDDEN");
  const r = await w.call("DELETE", `/projects/${encodeURIComponent("大量專案")}`, { token: admin });
  assert.deepEqual(r.body, { success: true, data: { deleted: 260, deletedCount: 260 } });
  assert.equal(w.fs.list("dailyLogs").filter(([, d]) => d.fields.project.stringValue === "大量專案").length, 0);
  await w.flush();
  assert.equal(w.gas.ss.getSheetByName("大量專案"), null);
  const zero = await w.call("DELETE", `/projects/${encodeURIComponent("不存在")}`, { token: admin });
  assert.deepEqual(zero.body.data, { deleted: 0, deletedCount: 0 });
});

test("驗證：TOKEN_EXPIRED、UNAUTHORIZED（沒有 token、竄改 token）", async () => {
  const { w } = await migratedWorld();
  assert.equal((await w.call("GET", "/logs")).body.error, "UNAUTHORIZED");
  const t = await w.login("admin");
  const [h, p, s] = t.split(".");
  assert.equal((await w.call("GET", "/logs", { token: `${h}.${p}.${s.slice(0, -2)}AA` })).body.error, "UNAUTHORIZED");
  w.env.TOKEN_TTL_SECONDS = "1";
  const short = await w.login("worker");
  await new Promise(r => setTimeout(r, 1100));
  const exp = await w.call("GET", "/logs", { token: short });
  assert.deepEqual([exp.status, exp.body.error], [401, "TOKEN_EXPIRED"]);
});

// ── 備份 ──
test("備份失敗：CRUD 照常成功、記錄失敗與重試次數、恢復後重試成功", async () => {
  const { w, admin } = await migratedWorld();
  w.gas.fail = true;
  const log = w.newLog();
  const r = await w.call("POST", "/logs", { token: admin, body: log });
  assert.equal(r.body.success, true, "備份失敗不可讓寫入失敗");
  await w.flush();
  const q = w.fs.get(`backupQueue/${log.id}`).fields;
  assert.equal(q.attempts.integerValue, "1");
  assert.equal(q.lastError.stringValue, "GAS_ERROR");

  const st = (await w.call("GET", "/admin/backup-status", { token: admin })).body.data;
  assert.equal(st.pending, 1);
  assert.equal(st.retrying, 1);
  assert.equal(st.readyForRollback, false);
  assert.ok(st.lastFailureAt);

  w.gas.fail = false;
  const retry = (await w.call("POST", "/admin/backup/retry", { token: admin })).body.data;
  assert.deepEqual(retry, { processed: 1, synced: 1, failed: 0 });
  assert.ok(sheetRow(w, log.project, log.id));
  assert.equal((await w.call("GET", "/admin/backup-status", { token: admin })).body.data.pending, 0);
});

test("背景工作中斷（waitUntil 沒有執行）：Cron 每 15 分鐘補同步", async () => {
  const { w, admin } = await migratedWorld();
  w.dropBackground = true;
  const log = w.newLog({ project: "中斷測試" });
  await w.call("POST", "/logs", { token: admin, body: log });
  assert.ok(w.fs.get(`backupQueue/${log.id}`));
  assert.equal(sheetRow(w, "中斷測試", log.id), null);
  await w.scheduled("*/15 * * * *");
  assert.equal(w.fs.get(`backupQueue/${log.id}`), null);
  assert.ok(sheetRow(w, "中斷測試", log.id));
});

test("版本保護：舊版本晚到不覆蓋新版本；刪除後不會被舊版本復活", async () => {
  const w = await createWorld({ provider: "firestore" });
  const apply = ops => w.gas.post({ action: "backupApply", secret: "gas-secret", ops }).results.map(r => r.result);
  const log = c => ({ id: "ID_V", date: "2026-09-01", project: "版本", weather: "", workCategory: "結構", workType: "", workerCount: "", content: c });
  assert.deepEqual(apply([{ op: "upsert", id: "ID_V", version: 200, log: log("新") }]), ["inserted"]);
  assert.deepEqual(apply([{ op: "upsert", id: "ID_V", version: 100, log: log("舊") }]), ["stale"]);
  assert.equal(sheetRow(w, "版本", "ID_V")[6], "新");
  assert.deepEqual(apply([{ op: "delete", id: "ID_V", version: 150 }]), ["stale"]);
  assert.ok(sheetRow(w, "版本", "ID_V"));
  assert.deepEqual(apply([{ op: "delete", id: "ID_V", version: 300 }]), ["deleted"]);
  assert.deepEqual(apply([{ op: "upsert", id: "ID_V", version: 250, log: log("晚到的舊版") }]), ["stale"]);
  assert.equal(sheetRow(w, "版本", "ID_V"), null, "已刪除的資料不可被舊版本復活");
  assert.deepEqual(apply([{ op: "upsert", id: "ID_V", version: 400, log: log("之後重新建立") }]), ["inserted"]);
});

test("版本保護（Worker）：連續修改同一筆，Sheets 最後是最新內容", async () => {
  const { w, admin } = await migratedWorld();
  w.dropBackground = true;
  const body = c => ({ date: TODAY, project: "A棟新建工程", weather: "晴天", workCategory: "結構", workType: "鋼筋", workerCount: '{"鋼筋":"1"}', content: c });
  await w.call("PUT", "/logs/ID_TODAY", { token: admin, body: body("第一次") });
  await w.call("PUT", "/logs/ID_TODAY", { token: admin, body: body("第二次") });
  await w.scheduled("*/15 * * * *");
  assert.equal(sheetRow(w, "A棟新建工程", "ID_TODAY")[6], "第二次");
});

test("安全閥：Firestore 0 筆或少於 80% → 停止且不修改 Sheets；GAS 端也會擋", async () => {
  const { w, admin } = await migratedWorld();
  const sheetIds = () => w.gas.allIds().sort();
  const before = sheetIds();

  w.fs.clear("dailyLogs");
  const empty = (await w.call("POST", "/admin/backup/full-sync", { token: admin })).body.data;
  assert.deepEqual([empty.result, empty.reason], ["STOPPED", "FIRESTORE_EMPTY"]);
  assert.deepEqual(sheetIds(), before);
  const st = (await w.call("GET", "/admin/backup-status", { token: admin })).body.data;
  assert.equal(st.lastWarning, "FIRESTORE_EMPTY");
  assert.equal(st.readyForRollback, false);

  // 3 / 4 = 75% < 80%
  const w2 = (await migratedWorld()).w;
  const admin2 = await w2.login("admin");
  w2.fs.docs.delete(w2.fs.name("dailyLogs/ID_SEP"));
  const few = (await w2.call("POST", "/admin/backup/full-sync", { token: admin2 })).body.data;
  assert.deepEqual([few.result, few.reason], ["STOPPED", "FIRESTORE_TOO_FEW"]);
  assert.ok(sheetRow(w2, "A棟新建工程", "ID_SEP"), "不可刪除 Sheets 資料");

  // GAS 端安全閥（就算 Worker 端沒擋住）
  assert.equal(w.gas.post({ action: "fullSync", secret: "gas-secret", logs: [], snapshotAt: Date.now() }).result, "STOPPED");
  // 系統動作一律要求密鑰，即使 REQUIRE_SECRET=false
  w.gas.props.set("REQUIRE_SECRET", "false");
  assert.equal(w.gas.post({ action: "fullSync", logs: [] }).code, "UNAUTHORIZED");
  assert.equal(w.gas.post({ action: "exportAll" }).code, "UNAUTHORIZED");
});

test("完整核對：補齊遺漏、刪除多餘；不刪較新的列與沒有 ID 的列", async () => {
  const { w, admin } = await migratedWorld();
  // Sheets 多出：舊的多餘列（應刪除）、沒有 ID 的列（保留）、在快照之後才同步進來的新列（保留）
  w.gas.seed([
    { id: "ID_EXTRA_OLD", project: "A棟新建工程", date: "2026-08-01" },
    { id: "", project: "A棟新建工程", date: "2026-08-02", content: "手寫列" },
  ]);
  const future = Date.now() + 3600e3;
  w.gas.post({ action: "backupApply", secret: "gas-secret", ops: [{ op: "upsert", id: "ID_EXTRA_NEW", version: future, log: { id: "ID_EXTRA_NEW", date: "2026-08-03", project: "A棟新建工程", content: "新" } }] });
  // Firestore 有但 Sheets 沒有（遺漏）
  w.gas.ss.getSheetByName("B棟裝修").deleteRow(2);

  const r = (await w.call("POST", "/admin/backup/full-sync", { token: admin })).body.data;
  assert.equal(r.result, "SYNCED", JSON.stringify(r));
  assert.equal(sheetRow(w, "A棟新建工程", "ID_EXTRA_OLD"), null);
  assert.ok(sheetRow(w, "A棟新建工程", "ID_EXTRA_NEW"));
  assert.ok(w.gas.sheetRows("A棟新建工程").some(row => row[6] === "手寫列"));
  assert.ok(sheetRow(w, "B棟裝修", "ID_MUD") && sheetRow(w, "B棟裝修", "ID_SPECIAL"));
  const st = (await w.call("GET", "/admin/backup-status", { token: admin })).body.data;
  assert.equal(st.lastFullSync.result, "SYNCED");
  assert.equal(st.readyForRollback, true);
});

// ── 回滾 ──
test("回滾：確認備份狀態 → 切回 GAS 資料一致 → prune 遷移 → 100% MATCH → 切回 Firestore", async () => {
  const { w, admin } = await migratedWorld();
  const created = w.newLog({ project: "回滾測試" });
  await w.call("POST", "/logs", { token: admin, body: created });
  await w.call("PUT", "/logs/ID_SEP", { token: admin, body: { date: "2026-09-15", project: "改名專案", weather: "陰天", workCategory: "結構", workType: "鋼筋", workerCount: '{"鋼筋":"9"}', content: "改名" } });
  await w.call("DELETE", "/logs/ID_SPECIAL", { token: admin });
  await w.flush();
  await w.call("POST", "/admin/backup/full-sync", { token: admin });
  const st = (await w.call("GET", "/admin/backup-status", { token: admin })).body.data;
  assert.equal(st.readyForRollback, true);
  assert.equal(st.pending, 0);

  const fsLogs = (await w.call("GET", "/logs", { token: admin })).body.data;
  w.env.DATA_PROVIDER = "gas";
  const gasLogs = (await w.call("GET", "/logs", { token: admin })).body.data;
  assert.deepEqual(sortById(gasLogs), sortById(fsLogs), "回滾後資料必須與 Firestore 相同");

  // 回滾期間直接寫入 Sheets
  const during = w.newLog({ id: "ID_DURING_ROLLBACK", project: "回滾期間" });
  assert.equal((await w.call("POST", "/logs", { token: admin, body: during })).body.success, true);
  await w.call("DELETE", "/logs/ID_MUD?project=B棟裝修", { token: admin });

  const rep = (await w.call("POST", "/admin/migrate?prune=1", { token: admin })).body.data;
  assert.equal(rep.inserted, 1);
  assert.equal(rep.pruned, 1);
  assert.equal((await w.call("GET", "/admin/compare", { token: admin })).body.data.allMatch, true);

  const gasAfter = (await w.call("GET", "/logs", { token: admin })).body.data;
  w.env.DATA_PROVIDER = "firestore";
  assert.deepEqual(sortById((await w.call("GET", "/logs", { token: admin })).body.data), sortById(gasAfter));
});

// ── 安全性 ──
test("安全性：回應不含管理欄位、金鑰或 Firestore 原始錯誤", async () => {
  const { w, admin, worker } = await migratedWorld();
  const bodies = [];
  bodies.push((await w.call("GET", "/logs", { token: admin })).body);
  bodies.push((await w.call("POST", "/logs", { token: worker, body: w.newLog() })).body);
  bodies.push((await w.call("GET", "/admin/backup-status", { token: admin })).body);
  w.fs.failNext = 10;
  const failed = await w.call("GET", "/logs", { token: admin });
  bodies.push(failed.body);
  assert.deepEqual([failed.status, failed.body.error, failed.body.message], [502, "DB_ERROR", "資料庫暫時無法處理，請稍後再試"]);
  const text = JSON.stringify(bodies.slice(0, 2)) + JSON.stringify(failed.body);
  for (const secret of ["createdAt", "updatedBy", "PRIVATE KEY", "tok_", "projects/", "UNAVAILABLE", "gas-secret", "shiudi-log-test"]) {
    assert.ok(!text.includes(secret), `回應不可包含 ${secret}`);
  }
});
