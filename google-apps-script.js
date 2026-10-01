// ── 共用設定 ──
var TIME_ZONE = "Asia/Taipei";
var SKIP_SHEETS = ["工程日誌", "Sheet1"]; // 總表，不屬於任何專案

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = ss.getSheets();
    var allLogs = [];

    sheets.forEach(function(sheet) {
      // 跳過總表
      if (SKIP_SHEETS.indexOf(sheet.getName()) >= 0) return;

      var data = sheet.getDataRange().getValues();
      if (data.length <= 1) return;

      for (var j = 1; j < data.length; j++) {
        var row = data[j];
        if (!row[0] && !row[1]) continue;

        var ymd = toYMD(row[0]);

        allLogs.push({
          id:           String(row[7] || Date.now() + "_" + j),
          date:         ymd,
          project:      String(row[1] || ""),
          weather:      String(row[2] || ""),
          workCategory: String(row[3] || ""),
          workType:     String(row[4] || ""),
          workerCount:  String(row[5] || ""),
          content:      String(row[6] || ""),
          ts:           ymd
        });
      }
    });

    // 依日期由新到舊排序
    allLogs.sort(function(a, b) {
      return b.ts.localeCompare(a.ts);
    });

    return jsonOutput({ status: "success", logs: allLogs });

  } catch(error) {
    return jsonOutput({ status: "error", message: error.toString() });
  }
}

// ── 寫入／修改／刪除日誌 ──
function doPost(e) {
  // 同一時間只處理一個寫入，避免同時修改造成列號錯位
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return jsonOutput({ status: "error", message: "系統忙碌中，請稍後再試" });
  try {
    return handlePost(e);
  } catch(error) {
    return jsonOutput({ status: "error", message: error.toString() });
  } finally {
    lock.releaseLock();
  }
}

function handlePost(e) {
  if (!e.postData || !e.postData.contents) throw new Error("沒有收到有效資料");

  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = toSheetName(data.project);

  // ── 刪除 ──
  if (data.action === "delete") {
    var delFound = data.id ? findLogRow(ss, data.id, sheetName) : null;
    if (!delFound) return jsonOutput({ status: "error", message: "找不到此筆日誌，可能已被刪除" });
    delFound.sheet.deleteRow(delFound.row);
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
    if (!found) return jsonOutput({ status: "error", message: "找不到此筆日誌，可能已被刪除，請重新整理" });

    rowValues[8] = found.values[8] || rowValues[8]; // 保留原本的填寫時間

    if (found.sheet.getName() === sheetName) {
      writeRow(found.sheet, found.row, rowValues);
    } else {
      // 專案名稱有變更：先寫入新專案工作表，再從原工作表移除
      var target = getOrCreateSheet(ss, sheetName);
      writeRow(target, target.getLastRow() + 1, rowValues);
      found.sheet.deleteRow(found.row);
    }
    return jsonOutput({ status: "success", action: "update" });
  }

  // ── 新增 ──
  var sheet = getOrCreateSheet(ss, sheetName);
  writeRow(sheet, sheet.getLastRow() + 1, rowValues);

  return jsonOutput({ status: "success", action: "insert", projectSheet: sheetName });
}

function doOptions(e) {
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
}
