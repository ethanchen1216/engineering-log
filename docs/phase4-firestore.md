# Phase 4：Firestore 遷移

> 2026-10-08 正式切換。Firestore 為主要資料庫（Source of Truth），Google Sheets 為備份 / 報表。
> 前端 `index.html` 零修改；API request / response 與 Phase 3 完全相同。

## 1. 架構

```
前端（GitHub Pages，未修改）
  │  Authorization: Bearer <token>
  ▼
Cloudflare Worker（DATA_PROVIDER=firestore）
  │  Firestore REST API + Service Account JWT
  ▼
Firestore（shiudi-log-prod，asia-east1）── 主要資料庫
  │  backupQueue（與資料同一交易寫入）→ ctx.waitUntil 立即同步 → Cron 每 15 分鐘重試 → 每日 03:00 完整核對
  ▼
GAS → Google Sheets ── 備份 / 報表（J 欄「同步版本」）
```

回滾：`DATA_PROVIDER=gas` → Worker 直接讀寫 GAS / Sheets（Phase 3 路徑，程式原樣保留在 `worker/src/providers/gas.js`）。

## 2. Firestore Schema

`dailyLogs/{原本的 log.id}`

| 欄位 | 型態 | 說明 |
|---|---|---|
| id, date, project, weather, workCategory, workType, workerCount, content, ts | string | 與 Phase 3 API 完全相同。`date`、`ts` 為 `YYYY-MM-DD`（台北業務日期）；`workType` 為「、」串接；`workerCount` 為「鋼筋:3人、水電:2人」 |
| createdAt, updatedAt | timestamp | 系統時間。遷移時 createdAt 取自 Sheets I 欄「填寫時間」 |
| createdBy, updatedBy | string | `pin:worker`、`pin:admin`、`migration` |

API 回應只回傳 9 個欄位，不包含管理欄位。

其他集合：
- `backupQueue/{logId}`：該筆待同步到 Sheets 的最新版本（version、attempts、lastError、queuedAt）
- `system/backupStatus`：最後成功 / 失敗時間、最後完整核對結果、最後警告

索引：`dailyLogs`：`project` 遞增 + `date` 遞減（`firestore/firestore.indexes.json`）。
規則：全部拒絕（`firestore/firestore.rules`）；只有 Worker 以 Service Account 存取。

## 3. Worker 存取方式

Firebase Admin SDK 無法在 Cloudflare Workers 執行（實測 `EvalError: Code generation from strings disallowed`），
改用 Firestore REST API：Service Account 私鑰以 Web Crypto RS256 簽 JWT → 換取 OAuth access token（快取約 55 分鐘）。
程式：`worker/src/firestore/client.js`。Firestore 原始錯誤只記錄在 Worker log，前端只收到 `DB_ERROR` / `CONFLICT` / `NOT_FOUND`。

## 4. 驗證

與 Phase 3 相同：PIN → Worker 簽發 12 小時 HS256 token；Durable Object 登入次數限制。

## 5. 權限

| 動作 | worker | admin |
|---|---|---|
| 讀取、新增 | ✅ | ✅ |
| 修改 | 只限 Firestore 上**原始日期**為台北今天的日誌 | ✅ |
| 刪除、刪除專案 | ❌ | ✅ |

修改時以 `updateTime` 前提條件寫入；讀取後被他人修改則回傳 `CONFLICT`。

## 6. 遷移程序

```bash
python3 scripts/migrate.py <WORKER_URL> dry-run   # 只分析
python3 scripts/migrate.py <WORKER_URL> migrate   # 寫入（需 MIGRATION_ENABLED=true 且 DATA_PROVIDER=gas）
python3 scripts/migrate.py <WORKER_URL> compare   # 逐筆比對 9 欄位，必須 100% MATCH
```

- 文件 ID = 原本 log.id；upsert，重複執行不產生重複資料（內容相同時「未變動」）
- dry run 回報：缺少 ID、重複 ID、格式錯誤、儲存格型態警告
- 寫入只允許在 `DATA_PROVIDER=gas` 時執行，避免用較舊的 Sheets 覆蓋 Firestore

## 7. 比對程序

`compare` 輸出 MATCH / MISMATCH / MISSING_IN_FIRESTORE / EXTRA_IN_FIRESTORE；
有任何差異、缺少 ID、重複 ID、格式錯誤都不算 100%。

## 8. 備份程序

- **即時**：每筆寫入與 `backupQueue/{logId}` 同一交易提交；回應使用者後在背景同步（重新讀取 Firestore 最新狀態再送 GAS）
- **重試**：Cron 每 15 分鐘處理 `backupQueue`；失敗累計 attempts、記錄錯誤代碼
- **版本保護**：GAS 只接受 version ≥ Sheets J 欄的資料；刪除記錄 tombstone（30 天），舊版本晚到不會覆蓋新版本或讓已刪除的資料復活
- **每日完整核對**（台北 03:00）：Firestore 全部資料 → Sheets；只改有差異的列；不刪除沒有 ID 的列，也不刪除比核對時間點更新的列
- **安全閥**（Worker 與 GAS 兩邊）：Firestore 為 0 筆，或少於 Sheets 的 80% → 停止、不修改 Sheets、記錄警告
- 手動：`migrate.py status`、`retry`、`full-sync`

## 9. 回滾程序

1. `python3 scripts/migrate.py <正式 URL> status` → 必須「待同步 0 筆」且「回滾準備 ✅」；否則先執行 `full-sync`
2. `worker/wrangler.toml` 正式環境 `DATA_PROVIDER = "gas"` → `cd worker && npx --yes wrangler@4 deploy --env=""`（約 10 秒，前端不需改）
3. 要切回 Firestore 時：
   ```bash
   cd worker && npx --yes wrangler@4 deploy --env="" --var DATA_PROVIDER:gas --var MIGRATION_ENABLED:true
   cd .. && python3 scripts/migrate.py <正式 URL> prune     # 把回滾期間的變動同步回 Firestore
   python3 scripts/migrate.py <正式 URL> compare            # 必須 100% MATCH
   ```
   再把 `DATA_PROVIDER` 改回 `firestore`、`MIGRATION_ENABLED` 改回 `false` 後部署。

## 10. 環境變數與密鑰

| 名稱 | 種類 | 說明 |
|---|---|---|
| `GCP_SERVICE_ACCOUNT` | secret（新增） | Service Account JSON（角色 Cloud Datastore User）；正式 / 測試各自一把，檔案匯入後已刪除 |
| `PIN_ADMIN`, `PIN_WORKER`, `TOKEN_SECRET`, `GAS_SHARED_SECRET`, `GAS_URL` | secret | 與 Phase 3 相同 |
| `DATA_PROVIDER` | var | `firestore`（目前）或 `gas` |
| `MIGRATION_ENABLED` | var | 平常 `false` |
| Cron | triggers | `*/15 * * * *`、`0 19 * * *` |

| 環境 | Worker | Firebase 專案 | Sheets 備份 |
|---|---|---|---|
| 正式 | engineering-log-api.shiudi-log.workers.dev | shiudi-log-prod | 正式試算表 |
| 測試 | engineering-log-api-test.shiudi-log.workers.dev | shiudi-log-test | 備份試算表 |

## 11. 部署順序（實際執行）

1. 本機開發，`tests/` 回歸測試
2. 建立 Firebase 專案 test / prod（asia-east1、Spark、正式版模式規則）
3. 測試：SA 金鑰 → 測試 GAS 更新 → 測試 Worker（gas 模式）→ dry run → 遷移 → 100% 比對 → 索引 → 切換 firestore → smoke → 備份故障演練 → 回滾演練
4. 正式：Worker 部署（gas 模式）→ SA 金鑰 → 索引 → 正式 GAS 更新 → dry run → 遷移 → 100% 比對 → 切換 firestore → smoke → full-sync → status → compare

## 12. 測試結果

| 項目 | 結果 |
|---|---|
| `node --test 'tests/*.test.js'` | 22/22 |
| 測試環境 smoke test（firestore） | 39/39 |
| 測試環境遷移 | 105/105，100% MATCH，重複執行未變動 105 |
| 備份故障演練 | GAS 故障時 CRUD 照常成功；待同步 2 筆被記錄；修復後 retry 2/2；100% MATCH |
| 回滾演練 | full-sync → ready ✅ → 切 gas → 回滾期間寫入 → prune（新增 1）→ 100% MATCH → 切回 firestore |
| 正式遷移 | 108/108，100% MATCH |
| 正式 smoke test（firestore） | 36/36 |
| 正式 full-sync / status / compare | SYNCED / 回滾準備 ✅ / 100% MATCH |
| `index.html` | 與 v3-phase3 完全相同 |

效能（同一測試環境、同一網頁實測）：

| 操作 | GAS | Firestore |
|---|---|---|
| 讀取全部 | 7.4 秒 | 1.3 秒 |
| 新增 | 4.9 秒 | 1.1 秒 |
| 修改 | 3.1 秒 | 0.9 秒 |
| 刪除 | 約 3 秒 | 0.9～1.8 秒 |

## 已知事項

- 實測約 1 秒，未達原先預估的 0.1～0.3 秒（修改 / 刪除需先讀再寫；首次請求需換 token）；仍快 3～5 倍
- GAS 偶爾暫時失敗：只讀呼叫（exportAll、sheetsStats、getLogs）自動重試一次；備份由 backupQueue 重試
- 讀取次數：Firestore 依文件數計費，前端每次開啟讀取全部日誌；資料量大時應改用 `startDate` / `limit`（後端已支援）
- Workers 免費方案每次請求 CPU 10 ms：資料量大幅增加時需留意
