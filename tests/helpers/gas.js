// 在 Node 的 vm 中執行「真正的」google-apps-script.js，搭配模擬的 Google Sheets。
// 模擬重點：寫入 "YYYY-MM-DD" 會被自動轉成 Date、數字字串會被轉成數字（除非儲存格格式為 "@"），與真實 Sheets 相同。
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HEADER = ["日期", "專案名稱", "天氣", "工程類別", "出工項目", "出工項目與人數", "備註", "系統ID", "填寫時間"];

export function taipeiDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 8 * 3600e3);
}

function autoConvert(v, fmt) {
  if (fmt === "@" || typeof v !== "string") return v;
  const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return taipeiDate(`${m[1]}-${m[2]}-${m[3]}`);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  ensure() {
    const s = this.sheet;
    while (s.rows.length < this.r + this.nr - 1) { s.rows.push([]); s.fmt.push([]); }
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setFontColor() { return this; }
  setNumberFormat(f) {
    this.ensure();
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.fmt[this.r - 1 + i][this.c - 1 + j] = f;
    return this;
  }
  setValues(vals) {
    this.ensure();
    vals.forEach((row, i) => row.forEach((v, j) => {
      const r = this.r - 1 + i, c = this.c - 1 + j;
      this.sheet.rows[r][c] = autoConvert(v, this.sheet.fmt[r][c]);
    }));
    this.sheet.writes++;
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  getValue() { const row = this.sheet.rows[this.r - 1]; return row && row[this.c - 1] !== undefined ? row[this.c - 1] : ""; }
}

export class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.fmt = []; this.writes = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(r => r.length)); }
  getDataRange() {
    const width = this.getLastColumn();
    const rows = this.rows;
    return { getValues: () => rows.map(r => Array.from({ length: width }, (_, i) => (r[i] === undefined ? "" : r[i]))) };
  }
  appendRow(vals) { this.rows.push(vals.map(v => autoConvert(v))); this.fmt.push([]); this.writes++; }
  deleteRow(n) { this.rows.splice(n - 1, 1); this.fmt.splice(n - 1, 1); this.writes++; }
  deleteRows(n, k) { this.rows.splice(n - 1, k); this.fmt.splice(n - 1, k); this.writes++; }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
}

export function createGas({ secret = "gas-secret", requireSecret = "true" } = {}) {
  const sheets = [];
  const ss = {
    getSheets: () => sheets.slice(),
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = new Sheet(n); sheets.push(s); return s; },
    deleteSheet: s => { const i = sheets.indexOf(s); if (i < 0) throw new Error("no such sheet"); sheets.splice(i, 1); },
  };
  const props = new Map([["GAS_SHARED_SECRET", secret], ["REQUIRE_SECRET", requireSecret]]);
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        deleteProperty: k => { props.delete(k); },
        getProperties: () => Object.fromEntries(props),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: "json", TEXT: "text" }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
    Utilities: {
      formatDate: (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
    },
    Date, JSON, String, Number, Math, Object, Array, Error, isNaN,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "google-apps-script.js"), "utf8"), ctx);

  const gas = {
    ss, sheets, props,
    fail: false,          // true → 模擬 GAS 無法連線
    calls: [],
    post(body) {
      this.calls.push(body.action);
      return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).s);
    },
    get() { return JSON.parse(ctx.doGet({}).s); },
    // 依專案建立工作表並寫入列（模擬既有資料，A 欄寫入字串後會被轉成 Date）
    seed(rows) {
      for (const r of rows) {
        let sh = ss.getSheetByName(r.sheet || r.project);
        if (!sh) { sh = ss.insertSheet(r.sheet || r.project); sh.appendRow(HEADER); }
        sh.appendRow([r.date, r.project, r.weather ?? "晴天", r.workCategory ?? "結構", r.workType ?? "", r.workerCount ?? "", r.content ?? "", r.id ?? "", r.createdAt ?? new Date("2026-09-01T02:00:00Z")]);
      }
    },
    sheetRows(name) {
      const sh = ss.getSheetByName(name);
      return sh ? sh.getDataRange().getValues().slice(1) : null;
    },
    allIds() {
      return sheets.filter(s => !["工程日誌", "Sheet1"].includes(s.name))
        .flatMap(s => s.getDataRange().getValues().slice(1).map(r => String(r[7] || "")));
    },
  };
  return gas;
}
