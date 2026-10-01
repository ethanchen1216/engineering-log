// 施工工程日誌 API Worker
// Frontend → (Bearer token) → 本 Worker → (共用密鑰) → Google Apps Script → Google Sheets
//
// Secrets（wrangler secret put，不可寫進程式碼或 GitHub）：
//   PIN_ADMIN / PIN_WORKER   6 位數登入密碼
//   TOKEN_SECRET             簽發登入 token 用的金鑰（至少 32 字元）
//   GAS_SHARED_SECRET        與 GAS 指令碼屬性 GAS_SHARED_SECRET 相同
//   GAS_URL                  GAS 網頁應用程式網址
// Vars（wrangler.toml）：
//   ALLOWED_ORIGINS          允許的前端來源，逗號分隔
//   TOKEN_TTL_SECONDS        token 有效秒數（選填，預設 12 小時）

const DEFAULT_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;

// ── 角色權限（真正的權限判斷在這裡；前端隱藏按鈕只是使用體驗）──
// 師傅「只能修改當天日誌」需要雲端上的原始日期，由 GAS 依 Worker 帶入的 actor 判斷
const PERMISSIONS = {
  "logs:read":       ["admin", "worker"],
  "logs:create":     ["admin", "worker"],
  "logs:update":     ["admin", "worker"],
  "logs:delete":     ["admin"],
  "projects:delete": ["admin"],
};

// ── 錯誤代碼 → HTTP 狀態與給使用者看的訊息（不外洩內部錯誤）──
const ERRORS = {
  INVALID_PIN:    [401, "密碼錯誤，請再試一次"],
  RATE_LIMITED:   [429, "嘗試次數過多，請稍後再試"],
  UNAUTHORIZED:   [401, "請重新登入"],
  TOKEN_EXPIRED:  [401, "登入已逾時，請重新登入"],
  FORBIDDEN:      [403, "沒有權限執行此操作"],
  NOT_FOUND:      [404, "找不到資料"],
  BAD_REQUEST:    [400, "資料格式錯誤"],
  GAS_ERROR:      [502, "雲端資料庫暫時無法處理，請稍後再試"],
  INTERNAL_ERROR: [500, "系統錯誤，請稍後再試"],
};

class ApiError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    this.userMessage = message;
    this.extra = extra;
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return jsonResponse(errorBody("FORBIDDEN", "來源不被允許"), 403, {});
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      return await route(request, env, cors);
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err, cors);
      console.error("unhandled", err && err.stack || err);
      return errorResponse(new ApiError("INTERNAL_ERROR"), cors);
    }
  },
};

// ── 路由 ──
async function route(request, env, cors) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (path === "/health" && method === "GET") return ok({ status: "ok" }, cors);
  if (path === "/auth/login" && method === "POST") return ok(await loginWithPin(request, env), cors);

  // 以下都需要登入
  const user = await authenticate(request, env);

  if (path === "/logs" && method === "GET") {
    authorize(user, "logs:read");
    const r = await callGas(env, user, { action: "getLogs" });
    return ok(r.logs || [], cors);
  }
  if (path === "/logs" && method === "POST") {
    authorize(user, "logs:create");
    const body = await readJson(request);
    const log = validateLog(body, { requireId: true });
    const r = await callGas(env, user, { action: "insert", ...log });
    return ok(r.log || null, cors);
  }

  const logMatch = path.match(/^\/logs\/([^/]+)$/);
  if (logMatch && method === "PUT") {
    authorize(user, "logs:update");
    const id = validateId(decodeURIComponent(logMatch[1]));
    const body = await readJson(request);
    const log = validateLog(body, { requireId: false });
    const r = await callGas(env, user, { action: "update", ...log, id });
    return ok(r.log || null, cors);
  }
  if (logMatch && method === "DELETE") {
    authorize(user, "logs:delete");
    const id = validateId(decodeURIComponent(logMatch[1]));
    const project = optionalString(url.searchParams.get("project"), 100, "project");
    await callGas(env, user, { action: "delete", id, project });
    return ok(null, cors);
  }

  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (projectMatch && method === "DELETE") {
    authorize(user, "projects:delete");
    const project = requiredString(decodeURIComponent(projectMatch[1]), 100, "project");
    const r = await callGas(env, user, { action: "deleteProject", project });
    // 確認 GAS 真的執行了專案刪除（舊版 GAS 不認得此 action）
    if (r.action !== "deleteProject") throw new ApiError("GAS_ERROR");
    return ok({ deleted: r.deleted || 0 }, cors);
  }

  throw new ApiError("NOT_FOUND", "找不到此 API");
}

// ── 登入：PIN（未來可新增 LIFF 等其他登入方式，共用 issueToken）──
async function loginWithPin(request, env) {
  const body = await readJson(request);
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!/^\d{6}$/.test(pin)) throw new ApiError("BAD_REQUEST", "請輸入 6 位數密碼");

  // 比對 PIN 與失敗次數記錄在同一個 Durable Object 內完成，避免平行請求繞過次數限制
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const limiter = env.LOGIN_LIMITER.get(env.LOGIN_LIMITER.idFromName("global"));
  const res = await limiter.fetch("https://limiter/attempt", {
    method: "POST",
    body: JSON.stringify({ ip, pin }),
  });
  const result = await res.json();
  if (result.error === "RATE_LIMITED") {
    const minutes = Math.max(1, Math.ceil(result.retryAfter / 60));
    throw new ApiError("RATE_LIMITED", `嘗試次數過多，請 ${minutes} 分鐘後再試`, { retryAfter: result.retryAfter });
  }
  if (result.error === "CONFIG") throw new Error("PIN secrets not configured");
  if (!result.role) throw new ApiError("INVALID_PIN");

  const user = { sub: `pin:${result.role}`, role: result.role, amr: "pin" };
  const { token, exp } = await issueToken(user, env);
  return { token, role: user.role, expiresAt: exp * 1000 };
}

// ── 驗證：所有需要登入的 API 都經過這裡 ──
// 回傳使用者 { sub, role, amr }；不論用哪種方式登入，之後都使用本 Worker 簽發的 token
async function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m) throw new ApiError("UNAUTHORIZED");
  return verifyToken(m[1].trim(), env);
}

function authorize(user, permission) {
  if (!PERMISSIONS[permission].includes(user.role)) throw new ApiError("FORBIDDEN");
}

// ── Token：HS256 JWT（Web Crypto，Workers 原生支援）──
async function issueToken(user, env) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(env.TOKEN_TTL_SECONDS) || DEFAULT_TOKEN_TTL_SECONDS;
  const payload = { sub: user.sub, role: user.role, amr: user.amr, iat: now, exp: now + ttl, jti: crypto.randomUUID() };
  const head = b64urlEncodeJson({ alg: "HS256", typ: "JWT" });
  const body = b64urlEncodeJson(payload);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(`${head}.${body}`));
  return { token: `${head}.${body}.${b64urlEncodeBytes(new Uint8Array(sig))}`, exp: payload.exp };
}

async function verifyToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ApiError("UNAUTHORIZED");
  let header, payload, sig;
  try {
    header = JSON.parse(b64urlDecodeText(parts[0]));
    payload = JSON.parse(b64urlDecodeText(parts[1]));
    sig = b64urlDecodeBytes(parts[2]);
  } catch {
    throw new ApiError("UNAUTHORIZED");
  }
  if (header.alg !== "HS256" || header.typ !== "JWT") throw new ApiError("UNAUTHORIZED");
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(env), sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new ApiError("UNAUTHORIZED");
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) throw new ApiError("TOKEN_EXPIRED");
  if (!PERMISSIONS["logs:read"].includes(payload.role)) throw new ApiError("UNAUTHORIZED");
  return { sub: payload.sub, role: payload.role, amr: payload.amr };
}

async function hmacKey(env) {
  const secret = env.TOKEN_SECRET || "";
  if (secret.length < 32) throw new Error("TOKEN_SECRET missing or too short");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// ── 呼叫 GAS ──
// 密鑰放在 POST body（GAS 讀不到 header，也避免出現在網址或紀錄中）
async function callGas(env, user, payload) {
  if (!env.GAS_URL || !env.GAS_SHARED_SECRET) throw new Error("GAS secrets not configured");
  let res, data;
  try {
    res = await fetch(env.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ ...payload, secret: env.GAS_SHARED_SECRET, actor: { role: user.role, sub: user.sub } }),
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

// ── 輸入驗證：只轉送白名單欄位 ──
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError("BAD_REQUEST", "資料太大");
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new ApiError("BAD_REQUEST");
  }
}

function validateLog(body, { requireId }) {
  const log = {
    date:         requiredString(body.date, 10, "date"),
    project:      requiredString(body.project, 100, "project"),
    weather:      optionalString(body.weather, 20, "weather"),
    workCategory: optionalString(body.workCategory, 10, "workCategory"),
    workType:     optionalString(body.workType, 1000, "workType"),
    workerCount:  optionalString(body.workerCount, 2000, "workerCount"),
    content:      optionalString(body.content, 5000, "content"),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(log.date)) throw new ApiError("BAD_REQUEST", "日期格式錯誤");
  if (log.workCategory && !["結構", "裝修"].includes(log.workCategory)) throw new ApiError("BAD_REQUEST", "工程類別錯誤");
  if (log.workerCount) {
    let counts;
    try { counts = JSON.parse(log.workerCount); } catch { throw new ApiError("BAD_REQUEST", "出工人數格式錯誤"); }
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) throw new ApiError("BAD_REQUEST", "出工人數格式錯誤");
  }
  if (requireId) log.id = validateId(body.id);
  return log;
}

function validateId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new ApiError("BAD_REQUEST", "日誌 ID 格式錯誤");
  return id;
}

function requiredString(v, max, field) {
  const s = optionalString(v, max, field);
  if (!s) throw new ApiError("BAD_REQUEST", `缺少必要欄位：${field}`);
  return s;
}

function optionalString(v, max, field) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new ApiError("BAD_REQUEST", `欄位格式錯誤：${field}`);
  const s = v.trim();
  if (s.length > max) throw new ApiError("BAD_REQUEST", `欄位過長：${field}`);
  return s;
}

// ── CORS：只允許設定的前端來源；沒有 Origin 的請求（例如伺服器端工具）不加 CORS 標頭 ──
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const base = { "Vary": "Origin" };
  if (!origin) return base;
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    ...base,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// ── 回應格式：{ success: true, data } / { success: false, error, message } ──
function ok(data, cors) {
  return jsonResponse({ success: true, data }, 200, cors);
}

function errorBody(code, message, extra) {
  return { success: false, error: code, message: message || ERRORS[code][1], ...(extra || {}) };
}

function errorResponse(err, cors) {
  const [status] = ERRORS[err.code] || ERRORS.INTERNAL_ERROR;
  const headers = { ...cors };
  if (err.extra && err.extra.retryAfter) headers["Retry-After"] = String(err.extra.retryAfter);
  return jsonResponse(errorBody(err.code, err.userMessage, err.extra), status, headers);
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

// ── base64url ──
function b64urlEncodeBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeJson(obj) {
  return b64urlEncodeBytes(new TextEncoder().encode(JSON.stringify(obj)));
}
function b64urlDecodeBytes(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function b64urlDecodeText(str) {
  return new TextDecoder().decode(b64urlDecodeBytes(str));
}

// ── 登入次數限制（Durable Object，強一致，單一實例）──
// 同一 IP：15 分鐘內失敗 5 次 → 鎖 15 分鐘
// 全部來源：10 分鐘內失敗 30 次 → 暫停 PIN 登入 10 分鐘（防止換 IP 暴力破解）
const IP_MAX_FAILS = 5, IP_WINDOW_MS = 15 * 60e3, IP_LOCK_MS = 15 * 60e3;
const GLOBAL_MAX_FAILS = 30, GLOBAL_WINDOW_MS = 10 * 60e3, GLOBAL_LOCK_MS = 10 * 60e3;

export class LoginLimiter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const { ip, pin } = await request.json();
    const storage = this.ctx.storage;
    const now = Date.now();
    const ipKey = `ip:${ip}`;
    const g = (await storage.get("global")) || { fails: 0, windowStart: now, lockedUntil: 0 };
    const r = (await storage.get(ipKey)) || { fails: 0, windowStart: now, lockedUntil: 0 };

    const lockedUntil = Math.max(g.lockedUntil, r.lockedUntil);
    if (lockedUntil > now) return Response.json({ error: "RATE_LIMITED", retryAfter: Math.ceil((lockedUntil - now) / 1000) });

    const role = matchPinRole(pin, this.env);
    if (role === "CONFIG") return Response.json({ error: "CONFIG" });
    if (role) {
      await storage.delete(ipKey);
      return Response.json({ role });
    }

    recordFailure(r, now, IP_MAX_FAILS, IP_WINDOW_MS, IP_LOCK_MS);
    recordFailure(g, now, GLOBAL_MAX_FAILS, GLOBAL_WINDOW_MS, GLOBAL_LOCK_MS);
    await storage.put({ global: g, [ipKey]: r });
    return Response.json({ error: "INVALID_PIN" });
  }
}

function recordFailure(rec, now, maxFails, windowMs, lockMs) {
  if (now - rec.windowStart > windowMs) { rec.fails = 0; rec.windowStart = now; }
  rec.fails++;
  if (rec.fails >= maxFails) { rec.lockedUntil = now + lockMs; rec.fails = 0; rec.windowStart = now; }
}

// 同步、固定時間比對（避免以回應時間推測 PIN）
function matchPinRole(pin, env) {
  const candidates = [["admin", env.PIN_ADMIN], ["worker", env.PIN_WORKER]].filter(([, p]) => /^\d{6}$/.test(p || ""));
  if (!candidates.length) return "CONFIG";
  let matched = null;
  for (const [role, p] of candidates) {
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= pin.charCodeAt(i) ^ p.charCodeAt(i);
    if (diff === 0 && !matched) matched = role;
  }
  return matched;
}
