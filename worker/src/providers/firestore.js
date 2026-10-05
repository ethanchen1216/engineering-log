// Firestore Provider：Worker → Firestore（Phase 4 的主要資料庫）
// 每筆寫入都和 backupQueue/{logId} 在同一個原子交易中提交，Sheets 備份的可靠性不依賴 ctx.waitUntil
import { ApiError, toApiLog, todayTaipei, toSheetWorkerCount } from "../errors.js";
import { firestore, toFields, fromFields, fieldFilter, whereAll, docId, FirestoreError } from "../firestore/client.js";
import { queueWrite, processQueue } from "../backup.js";

export const LOGS = "dailyLogs";
const COMMIT_CHUNK = 250; // 每筆刪除另含一筆 backupQueue 寫入，Firestore 單次交易上限 500 筆

export function docToLog(doc) {
  return toApiLog({ ...fromFields(doc.fields), id: docId(doc) });
}

// Firestore 儲存的欄位：9 個 API 欄位 + 管理欄位
// workerCount 以對外格式「鋼筋:3人、…」儲存，ts 實際保存（= date）
export function storedFields(log, id, meta) {
  return {
    id,
    date: log.date,
    project: log.project,
    weather: log.weather,
    workCategory: log.workCategory,
    workType: log.workType,
    workerCount: toSheetWorkerCount(log.workType, log.workerCount),
    content: log.content,
    ts: log.date,
    createdAt: meta.createdAt,
    createdBy: meta.createdBy,
    updatedAt: meta.updatedAt,
    updatedBy: meta.updatedBy,
  };
}

function toApiError(err, conflictMessage) {
  if (err instanceof ApiError) return err;
  if (err instanceof FirestoreError && ["FAILED_PRECONDITION", "ALREADY_EXISTS", "ABORTED"].includes(err.status)) {
    return new ApiError("CONFLICT", conflictMessage);
  }
  console.error("firestore provider error", err && err.message);
  return new ApiError("DB_ERROR");
}

// 寫入成功後立即嘗試同步到 Sheets（失敗沒關係：backupQueue 會由 Cron 重試）
function syncSoon(env, ctx, ids) {
  if (!ids.length || !ctx || typeof ctx.waitUntil !== "function") return;
  ctx.waitUntil(processQueue(env, { ids }).catch(err => console.error("backup sync failed", err && err.message)));
}

export function firestoreProvider(env, ctx) {
  const db = firestore(env);
  const guard = async (fn, conflictMessage) => {
    try { return await fn(); } catch (err) { throw toApiError(err, conflictMessage); }
  };

  return {
    name: "firestore",

    listLogs: (user, filter) => guard(async () => {
      const filters = [];
      if (filter.project) filters.push(fieldFilter("project", "EQUAL", filter.project));
      if (filter.date) filters.push(fieldFilter("date", "EQUAL", filter.date));
      if (filter.startDate) filters.push(fieldFilter("date", "GREATER_THAN_OR_EQUAL", filter.startDate));
      if (filter.endDate) filters.push(fieldFilter("date", "LESS_THAN_OR_EQUAL", filter.endDate));
      const q = { from: [{ collectionId: LOGS }], orderBy: [{ field: { fieldPath: "date" }, direction: "DESCENDING" }] };
      const where = whereAll(filters);
      if (where) q.where = where;
      if (filter.limit) q.limit = filter.limit;
      return (await db.runQuery(q)).map(docToLog);
    }),

    createLog: (user, log) => guard(async () => {
      const now = new Date();
      const data = storedFields(log, log.id, { createdAt: now, createdBy: user.sub, updatedAt: now, updatedBy: user.sub });
      await db.commit([
        { update: { name: await db.docName(`${LOGS}/${log.id}`), fields: toFields(data) }, currentDocument: { exists: false } },
        await queueWrite(db, log.id, now),
      ]);
      syncSoon(env, ctx, [log.id]);
      return toApiLog(data);
    }, "此日誌 ID 已存在，請重新整理後再試"),

    updateLog: (user, id, log) => guard(async () => {
      const doc = await db.get(`${LOGS}/${id}`);
      if (!doc) throw new ApiError("NOT_FOUND", "找不到此筆日誌，可能已被刪除，請重新整理");
      const cur = fromFields(doc.fields);
      // 師傅只能修改當天的日誌：依 Firestore 上原本的日期判斷，不信任 request body
      if (user.role === "worker" && cur.date !== todayTaipei()) {
        throw new ApiError("FORBIDDEN", "師傅只能修改當天的日誌");
      }
      const now = new Date();
      const data = storedFields(log, id, {
        createdAt: cur.createdAt || now,
        createdBy: cur.createdBy || user.sub,
        updatedAt: now,
        updatedBy: user.sub,
      });
      // updateTime 前提條件：讀取後被別人改過就回傳 CONFLICT，避免繞過當天規則或覆蓋別人的修改
      await db.commit([
        { update: { name: doc.name, fields: toFields(data) }, currentDocument: { updateTime: doc.updateTime } },
        await queueWrite(db, id, now),
      ]);
      syncSoon(env, ctx, [id]);
      return toApiLog(data);
    }),

    deleteLog: (user, id) => guard(async () => {
      const doc = await db.get(`${LOGS}/${id}`);
      if (!doc) throw new ApiError("NOT_FOUND", "找不到此筆日誌，可能已被刪除");
      const now = new Date();
      await db.commit([
        { delete: doc.name, currentDocument: { updateTime: doc.updateTime } },
        await queueWrite(db, id, now),
      ]);
      syncSoon(env, ctx, [id]);
    }),

    deleteProject: (user, project) => guard(async () => {
      const query = { from: [{ collectionId: LOGS }], where: fieldFilter("project", "EQUAL", project) };
      const ids = (await db.runQuery({ ...query, select: { fields: [{ fieldPath: "__name__" }] } })).map(docId);
      const now = new Date();
      let deleted = 0;
      for (let i = 0; i < ids.length; i += COMMIT_CHUNK) {
        const chunk = ids.slice(i, i + COMMIT_CHUNK);
        const writes = [];
        for (const id of chunk) {
          writes.push({ delete: await db.docName(`${LOGS}/${id}`) });
          writes.push(await queueWrite(db, id, now));
        }
        await db.commit(writes);
        deleted += chunk.length;
      }
      // 刪除後再查一次，確認沒有殘留才回傳成功
      const remaining = await db.count(query);
      syncSoon(env, ctx, ids);
      if (remaining > 0) throw new ApiError("DB_ERROR", `專案只刪除了 ${deleted} 筆，還剩 ${remaining} 筆，請再試一次`);
      return { deleted };
    }),
  };
}
