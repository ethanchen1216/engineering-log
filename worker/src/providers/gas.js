// GAS Provider：Worker → Google Apps Script → Google Sheets（Phase 3 的資料路徑，保留作為回滾用）
import { ApiError } from "../errors.js";

// 密鑰放在 POST body（GAS 讀不到 header，也避免出現在網址或紀錄中）
export async function callGas(env, actor, payload) {
  if (!env.GAS_URL || !env.GAS_SHARED_SECRET) throw new Error("GAS secrets not configured");
  let res, data;
  try {
    res = await fetch(env.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ ...payload, secret: env.GAS_SHARED_SECRET, actor: { role: actor.role, sub: actor.sub } }),
      redirect: "follow",
    });
    data = await res.json();
  } catch (err) {
    console.error("gas fetch failed", payload.action, err && err.message);
    throw new ApiError("GAS_ERROR");
  }
  if (data.status === "success") return data;

  // GAS 回傳的 message 是我們自己寫的中文訊息，只有已知代碼才轉給使用者
  console.warn("gas error", payload.action, data.code);
  switch (data.code) {
    case "NOT_FOUND":      throw new ApiError("NOT_FOUND", data.message);
    case "FORBIDDEN":      throw new ApiError("FORBIDDEN", data.message);
    case "BAD_REQUEST":    throw new ApiError("BAD_REQUEST", data.message);
    case "BUSY":
    case "PARTIAL_DELETE": throw new ApiError("GAS_ERROR", data.message);
    case "UNAUTHORIZED":   console.error("GAS rejected shared secret"); throw new ApiError("GAS_ERROR");
    default:               throw new ApiError("GAS_ERROR");
  }
}

// 只讀的系統呼叫（exportAll、sheetsStats）：GAS 偶爾會暫時失敗，自動重試一次（不會修改資料，重試安全）
const READ_ONLY_ACTIONS = ["exportAll", "sheetsStats", "getLogs"];
export async function callGasRead(env, actor, payload) {
  if (!READ_ONLY_ACTIONS.includes(payload.action)) throw new Error("callGasRead only for read-only actions");
  try {
    return await callGas(env, actor, payload);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "GAS_ERROR") throw err;
    console.warn("gas read retry", payload.action);
    await new Promise(r => setTimeout(r, 1500));
    return callGas(env, actor, payload);
  }
}

// 查詢條件在 Worker 端套用（GAS 只會回傳全部資料，已依日期由新到舊排序）
export function applyLogFilter(logs, filter) {
  let out = logs;
  if (filter.project) out = out.filter(l => l.project === filter.project);
  if (filter.date) out = out.filter(l => l.date === filter.date);
  if (filter.startDate) out = out.filter(l => l.date >= filter.startDate);
  if (filter.endDate) out = out.filter(l => l.date <= filter.endDate);
  if (filter.limit) out = out.slice(0, filter.limit);
  return out;
}

export function gasProvider(env) {
  return {
    name: "gas",
    async listLogs(user, filter) {
      const r = await callGas(env, user, { action: "getLogs" });
      return applyLogFilter(r.logs || [], filter);
    },
    async createLog(user, log) {
      const r = await callGas(env, user, { action: "insert", ...log });
      return r.log || null;
    },
    async updateLog(user, id, log) {
      const r = await callGas(env, user, { action: "update", ...log, id });
      return r.log || null;
    },
    async deleteLog(user, id, project) {
      await callGas(env, user, { action: "delete", id, project });
    },
    async deleteProject(user, project) {
      const r = await callGas(env, user, { action: "deleteProject", project });
      // 確認 GAS 真的執行了專案刪除（舊版 GAS 不認得此 action）
      if (r.action !== "deleteProject") throw new ApiError("GAS_ERROR");
      return { deleted: r.deleted || 0 };
    },
  };
}
