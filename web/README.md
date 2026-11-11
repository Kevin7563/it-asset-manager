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
| 廠商管理看板（清單、搜尋、統計、匯出、點名稱看完整資訊） | ✅ |
| 新增廠商資訊 | ✅ |
| 廠商資料維護（編輯／註銷／附件） | ✅ |
| 廠商維護歷程看板（統計卡、單一廠商匯出、🔍 檢視明細＋單據） | ✅ |
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
| 匯入單機版備份（.zip／.db，含附件與路徑自動修正） | ✅ |
| 附件路徑修復（單機版自訂資料夾的附件，上傳資料夾 ZIP 重新對應） | ✅ |
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
| 📊 廠商管理看板 | 廠商清單（搜尋、統計卡：未簽 NDA／合約 60 天內到期／已到期）、匯出、📎 附件、✏️ 帶入維護頁；**點廠商名稱 → 完整資訊彈窗（唯讀）** |
| ➕ 新增廠商資訊 | 建立廠商（同名視為更新） |
| ✏️ 廠商資料維護 | 搜尋或從下拉選廠商 → 編輯資料、上傳附件、註銷廠商（開啟時取得編輯鎖） |
| 🗂️ 廠商維護歷程看板 | 統計列（總數／本月／已簽收／未簽收／費用合計）、廠商設備維護歷程名冊、單一廠商匯出、快速篩選、9 欄表格（可切換日期排序）、🔍 檢視明細彈窗（含單據下載／刪除） |
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

---

## 8. 從單機版搬家（匯入備份 .zip／.db）

Web 版可以直接吃單機版的備份檔，不需要手動複製資料庫檔案。

### 步驟

1. 在單機版執行「🗄️ 系統管理 → 資料庫備份 → 全部資料」：
   - 得到 `backup_全備份_YYYYMMDD_HHMMSS.db`（資料）
   - 若有勾「一併備份附件檔」，會另外得到 `backup_附件_YYYYMMDD_HHMMSS.zip`（NDA／合約／維護單據）
2. 登入 Web 版（需管理者）→ 左側「📥 匯入／備份」→ **📥 匯入單機版備份（.zip／.db）**
3. 一次選取上面兩個檔案（可多選；也可以直接選整個資料夾壓成的 ZIP）→ 按「📥 開始匯入」→ 確認
4. 完成後按「🔄 重新載入頁面」即可看到單機版資料

> 也可以先把單機版的整個資料夾（含 `asset_data.db` 與 `vendor_files`）壓成一個 ZIP，直接選那一個 ZIP 即可。

### 匯入會做什麼

| 動作 | 說明 |
| --- | --- |
| 覆蓋資料表 | `assets_new`、`vendors_new`、`repairs_new`、`transfers_new`、`asset_history_new`、`vendor_maint_records`（欄位取交集，新舊 schema 都相容） |
| 保留帳號 | `app_users`、`web_sessions`（登入狀態）**不會被覆蓋**，匯入後原本的帳號密碼照用 |
| 欄位選項 | 勾選「一併匯入欄位選項」時，`field_options`（自訂大類／部門）也會一起帶過來 |
| 附件檔 | 解壓到 `<資料庫資料夾>\vendor_files\`，並把資料庫內記錄的舊絕對路徑**自動改指向新位置** |
| 安全備份 | 匯入前自動把目前資料庫複製到 `<資料庫資料夾>\backups\asset_data_before_import_*.db` |
| 編輯鎖 | 匯入後清空 `edit_locks`（舊鎖已無意義） |

### 支援的檔案格式

- `.db`：單機版「全備份／資產／廠商」備份檔，或整份 `asset_data.db`
- `.zip`：單機版「附件檔備份」，或整個資料夾壓縮（deflate／store、UTF-8 檔名皆可；不支援 ZIP64 與加密 ZIP）
- 可一次上傳多個檔案（例如 `.db` + `.zip`）

### 常見問題

| 症狀 | 原因／處理 |
| --- | --- |
| 「檔案內找不到資料庫（.db）或附件」 | 選到 `.db-wal`／`.db-shm` 或空的 ZIP；請選 `.db` 或含 `vendor_files` 的 `.zip` |
| 「只支援 .zip 或 .db 檔」 | 混入了其他副檔名，請只選備份檔 |
| 匯入後附件打不開 | 若只匯入 `.db` 而沒有 `.zip`，資料庫記錄的仍是單機版舊路徑；補匯入附件 `.zip` 即會自動修正路徑 |
| 匯入後想反悔 | 用「♻️ 資料庫還原（危險操作）」選 `backups\asset_data_before_import_*.db` 即可回到匯入前 |

### 附件點不開？（單機版把檔案放在自訂資料夾）

單機版允許把 NDA／合約放在任何磁碟位置（例如 `D:\CITRMS\CIT資產管理系統資料\...`、`D:\ITRMS\...`）。
這些檔案**不在**單機版備份的 `.zip`／`.db` 內，所以匯入後資料庫仍記錄舊路徑，點附件會出現
「檔案路徑不合法」或「找不到檔案」。

處理方式（Web 版管理者）：

1. 在單機版把那些資料夾**按右鍵 → 傳送到 → 壓縮的資料夾**（可一次壓多個，例如 `CITRMS.zip`、`ITRMS.zip`）
2. Web 版 → 「📥 匯入／備份」→ **🔧 附件路徑修復**
3. 先看「附件狀態：可用 N ／ 缺少 M」確認現況（滑鼠移到文字上可看缺少的範例路徑）
4. 選擇 ZIP（可多選）→「🔧 修復附件路徑」→ 確認
5. 完成後會顯示：解壓檔案 N 個、路徑修正 N 個、修復前後可用／缺少數量
6. 按 `F5` 重新整理，回廠商看板點廠商名稱 → 📎 附件即可下載

> 不想壓 ZIP 也可以：直接把資料夾複製到 `<資料庫資料夾>\imported_files\`（保留原本結構），
> 再按一次「🔧 修復附件路徑」（**不用選檔**）即可重新對應。

**運作方式**

- ZIP 內的檔案（含 `vendor_files`）解壓到 `<資料庫資料夾>\imported_files\<原資料夾結構>\`
- 資料庫內的舊路徑依序比對：① `vendor_files` 相對路徑 ② **尾段路徑**（最長優先，可跨磁碟） ③ 檔名
- 比對到就改寫成新位置；比對不到則保留原字串（檔名仍會顯示，並列入「缺少」統計）
- 可重複執行；已正確的路徑不會被改動

**注意**

- 只會解壓「檔案」，不會覆蓋資料庫，也不會刪除任何檔案
- 重複檔名若內容不同，建議把整個上層資料夾一起壓縮（保留目錄結構），系統會優先以尾段路徑比對
- 若要還原資料庫，用「♻️ 資料庫還原」選 `backups\` 內的備份（匯入前的自動備份也在這裡）

## 9. 疑難排解

### ❌ 找不到資料庫檔案：C:\Users\...\Temp\...\asset_data.db

代表啟動時使用的資料庫路徑指向不存在的檔案。最常見原因是**先前測試留下的 `WEB_DB` 環境變數**還指向暫存資料夾（該資料夾已被清除）。

```powershell
# 1) 查看目前設定
$env:WEB_DB                                               # 目前視窗
[Environment]::GetEnvironmentVariable('WEB_DB','User')    # 使用者層級
[Environment]::GetEnvironmentVariable('WEB_DB','Machine') # 系統層級

# 2) 清除（只影響目前視窗）
Remove-Item Env:WEB_DB

# 3) 重新啟動
npm run web
```

- 若 `uploads\asset_data.db` 存在，程式會**自動退回預設資料庫**並在啟動訊息提示（設定來源顯示「預設（專案內 uploads）」）。
- 要「路徑錯了就直接失敗、不要自動退回」，設定 `WEB_DB_STRICT=1`。
- 要固定使用自己的資料庫，建議用 `web/config.json`（複製 `web/config.json.example`）：

```json
{ "port": 3010, "host": "0.0.0.0", "dbPath": "D:\\IT資產管理系統資料\\asset_data.db" }
```

優先順序：**環境變數 `WEB_DB` > `web/config.json` > 預設 `uploads\asset_data.db`**

### 啟動訊息怎麼看

```
  資料庫  ：D:\it-asset-manager\uploads\asset_data.db（預設（專案內 uploads））
                  ↑ 實際使用的檔案                       ↑ 這個路徑的來源
                                                          （環境變數 WEB_DB / web/config.json / 預設）
```

若來源顯示「環境變數 WEB_DB」但路徑不是你要的，就是環境變數沒清掉。

