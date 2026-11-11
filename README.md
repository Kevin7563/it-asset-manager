# IT 資產管理系統（IT Asset Manager）

以 **Electron + SQLite** 打造的公司內部 IT 資產管理桌面應用程式（Windows）。
提供資產建檔、維修、移轉、盤點貼紙（QR Code / Code-128 條碼）、廠商管理與 Excel 匯出等功能，
所有資料保存在本機，不需連線即可使用。

- 目前版本：**v1.3.1**
- 系統開發：Kevin Chang
- 開發日期：2026.10.15（最近更新：2026.11.11）
- 聯絡信箱：kevin7563@gmail.com
- 版本更新：內建「🔄 版本更新」直接讀取 **GitHub Releases**（`Kevin7563/it-asset-manager`），可檢查、下載並安裝最新版本

---

## ✨ 功能特色

| 模組 | 說明 |
| --- | --- |
| 🗂️ 資產管理 | 新增／編輯／刪除資產，資產編號自動產生：`類別-部門-建檔日期-流水號` |
| ✏️ 資產編輯 | 可修改 7 個欄位，其餘欄位（編號、建檔日等）鎖定以維持資料一致性 |
| 🧾 資產規格/備註 | 記錄設備規格（CPU／RAM／硬碟）、加裝配備等補充資訊，同步顯示於總覽、履歷與盤點總表 |
| 🔧 維修管理 | 送修／完修登記，記錄維修廠商、費用、狀態 |
| 🔁 資產移轉 | 部門／使用人移轉紀錄，完整保留移轉歷程 |
| 📜 資產履歷 | 單一資產的維修週期 + 移轉紀錄整合檢視，可匯出 Excel |
| 🖨️ 盤點貼紙 | 匯出盤點總表，附 QR Code 與 Code-128 條碼（TwoCell 錨定，不變形） |
| 🏢 廠商管理 | 廠商建檔、維護歷程、清單匯出 |
| 🧩 欄位管理 | 自訂「資產大類／所屬部門」（名稱中文、代號英數 1~8 碼），即時套用至編號、下拉選單與匯出 |
| 🔄 版本更新 | 內建檢查更新、下載與安裝（讀取 `latest.json`） |
| 🔐 登入與權限 | 啟動需登入；管理者擁有全部功能，一般使用者僅能查詢與匯出報表 |
| 👥 帳號管理 | 新增帳號、重設密碼、切換角色、停用／啟用、刪除（僅管理者） |
| 💾 資料備份 | 資料庫與附件可自訂儲存位置，支援舊資料搬移 |

---

## 🌐 Web 版（完整功能，免安裝單機版）

除了單機版，本專案另提供 **Web 版**，可安裝在伺服器讓使用者遠端（電腦／平板／手機）使用。

```powershell
npm run web        # 預設 http://localhost:3010
```

- **完整功能（100% 對齊單機版）**：登入、新增／編輯／刪除／回收桶、維修、轉移、廠商與維護紀錄、廠商附件（NDA／合約／維護單據）上傳下載、欄位管理、帳號管理、匯出 Excel（盤點總表／資產履歷／廠商清單／維護歷程）、匯入資產與廠商（含範本下載）、資料庫備份與還原、附件 ZIP 備份、版本資訊
- 直接讀寫同一份 `asset_data.db`（WAL 模式），寫入採交易與排隊避免併發撞號
- 沿用同一組帳號密碼（`app_users`，scrypt 雜湊），**寫入 API 於後端檢查角色**
- 不需額外 npm 套件；詳細部署說明見 [`web/README.md`](web/README.md)

> 📦 **單機版保留**：桌面（Electron）版本以 `desktop` 分支與 `desktop-v1.3.1` 標籤保存，
> 可隨時 `git checkout desktop` 或下載該版本獨立使用／重新打包。

---

| 角色 | 帳號 | 預設密碼 | 權限 |
| --- | --- | --- | --- |
| 👑 管理者 | `admin` | `5508888` | 全部功能（含帳號管理、備份還原、版本更新、匯入） |
| 👤 一般使用者 | `User` | `1234` | 僅查詢資料（總覽／搜尋／資產履歷）與匯出報表 |

> ⚠️ 首次登入後請至「⚙️ 系統管理 → 👥 帳號管理 → 🔒 修改我的密碼」更換預設密碼。
> 密碼以 scrypt + 隨機 salt 雜湊儲存；一般使用者的寫入操作由後端 IPC 白名單直接攔阻。

---

## 🧱 技術架構

- **Electron 32.3.3**（主程序 `main.js` + 單頁前端 `index.html`）
- **SQLite**：`sqlite3` 本機資料庫（`assets_new`、`vendors_new`、`repairs_new`、`transfers_new`、`asset_history_new`、`field_options`）
- **ExcelJS**：盤點總表／履歷／廠商清單匯出（含條碼圖片）
- **qrcode**：QR Code 產生
- **XLSX**：匯入範本讀取
- **electron-builder 24.13.3**：NSIS 安裝檔打包

---

## 🚀 開發環境

### 需求
- Node.js（建議 18 以上）
- Windows 10 / 11

### 安裝與啟動

```powershell
# 1. 安裝相依套件
npm install

# 2. 啟動開發模式
npm start
```

### 打包安裝檔

```powershell
npm run build
```

輸出：`dist\IT資產管理系統_安裝檔_v<版本>.exe`（NSIS，約 90 MB）

### 產生更新資訊（GitHub Releases｜建議方式）

程式內建「🔄 版本更新」直接讀取 GitHub 的最新 Release（`<repo>/releases/latest`），因此發行新版本只要：

```powershell
# 1. 升版號 + 更新 CHANGELOG
npm version 1.3.2 --no-git-tag-version

# 2. 重新打包
npm run build

# 3. 提交並建立標籤
git add -A; git commit -m "chore: release v1.3.2"; git tag -a v1.3.2 -m "IT 資產管理系統 v1.3.2"
git push origin main --tags

# 4. 建立 GitHub Release 並「上傳安裝檔」（一定要有 .exe 資產，程式才抓得到）
gh release create v1.3.2 --title v1.3.2 --notes-file notes.md
gh release upload v1.3.2 "dist\ITAssetManager_Setup_v1.3.2.exe"
```

> GitHub 會為資產提供 `digest`（sha256），程式下載後會自動驗證。

### 備援：自訂更新伺服器（latest.json）

若要走內網／自架伺服器，可在「系統管理 → 版本更新 → 更新來源設定」切換為「自訂 latest.json」，或用下列腳本產生：

```powershell
.\產生更新資訊.ps1 -Notes "1. 修正xxx`n2. 新增yyy"
```

上傳 `dist\latest.json` 與 `dist\ITAssetManager_Setup_v<版本>.exe` 至同一資料夾即可。

---

## 📁 專案結構

```
it-asset-manager/
├─ main.js                 # Electron 主程序：視窗、IPC、SQLite、Excel 匯出、更新檢查
├─ index.html              # 前端 UI（單檔：版面 + 樣式 + 前端邏輯）
├─ help-guide.html         # 操作說明（圖文指引）
├─ package.json            # 版本號、scripts、electron-builder 設定
├─ 產生更新資訊.ps1        # 產生 latest.json 與上傳用安裝檔
├─ 版本更新_上架操作說明.md
├─ 版本更新伺服器設定說明.md
├─ 範例_資產匯入範本.xlsx
├─ 範例_廠商匯入範本.xlsx
├─ 範例_盤點總表_條碼貼紙.xlsx
├─ CHANGELOG.md            # 版本歷程
└─ dist/                   # 打包產物（不進版控）
```

---

## 💾 資料存放位置

| 環境 | 資料庫 / 附件位置 |
| --- | --- |
| 開發模式（`npm start`） | 專案資料夾（`*.db`、`uploads/`） |
| 安裝版 | `%APPDATA%\it-asset-manager\`（可在程式中設定自訂儲存位置） |

> ⚠️ 資料庫與 `uploads/` 附件含公司與個人資料，**已在 `.gitignore` 排除，請勿上傳**。

---

## 🏷️ 版本管理規範

- 分支：`main` 為可發行版本；功能開發使用 `feature/<名稱>`，修正使用 `fix/<名稱>`
- 版號：語意化版號 `主版.次版.修訂`（`package.json` 為唯一來源）
- 標籤：每次發行建立 annotated tag，例如
  ```powershell
  git tag -a v1.2.1 -m "IT 資產管理系統 v1.2.1"
  git push origin main --tags
  ```
- 版更紀錄：每次發行同步更新 `CHANGELOG.md`
- 提交訊息：`feat: ...` / `fix: ...` / `docs: ...` / `chore: ...`

---

## ⚖️ 版權

© 2026 Kevin Chang · 版權所有，盜版必究。
本專案為公司內部使用之私有軟體；**本倉庫設為公開僅為提供更新檔下載與版本紀錄**，不代表授權重製、散布或商業使用。
