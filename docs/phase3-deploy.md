# Phase 3 部署指南：Cloudflare Worker + 伺服器端驗證

> 原則：先建好**測試環境**（備份試算表 + 測試 Worker）全部驗證通過，才動正式環境。
> 前端一定最後才切換；GAS 的「強制密鑰」在前端切換完成後才打開。

## 架構

```
前端（GitHub Pages）
  │  Authorization: Bearer <token>
  ▼
Cloudflare Worker  ── 驗證 PIN、簽發 token、判斷權限、檢查輸入
  │  POST body 夾帶 GAS_SHARED_SECRET + actor(role)
  ▼
Google Apps Script ── 驗證密鑰；師傅「只能改當天」依雲端原始日期判斷
  ▼
Google Sheets
```

## 會用到的密鑰（都不可以進 GitHub、不可以貼到對話）

| 名稱 | 放在哪裡 | 說明 |
|---|---|---|
| `PIN_ADMIN` / `PIN_WORKER` | Worker secret | 6 位數。**建議換新 PIN**：舊 PIN 的 hash 留在公開 GitHub 歷史裡，可以被反推 |
| `TOKEN_SECRET` | Worker secret | 簽發登入 token，隨機產生 |
| `GAS_SHARED_SECRET` | Worker secret **和** GAS 指令碼屬性 | 兩邊相同；測試與正式用**不同**的值 |
| `GAS_URL` | Worker secret | GAS 網頁應用程式網址 |
| `REQUIRE_SECRET` | GAS 指令碼屬性 | `false`：過渡期，舊前端仍可用；`true`：只接受 Worker |

產生隨機密鑰（直接複製到剪貼簿，畫面不顯示）：

```bash
openssl rand -base64 48 | tr -d '\n' | pbcopy
```

---

## A. 事前準備（只做一次）

1. 註冊 / 登入 Cloudflare：https://dash.cloudflare.com/sign-up （免費方案即可）
2. 安裝 Node.js LTS：https://nodejs.org → 下載 macOS Installer（.pkg）並安裝
3. 登入 wrangler（會開瀏覽器請你授權）：
   ```bash
   cd ~/工地日報表-app/worker && npx wrangler@4 login
   ```

## B. 測試環境

### B1. 測試用 GAS（使用備份試算表，不影響正式資料）
1. 打開備份試算表 `工程日誌_備份_v0-baseline_…` →「擴充功能 → Apps Script」
2. 貼上 `google-apps-script.js`（phase3 版本）並存檔
3. 「專案設定（齒輪）→ 指令碼屬性」新增：
   - `GAS_SHARED_SECRET` = 測試用密鑰（用上面的指令產生後貼上）
   - `REQUIRE_SECRET` = `true`
4. 「部署 → 新增部署作業 → 網頁應用程式」：執行身分「我」、存取權「所有人」→ 記下網址（測試 GAS URL）

### B2. 測試 Worker
```bash
cd ~/工地日報表-app/worker
npx wrangler@4 deploy --env test
npx wrangler@4 secret put PIN_ADMIN --env test
npx wrangler@4 secret put PIN_WORKER --env test
npx wrangler@4 secret put TOKEN_SECRET --env test
npx wrangler@4 secret put GAS_SHARED_SECRET --env test
npx wrangler@4 secret put GAS_URL --env test
```
每個 `secret put` 會要你貼上值；部署完成會顯示測試 Worker 網址
（`https://engineering-log-api-test.<你的子網域>.workers.dev`）。

### B3. 自動測試
```bash
cd ~/工地日報表-app && python3 scripts/smoke_test.py <測試 Worker 網址> --gas <測試 GAS URL>
```
全部 ✅ 才繼續。

### B4. 手動測試 UI（選做）
由 Claude 產生指向測試 Worker 的本機測試頁（http://localhost:8765），在瀏覽器實際操作登入、新增、修改、刪除。

---

## C. 正式環境

### C1. 正式 GAS（向下相容，現有前端不受影響）
1. 正式試算表 → Apps Script → 貼上 phase3 版本 → 存檔
2. 指令碼屬性：
   - `GAS_SHARED_SECRET` = 正式用密鑰（**和測試不同**）
   - `REQUIRE_SECRET` = `false`
3. 「管理部署作業 → 編輯 → 新版本」部署（**網址不變**）

### C2. 正式 Worker
```bash
cd ~/工地日報表-app/worker
npx wrangler@4 deploy --env=""
npx wrangler@4 secret put PIN_ADMIN --env=""
npx wrangler@4 secret put PIN_WORKER --env=""
npx wrangler@4 secret put TOKEN_SECRET --env=""
npx wrangler@4 secret put GAS_SHARED_SECRET --env=""
npx wrangler@4 secret put GAS_URL --env=""
```

### C3. 正式環境驗證（只讀，不寫入正式資料）
```bash
cd ~/工地日報表-app && python3 scripts/smoke_test.py <正式 Worker 網址> --readonly
```

### C4. 切換前端
由 Claude 把 `index.html` 的 `API_BASE` 改成正式 Worker 網址，合併 `phase3` 到 `main` 並推送（推送前會先確認）。
手機上重新整理，用**新 PIN** 測試登入、新增、修改、刪除。

### C5. 關閉 GAS 直連（最後一步）
正式 GAS 指令碼屬性 `REQUIRE_SECRET` 改成 `true`（不需要重新部署，立即生效）。
驗證：
```bash
cd ~/工地日報表-app && python3 scripts/smoke_test.py <正式 Worker 網址> --readonly --gas <正式 GAS URL>
```

---

## 回復方式

| 時間點 | 做法 |
|---|---|
| C4 之前 | 什麼都不用做，現有前端一直直連 GAS |
| C4 之後、C5 之前 | 前端退回 `v2-phase2`（Claude 執行 `git revert` 後推送） |
| C5 之後 | 先把 `REQUIRE_SECRET` 改回 `false`，再退回前端 |

## 日後維運

- **換 PIN**：`npx wrangler@4 secret put PIN_WORKER --env=""`，立即生效，不需改程式
- **讓所有人登出**：重新設定 `TOKEN_SECRET`
- **換 GAS 密鑰**：先改 Worker secret，再改 GAS 指令碼屬性（中間約數十秒寫入會失敗）
- **看 Worker 紀錄**：`npx wrangler@4 tail --env=""`
