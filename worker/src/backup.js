// Firestore → Google Sheets 備份
//
// 可靠性來源（不依賴 ctx.waitUntil）：
//   1. 每筆資料寫入與 backupQueue/{logId} 在同一個 Firestore 交易中提交
//   2. backupQueue 每個 logId 只有一筆「最新待同步」紀錄；同步時重新讀取 Firestore 最新狀態
//   3. 同步失敗：保留紀錄並累計 attempts、lastError，由 Cron 每 15 分鐘重試
//   4. 每日完整核對（含安全閥），補上任何遺漏
// 版本保護：每次同步帶 version（Firestore updatedAt 毫秒；刪除為刪除時間），
//   GAS 只接受 version >= Sheets J 欄「同步版本」的資料，舊版本晚到不會覆蓋新版本。
import { firestore, toFields, fromFields, docId } from "./firestore/client.js";
import { callGas } from "./providers/gas.js";
import { toApiLog } from "./errors.js";

export const QUEUE = "backupQueue";
const STATUS = "system/backupStatus";
const LOGS = "dailyLogs";
const SYSTEM_ACTOR = { role: "system", sub: "system:backup" };
const GAS_BATCH = 200;          // 每次送給 GAS 的筆數
export const GUARD_RATIO = 0.8; // Firestore 少於 Sheets 的 80% → 停止完整同步

export async function queueWrite(db, id, at) {
  return {
    update: {
      name: await db.docName(`${QUEUE}/${id}`),
      fields: toFields({ logId: id, version: at.getTime(), queuedAt: at, attempts: 0, lastError: "" }),
    },
  };
}

function millis(d) {
  return d instanceof Date ? d.getTime() : 0;
}

// 處理待同步項目。ids 指定時只處理這些（寫入後立即同步）；否則處理佇列中最舊的一批（Cron）
export async function processQueue(env, { ids, limit = GAS_BATCH } = {}) {
  const db = firestore(env);
  let entries;
  if (ids) {
    const found = await db.batchGet(ids.map(id => `${QUEUE}/${id}`));
    entries = ids.filter(id => found.get(id)).map(id => ({ id, q: found.get(id) }));
  } else {
    const docs = await db.runQuery({
      from: [{ collectionId: QUEUE }],
      orderBy: [{ field: { fieldPath: "queuedAt" }, direction: "ASCENDING" }],
      limit,
    });
    entries = docs.map(d => ({ id: docId(d), q: d }));
  }

  const summary = { processed: 0, synced: 0, failed: 0 };
  for (let i = 0; i < entries.length; i += GAS_BATCH) {
    const r = await syncBatch(env, db, entries.slice(i, i + GAS_BATCH));
    summary.processed += r.processed;
    summary.synced += r.synced;
    summary.failed += r.failed;
  }
  return summary;
}

async function syncBatch(env, db, entries) {
  // 重新讀取 Firestore 最新狀態：存在 → upsert；不存在 → delete
  const logs = await db.batchGet(entries.map(e => `${LOGS}/${e.id}`));
  const ops = entries.map(e => {
    const q = fromFields(e.q.fields);
    const doc = logs.get(e.id);
    if (doc) {
      const f = fromFields(doc.fields);
      return {
        op: "upsert",
        id: e.id,
        version: millis(f.updatedAt) || q.version,
        createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : "",
        log: toApiLog({ ...f, id: e.id }),
      };
    }
    return { op: "delete", id: e.id, version: q.version };
  });

  let results = [];
  let gasError = "";
  try {
    results = (await callGas(env, SYSTEM_ACTOR, { action: "backupApply", ops })).results || [];
  } catch (err) {
    gasError = err.code || "GAS_ERROR";
  }
  const byId = new Map(results.map(r => [r.id, r]));

  // 成功：刪除佇列項目（updateTime 前提條件：同步期間又有新修改就保留，下次再同步）
  // 失敗：attempts + 1、記錄錯誤代碼，等待重試
  const writes = [];
  let synced = 0, failed = 0;
  const now = new Date();
  for (const e of entries) {
    const r = byId.get(e.id);
    if (r && r.result !== "error") {
      synced++;
      writes.push({ delete: e.q.name, currentDocument: { updateTime: e.q.updateTime } });
    } else {
      failed++;
      const q = fromFields(e.q.fields);
      writes.push({
        update: {
          name: e.q.name,
          fields: toFields({ ...q, attempts: (q.attempts || 0) + 1, lastError: gasError || "APPLY_FAILED", lastAttemptAt: now }),
        },
        currentDocument: { updateTime: e.q.updateTime },
      });
    }
  }
  await db.batchWrite(writes);

  const status = { lastRunAt: now };
  if (synced) status.lastSuccessAt = now;
  if (failed) { status.lastFailureAt = now; status.lastError = gasError || "APPLY_FAILED"; }
  await updateStatus(db, status);
  if (failed) console.warn("backup sync failures", failed, gasError || "APPLY_FAILED");
  return { processed: entries.length, synced, failed };
}

async function updateStatus(db, fields) {
  await db.commit([{
    update: { name: await db.docName(STATUS), fields: toFields(fields) },
    updateMask: { fieldPaths: Object.keys(fields) },
  }]);
}

// 每日完整核對：Firestore 全部資料 → Sheets
// 安全閥（Worker 與 GAS 兩邊都檢查）：Firestore 為 0 筆，或少於 Sheets 的 80% → 停止，不修改 Sheets
export async function fullReconcile(env) {
  const db = firestore(env);
  let queue = null;
  try { queue = await processQueue(env); } catch (err) { console.error("queue before full sync failed", err && err.message); }

  const snapshotAt = Date.now();
  const docs = await db.runQuery({ from: [{ collectionId: LOGS }] });
  const items = docs.map(d => {
    const f = fromFields(d.fields);
    return {
      log: toApiLog({ ...f, id: docId(d) }),
      version: millis(f.updatedAt),
      createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : "",
    };
  });

  const stats = await callGas(env, SYSTEM_ACTOR, { action: "sheetsStats" });
  const sheetsCount = stats.managedRows || 0;
  let result;
  if (items.length === 0) {
    result = { result: "STOPPED", reason: "FIRESTORE_EMPTY", firestoreCount: 0, sheetsCount };
  } else if (items.length < sheetsCount * GUARD_RATIO) {
    result = { result: "STOPPED", reason: "FIRESTORE_TOO_FEW", firestoreCount: items.length, sheetsCount };
  } else {
    const r = await callGas(env, SYSTEM_ACTOR, { action: "fullSync", logs: items, snapshotAt });
    result = {
      result: r.result,
      reason: r.reason || "",
      firestoreCount: items.length,
      sheetsCount: r.sheetsCount,
      unmanagedRows: r.unmanagedRows || 0,
      stats: r.stats || {},
    };
  }
  if (result.result !== "SYNCED") console.warn("full sync stopped", result.reason);

  const at = new Date();
  const status = { lastFullSync: { at, ...result } };
  if (result.result === "STOPPED") { status.lastWarningAt = at; status.lastWarning = result.reason; }
  await updateStatus(db, status);
  return { ...result, queue };
}

// 回滾前檢查用：最後成功同步時間、待同步筆數、最舊待同步時間、最後一次完整核對結果
export async function backupStatus(env) {
  const db = firestore(env);
  const statusDoc = await db.get(STATUS);
  const s = statusDoc ? fromFields(statusDoc.fields) : {};
  const pending = await db.count({ from: [{ collectionId: QUEUE }] });
  const retrying = await db.count({ from: [{ collectionId: QUEUE }], where: { fieldFilter: { field: { fieldPath: "attempts" }, op: "GREATER_THAN", value: { integerValue: "0" } } } });
  const oldest = pending
    ? await db.runQuery({ from: [{ collectionId: QUEUE }], orderBy: [{ field: { fieldPath: "queuedAt" }, direction: "ASCENDING" }], limit: 1 })
    : [];
  const oldestPendingAt = oldest.length ? fromFields(oldest[0].fields).queuedAt : null;
  const lastFull = s.lastFullSync || null;
  return {
    pending,
    retrying,
    oldestPendingAt,
    lastSuccessAt: s.lastSuccessAt || null,
    lastFailureAt: s.lastFailureAt || null,
    lastError: s.lastError || "",
    lastFullSync: lastFull,
    lastWarning: s.lastWarning || "",
    lastWarningAt: s.lastWarningAt || null,
    // 可以安全回滾到 GAS：沒有待同步資料，而且最後一次完整核對成功
    readyForRollback: pending === 0 && !!lastFull && lastFull.result === "SYNCED",
  };
}
