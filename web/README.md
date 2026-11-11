# Web 版（完整功能）

把 IT 資產管理系統安裝到伺服器，讓使用者用瀏覽器（電腦／平板／手機）遠端使用，
**不需要安裝單機版**。單機版（Electron）仍保留在 `desktop` 分支，可獨立使用或作為離線備援。

---

## 1. 功能對照

| 功能 | Web 版 |
| --- | --- |
| 登入／登出、修改自己的密碼 | ✅ |
| 總覽看板（統計卡、搜尋、資產履歷） | ✅ |
| 新增資產（自動編號：類別-部門-日期-流水號） | ✅ |
| 編輯資產（名稱／S/N／廠商／狀態／日期／規格／備註） | ✅ |
| 移至回收桶／還原 | ✅ |
| 維修登記、完工結案 | ✅ |
| 資產轉移（跨部門自動重新編號） | ✅ |
| 廠商新增／修改／刪除 | ✅ |
| 廠商維護紀錄 | ✅ |
| 欄位管理（自訂資產大類／部門） | ✅ |
| 帳號管理（新增／重設密碼／角色／停用／刪除） | ✅ |
| 匯出 Excel 盤點總表（含條碼貼紙） | ✅ |
| 匯入資產 Excel | ✅ |
| 資料庫備份下載 | ✅ |
| 廠商附件（NDA／合約／維護單據） | ⛔ 尚未支援（後續版本） |
| 資料庫還原、版本更新 | ⛔ 由伺服器端處理 |

---

## 2. 需求與啟動

- Node.js 18+
- 伺服器本機磁碟上要有一份 `asset_data.db`（可由單機版產生，或全新空庫自動建立）

```powershell
npm run web          # 預設 http://localhost:3010
```

環境變數（建議正式環境使用）：

```powershell
$env:WEB_PORT = "3010"
$env:WEB_HOST = "0.0.0.0"
$env:WEB_DB   = "D:\IT資產管理系統資料\asset_data.db"
npm run web
```

或建立 `web/config.json`（已列在 `.gitignore`）：

```json
{ "port": 3010, "host": "0.0.0.0", "dbPath": "D:\\IT資產管理系統資料\\asset_data.db" }
```

---

## 3. 帳號與權限

| 角色 | 預設帳號 | 權限 |
| --- | --- | --- |
| 👑 管理者 | `admin` / `5508888` | 全部功能 |
| 👤 一般使用者 | `User` / `1234` | 僅查詢與匯出報表 |

- 密碼以 scrypt + 隨機 salt 雜湊儲存（沿用 `app_users`）
- 登入失敗 5 次鎖定該 IP 60 秒
- Session 存於伺服器記憶體（8 小時），Cookie 為 HttpOnly + SameSite
- **寫入 API 一律在後端檢查角色**（非管理者回 403），不是只靠前端隱藏按鈕

---

## 4. API 一覽（除 login / health 外皆需登入）

### 讀取
| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/health` | 健康檢查（版本、DB 狀態） |
| GET | `/api/me` | 目前登入者 |
| GET | `/api/stats` | 儀表板統計 |
| GET | `/api/assets` | 資產清單 |
| GET | `/api/assets/:id` | 資產 + 維修 + 轉移 + 歷程 |
| GET | `/api/recycle` | 回收桶（管理者） |
| GET | `/api/repairs`、`/api/transfers` | 維修／轉移清單 |
| GET | `/api/vendors`、`/api/vendor-maint` | 廠商／維護紀錄 |
| GET | `/api/field-options` | 大類／部門選項 |
| GET | `/api/users` | 帳號清單（管理者） |
| GET | `/api/export/inventory.xlsx` | 匯出盤點總表 |
| GET | `/api/backup/db` | 下載資料庫備份（管理者） |

### 寫入（管理者）
`POST/PUT/DELETE /api/assets`、`/api/assets/:id/restore`、`/api/repairs`、`/api/repairs/:id/complete`、
`/api/transfers`、`/api/vendors`、`/api/vendor-maint`、`/api/field-options`、`/api/users`、
`/api/users/:id/password`、`POST /api/import/assets`（Excel base64）

`POST /api/me/password` 任何登入者皆可使用（需驗證目前密碼）。

---

## 5. 併發安全

- 所有寫入排隊執行，並使用 `BEGIN IMMEDIATE` 交易
- 資產編號在交易內取「同類別＋同部門」最大流水號 +1，避免多人同時新增撞號
- 轉移跨部門時，於同一交易內更新資產編號與關聯表（維修／歷程／轉移）

---

## 6. 上線檢查清單

- [ ] 透過 IIS／Nginx 反向代理並啟用 HTTPS
- [ ] 防火牆只開放必要 Port；對外網請走 VPN 或 IP 白名單
- [ ] 修改預設帳號密碼（`admin` / `5508888` 一定要改）
- [ ] 設定每日備份（可用 `/api/backup/db` 抓檔，或直接複製 `.db`）
- [ ] 以 Windows 服務常駐（NSSM 或 PM2）

### Windows 服務（NSSM 範例）

```powershell
nssm install ITAssetWeb "C:\Program Files\nodejs\node.exe" "D:\it-asset-manager\web\server.js"
nssm set ITAssetWeb AppDirectory "D:\it-asset-manager"
nssm set ITAssetWeb AppEnvironmentExtra WEB_PORT=3010 WEB_HOST=0.0.0.0 "WEB_DB=D:\IT資產管理系統資料\asset_data.db"
nssm start ITAssetWeb
```

---

## 7. 已知限制

- 廠商附件（NDA／合約／維護單據）尚未提供上傳下載
- 資料庫還原需在伺服器上手動替換檔案（避免誤操作）
- Session 存在記憶體：重啟服務後使用者需重新登入
- 多人「同時編輯同一筆資產」採後寫入覆蓋，尚無鎖定機制

