// ── 共用設定 ──
var TIME_ZONE = "Asia/Taipei";
var SKIP_SHEETS = ["工程日誌", "Sheet1"]; // 總表，不屬於任何專案

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 錯誤回應：code 給 Worker 判斷用，message 為可直接顯示給使用者的中文訊息
function jsonError(code, message) {
  return jsonOutput({ status: "error", code: code, message: message });
}

// ── Worker → GAS 共用密鑰驗證 ──
// 指令碼屬性（專案設定 → 指令碼屬性）：
//   GAS_SHARED_SECRET：與 Cloudflare Worker 的 GAS_SHARED_SECRET 相同
//   REQUIRE_SECRET：   "true" 時拒絕所有沒有密鑰的請求；切換到 Worker 前維持 "false"，舊前端仍可使用
function secretMode() {
  var props = PropertiesService.getScriptProperties();
  return {
    expected: props.getProperty("GAS_SHARED_SECRET") || "",
    required: props.getProperty("REQUIRE_SECRET") === "true"
  };
}

// 回傳 true 表示通過；有帶密鑰就必須正確，REQUIRE_SECRET 開啟時一定要帶
function checkSecret(data) {
  var mode = secretMode();
  if (data.secret !== undefined) return !!mode.expected && String(data.secret) === mode.expected;
  return !mode.required;
}

function todayYMD() {
  return Utilities.formatDate(new Date(), TIME_ZONE, "yyyy-MM-dd");
}

// 日期統一輸出為 YYYY-MM-DD（Sheets 會把日期字串自動轉成 Date 物件）
function toYMD(value) {
  if (value instanceof Date) return Utilities.formatDate(value, TIME_ZONE, "yyyy-MM-dd");
  var s = String(value || "").trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
  return s;
}

// 專案名稱 → 工作表名稱
function toSheetName(project) {
  return (project || "未命名專案")
    .substring(0, 31)
    .replace(/[\\\/\*\?\[\]\:]/g, "")
    .trim();
}

// 依系統ID 找日誌所在的工作表與列號（先找指定的專案工作表，找不到再找其他專案）
function findLogRow(ss, id, preferredSheetName) {
  var sheets = ss.getSheets();
  var preferred = ss.getSheetByName(preferredSheetName);
  if (preferred) {
    sheets = [preferred].concat(sheets.filter(function(s) { return s.getName() !== preferredSheetName; }));
  }
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    if (SKIP_SHEETS.indexOf(sheet.getName()) >= 0) continue;
    var rows = sheet.getDataRange().getValues();
    for (var i = rows.length - 1; i >= 1; i--) {
      if (String(rows[i][7]) === String(id)) return { sheet: sheet, row: i + 1, values: rows[i] };
    }
  }
  return null;
}

// 工作表的一列 → 前端使用的日誌物件（讀取與寫入回傳共用，確保格式一致）
function rowToLog(row, rowIndex) {
  var ymd = toYMD(row[0]);
  return {
    id:           String(row[7] || Date.now() + "_" + rowIndex),
    date:         ymd,
    project:      String(row[1] || ""),
    weather:      String(row[2] || ""),
    workCategory: String(row[3] || ""),
    workType:     String(row[4] || ""),
    workerCount:  String(row[5] || ""),
    content:      String(row[6] || ""),
    ts:           ymd
  };
}

// 專案工作表只剩標題列時移除，避免留下空白工作表（有任何其他內容就保留）
function removeSheetIfEmpty(ss, sheet) {
  if (SKIP_SHEETS.indexOf(sheet.getName()) >= 0) return;
  if (sheet.getLastRow() > 1 || ss.getSheets().length <= 1) return;
  ss.deleteSheet(sheet);
}

// 刪除整個專案：在所有專案工作表中刪除 B 欄等於該專案名稱的列
function deleteProjectRows(ss, project) {
  var deleted = 0;
  ss.getSheets().forEach(function(sheet) {
    if (SKIP_SHEETS.indexOf(sheet.getName()) >= 0) return;
    var rows = sheet.getDataRange().getValues();
    var deletedHere = 0;
    // 由下往上，把連續的符合列合併成一次 deleteRows，避免列號位移
    var i = rows.length - 1;
    while (i >= 1) {
      if (String(rows[i][1]) !== project) { i--; continue; }
      var end = i;
      while (i >= 1 && String(rows[i][1]) === project) i--;
      sheet.deleteRows(i + 2, end - i);
      deletedHere += end - i;
    }
    if (deletedHere) removeSheetIfEmpty(ss, sheet);
    deleted += deletedHere;
  });
  return deleted;
}

// 計算某專案剩餘的列數（刪除後驗證用）
function countProjectRows(ss, project) {
  var count = 0;
  ss.getSheets().forEach(function(sheet) {
    if (SKIP_SHEETS.indexOf(sheet.getName()) >= 0) return;
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) if (String(rows[i][1]) === project) count++;
  });
  return count;
}

// 找或建立專案工作表
function getOrCreateSheet(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(["日期","專案名稱","天氣","工程類別","出工項目","出工項目與人數","備註","系統ID","填寫時間"]);
    var hr = sheet.getRange(1, 1, 1, 9);
    hr.setFontWeight("bold");
    hr.setBackground("#1a2332");
    hr.setFontColor("#ffffff");
  }
  return sheet;
}

// 寫入一整列；B～H 欄設為純文字，避免專案名稱、備註被 Sheets 自動轉成數字或日期
function writeRow(sheet, rowNum, values) {
  sheet.getRange(rowNum, 2, 1, 7).setNumberFormat("@");
  sheet.getRange(rowNum, 1, 1, 9).setValues([values]);
}

// ── 讀取所有專案工作表的資料 ──
function listLogs(ss) {
  var allLogs = [];
  ss.getSheets().forEach(function(sheet) {
    // 跳過總表
    if (SKIP_SHEETS.indexOf(sheet.getName()) >= 0) return;

    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return;

    for (var j = 1; j < data.length; j++) {
      var row = data[j];
      if (!row[0] && !row[1]) continue;
      allLogs.push(rowToLog(row, j));
    }
  });

  // 依日期由新到舊排序
  allLogs.sort(function(a, b) {
    return b.ts.localeCompare(a.ts);
  });
  return allLogs;
}

// GET 無法夾帶密鑰，REQUIRE_SECRET 開啟後一律拒絕（Worker 改用 POST action "getLogs"）
function doGet(e) {
  try {
    if (secretMode().required) return jsonError("UNAUTHORIZED", "未授權的請求");
    return jsonOutput({ status: "success", logs: listLogs(SpreadsheetApp.getActiveSpreadsheet()) });
  } catch(error) {
    return jsonError("INTERNAL_ERROR", error.toString());
  }
}

// ── 讀取／寫入／修改／刪除日誌 ──
function doPost(e) {
  var data;
  try {
    if (!e.postData || !e.postData.contents) throw new Error("empty");
    data = JSON.parse(e.postData.contents);
  } catch(err) {
    return jsonError("BAD_REQUEST", "沒有收到有效資料");
  }
  // 先驗證密鑰，未授權的請求不會佔用鎖
  if (!checkSecret(data)) return jsonError("UNAUTHORIZED", "未授權的請求");
  delete data.secret;

  if (data.action === "getLogs") {
    try {
      return jsonOutput({ status: "success", action: "getLogs", logs: listLogs(SpreadsheetApp.getActiveSpreadsheet()) });
    } catch(error) {
      return jsonError("INTERNAL_ERROR", error.toString());
    }
  }

  // 同一時間只處理一個寫入，避免同時修改造成列號錯位
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return jsonError("BUSY", "系統忙碌中，請稍後再試");
  try {
    return handlePost(data);
  } catch(error) {
    return jsonError("INTERNAL_ERROR", error.toString());
  } finally {
    lock.releaseLock();
  }
}

function handlePost(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = toSheetName(data.project);
  // actor 由 Worker 帶入（只有通過密鑰驗證的請求才會有）；舊前端直接呼叫時沒有 actor，維持原本行為
  var isWorkerRole = !!(data.actor && data.actor.role === "worker");

  // ── 刪除整個專案 ──
  if (data.action === "deleteProject") {
    if (isWorkerRole) return jsonError("FORBIDDEN", "只有主管可以刪除專案");
    var project = String(data.project || "");
    if (!project) return jsonError("BAD_REQUEST", "未指定專案名稱");
    var deletedCount = deleteProjectRows(ss, project);
    var remaining = countProjectRows(ss, project);
    if (remaining > 0) {
      return jsonError("PARTIAL_DELETE", "專案只刪除了 " + deletedCount + " 筆，還剩 " + remaining + " 筆，請再試一次");
    }
    return jsonOutput({ status: "success", action: "deleteProject", deleted: deletedCount });
  }

  // ── 刪除 ──
  if (data.action === "delete") {
    if (isWorkerRole) return jsonError("FORBIDDEN", "只有主管可以刪除");
    var delFound = data.id ? findLogRow(ss, data.id, sheetName) : null;
    if (!delFound) return jsonError("NOT_FOUND", "找不到此筆日誌，可能已被刪除");
    delFound.sheet.deleteRow(delFound.row);
    removeSheetIfEmpty(ss, delFound.sheet);
    return jsonOutput({ status: "success", action: "delete" });
  }

  // 整理出工人數
  var workTypeStr = data.workType || "";
  var workerStr = "";
  try {
    var counts = typeof data.workerCount === "string" ? JSON.parse(data.workerCount || "{}") : (data.workerCount || {});
    var types = workTypeStr.split("、").filter(function(w) { return w !== ""; });
    workerStr = types.map(function(w) {
      return counts[w] ? w + ":" + counts[w] + "人" : w;
    }).join("、");
  } catch(err) { workerStr = workTypeStr; }

  var rowValues = [
    data.date         || "",  // A: 日期
    data.project      || "",  // B: 專案名稱
    data.weather      || "",  // C: 天氣
    data.workCategory || "",  // D: 工程類別
    workTypeStr,              // E: 出工項目
    workerStr,                // F: 出工項目與人數
    data.content      || "",  // G: 備註
    data.id           || "",  // H: 系統ID
    new Date()                // I: 填寫時間
  ];

  // ── 修改 ──
  if (data.action === "update") {
    var found = data.id ? findLogRow(ss, data.id, sheetName) : null;
    if (!found) return jsonError("NOT_FOUND", "找不到此筆日誌，可能已被刪除，請重新整理");
    // 師傅只能修改當天的日誌（依雲端上原本的日期判斷，不信任前端）
    if (isWorkerRole && toYMD(found.values[0]) !== todayYMD()) {
      return jsonError("FORBIDDEN", "師傅只能修改當天的日誌");
    }

    rowValues[8] = found.values[8] || rowValues[8]; // 保留原本的填寫時間

    if (found.sheet.getName() === sheetName) {
      writeRow(found.sheet, found.row, rowValues);
    } else {
      // 專案名稱有變更：先寫入新專案工作表，再從原工作表移除
      var target = getOrCreateSheet(ss, sheetName);
      writeRow(target, target.getLastRow() + 1, rowValues);
      found.sheet.deleteRow(found.row);
      removeSheetIfEmpty(ss, found.sheet);
    }
    // 回傳更新後的日誌，前端直接更新本地資料，不必重新讀取全部
    return jsonOutput({ status: "success", action: "update", log: rowToLog(rowValues, found.row) });
  }

  // ── 新增 ──
  if (data.action !== "insert") return jsonError("BAD_REQUEST", "未知的操作");
  var sheet = getOrCreateSheet(ss, sheetName);
  var newRow = sheet.getLastRow() + 1;
  writeRow(sheet, newRow, rowValues);

  return jsonOutput({ status: "success", action: "insert", projectSheet: sheetName, log: rowToLog(rowValues, newRow) });
}

function doOptions(e) {
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
}
