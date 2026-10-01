// ── 讀取所有專案工作表的資料 ──
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = ss.getSheets();
    var allLogs = [];

    sheets.forEach(function(sheet) {
      var name = sheet.getName();
      // 跳過總表
      if (name === "工程日誌" || name === "Sheet1") return;

      var data = sheet.getDataRange().getValues();
      if (data.length <= 1) return;

      for (var j = 1; j < data.length; j++) {
        var row = data[j];
        if (!row[0] && !row[1]) continue;

        var dateStr = String(row[0] || "");
        var tsStr = dateStr.replace(/\//g, "-");

        allLogs.push({
          id:           String(row[7] || Date.now() + "_" + j),
          date:         dateStr,
          project:      String(row[1] || ""),
          weather:      String(row[2] || ""),
          workCategory: String(row[3] || ""),
          workType:     String(row[4] || ""),
          workerCount:  String(row[5] || ""),
          content:      String(row[6] || ""),
          ts:           tsStr
        });
      }
    });

    // 依日期由新到舊排序
    allLogs.sort(function(a, b) {
      return b.ts.localeCompare(a.ts);
    });

    return ContentService
      .createTextOutput(JSON.stringify({ status: "success", logs: allLogs }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(error) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── 寫入／修改／刪除日誌 ──
function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) throw new Error("沒有收到有效資料");

    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 依專案名稱找或建立工作表
    var sheetName = (data.project || "未命名專案")
      .substring(0, 31)
      .replace(/[\\\/\*\?\[\]\:]/g, "")
      .trim();

    // ── 刪除 ──
    if (data.action === "delete") {
      var delSheet = ss.getSheetByName(sheetName);
      if (delSheet) {
        var delRows = delSheet.getDataRange().getValues();
        for (var i = delRows.length - 1; i >= 1; i--) {
          if (String(delRows[i][7]) === String(data.id)) {
            delSheet.deleteRow(i + 1);
            break;
          }
        }
      }
      return ContentService
        .createTextOutput(JSON.stringify({ status: "success", action: "delete" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 找或建立工作表
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(["日期","專案名稱","天氣","工程類別","出工項目","出工項目與人數","備註","系統ID","填寫時間"]);
      var hr = sheet.getRange(1, 1, 1, 9);
      hr.setFontWeight("bold");
      hr.setBackground("#1a2332");
      hr.setFontColor("#ffffff");
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

    // ── 修改 ──
    if (data.action === "update") {
      var updRows = sheet.getDataRange().getValues();
      for (var k = updRows.length - 1; k >= 1; k--) {
        if (String(updRows[k][7]) === String(data.id)) {
          sheet.getRange(k+1, 1).setValue(data.date || "");
          sheet.getRange(k+1, 2).setValue(data.project || "");
          sheet.getRange(k+1, 3).setValue(data.weather || "");
          sheet.getRange(k+1, 4).setValue(data.workCategory || "");
          sheet.getRange(k+1, 5).setValue(workTypeStr);
          sheet.getRange(k+1, 6).setValue(workerStr);
          sheet.getRange(k+1, 7).setValue(data.content || "");
          break;
        }
      }
      return ContentService
        .createTextOutput(JSON.stringify({ status: "success", action: "update" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── 新增 ──
    sheet.appendRow([
      data.date         || "",  // A: 日期
      data.project      || "",  // B: 專案名稱
      data.weather      || "",  // C: 天氣
      data.workCategory || "",  // D: 工程類別
      workTypeStr,              // E: 出工項目
      workerStr,                // F: 出工項目與人數
      data.content      || "",  // G: 備註
      data.id           || "",  // H: 系統ID
      new Date()                // I: 填寫時間
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ status: "success", action: "insert", projectSheet: sheetName }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(error) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doOptions(e) {
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
}
