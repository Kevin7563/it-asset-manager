# Web 版（Phase 1：唯讀查詢）

把 IT 資產管理系統安裝到伺服器，讓使用者用瀏覽器（電腦／平板／手機）遠端使用。
**本階段為唯讀**：登入、查詢、搜尋、資產履歷、匯出 Excel 盤點總表（含條碼貼紙）。
新增／修改／維修／轉移等功能仍請使用單機版（`desktop` 分支）。

---

## 1. 需求

- Node.js 18+（與單機版相同）
- 伺服器上要有一份資料庫：`asset_data.db`（由單機版產生）
- 不需要額外 npm 套件（使用 Node 內建 `http` + 既有 `sqlite3` / `exceljs`）

---

## 2. 啟動

在專案根目錄：

```powershell
npm run web
```

預設：

| 項目 | 值 |
| --- | --- |
| 網址 | http://localhost:3010 |
| 資料庫 | `./uploads/asset_data.db`（**唯讀開啟**） |

### 環境變數（建議正式環境使用）

```powershell
$env:WEB_PORT = "3010"
$env:WEB_HOST = "0.0.0.0"        # 0.0.0.0 = 區網可連
$env:WEB_DB   = "D:\IT資產管理系統資料\asset_data.db"
npm run web
```

也可以建立 `web/config.json`：

```json
{
  "port": 3010,
  "host": "0.0.0.0",
  "dbPath": "D:\\IT資產管理系統資料\\asset_data.db"
}
```

---

## 3. 帳號

沿用資料庫 `app_users` 表（與單機版相同密碼）：

| 角色 | 帳號 | 預設密碼 |
| --- | --- | --- |
| 管理者 | `admin` | `5508888` |
| 一般使用者 | `User` | `1234` |

- 密碼以 scrypt + salt 雜湊儲存
- 登入失敗 5 次會鎖定該 IP 60 秒
- Session 存在伺服器記憶體（重啟後需重新登入），Cookie 為 HttpOnly

---

## 4. API 一覽（皆需登入，除 login / health）

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/health` | 健康檢查（版本、DB 狀態） |
| POST | `/api/login` | `{ username, password }` → 設定 Cookie |
| POST | `/api/logout` | 登出 |
| GET | `/api/me` | 目前登入者 |
| GET | `/api/assets` | 資產清單（未刪除） |
| GET | `/api/assets/:id` | 單一資產 + 維修 + 轉移紀錄 |
| GET | `/api/field-options` | 資產大類／部門選項 |
| GET | `/api/export/inventory.xlsx` | 匯出盤點總表（xlsx） |

---

## 5. 上線檢查清單

- [ ] 伺服器防火牆只開放必要 Port（建議透過 IIS／Nginx 反向代理 + HTTPS）
- [ ] 資料庫每日備份（複製 `asset_data.db` 或使用 SQLite `.backup`）
- [ ] 帳號密碼已更換（預設 `admin/5508888` 一定要改）
- [ ] 若要對外網開放，務必走 VPN 或 IP 白名單
- [ ] 以 Windows 服務方式常駐（例如 NSSM 或 PM2）

### Windows 服務（NSSM 範例）

```powershell
nssm install ITAssetWeb "C:\Program Files\nodejs\node.exe" "D:\it-asset-manager\web\server.js"
nssm set ITAssetWeb AppDirectory "D:\it-asset-manager"
nssm set ITAssetWeb AppEnvironmentExtra WEB_PORT=3010 WEB_HOST=0.0.0.0 "WEB_DB=D:\IT資產管理系統資料\asset_data.db"
nssm start ITAssetWeb
```

---

## 6. 限制（Phase 1）

- 僅唯讀：不提供新增／修改／刪除／維修／轉移／廠商維護
- 沒有帳號管理介面（請用單機版管理帳號）
- 沒有附件下載（NDA／合約／維護單據）— 規劃於 Phase 2
- 匯出僅「盤點總表」（單筆資產履歷匯出規劃於 Phase 2）
