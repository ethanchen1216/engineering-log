// Firestore REST API 用戶端（Cloudflare Workers 無法使用 Firebase Admin SDK：執行時會出現
// "EvalError: Code generation from strings disallowed"）。
// 認證：Service Account JSON（Worker secret GCP_SERVICE_ACCOUNT）→ RS256 JWT → OAuth access token（快取）
// 注意：私鑰、token 與 Firestore 原始錯誤絕不回傳給前端，也不寫進 log。

const SCOPE = "https://www.googleapis.com/auth/datastore";
const API = "https://firestore.googleapis.com/v1";

export class FirestoreError extends Error {
  constructor(httpStatus, status) {
    super(`firestore ${httpStatus} ${status || ""}`.trim());
    this.httpStatus = httpStatus;
    this.status = status || ""; // 例如 NOT_FOUND / ALREADY_EXISTS / FAILED_PRECONDITION
  }
}

// ── 認證 ──
let credCache = null;   // { raw, sa, key }
let tokenCache = null;  // { email, token, exp }

async function credentials(env) {
  const raw = env.GCP_SERVICE_ACCOUNT || "";
  if (credCache && credCache.raw === raw) return credCache;
  let sa;
  try { sa = JSON.parse(raw); } catch { throw new Error("GCP_SERVICE_ACCOUNT is not valid JSON"); }
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error("GCP_SERVICE_ACCOUNT missing fields");
  const der = pemToDer(sa.private_key);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  credCache = { raw, sa, key };
  tokenCache = null;
  return credCache;
}

async function accessToken(env) {
  const { sa, key } = await credentials(env);
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp - 300 > now) return tokenCache.token;
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`));
  const assertion = `${head}.${claims}.${b64urlBytes(new Uint8Array(sig))}`;
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
  });
  if (!res.ok) throw new FirestoreError(res.status, "AUTH_FAILED");
  const data = await res.json();
  tokenCache = { email: sa.client_email, token: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.token;
}

// ── REST 呼叫 ──
export function firestore(env) {
  return {
    async projectId() { return (await credentials(env)).sa.project_id; },
    async docName(path) { return `projects/${await this.projectId()}/databases/(default)/documents/${path}`; },

    async request(method, suffix, body) {
      const pid = await this.projectId();
      const url = `${API}/projects/${pid}/databases/(default)/documents${suffix}`;
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await accessToken(env)}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch { /* 空回應 */ }
      if (!res.ok) {
        const status = data && data.error && data.error.status;
        console.error("firestore error", method, res.status, status || "");
        throw new FirestoreError(res.status, status);
      }
      return data;
    },

    // 取得單一文件；不存在回傳 null
    async get(path) {
      try {
        return await this.request("GET", `/${path}`);
      } catch (err) {
        if (err instanceof FirestoreError && err.httpStatus === 404) return null;
        throw err;
      }
    },

    // 一次讀取多份文件；回傳 Map(文件 ID → 文件 或 null)。batchGet 不保證回傳順序，所以用 ID 對應
    async batchGet(paths) {
      const out = new Map();
      if (!paths.length) return out;
      const docs = await Promise.all(paths.map(p => this.docName(p)));
      const res = await this.request("POST", ":batchGet", { documents: docs });
      for (const r of res || []) {
        if (r.found) out.set(docId(r.found), r.found);
        else if (r.missing) out.set(r.missing.slice(r.missing.lastIndexOf("/") + 1), null);
      }
      return out;
    },

    // 原子交易：全部成功或全部失敗
    async commit(writes) {
      return this.request("POST", ":commit", { writes });
    },

    // 非原子：每筆寫入各自成功或失敗（清理 backupQueue 用）
    async batchWrite(writes) {
      if (!writes.length) return { status: [] };
      return this.request("POST", ":batchWrite", { writes });
    },

    async runQuery(structuredQuery) {
      const res = await this.request("POST", ":runQuery", { structuredQuery });
      return (res || []).filter(r => r.document).map(r => r.document);
    },

    async count(structuredQuery) {
      const res = await this.request("POST", ":runAggregationQuery", {
        structuredAggregationQuery: { structuredQuery, aggregations: [{ alias: "n", count: {} }] },
      });
      const f = res && res[0] && res[0].result && res[0].result.aggregateFields;
      return f && f.n ? Number(f.n.integerValue || 0) : 0;
    },
  };
}

// ── 值轉換：JS ⇄ Firestore Value ──
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "object") return { mapValue: { fields: toFields(v) } };
  throw new Error("unsupported value");
}

export function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) fields[k] = toValue(v);
  return fields;
}

export function fromValue(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
  return null;
}

export function fromFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = fromValue(v);
  return obj;
}

export function docId(doc) {
  return doc.name.slice(doc.name.lastIndexOf("/") + 1);
}

// ── 查詢條件 ──
export function fieldFilter(field, op, value) {
  return { fieldFilter: { field: { fieldPath: field }, op, value: toValue(value) } };
}

export function whereAll(filters) {
  if (!filters.length) return undefined;
  if (filters.length === 1) return filters[0];
  return { compositeFilter: { op: "AND", filters } };
}

// ── base64url / PEM ──
function b64urlBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64url(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer;
}
