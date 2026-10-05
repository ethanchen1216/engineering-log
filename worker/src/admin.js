// 主管專用：Sheets → Firestore 遷移、逐筆比對
// 遷移只在 MIGRATION_ENABLED=true 時開放；實際寫入只允許在 DATA_PROVIDER=gas（Sheets 為正式資料來源）時執行，
// 避免用較舊的 Sheets 覆蓋 Firestore 上的最新資料。
import { ApiError, LOG_FIELDS, YMD } from "./errors.js";
import { firestore, toFields, fromFields, docId } from "./firestore/client.js";
import { callGas } from "./providers/gas.js";
import { LOGS } from "./providers/firestore.js";

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const COMMIT_CHUNK = 400;
const COLS = ["A 日期", "B 專案名稱", "C 天氣", "D 工程類別", "E 出工項目", "F 出工項目與人數", "G 備註", "H 系統ID", "I 填寫時間"];

// 讀取 Sheets 全部資料並分類：有效、無效、重複 ID、缺少 ID、警告
async function readSheets(env, user) {
  const r = await callGas(env, user, { action: "exportAll" });
  const rows = r.rows || [];
  const count = new Map();
  for (const row of rows) if (row.id) count.set(row.id, (count.get(row.id) || 0) + 1);

  const valid = [], invalid = [], duplicates = [], missingId = [], warnings = [];
  for (const row of rows) {
    const where = { sheet: row.sheet, row: row.row, id: row.id };
    if (!row.id) { missingId.push(where); continue; }
    if (count.get(row.id) > 1) { duplicates.push(where); continue; }
    const reasons = [];
    if (!ID_RE.test(row.id)) reasons.push("INVALID_ID");
    if (!YMD.test(row.log.date)) reasons.push("INVALID_DATE");
    if (!row.log.project) reasons.push("MISSING_PROJECT");
    if (reasons.length) { invalid.push({ ...where, reasons }); continue; }
    // 原始儲存格型態：B～G 應為文字；A、I 應為日期（Phase 1 以前的資料可能已被 Sheets 自動轉型）
    (row.cellTypes || []).forEach((t, i) => {
      if (i >= 1 && i <= 6 && t !== "string") warnings.push({ ...where, warning: `CELL_TYPE ${COLS[i]} = ${t}` });
    });
    if (!row.createdAt) warnings.push({ ...where, warning: "MISSING_CREATED_AT" });
    valid.push(row);
  }
  return { total: rows.length, valid, invalid, duplicates, missingId, warnings };
}

async function readFirestore(db) {
  const docs = await db.runQuery({ from: [{ collectionId: LOGS }] });
  const map = new Map();
  for (const d of docs) map.set(docId(d), { name: d.name, fields: fromFields(d.fields) });
  return map;
}

function diffFields(sheetLog, fsFields) {
  const diffs = [];
  for (const f of LOG_FIELDS) {
    const a = String(sheetLog[f] ?? "");
    const b = String(fsFields[f] ?? "");
    if (a !== b) diffs.push({ field: f, sheets: a, firestore: b });
  }
  return diffs;
}

export async function migrate(env, user, { dryRun, prune }) {
  if (env.MIGRATION_ENABLED !== "true") throw new ApiError("FORBIDDEN", "遷移功能未開啟（MIGRATION_ENABLED）");
  if (!dryRun && env.DATA_PROVIDER !== "gas") {
    throw new ApiError("BAD_REQUEST", "遷移寫入只能在 DATA_PROVIDER=gas 時執行");
  }
  const sheets = await readSheets(env, user);
  const db = firestore(env);
  const existing = await readFirestore(db);
  const now = new Date();

  const writes = [];
  const report = {
    dryRun: !!dryRun, prune: !!prune,
    sheetsTotal: sheets.total, valid: sheets.valid.length,
    inserted: 0, updated: 0, unchanged: 0, pruned: 0, failed: 0,
    invalid: sheets.invalid, duplicates: sheets.duplicates, missingId: sheets.missingId, warnings: sheets.warnings,
    failures: [],
  };

  for (const row of sheets.valid) {
    const cur = existing.get(row.id);
    if (cur && diffFields(row.log, cur.fields).length === 0) { report.unchanged++; continue; }
    if (cur) report.updated++; else report.inserted++;
    const createdAt = row.createdAt && !isNaN(Date.parse(row.createdAt)) ? new Date(row.createdAt) : now;
    const fields = {};
    for (const f of LOG_FIELDS) fields[f] = String(row.log[f] ?? "");
    Object.assign(fields, { createdAt, createdBy: "migration", updatedAt: now, updatedBy: "migration" });
    writes.push({ update: { name: await db.docName(`${LOGS}/${row.id}`), fields: toFields(fields) } });
  }

  if (prune) {
    // 只刪除「Sheets 完全沒有這個 ID」的文件；Sheets 有但格式無效或重複的，保留不動
    const inSheets = new Set([...sheets.valid, ...sheets.invalid, ...sheets.duplicates].map(r => r.id));
    for (const [id, doc] of existing) {
      if (!inSheets.has(id)) { report.pruned++; writes.push({ delete: doc.name }); }
    }
  }

  if (!dryRun) {
    for (let i = 0; i < writes.length; i += COMMIT_CHUNK) {
      const chunk = writes.slice(i, i + COMMIT_CHUNK);
      try {
        await db.commit(chunk);
      } catch (err) {
        report.failed += chunk.length;
        report.failures.push({ batch: i / COMMIT_CHUNK, size: chunk.length, error: err.status || "DB_ERROR" });
      }
    }
  }
  return report;
}

// 逐筆比對 Sheets 與 Firestore 的 9 個 API 欄位
export async function compare(env, user) {
  const sheets = await readSheets(env, user);
  const existing = await readFirestore(firestore(env));
  const result = {
    sheetsTotal: sheets.total, firestoreTotal: existing.size,
    MATCH: 0, MISMATCH: [], MISSING_IN_FIRESTORE: [], EXTRA_IN_FIRESTORE: [],
    invalid: sheets.invalid, duplicates: sheets.duplicates, missingId: sheets.missingId,
  };
  const seen = new Set();
  for (const row of sheets.valid) {
    seen.add(row.id);
    const cur = existing.get(row.id);
    if (!cur) { result.MISSING_IN_FIRESTORE.push(row.id); continue; }
    const diffs = diffFields(row.log, cur.fields);
    if (diffs.length) result.MISMATCH.push({ id: row.id, diffs }); else result.MATCH++;
  }
  const knownIds = new Set([...sheets.invalid, ...sheets.duplicates].map(r => r.id));
  for (const id of existing.keys()) if (!seen.has(id) && !knownIds.has(id)) result.EXTRA_IN_FIRESTORE.push(id);
  result.allMatch =
    result.MISMATCH.length === 0 && result.MISSING_IN_FIRESTORE.length === 0 && result.EXTRA_IN_FIRESTORE.length === 0 &&
    sheets.invalid.length === 0 && sheets.duplicates.length === 0 && sheets.missingId.length === 0 &&
    result.MATCH === sheets.total;
  return result;
}
