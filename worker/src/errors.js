// ── 錯誤代碼 → HTTP 狀態與給使用者看的訊息（不外洩內部錯誤）──
export const ERRORS = {
  INVALID_PIN:    [401, "密碼錯誤，請再試一次"],
  RATE_LIMITED:   [429, "嘗試次數過多，請稍後再試"],
  UNAUTHORIZED:   [401, "請重新登入"],
  TOKEN_EXPIRED:  [401, "登入已逾時，請重新登入"],
  FORBIDDEN:      [403, "沒有權限執行此操作"],
  NOT_FOUND:      [404, "找不到資料"],
  BAD_REQUEST:    [400, "資料格式錯誤"],
  CONFLICT:       [409, "資料已被其他人修改，請重新整理後再試"],
  GAS_ERROR:      [502, "雲端資料庫暫時無法處理，請稍後再試"],
  DB_ERROR:       [502, "資料庫暫時無法處理，請稍後再試"],
  INTERNAL_ERROR: [500, "系統錯誤，請稍後再試"],
};

export class ApiError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    this.userMessage = message;
    this.extra = extra;
  }
}

// 台北時區的今天（YYYY-MM-DD），師傅「只能修改當天」用
export function todayTaipei(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const YMD = /^\d{4}-\d{2}-\d{2}$/;

// 對外 API 的日誌物件：固定 9 個欄位，與 Phase 3 完全相同
export const LOG_FIELDS = ["id", "date", "project", "weather", "workCategory", "workType", "workerCount", "content", "ts"];

export function toApiLog(src) {
  const log = {};
  for (const f of LOG_FIELDS) log[f] = src[f] === undefined || src[f] === null ? "" : String(src[f]);
  return log;
}

// 前端送來的 workerCount（JSON 字串）→ 對外格式「鋼筋:3人、水電:2人」
// 與 GAS 寫入 Sheets 時的轉換規則完全相同（google-apps-script.js「整理出工人數」）
export function toSheetWorkerCount(workType, workerCountJson) {
  const workTypeStr = workType || "";
  let counts;
  try {
    counts = workerCountJson ? JSON.parse(workerCountJson) : {};
  } catch {
    return workTypeStr;
  }
  if (!counts || typeof counts !== "object") counts = {};
  return workTypeStr
    .split("、")
    .filter(w => w !== "")
    .map(w => (counts[w] ? `${w}:${counts[w]}人` : w))
    .join("、");
}
