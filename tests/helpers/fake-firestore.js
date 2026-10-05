// 記憶體版 Firestore REST API（只實作 Worker 用到的部分），用來驗證 REST 請求格式與行為：
// - OAuth token：驗證 Service Account JWT 的 RS256 簽章
// - commit：所有前提條件（exists / updateTime）先檢查，全部成功才寫入（原子）
// - batchWrite：每筆各自成功或失敗（非原子）
// - batchGet：故意打亂回傳順序
// - runQuery：等值 + 排序需要 firestore.indexes.json 宣告的複合索引，否則回傳 FAILED_PRECONDITION
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INDEXES = JSON.parse(fs.readFileSync(path.join(ROOT, "firestore/firestore.indexes.json"), "utf8")).indexes;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function err(status, code) {
  return json(status, { error: { code: status, message: `fake ${code}`, status: code } });
}

function rawValue(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("booleanValue" in v) return v.booleanValue;
  return null;
}

// Worker 會在模組層級快取 access token（正式環境的正確行為），所以已核發的 token 在所有模擬實例間共用
const issued = new Set();

export function createFakeFirestore({ projectId, publicKey, clientEmail }) {
  const docs = new Map(); // name → { fields, createTime, updateTime }
  let clock = Date.parse("2026-10-05T00:00:00Z") * 1000;
  const tick = () => { clock += 1; const ms = Math.floor(clock / 1000); return new Date(ms).toISOString().replace("Z", String(clock % 1000).padStart(3, "0") + "Z"); };
  const prefix = `projects/${projectId}/databases/(default)/documents`;
  const fake = {
    docs, prefix,
    requests: [],
    failNext: 0,             // > 0：接下來 N 個 Firestore 請求回傳 503
    beforeCommit: null,      // 測試用掛勾：commit 前執行（模擬同時修改）
    tokenRequests: 0,
    name: p => `${prefix}/${p}`,
    put(p, fields) { docs.set(`${prefix}/${p}`, { fields: structuredClone(fields), createTime: tick(), updateTime: tick() }); },
    get(p) { return docs.get(`${prefix}/${p}`) || null; },
    list(collection) {
      return [...docs.entries()].filter(([n]) => n.startsWith(`${prefix}/${collection}/`) && !n.slice(`${prefix}/${collection}/`.length).includes("/"));
    },
    clear(collection) { for (const [n] of fake.list(collection)) docs.delete(n); },
    async handle(url, init = {}) {
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com") return fake.token(init);
      fake.requests.push(`${init.method || "GET"} ${u.pathname.split("/documents")[1] || ""}`);
      const auth = (init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
      if (!issued.has(auth.replace("Bearer ", ""))) return err(401, "UNAUTHENTICATED");
      if (fake.failNext > 0) { fake.failNext--; return err(503, "UNAVAILABLE"); }
      const base = `/v1/${prefix}`;
      const p = decodeURIComponent(u.pathname);
      if (!p.startsWith(base)) return err(404, "NOT_FOUND");
      const rest = p.slice(base.length);
      const body = init.body ? JSON.parse(init.body) : {};
      if ((init.method || "GET") === "GET") {
        const d = docs.get(`${prefix}${rest}`);
        return d ? json(200, { name: `${prefix}${rest}`, ...structuredClone(d) }) : err(404, "NOT_FOUND");
      }
      if (rest === ":commit") return fake.commit(body.writes || []);
      if (rest === ":batchWrite") return fake.batchWrite(body.writes || []);
      if (rest === ":batchGet") return fake.batchGet(body.documents || []);
      if (rest === ":runQuery") return fake.runQuery(body.structuredQuery);
      if (rest === ":runAggregationQuery") {
        const r = fake.query(body.structuredAggregationQuery.structuredQuery);
        if (r.error) return r.error;
        return json(200, [{ result: { aggregateFields: { n: { integerValue: String(r.docs.length) } } } }]);
      }
      return err(400, "INVALID_ARGUMENT");
    },

    async token(init) {
      fake.tokenRequests++;
      const params = new URLSearchParams(init.body);
      const [h, c, s] = params.get("assertion").split(".");
      const b64 = x => Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, b64(s), new TextEncoder().encode(`${h}.${c}`));
      const claims = JSON.parse(b64(c).toString());
      if (!ok || claims.iss !== clientEmail || claims.scope !== "https://www.googleapis.com/auth/datastore") return json(400, { error: "invalid_grant" });
      const token = `tok_${fake.tokenRequests}`;
      issued.add(token);
      return json(200, { access_token: token, expires_in: 3600 });
    },

    check(w) {
      const name = w.update ? w.update.name : w.delete;
      const cur = docs.get(name);
      const pre = w.currentDocument;
      if (!pre) return null;
      if (pre.exists === false && cur) return "ALREADY_EXISTS";
      if (pre.exists === true && !cur) return "NOT_FOUND";
      if (pre.updateTime && (!cur || cur.updateTime !== pre.updateTime)) return "FAILED_PRECONDITION";
      return null;
    },
    apply(w) {
      if (w.delete) { docs.delete(w.delete); return; }
      const name = w.update.name;
      const cur = docs.get(name);
      const time = tick();
      if (w.updateMask && cur) {
        const fields = { ...cur.fields };
        for (const f of w.updateMask.fieldPaths) { if (f in w.update.fields) fields[f] = w.update.fields[f]; else delete fields[f]; }
        docs.set(name, { fields, createTime: cur.createTime, updateTime: time });
      } else {
        docs.set(name, { fields: structuredClone(w.update.fields), createTime: cur ? cur.createTime : time, updateTime: time });
      }
    },
    commit(writes) {
      if (writes.length > 500) return err(400, "INVALID_ARGUMENT");
      if (fake.beforeCommit) { const fn = fake.beforeCommit; fake.beforeCommit = null; fn(); }
      for (const w of writes) {
        const e = fake.check(w);
        if (e === "ALREADY_EXISTS") return err(409, e);
        if (e === "NOT_FOUND") return err(404, e);
        if (e) return err(400, e);
      }
      writes.forEach(w => fake.apply(w));
      return json(200, { writeResults: writes.map(() => ({})), commitTime: tick() });
    },
    batchWrite(writes) {
      const status = writes.map(w => {
        const e = fake.check(w);
        if (e) return { code: 9, message: e };
        fake.apply(w);
        return {};
      });
      return json(200, { writeResults: writes.map(() => ({})), status });
    },
    batchGet(names) {
      const out = names.map(n => (docs.has(n) ? { found: { name: n, ...structuredClone(docs.get(n)) } } : { missing: n }));
      out.sort(() => Math.random() - 0.5);
      return json(200, out);
    },
    query(q) {
      const coll = q.from[0].collectionId;
      const filters = [];
      const collect = f => {
        if (!f) return;
        if (f.compositeFilter) f.compositeFilter.filters.forEach(collect);
        else filters.push(f.fieldFilter);
      };
      collect(q.where);
      const orderBy = q.orderBy || [];
      // 索引檢查：有等值條件（非排序欄位）又有排序 → 需要複合索引
      const eqFields = filters.filter(f => f.op === "EQUAL").map(f => f.field.fieldPath).filter(fp => !orderBy.some(o => o.field.fieldPath === fp));
      if (eqFields.length && orderBy.length) {
        const ob = orderBy[0];
        const need = [...eqFields.map(fp => ({ fieldPath: fp, order: "ASCENDING" })), { fieldPath: ob.field.fieldPath, order: ob.direction === "DESCENDING" ? "DESCENDING" : "ASCENDING" }];
        const has = INDEXES.some(ix => ix.collectionGroup === coll && ix.fields.length === need.length &&
          ix.fields.every((f, i) => f.fieldPath === need[i].fieldPath && f.order === need[i].order));
        if (!has) return { error: err(400, "FAILED_PRECONDITION") };
      }
      let rows = fake.list(coll).map(([name, d]) => ({ name, ...structuredClone(d) }));
      for (const f of filters) {
        const fp = f.field.fieldPath, want = rawValue(f.value);
        rows = rows.filter(r => {
          const v = rawValue(r.fields[fp]);
          switch (f.op) {
            case "EQUAL": return v === want;
            case "GREATER_THAN": return v !== null && v > want;
            case "GREATER_THAN_OR_EQUAL": return v !== null && v >= want;
            case "LESS_THAN_OR_EQUAL": return v !== null && v <= want;
            default: throw new Error("unsupported op " + f.op);
          }
        });
      }
      for (const o of [...orderBy].reverse()) {
        const fp = o.field.fieldPath, dir = o.direction === "DESCENDING" ? -1 : 1;
        rows.sort((a, b) => {
          const x = rawValue(a.fields[fp]), y = rawValue(b.fields[fp]);
          return x === y ? 0 : (x > y ? dir : -dir);
        });
      }
      if (q.limit) rows = rows.slice(0, q.limit);
      if (q.select) rows = rows.map(r => ({ name: r.name, createTime: r.createTime, updateTime: r.updateTime, fields: {} }));
      return { docs: rows };
    },
    runQuery(q) {
      const r = fake.query(q);
      if (r.error) return r.error;
      return json(200, r.docs.length ? r.docs.map(d => ({ document: d, readTime: tick() })) : [{ readTime: tick() }]);
    },
  };
  return fake;
}
