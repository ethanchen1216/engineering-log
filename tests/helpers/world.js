// 測試環境：真正的 Worker 程式（worker/src）＋ 真正的 GAS 程式（google-apps-script.js）
// ＋ 模擬的 Google Sheets、Firestore REST、Durable Object，全部透過攔截 fetch 串起來。
import worker, { LoginLimiter } from "../../worker/src/index.js";
import { createGas } from "./gas.js";
import { createFakeFirestore } from "./fake-firestore.js";

export const PIN = { admin: "222222", worker: "111111" };
const GAS_URL = "https://gas.test/exec";
const API = "https://worker.test";

export function todayTaipei(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400e3);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

let keyPair = null;
async function serviceAccount() {
  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    );
  }
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  return {
    json: JSON.stringify({ type: "service_account", project_id: "shiudi-log-test", client_email: "worker@shiudi-log-test.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" }),
    publicKey: keyPair.publicKey,
    pem,
  };
}

export async function createWorld({ provider = "firestore", migration = "true", seed = [] } = {}) {
  const sa = await serviceAccount();
  const gas = createGas({ secret: "gas-secret" });
  gas.seed(seed);
  const fs = createFakeFirestore({ projectId: "shiudi-log-test", publicKey: sa.publicKey, clientEmail: "worker@shiudi-log-test.iam.gserviceaccount.com" });

  const store = new Map();
  const doCtx = { storage: {
    async get(k) { return store.has(k) ? structuredClone(store.get(k)) : undefined; },
    async put(k, v) { if (typeof k === "object") for (const [a, b] of Object.entries(k)) store.set(a, structuredClone(b)); else store.set(k, structuredClone(v)); },
    async delete(k) { store.delete(k); },
  } };

  const env = {
    PIN_ADMIN: PIN.admin, PIN_WORKER: PIN.worker, TOKEN_SECRET: "t".repeat(48),
    GAS_URL, GAS_SHARED_SECRET: "gas-secret", GCP_SERVICE_ACCOUNT: sa.json,
    ALLOWED_ORIGINS: "https://ethanchen1216.github.io", DATA_PROVIDER: provider, MIGRATION_ENABLED: migration,
  };
  const limiter = new LoginLimiter(doCtx, env);
  env.LOGIN_LIMITER = { idFromName: n => n, get: () => ({ fetch: (u, init) => limiter.fetch(new Request(u, init)) }) };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(GAS_URL)) {
      if (gas.fail) throw new TypeError("fetch failed");
      const out = (init.method || "GET") === "POST" ? gas.post(JSON.parse(init.body)) : gas.get();
      return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("googleapis.com")) return fs.handle(u, init);
    throw new Error("unexpected fetch " + u);
  };

  const world = {
    env, gas, fs, sa,
    pending: [],
    dropBackground: false, // true → 模擬 Worker 背景工作被中斷（waitUntil 沒有執行）
    ctx() {
      return { waitUntil: p => { if (!world.dropBackground) world.pending.push(p); else p.catch(() => {}); } };
    },
    async flush() { while (world.pending.length) await world.pending.shift(); },
    async call(method, path, { body, token, headers = {} } = {}) {
      const h = { ...headers };
      if (body !== undefined) h["Content-Type"] = "application/json";
      if (token) h.Authorization = `Bearer ${token}`;
      const res = await worker.fetch(new Request(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, world.ctx());
      return { status: res.status, body: await res.json(), raw: res };
    },
    async login(role) {
      const r = await world.call("POST", "/auth/login", { body: { pin: PIN[role] } });
      if (!r.body.success) throw new Error("login failed " + JSON.stringify(r.body));
      return r.body.data.token;
    },
    async scheduled(cron) {
      const tasks = [];
      await worker.scheduled({ cron }, env, { waitUntil: p => tasks.push(p) });
      await Promise.all(tasks);
    },
    // 前端送出的格式（與 index.html saveLog 相同）
    newLog(overrides = {}) {
      return {
        id: `ID_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        date: todayTaipei(), project: "測試專案", weather: "晴天", workCategory: "結構",
        workType: "鋼筋、水電", workerCount: JSON.stringify({ 鋼筋: "3", 水電: "2" }), content: "測試內容",
        ...overrides,
      };
    },
  };
  return world;
}
