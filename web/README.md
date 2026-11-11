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
| 廠商管理看板（清單、搜尋、統計、匯出） | ✅ |
| 新增廠商資訊 | ✅ |
| 廠商資料維護（編輯／註銷／附件） | ✅ |
| 廠商維護歷程看板（搜尋、匯出） | ✅ |
| 新增廠商維護紀錄 | ✅ |
| 欄位管理（自訂資產大類／部門） | ✅ |
| 帳號管理（新增／重設密碼／角色／停用／刪除） | ✅ |
| 匯出 Excel 盤點總表（含條碼貼紙） | ✅ |
| 匯出單筆資產履歷（3 工作表：基本資料／維修／轉移） | ✅ |
| 匯出廠商清單／廠商維護歷程 | ✅ |
| 匯入資產 Excel＋空白範本下載 | ✅ |
| 匯入廠商 Excel＋空白範本下載 | ✅ |
| 廠商附件（NDA／合約）上傳、下載、刪除 | ✅ |
| 廠商維護單據上傳、下載、刪除 | ✅ |
| 資料庫備份下載、附件 ZIP 備份 | ✅ |
| 資料庫還原（上傳 .db，還原前自動備份） | ✅ |
| 版本與系統資訊頁 | ✅ |
| Session 持久化（重啟不掉登入） | ✅ |
| 同時編輯鎖定（含衝突偵測） | ✅ |
| 資料庫還原、版本更新 | ✅／版本資訊（Web 版升級由伺服器部署） |

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

### 左側功能表（與單機版一致）

```
📊 總覽看板
📁 資訊資產管理
    ➕ 新增資訊資產
    🔧 資訊資產維修
    🔄 資訊資產轉移
    🗑️ 資源回收桶
🏢 廠商管理
    📊 廠商管理看板
        ➕ 新增廠商資訊
        ✏️ 廠商資料維護
    🗂️ 廠商維護歷程看板
        📝 新增廠商維護紀錄
⚙️ 系統管理
    🧩 欄位管理
    👥 帳號管理
    📥 匯入／備份
🔒 修改我的密碼（所有登入者）
```

**廠商管理 5 個頁面各自的職責**

| 頁面 | 用途 |
| --- | --- |
| 📊 廠商管理看板 | 廠商清單（搜尋、統計卡：未簽 NDA／合約 60 天內到期／已到期）、匯出、📎 附件、✏️ 帶入維護頁 |
| ➕ 新增廠商資訊 | 建立廠商（同名視為更新） |
| ✏️ 廠商資料維護 | 搜尋或從下拉選廠商 → 編輯資料、上傳附件、註銷廠商（開啟時取得編輯鎖） |
| 🗂️ 廠商維護歷程看板 | 維護紀錄清單（搜尋）、匯出、📎 單據 |
| 📝 新增廠商維護紀錄 | 建立維護紀錄，儲存後自動回到歷程看板 |

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
| GET | `/api/export/asset-history/:id.xlsx` | 匯出單筆資產履歷（3 工作表） |
| GET | `/api/export/vendors.xlsx`、`/api/export/vendor-maint.xlsx` | 廠商清單／維護歷程 |
| GET | `/api/template/assets.xlsx`、`/api/template/vendors.xlsx` | 匯入範本 |
| GET | `/api/files?path=…` | 附件下載（管理者，路徑白名單驗證） |
| GET | `/api/backup/db`、`/api/backup/files` | 資料庫備份／附件 ZIP（管理者） |
| GET | `/api/version` | 版本與系統資訊（管理者） |

### 寫入（管理者）
`POST/PUT/DELETE /api/assets`、`/api/assets/:id/restore`、`/api/repairs`、`/api/repairs/:id/complete`、
`/api/transfers`、`/api/vendors`、`/api/vendor-maint`、`/api/field-options`、`/api/users`、
`/api/users/:id/password`、`POST /api/import/assets`（Excel base64）

附件與備份：
- `POST /api/import/vendors`（Excel base64）
- `POST /api/vendors/:id/files`、`POST /api/vendors/:id/files/delete`
- `POST /api/vendor-maint/:id/docs`、`POST /api/vendor-maint/:id/docs/delete`
- `POST /api/backup/restore`（需 `confirm: "RESTORE"`）

`POST /api/me/password` 任何登入者皆可使用（需驗證目前密碼）。

---

## 5. 併發安全

- 所有寫入排隊執行，並使用 `BEGIN IMMEDIATE` 交易
- 資產編號在交易內取「同類別＋同部門」最大流水號 +1，避免多人同時新增撞號
- 轉移跨部門時，於同一交易內更新資產編號與關聯表（維修／歷程／轉移）

### 同時編輯鎖定（避免兩人互蓋）
- 按「✏️ 編輯」時會先取得該筆資料的**編輯鎖**（資產／廠商各自獨立）
- 鎖的有效期限 **10 分鐘**；儲存或關閉彈窗會立即釋放
- 別人正在編輯時，列表會顯示 **🔒（滑鼠移上去可看到是誰）**，點編輯會提示「由 XXX 編輯中」
- 儲存時另做 **`updated_at` 樂觀鎖**檢查：若資料已被他人修改，回 **409** 並提示重新整理，不會默默覆蓋
- 停用／改角色／重設密碼／刪除帳號時，該使用者的登入 Session 會**立即失效**

### 登入狀態持久化
- Session 同時寫入資料庫 `web_sessions`，服務重啟後使用者**不需要重新登入**
- 登出會同步刪除資料庫中的 Session；逾期（8 小時）自動清除

## 5-1. 多人協作常見情境

| 情境 | 系統行為 |
| --- | --- |
| A 正在編輯資產，B 也要編輯 | B 看到 🔒 與「由 A 編輯中」，無法進入編輯 |
| A 編輯中途關掉瀏覽器 | 鎖 10 分鐘後自動失效（其他人可接手） |
| A 開著編輯視窗超過 10 分鐘才存檔 | 樂觀鎖檢查資料是否被改過，未改可存、已改會提示重新整理 |
| 管理者停用某帳號 | 該帳號現有登入立即失效（下一動作回 401） |
| 伺服器重啟 | 已登入使用者維持登入狀態 |

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

- 編輯鎖為「軟鎖」：使用者直接關閉瀏覽器時，需等 10 分鐘自動失效
- 資料庫還原會**完全覆蓋**目前資料（系統會自動先備份到 `backups\`），請務必確認來源檔正確
- 附件檔存放於 `<資料庫所在資料夾>\vendor_files\`，搬家時請一併複製
- 多台伺服器同時服務同一個資料庫（水平擴充）尚未支援；目前設計為單一伺服器

