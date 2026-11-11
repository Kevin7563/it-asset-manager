const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
// 🏷️ 盤點總表貼紙已改為一維條碼 (Code 128，內建實作，見 13-D 區段)，不再需要 qrcode 套件
const ExcelJS = require('exceljs');

// =================================================================
// 0. 📁 資料存放根目錄 (資料庫 / 附件 / 備份檔 / 更新檔)
//    - 優先：使用者自訂位置 (系統管理 → 變更儲存位置；可指定 D:\ 等非系統槽)
//    - 已安裝版本：安裝目錄「同層」的「IT資產管理系統資料」資料夾
//      例：安裝到 D:\IT資產管理系統 → 資料放在 D:\IT資產管理系統資料
//      🚫 不會佔用 C 槽；也「不會」被程式更新刪除
//      ⚠️ 資料絕不可放在安裝目錄「內」：NSIS 更新時會清空整個安裝目錄 (RMDir /r $INSTDIR)
//    - 開發模式 / 免安裝版：程式目錄下的 uploads (資料與程式放在一起)
//    - 保底：使用者資料夾 (%APPDATA%\it-asset-manager\uploads)
// =================================================================
let _appDataDirCache = null;
let _dataMigratedFrom = ''; // 記錄是否曾自動從舊位置複製資料過來（供介面提示）
const dataLocationConfigFile = () => path.join(app.getPath('userData'), 'data_location.json');
// 讀取使用者自訂的資料儲存位置設定 (設定檔本身固定在 %APPDATA%，體積極小)
function readCustomDataPath() {
    try {
        const raw = fs.readFileSync(dataLocationConfigFile(), 'utf-8');
        const cfg = JSON.parse(raw);
        const p = cfg && cfg.dataPath ? String(cfg.dataPath) : '';
        return p.trim() === '' ? null : p;
    } catch (e) { return null; }
}
function writeCustomDataPath(p) {
    try {
        const dir = app.getPath('userData');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dataLocationConfigFile(), JSON.stringify({ dataPath: p, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
        return true;
    } catch (e) { return false; }
}
const isWritableDir = (dir) => {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.write_check');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch (e) { return false; }
};
// 📁 遞迴複製整個資料夾（不使用 fs.cpSync：實測在某些環境/目標路徑下會讓行程無聲結束）
function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const e of entries) {
        const sp = path.join(src, e.name);
        const dp = path.join(dest, e.name);
        if (e.isDirectory()) copyDirRecursive(sp, dp);
        else if (e.isFile()) fs.copyFileSync(sp, dp);
    }
    return true;
}
function dataDir() {
    if (_appDataDirCache) return _appDataDirCache;
    const candidates = [];
    // 1️⃣ 使用者自訂位置 (系統管理 → 變更儲存位置；可指定 D:\ 等非系統槽)
    const custom = readCustomDataPath();
    if (custom) candidates.push(custom);
    // 2️⃣ 已安裝版本：安裝目錄同層的「IT資產管理系統資料」
    //    → 跟隨安裝時選定的磁碟（例：安裝到 D:\IT資產管理系統，資料就在 D:\IT資產管理系統資料）
    //    → 不會佔用 C 槽，也不會被程式更新刪除
    try { if (app.isPackaged) { const p = packagedDataDir(); if (p) candidates.push(p); } } catch (e) {}
    // 3️⃣ 開發模式 / 免安裝版：資料與程式放在一起
    try { if (!app.isPackaged) candidates.push(path.join(__dirname, 'uploads')); } catch (e) {}
    // 4️⃣ 保底：使用者資料夾（安裝目錄所在磁碟不可寫時才會用到）
    try { candidates.push(path.join(app.getPath('userData'), 'uploads')); } catch (e) {}
    for (const dir of candidates) {
        if (isWritableDir(dir)) {
            _appDataDirCache = dir;
            // 📦 舊版資料放在 %APPDATA%（C 槽）：新位置若還沒有資料庫，就自動複製一份過來
            try { if (app.isPackaged) { const legacy = migrateLegacyDataDir(dir); if (legacy) _dataMigratedFrom = legacy; } } catch (e) {}
            return dir;
        }
    }
    _appDataDirCache = candidates.length > 0 ? candidates[candidates.length - 1] : path.join(__dirname, 'uploads');
    return _appDataDirCache;
}
// 🗂️ 已安裝版本的預設資料夾＝安裝目錄的同層（appDir 參數供測試使用，正式執行時為 __dirname）
function packagedDataDir(appDir) {
    try {
        let instDir = String(appDir || __dirname || '');
        if (instDir === '') return '';
        // 打包後 __dirname 通常為 <安裝目錄>\resources\app
        if (/[\\/]resources[\\/]app[\\/]*$/i.test(instDir)) instDir = path.resolve(instDir, '..', '..');
        else if (/[\\/]resources[\\/]*$/i.test(instDir)) instDir = path.resolve(instDir, '..');
        const parent = path.dirname(instDir);
        if (!parent) return '';
        // 例：instDir= D:\IT資產管理系統 → D:\IT資產管理系統資料
        //     instDir= D:\Apps\IT資產管理系統 → D:\Apps\IT資產管理系統資料
        //     instDir= E:\（安裝在磁碟根目錄，少見）→ E:\IT資產管理系統資料
        return path.join(parent, 'IT資產管理系統資料');
    } catch (e) { return ''; }
}
// 📦 把舊位置（%APPDATA%\it-asset-manager\uploads）的資料複製到新位置（只複製、不刪除舊資料）
function migrateLegacyDataDir(targetDir) {
    try {
        const legacy = path.join(app.getPath('userData'), 'uploads');
        if (path.resolve(legacy) === path.resolve(targetDir)) return '';
        if (!fs.existsSync(path.join(legacy, 'asset_data.db'))) return '';   // 舊位置沒有資料庫 → 不需搬移
        if (fs.existsSync(path.join(targetDir, 'asset_data.db'))) return ''; // 新位置已有資料庫 → 不覆蓋
        copyDirRecursive(legacy, targetDir);
        return legacy;
    } catch (e) { return ''; }
}

let mainWindow;
let db;

// =================================================================
// 🔐 0-A. 帳號與權限（登入 / 角色 / 密碼雜湊 / 帳號管理）
//    · admin＝全部功能；user＝僅「查詢資料」與「匯出報表」
//    · 密碼以 scrypt + 隨機 salt 雜湊儲存，資料庫不存明碼
//    · 寫入類 IPC 由後端統一攔阻（前端隱藏選單只是第二層防護）
// =================================================================
const AUTH_ROLE_ADMIN = 'admin';
const AUTH_ROLE_USER = 'user';
let authSession = null;   // { id, username, displayName, role, loginAt }
const authIsLoggedIn = () => !!authSession;
const authIsAdmin = () => !!(authSession && authSession.role === AUTH_ROLE_ADMIN);
const authErrText = (e) => String(e && e.message ? e.message : e);
const authHash = (password, salt) => crypto.scryptSync(String(password), String(salt), 64).toString('hex');
function authVerify(password, salt, hash) {
    try {
        const calc = Buffer.from(authHash(password, salt), 'hex');
        const stored = Buffer.from(String(hash || ''), 'hex');
        return calc.length === stored.length && crypto.timingSafeEqual(calc, stored);
    } catch (e) { return false; }
}
const authPublicUser = (r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name || r.username,
    role: (r.role === AUTH_ROLE_ADMIN) ? AUTH_ROLE_ADMIN : AUTH_ROLE_USER,
    isActive: !!r.is_active,
    createdAt: r.created_at || '',
    lastLogin: r.last_login || ''
});
async function authCreateUserRecord(u) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = authHash(u.password, salt);
    await db.execute({
        sql: `INSERT INTO app_users (username, display_name, password_hash, password_salt, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [u.username, u.displayName || u.username, hash, salt, (u.role === AUTH_ROLE_ADMIN) ? AUTH_ROLE_ADMIN : AUTH_ROLE_USER, (u.isActive === false) ? 0 : 1, new Date().toISOString()]
    });
}
// 🔐 首次啟動自動建立預設帳號：admin / 5508888（管理者）、User / 1234（一般使用者）
async function authEnsureSchema() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS app_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT, password_hash TEXT, password_salt TEXT, role TEXT DEFAULT 'user', is_active INTEGER DEFAULT 1, created_at TEXT, last_login TEXT)`);
        const cnt = await db.execute(`SELECT COUNT(*) AS c FROM app_users`);
        if (!(cnt.rows && cnt.rows[0] && cnt.rows[0].c > 0)) {
            await authCreateUserRecord({ username: 'admin', displayName: '系統管理員', password: '5508888', role: AUTH_ROLE_ADMIN });
            await authCreateUserRecord({ username: 'User', displayName: '一般使用者', password: '1234', role: AUTH_ROLE_USER });
        }
    } catch (e) {}
}
async function authCountOtherAdmins(excludeId) {
    const res = await db.execute({ sql: `SELECT COUNT(*) AS c FROM app_users WHERE role = 'admin' AND is_active = 1 AND id != ?`, args: [parseInt(excludeId) || 0] });
    return (res.rows && res.rows[0] && res.rows[0].c) || 0;
}
async function authPushUsers(event) {
    try {
        const res = await db.execute(`SELECT * FROM app_users ORDER BY (role = 'admin') DESC, id ASC`);
        const rows = (res.rows || []).map(authPublicUser);
        if (event && typeof event.reply === 'function') event.reply('auth-users-data', rows);
        else if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('auth-users-data', rows);
    } catch (e) {}
}
const AUTH_USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
function authPasswordProblem(pw) {
    const p = String(pw || '');
    if (p.length < 4) return '密碼長度至少 4 碼。';
    if (p.length > 64) return '密碼長度不可超過 64 碼。';
    return '';
}

// ── 登入 / 登出 / 目前狀態（此區使用原始 ipcMain.on，不受下方權限攔阻影響）──
const ipcOnRaw = ipcMain.on.bind(ipcMain);

ipcOnRaw('auth-login', async (event, data) => {
    try {
        const username = String((data && data.username) || '').trim();
        const password = String((data && data.password) || '');
        if (!username || !password) { event.reply('auth-login-result', { ok: false, message: '請輸入帳號與密碼。' }); return; }
        const res = await db.execute({ sql: `SELECT * FROM app_users WHERE username = ? COLLATE NOCASE LIMIT 1`, args: [username] });
        const row = (res.rows || [])[0];
        if (!row) { event.reply('auth-login-result', { ok: false, message: '帳號或密碼錯誤。' }); return; }
        if (!row.is_active) { event.reply('auth-login-result', { ok: false, message: '此帳號已停用，請洽系統管理者。' }); return; }
        if (!authVerify(password, row.password_salt, row.password_hash)) { event.reply('auth-login-result', { ok: false, message: '帳號或密碼錯誤。' }); return; }
        const loginAt = new Date().toISOString();
        authSession = {
            id: row.id, username: row.username,
            displayName: row.display_name || row.username,
            role: (row.role === AUTH_ROLE_ADMIN) ? AUTH_ROLE_ADMIN : AUTH_ROLE_USER,
            loginAt: loginAt
        };
        await db.execute({ sql: `UPDATE app_users SET last_login = ? WHERE id = ?`, args: [loginAt, row.id] });
        event.reply('auth-login-result', { ok: true, user: authSession });
    } catch (err) {
        event.reply('auth-login-result', { ok: false, message: '登入失敗：' + authErrText(err) });
    }
});

ipcOnRaw('auth-get-state', (event) => {
    event.reply('auth-state', { loggedIn: authIsLoggedIn(), user: authSession });
});

ipcOnRaw('auth-logout', (event) => {
    authSession = null;
    event.reply('auth-logged-out');
});

// ── 修改自己的密碼 ──────────────────────────────────────
ipcOnRaw('auth-change-password', async (event, data) => {
    try {
        if (!authIsLoggedIn()) { event.reply('auth-action-result', { ok: false, msg: '請先登入。' }); return; }
        const cur = String((data && data.currentPassword) || '');
        const next = String((data && data.newPassword) || '');
        const problem = authPasswordProblem(next);
        if (problem) { event.reply('auth-action-result', { ok: false, msg: problem }); return; }
        const res = await db.execute({ sql: `SELECT * FROM app_users WHERE id = ?`, args: [authSession.id] });
        const row = (res.rows || [])[0];
        if (!row || !authVerify(cur, row.password_salt, row.password_hash)) { event.reply('auth-action-result', { ok: false, msg: '目前密碼不正確。' }); return; }
        const salt = crypto.randomBytes(16).toString('hex');
        await db.execute({ sql: `UPDATE app_users SET password_hash = ?, password_salt = ? WHERE id = ?`, args: [authHash(next, salt), salt, authSession.id] });
        event.reply('auth-action-result', { ok: true, msg: '🔒 您的密碼已更新，下次登入請使用新密碼。' });
    } catch (err) {
        event.reply('auth-action-result', { ok: false, msg: '修改密碼失敗：' + authErrText(err) });
    }
});

// ── 🛡️ 權限攔阻：未登入一律拒絕；一般使用者僅開放「查詢 + 匯出」白名單 ──
const AUTH_USER_ALLOWED_CHANNELS = new Set([
    // 查詢（僅讀取）
    'get-all-assets', 'get-all-vendors', 'get-asset-history',
    'get-asset-repair-cycles', 'get-asset-transfer-cycles',
    'get-all-repairs', 'get-all-transfers', 'get-all-vendor-maint-records',
    'field-get-options', 'upd-get-status',
    // 匯出報表
    'export-inventory-excel', 'export-asset-history', 'export-vendors-excel',
    'export-vendor-maint-history-excel', 'export-to-excel-csv'
]);
ipcMain.on = function (channel, listener) {
    return ipcOnRaw(channel, function (event, ...args) {
        if (!authIsLoggedIn()) {
            try { event.reply('auth-required', { channel: channel }); } catch (e) {}
            return;
        }
        if (!authIsAdmin() && !AUTH_USER_ALLOWED_CHANNELS.has(channel)) {
            try { event.reply('auth-denied', { channel: channel }); } catch (e) {}
            return;
        }
        return listener(event, ...args);
    });
};

// ── 帳號管理（僅管理者）────────────────────────────────
const authDenyAdmin = (event) => event.reply('auth-action-result', { ok: false, msg: '權限不足：帳號管理僅限管理者使用。' });

ipcOnRaw('auth-list-users', async (event) => {
    if (!authIsAdmin()) return authDenyAdmin(event);
    await authPushUsers(event);
});

ipcOnRaw('auth-create-user', async (event, data) => {
    try {
        if (!authIsAdmin()) return authDenyAdmin(event);
        const username = String((data && data.username) || '').trim();
        const displayName = String((data && data.displayName) || '').trim();
        const password = String((data && data.password) || '');
        const role = (data && data.role === AUTH_ROLE_ADMIN) ? AUTH_ROLE_ADMIN : AUTH_ROLE_USER;
        const isActive = !(data && data.isActive === false);
        if (!AUTH_USERNAME_RE.test(username)) { event.reply('auth-action-result', { ok: false, msg: '帳號請使用 3~32 位英文、數字或 . _ -（不可空白）。' }); return; }
        const problem = authPasswordProblem(password);
        if (problem) { event.reply('auth-action-result', { ok: false, msg: problem }); return; }
        const dup = await db.execute({ sql: `SELECT id FROM app_users WHERE username = ? COLLATE NOCASE`, args: [username] });
        if (dup.rows && dup.rows.length > 0) { event.reply('auth-action-result', { ok: false, msg: '帳號「' + username + '」已存在，請改用其他帳號。' }); return; }
        await authCreateUserRecord({ username: username, displayName: displayName || username, password: password, role: role, isActive: isActive });
        await authPushUsers(event);
        event.reply('auth-action-result', { ok: true, msg: `✅ 已建立帳號「${username}」（${role === AUTH_ROLE_ADMIN ? '管理者' : '一般使用者'}）` });
    } catch (err) {
        event.reply('auth-action-result', { ok: false, msg: '建立帳號失敗：' + authErrText(err) });
    }
});

ipcOnRaw('auth-update-user', async (event, data) => {
    try {
        if (!authIsAdmin()) return authDenyAdmin(event);
        const id = parseInt(data && data.id) || 0;
        if (!id) { event.reply('auth-action-result', { ok: false, msg: '找不到要更新的帳號。' }); return; }
        const targetRes = await db.execute({ sql: `SELECT * FROM app_users WHERE id = ?`, args: [id] });
        const target = (targetRes.rows || [])[0];
        if (!target) { event.reply('auth-action-result', { ok: false, msg: '找不到要更新的帳號。' }); return; }
        const displayName = (data && data.displayName !== undefined && String(data.displayName).trim() !== '') ? String(data.displayName).trim() : (target.display_name || target.username);
        const role = (data && data.role === AUTH_ROLE_ADMIN) ? AUTH_ROLE_ADMIN : ((data && data.role === AUTH_ROLE_USER) ? AUTH_ROLE_USER : ((target.role === AUTH_ROLE_ADMIN) ? AUTH_ROLE_ADMIN : AUTH_ROLE_USER));
        const isActive = (data && data.isActive !== undefined) ? !!data.isActive : !!target.is_active;
        if (authSession && authSession.id === id && (role !== AUTH_ROLE_ADMIN || !isActive)) { event.reply('auth-action-result', { ok: false, msg: '不可停用或降級「目前登入中」的帳號。' }); return; }
        if ((target.role === AUTH_ROLE_ADMIN && target.is_active) && (role !== AUTH_ROLE_ADMIN || !isActive)) {
            const others = await authCountOtherAdmins(id);
            if (others < 1) { event.reply('auth-action-result', { ok: false, msg: '系統至少要保留一個啟用中的管理者帳號。' }); return; }
        }
        await db.execute({ sql: `UPDATE app_users SET display_name = ?, role = ?, is_active = ? WHERE id = ?`, args: [displayName, role, isActive ? 1 : 0, id] });
        await authPushUsers(event);
        event.reply('auth-action-result', { ok: true, msg: `✅ 已更新帳號「${target.username}」。` });
    } catch (err) {
        event.reply('auth-action-result', { ok: false, msg: '更新帳號失敗：' + authErrText(err) });
    }
});

ipcOnRaw('auth-reset-password', async (event, data) => {
    try {
        if (!authIsAdmin()) return authDenyAdmin(event);
        const id = parseInt(data && data.id) || 0;
        const next = String((data && data.newPassword) || '');
        if (!id) { event.reply('auth-action-result', { ok: false, msg: '找不到要重設密碼的帳號。' }); return; }
        const problem = authPasswordProblem(next);
        if (problem) { event.reply('auth-action-result', { ok: false, msg: problem }); return; }
        const res = await db.execute({ sql: `SELECT username FROM app_users WHERE id = ?`, args: [id] });
        const row = (res.rows || [])[0];
        if (!row) { event.reply('auth-action-result', { ok: false, msg: '找不到要重設密碼的帳號。' }); return; }
        const salt = crypto.randomBytes(16).toString('hex');
        await db.execute({ sql: `UPDATE app_users SET password_hash = ?, password_salt = ? WHERE id = ?`, args: [authHash(next, salt), salt, id] });
        event.reply('auth-action-result', { ok: true, msg: `🔑 已重設「${row.username}」的密碼。` });
    } catch (err) {
        event.reply('auth-action-result', { ok: false, msg: '重設密碼失敗：' + authErrText(err) });
    }
});

ipcOnRaw('auth-delete-user', async (event, data) => {
    try {
        if (!authIsAdmin()) return authDenyAdmin(event);
        const id = parseInt(data && data.id) || 0;
        if (!id) { event.reply('auth-action-result', { ok: false, msg: '找不到要刪除的帳號。' }); return; }
        if (authSession && authSession.id === id) { event.reply('auth-action-result', { ok: false, msg: '不可刪除「目前登入中」的帳號。' }); return; }
        const res = await db.execute({ sql: `SELECT * FROM app_users WHERE id = ?`, args: [id] });
        const row = (res.rows || [])[0];
        if (!row) { event.reply('auth-action-result', { ok: false, msg: '找不到要刪除的帳號。' }); return; }
        if (row.role === AUTH_ROLE_ADMIN) {
            const others = await authCountOtherAdmins(id);
            if (others < 1) { event.reply('auth-action-result', { ok: false, msg: '系統至少要保留一個啟用中的管理者帳號。' }); return; }
        }
        await db.execute({ sql: `DELETE FROM app_users WHERE id = ?`, args: [id] });
        await authPushUsers(event);
        event.reply('auth-action-result', { ok: true, msg: `🗑️ 已刪除帳號「${row.username}」。` });
    } catch (err) {
        event.reply('auth-action-result', { ok: false, msg: '刪除帳號失敗：' + authErrText(err) });
    }
});




// 1. 初始化連線至實體硬碟資料庫
async function initDatabase() {
    try {
        const sqlite3 = require('sqlite3').verbose();
        const dbPath = path.join(dataDir(), 'asset_data.db');
        db = new sqlite3.Database(dbPath);

        // 萬能相容傳統普通函數擴充包，完美相容前端 Promise 拋接
        db.execute = function(queryObject) {
            return new Promise((resolve, reject) => {
                const sqlText = typeof queryObject === 'string' ? queryObject : queryObject.sql;
                const sqlArgs = queryObject.args || [];
                const isSelect = sqlText.trim().toLowerCase().startsWith('select');

                if (isSelect) {
                    db.all(sqlText, sqlArgs, function(err, rows) {
                        if (err) resolve({ rows: [] }); else resolve({ rows: rows || [] });
                    });
                } else {
                    db.run(sqlText, sqlArgs, function(err) {
                        const lastId = this ? this.lastID : 0;
                        resolve({ rows: [], insertId: lastId });
                    });
                }
            });
        };
        db.run("PRAGMA journal_mode = WAL");
    } catch (err) {}
}

// 2. 自動在實體硬碟內開鑿「全新規格資料表」防線
async function upgradeDatabaseTables() {
    try {
        // 使用全然獨立、完美相容 8 欄位隨附多檔的全新結構資料表！
        await db.execute(`CREATE TABLE IF NOT EXISTS assets_new (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_no TEXT UNIQUE, name TEXT, category TEXT, sn TEXT, custodian TEXT, location TEXT, vendor_id INTEGER DEFAULT 0, status TEXT, purchase_date TEXT, warranty_date TEXT, scrap_reason TEXT, spec_note TEXT, notes TEXT, is_deleted INTEGER DEFAULT 0)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS vendors_new (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, representative TEXT, phone TEXT, address TEXT, has_nda INTEGER DEFAULT 0, service_items TEXT, nda_files TEXT, contract_files TEXT, maint_start TEXT, maint_end TEXT)`);
        // 🔧 相容升級：既有資料庫自動補上「維護合約開始日 / 截止日」欄位 (不會影響原有資料)
        const vColRes = await db.execute(`SELECT name FROM pragma_table_info('vendors_new')`);
        const vColNames = (vColRes.rows || []).map(c => c.name);
        if (vColNames.indexOf('maint_start') < 0) await db.execute(`ALTER TABLE vendors_new ADD COLUMN maint_start TEXT`);
        if (vColNames.indexOf('maint_end') < 0) await db.execute(`ALTER TABLE vendors_new ADD COLUMN maint_end TEXT`);
        await db.execute(`CREATE TABLE IF NOT EXISTS repairs_new (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER DEFAULT 0, asset_no TEXT, asset_name TEXT, fault_description TEXT, repair_vendor TEXT, reported_date TEXT, completed_date TEXT, cost REAL DEFAULT 0, status TEXT DEFAULT 'pending', notes TEXT, created_at TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS asset_history_new (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER DEFAULT 0, asset_no TEXT, event_type TEXT, event_title TEXT, event_detail TEXT, created_at TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS transfers_new (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER DEFAULT 0, asset_no TEXT, asset_name TEXT, from_custodian TEXT, to_custodian TEXT, from_location TEXT, to_location TEXT, transfer_date TEXT, reason TEXT, notes TEXT, created_at TEXT)`);
        // 🗂️ 廠商維護紀錄 (廠商設備維護資訊與歷程 + 維護單據文件)
        await db.execute(`CREATE TABLE IF NOT EXISTS vendor_maint_records (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER DEFAULT 0, vendor_name TEXT, maint_date TEXT, equipment TEXT, equipment_sn TEXT, maint_type TEXT, handler TEXT, cost REAL DEFAULT 0, signed INTEGER DEFAULT 0, content TEXT, notes TEXT, doc_files TEXT, created_at TEXT)`);
        // 🧩 欄位管理：可自訂「資產大類 / 所屬部門」選項（不同產業可自行新增/移除，預設沿用現有資料）
        await db.execute(`CREATE TABLE IF NOT EXISTS field_options (id INTEGER PRIMARY KEY AUTOINCREMENT, field_type TEXT, value TEXT, label TEXT, code TEXT, sort_order INTEGER DEFAULT 0, builtin INTEGER DEFAULT 0)`);
        await seedFieldOptions();
        // 🏢 部門欄位升級 (既有資料庫自動補上「部門」與轉移部門欄位，不影響原有資料)
        const aColRes = await db.execute(`SELECT name FROM pragma_table_info('assets_new')`);
        const aColNames = (aColRes.rows || []).map(c => c.name);
        if (aColNames.indexOf('department') < 0) await db.execute(`ALTER TABLE assets_new ADD COLUMN department TEXT DEFAULT 'IT'`);
        // 🧾 相容升級：既有資料庫自動補上「資產規格/備註」欄位 (不影響原有資料)
        if (aColNames.indexOf('spec_note') < 0) await db.execute(`ALTER TABLE assets_new ADD COLUMN spec_note TEXT`);
        const tColRes = await db.execute(`SELECT name FROM pragma_table_info('transfers_new')`);
        const tColNames = (tColRes.rows || []).map(c => c.name);
        if (tColNames.indexOf('from_department') < 0) await db.execute(`ALTER TABLE transfers_new ADD COLUMN from_department TEXT`);
        if (tColNames.indexOf('to_department') < 0) await db.execute(`ALTER TABLE transfers_new ADD COLUMN to_department TEXT`);
        if (tColNames.indexOf('from_asset_no') < 0) await db.execute(`ALTER TABLE transfers_new ADD COLUMN from_asset_no TEXT`);
        if (tColNames.indexOf('to_asset_no') < 0) await db.execute(`ALTER TABLE transfers_new ADD COLUMN to_asset_no TEXT`);
        // 🔢 既有資產編號遷移：舊格式 IT-類別-日期-流水 → 新格式 類別-部門-日期-流水 (部門預設 IT)
        await migrateLegacyAssetNumbers();
        await dedupeAssetSerialsByDept();
    } catch(err) {}
}
// 🧩 欄位管理：預設選項（第一次啟動寫入，之後由使用者在「欄位管理」自行維護）
const DEFAULT_CATEGORY_OPTIONS = [
    { value: 'hardware', label: '硬體設備', code: 'HW' },
    { value: 'software', label: '軟體授權', code: 'SW' },
    { value: 'network', label: '網路設備', code: 'NET' },
    { value: 'peripheral', label: '資訊周邊', code: 'DEV' },
    { value: 'credentials', label: '帳密安全性', code: 'SEC' }
];
const DEFAULT_DEPARTMENT_OPTIONS = [
    ['IT', '資訊部門'], ['DR', '院長室,醫師辦公室'], ['TL', '督導'], ['GA', '總務'], ['MO', '行政'], ['PT', '主任'],
    ['AC', '人事,會計'], ['CK', '廚房'], ['SM', '倉庫'], ['WO', '工務'], ['LA', '檢驗室'], ['OP', '婦科'],
    ['IN', '兒科'], ['PO', '警衛'], ['OR', '產房'], ['WA', '病房'], ['HE', '申報'], ['BR', '嬰兒室'],
    ['CH', '病歷室'], ['CO', '櫃台'], ['P1', '藥局']
];
async function seedFieldOptions() {
    try {
        const cRes = await db.execute(`SELECT COUNT(*) as c FROM field_options WHERE field_type='category'`);
        if (!(cRes.rows && cRes.rows[0] && cRes.rows[0].c > 0)) {
            let i = 0;
            for (const o of DEFAULT_CATEGORY_OPTIONS) {
                i++;
                await db.execute({ sql: `INSERT INTO field_options (field_type, value, label, code, sort_order, builtin) VALUES ('category', ?, ?, ?, ?, 1)`, args: [o.value, o.label, o.code, i] });
            }
        }
        const dRes = await db.execute(`SELECT COUNT(*) as c FROM field_options WHERE field_type='department'`);
        if (!(dRes.rows && dRes.rows[0] && dRes.rows[0].c > 0)) {
            let i = 0;
            for (const pair of DEFAULT_DEPARTMENT_OPTIONS) {
                i++;
                await db.execute({ sql: `INSERT INTO field_options (field_type, value, label, code, sort_order, builtin) VALUES ('department', ?, ?, ?, ?, 1)`, args: [pair[0], pair[1], pair[0], i] });
            }
        }
    } catch (e) {}
}
// 🔢 將既有「IT-類別-日期-流水」舊編號遷移為「類別-部門-日期-流水」新編號並同步關聯表
async function migrateLegacyAssetNumbers() {
    try {
        await db.execute(`UPDATE assets_new SET department = 'IT' WHERE department IS NULL OR department = ''`);
        const res = await db.execute(`SELECT id, asset_no FROM assets_new WHERE asset_no LIKE 'IT-%'`);
        const rows = res.rows || [];
        for (const row of rows) {
            const m = String(row.asset_no || '').match(/^IT-([A-Z0-9]+)-(\d{8})-(\d{4})$/);
            if (!m) continue;
            const newNo = `${m[1]}-IT-${m[2]}-${m[3]}`;
            const exists = await db.execute({ sql: `SELECT id FROM assets_new WHERE asset_no = ? AND id != ?`, args: [newNo, row.id] });
            if (exists.rows && exists.rows.length > 0) continue;
            await db.execute({ sql: `UPDATE assets_new SET asset_no = ? WHERE id = ?`, args: [newNo, row.id] });
            await db.execute({ sql: `UPDATE repairs_new SET asset_no = ? WHERE asset_id = ?`, args: [newNo, row.id] });
            await db.execute({ sql: `UPDATE transfers_new SET asset_no = ? WHERE asset_id = ?`, args: [newNo, row.id] });
            await db.execute({ sql: `UPDATE asset_history_new SET asset_no = ? WHERE asset_id = ?`, args: [newNo, row.id] });
        }
    } catch(e) {}
}
// 🔢 計算「同類別 + 同部門」的下一個流水號 (不受建檔日期影響；取現有最大流水號 +1)
async function computeNextSeqByDept(catPrefix, dept, excludeId) {
    const pattern = `${catPrefix}-${dept}-%`;
    const res = excludeId
        ? await db.execute({ sql: `SELECT MAX(CAST(substr(asset_no, -4) AS INTEGER)) as mx FROM assets_new WHERE asset_no LIKE ? AND id != ?`, args: [pattern, excludeId] })
        : await db.execute({ sql: `SELECT MAX(CAST(substr(asset_no, -4) AS INTEGER)) as mx FROM assets_new WHERE asset_no LIKE ?`, args: [pattern] });
    const mx = (res && res.rows && res.rows[0] && res.rows[0].mx) || 0;
    return (parseInt(mx, 10) || 0) + 1;
}
// 🔧 修正既有資料：同一「類別 + 部門」若有重複流水號，保留第一筆，其餘改為最大流水號 +1 (冪等，可重複執行)
async function dedupeAssetSerialsByDept() {
    try {
        const res = await db.execute(`SELECT id, asset_no FROM assets_new`);
        const rows = res.rows || [];
        const groups = {};
        for (const r of rows) {
            const m = String(r.asset_no || '').match(/^([A-Z0-9]+)-([A-Z0-9]+)-(\d{8})-(\d{4})$/);
            if (!m) continue;
            const key = m[1] + '|' + m[2];
            (groups[key] = groups[key] || []).push({ id: r.id, cat: m[1], dept: m[2], date: m[3], seq: parseInt(m[4], 10) });
        }
        for (const key of Object.keys(groups)) {
            const list = groups[key].sort((a, b) => (Number(a.date) - Number(b.date)) || (a.seq - b.seq) || (a.id - b.id));
            const seen = new Set();
            let maxSeq = list.reduce((mx, x) => Math.max(mx, x.seq), 0);
            for (const x of list) {
                if (!seen.has(x.seq)) { seen.add(x.seq); continue; }
                maxSeq += 1;
                const newNo = `${x.cat}-${x.dept}-${x.date}-${String(maxSeq).padStart(4, '0')}`;
                await db.execute({ sql: `UPDATE assets_new SET asset_no = ? WHERE id = ?`, args: [newNo, x.id] });
                await db.execute({ sql: `UPDATE repairs_new SET asset_no = ? WHERE asset_id = ?`, args: [newNo, x.id] });
                await db.execute({ sql: `UPDATE asset_history_new SET asset_no = ? WHERE asset_id = ?`, args: [newNo, x.id] });
                await db.execute({ sql: `UPDATE transfers_new SET asset_no = ? WHERE asset_id = ?`, args: [newNo, x.id] });
                seen.add(maxSeq);
            }
        }
    } catch (e) {}
}
// 3. 全新資料表資料流：資產主表推播天線
async function pushAllAssetsToFrontend() {
    try {
        const sql = `SELECT a.*, v.name as vendor_name FROM assets_new a LEFT JOIN vendors_new v ON a.vendor_id = v.id WHERE a.is_deleted = 0 ORDER BY a.id DESC`;
        const res = await db.execute(sql);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('all-assets-data', res.rows || []);
    } catch(err) {}
}

ipcMain.on('get-all-assets', async () => { await pushAllAssetsToFrontend(); });

// 🧩 欄位管理 IPC：讀取 / 新增 / 刪除「資產大類」「所屬部門」選項
ipcMain.on('field-get-options', async () => {
    try {
        const cats = (await db.execute(`SELECT * FROM field_options WHERE field_type='category' ORDER BY sort_order ASC, id ASC`)).rows || [];
        const deps = (await db.execute(`SELECT * FROM field_options WHERE field_type='department' ORDER BY sort_order ASC, id ASC`)).rows || [];
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('field-options-data', { categories: cats, departments: deps });
    } catch (e) {}
});

ipcMain.on('field-add-option', async (event, d) => {
    try {
        const type = (d && d.type === 'department') ? 'department' : 'category';
        const label = String((d && d.label) || '').trim();
        const code = String((d && d.code) || '').trim().toUpperCase();
        if (!label || !code) { event.reply('field-action-result', { ok: false, msg: '名稱與代號皆為必填。' }); return; }
        if (!/^[A-Z0-9]{1,8}$/.test(code)) { event.reply('field-action-result', { ok: false, msg: '代號請使用 1~8 位英文或數字（例：OT、MON、HW），不可使用中文或符號。' }); return; }
        const dup = await db.execute({ sql: `SELECT id FROM field_options WHERE field_type = ? AND code = ?`, args: [type, code] });
        if (dup.rows && dup.rows.length > 0) { event.reply('field-action-result', { ok: false, msg: '代號「' + code + '」已存在，請改用其他代號。' }); return; }
        const maxRes = await db.execute({ sql: `SELECT COALESCE(MAX(sort_order),0) as m FROM field_options WHERE field_type = ?`, args: [type] });
        const next = ((maxRes.rows && maxRes.rows[0] && maxRes.rows[0].m) || 0) + 1;
        await db.execute({ sql: `INSERT INTO field_options (field_type, value, label, code, sort_order, builtin) VALUES (?, ?, ?, ?, ?, 0)`, args: [type, code, label, code, next] });
        event.reply('field-action-result', { ok: true, msg: `已新增${type === 'department' ? '部門' : '資產大類'}：${label}（${code}）` });
    } catch (e) { event.reply('field-action-result', { ok: false, msg: String(e && e.message ? e.message : e) }); }
});

ipcMain.on('field-delete-option', async (event, id) => {
    try {
        await db.execute({ sql: `DELETE FROM field_options WHERE id = ?`, args: [parseInt(id)] });
        event.reply('field-action-result', { ok: true, msg: '已刪除選項。' });
    } catch (e) { event.reply('field-action-result', { ok: false, msg: String(e && e.message ? e.message : e) }); }
});

// 4. 登記與更新資訊資產 (全新資料表)
ipcMain.on('save-asset', async (event, a) => {
    try {
        const check = await db.execute({ sql: `SELECT id FROM assets_new WHERE asset_no = ?`, args: [a.asset_no] });
        if (check && check.rows && check.rows.length > 0) {
            const existingId = check.rows[0].id;
            const sqlUpdate = `UPDATE assets_new SET name=?, category=?, sn=?, custodian=?, location=?, vendor_id=?, status=?, purchase_date=?, warranty_date=?, scrap_reason=?, spec_note=?, notes=?, department = COALESCE(NULLIF(?, ''), department), is_deleted=0 WHERE asset_no=?`;
            await db.execute({ sql: sqlUpdate, args: [a.name, a.category, a.sn, a.custodian, a.location, a.vendor_id, a.status, a.purchase_date, a.warranty_date, a.scrap_reason, a.spec_note || '', a.notes, a.department || '', a.asset_no] });
            await logAssetHistory(existingId, a.asset_no, 'edit', '資產資料編輯修改', `設備名稱:${a.name} ｜ 狀態:${a.status}`);
            if (a.status === 'scrapped') {
                await logAssetHistory(existingId, a.asset_no, 'scrap', '資產報廢註銷', `報廢原因:${a.scrap_reason || '未填寫'}`);
                // 報廢時,將該資產所有「維修中」的工單自動標記為因報廢而結案
                const scrapToday = new Date().toISOString().slice(0, 10);
                await db.execute({ sql: `UPDATE repairs_new SET status = 'scrapped', completed_date = ? WHERE asset_id = ? AND status = 'pending'`, args: [scrapToday, existingId] });
            }
        } else {
            const sqlInsert = `INSERT INTO assets_new (asset_no, name, category, sn, custodian, location, vendor_id, status, purchase_date, warranty_date, scrap_reason, spec_note, notes, department, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;
            await db.execute({ sql: sqlInsert, args: [a.asset_no, a.name, a.category, a.sn, a.custodian, a.location, a.vendor_id, a.status, a.purchase_date, a.warranty_date, a.scrap_reason, a.spec_note || '', a.notes, a.department || 'IT'] });
            const idRes = await db.execute({ sql: `SELECT id FROM assets_new WHERE asset_no = ?`, args: [a.asset_no] });
            const newId = (idRes && idRes.rows && idRes.rows.length > 0) ? idRes.rows[0].id : 0;
            await logAssetHistory(newId, a.asset_no, 'create', '資產建立登記', `設備名稱:${a.name} ｜ 大類:${a.category}`);
        }
        await pushAllAssetsToFrontend();
    } catch(err) {}
});

// 5. 登記與更新廠商資料 (全新資料表)
async function pushAllVendorsToFrontend() {
    try {
        const sql = `SELECT * FROM vendors_new ORDER BY id DESC`;
        const res = await db.execute(sql);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('all-vendors-data', res.rows || []);
    } catch(err) {}
}

ipcMain.on('get-all-vendors', async () => { await pushAllVendorsToFrontend(); });

ipcMain.on('save-vendor', async (event, v) => {
    try {
        const name = String((v && v.name) || '').trim();
        // 🛡️ 空名稱防護：避免任何異常流程寫入「空白廠商」垃圾資料
        if (name === '') { event.reply('save-vendor-rejected', 'empty-name'); return; }
        // 🎯 優先以數字 id 精準更新 (改名也能正確更新同一筆)；沒有 id 才用名稱反查
        let targetId = parseInt(v && v.id) || 0;
        if (!targetId) {
            const check = await db.execute({ sql: `SELECT id FROM vendors_new WHERE name = ? ORDER BY id DESC LIMIT 1`, args: [name] });
            if (check && check.rows && check.rows.length > 0) targetId = check.rows[0].id;
        }
        // 📅 維護合約期間：未提供 (undefined) 時保留原值；提供空字串則清空
        const maintStart = (v.maint_start === undefined) ? null : String(v.maint_start || '').trim();
        const maintEnd = (v.maint_end === undefined) ? null : String(v.maint_end || '').trim();
        if (targetId) {
            const sqlUpdate = `UPDATE vendors_new SET name=?, representative=?, phone=?, address=?, has_nda=?, service_items=?, nda_files=?, contract_files=?, maint_start=COALESCE(?, maint_start), maint_end=COALESCE(?, maint_end) WHERE id=?`;
            await db.execute({ sql: sqlUpdate, args: [name, v.representative, v.phone, v.address, v.has_nda, v.service_items, v.nda_files, v.contract_files, maintStart, maintEnd, targetId] });
        } else {
            const sqlInsert = `INSERT INTO vendors_new (name, representative, phone, address, has_nda, service_items, nda_files, contract_files, maint_start, maint_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await db.execute({ sql: sqlInsert, args: [name, v.representative, v.phone, v.address, v.has_nda, v.service_items, v.nda_files, v.contract_files, maintStart || '', maintEnd || ''] });
        }
        await pushAllVendorsToFrontend();
    } catch(err) {}
});
// 6. 資源回收桶與軟刪除控制 (全新資料表)
ipcMain.on('soft-delete-asset', async (event, id) => {
    try {
        const infoRes = await db.execute({ sql: `SELECT asset_no, name FROM assets_new WHERE id = ?`, args: [parseInt(id)] });
        await db.execute({ sql: `UPDATE assets_new SET is_deleted = 1 WHERE id = ?`, args: [parseInt(id)] });
        if (infoRes && infoRes.rows && infoRes.rows.length > 0) await logAssetHistory(parseInt(id), infoRes.rows[0].asset_no, 'recycle', '移至資源回收桶', `設備名稱:${infoRes.rows[0].name}`);
        await pushAllAssetsToFrontend();
        const res = await db.execute(`SELECT * FROM assets_new WHERE is_deleted = 1 ORDER BY id DESC`);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('deleted-assets-data', res.rows || []);
    } catch(err) {}
});

ipcMain.on('get-deleted-assets', async () => {
    try {
        const res = await db.execute(`SELECT * FROM assets_new WHERE is_deleted = 1 ORDER BY id DESC`);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('deleted-assets-data', res.rows || []);
    } catch(err) {}
});

ipcMain.on('restore-asset', async (event, id) => {
    try {
        const infoRes = await db.execute({ sql: `SELECT asset_no, name FROM assets_new WHERE id = ?`, args: [parseInt(id)] });
        await db.execute({ sql: `UPDATE assets_new SET is_deleted = 0 WHERE id = ?`, args: [parseInt(id)] });
        if (infoRes && infoRes.rows && infoRes.rows.length > 0) await logAssetHistory(parseInt(id), infoRes.rows[0].asset_no, 'restore', '從回收桶還原', `設備名稱:${infoRes.rows[0].name}`);
        await pushAllAssetsToFrontend();
        const res = await db.execute(`SELECT * FROM assets_new WHERE is_deleted = 1 ORDER BY id DESC`);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('deleted-assets-data', res.rows || []);
    } catch(err) {}
});

// 7. 智慧型流水號計數器天線
ipcMain.on('get-next-sequence', async (event, data) => {
    try {
        const prefixMap = { hardware: 'HW', software: 'SW', network: 'NET', peripheral: 'DEV', credentials: 'SEC' };
        const dept = String(data.department || 'IT').toUpperCase();
        const dateStr = String(data.dateStr || '');
        // 🧩 依「欄位管理」設定的類別代碼解析；查無則回退舊對照表
        let cat = prefixMap[data.category] || '';
        try {
            const cRes = await db.execute({ sql: `SELECT code FROM field_options WHERE field_type='category' AND value = ? LIMIT 1`, args: [data.category] });
            if (cRes.rows && cRes.rows[0] && cRes.rows[0].code) cat = cRes.rows[0].code;
        } catch (e) {}
        if (!cat) cat = 'AST';
        cat = String(cat).toUpperCase();
        const nextSeq = await computeNextSeqByDept(cat, dept, null);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('next-sequence-reply', { category: data.category, catCode: cat, department: dept, dateStr: dateStr, nextSeq: nextSeq });
    } catch(err) {}
});

// 8. 廠商修改隨附檔案反查與單檔 Index 實體銷毀
// 🎯 全系統唯一的『單一廠商完整資料反查』專線 (不可重複註冊，避免同一請求被回覆多次)
ipcMain.on('get-vendor-detail-for-edit', async (event, vendorId) => {
    try {
        const res = await db.execute({ sql: `SELECT * FROM vendors_new WHERE id = ?`, args: [parseInt(vendorId)] });
        if (res && res.rows && res.rows.length > 0) event.reply('vendor-detail-for-edit-reply', res.rows[0]);
    } catch(err) {}
});

ipcMain.on('delete-vendor-single-file-by-idx-request', async (event, data) => {
    try {
        const { vendorId, vendorName, fileType, fileIndex } = data;
        const idxTarget = parseInt(fileIndex);
        const targetId = parseInt(vendorId) || 0;
        // 🎯 有數字 id 就用 id 精準反查 (同名廠商也不會刪錯)；否則退回以名稱查最新一筆
        const idRes = targetId
            ? await db.execute({ sql: `SELECT id, nda_files, contract_files FROM vendors_new WHERE id = ?`, args: [targetId] })
            : await db.execute({ sql: `SELECT id, nda_files, contract_files FROM vendors_new WHERE name = ? ORDER BY id DESC LIMIT 1`, args: [String(vendorName || '').trim()] });
        if (!idRes || !idRes.rows || idRes.rows.length === 0) return;
        
        const currentVendorId = idRes.rows[0].id;
        let originalString = (fileType === 'nda') ? (idRes.rows[0].nda_files || '') : (idRes.rows[0].contract_files || '');
        let pathsArray = originalString.split(';').map(p => p.trim()).filter(p => p !== '');

        if (idxTarget >= 0 && idxTarget < pathsArray.length) {
            const filePathToDelete = pathsArray[idxTarget];
            try { if (filePathToDelete && fs.existsSync(filePathToDelete)) fs.unlinkSync(filePathToDelete); } catch(e) {}
            pathsArray.splice(idxTarget, 1);
        }

        let newCombinedString = pathsArray.join(';');
        await db.execute({ sql: `UPDATE vendors_new SET ${fileType === 'nda' ? 'nda_files' : 'contract_files'} = ? WHERE id = ?`, args: [newCombinedString, currentVendorId] });
        event.reply('delete-vendor-single-file-success', currentVendorId);
        await pushAllVendorsToFrontend();
    } catch (err) {}
});

// 9. 廠商登記檔案原生對話框多選與複製
ipcMain.on('select-multi-nda', async (event) => {
    try {
        const { canceled, filePaths } = await dialog.showOpenDialog({ title: 'Select NDA Files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Docs', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }] });
        if (!canceled && filePaths && filePaths.length > 0) event.sender.send('multi-nda-reply', filePaths.length, filePaths.join(';'));
    } catch(err) {}
});

ipcMain.on('select-multi-contract', async (event) => {
    try {
        const { canceled, filePaths } = await dialog.showOpenDialog({ title: 'Select Contract Files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Docs', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }] });
        if (!canceled && filePaths && filePaths.length > 0) event.sender.send('multi-contract-reply', filePaths.length, filePaths.join(';'));
    } catch(err) {}
});

ipcMain.on('save-vendor-files-request', async (event, data) => {
    try {
        const { vendorName, ndaRaw, contractRaw } = data;
        // 🛡️ 空名稱防護：維護分頁尚未選取廠商時，不可建立資料夾或寫入任何檔案
        if (String(vendorName || '').trim() === '') { event.reply('save-vendor-files-success', '', ''); return; }
        const safeVendorName = vendorName.replace(/[\\/:*?"<>|]/g, "_").trim();
        const baseUploadsDir = path.join(dataDir());
        const ndaTargetDir = path.join(baseUploadsDir, safeVendorName, '相關文件', '保密條款');
        const contractTargetDir = path.join(baseUploadsDir, safeVendorName, '相關文件', '合約相關');

        if (!fs.existsSync(ndaTargetDir)) fs.mkdirSync(ndaTargetDir, { recursive: true });
        if (!fs.existsSync(contractTargetDir)) fs.mkdirSync(contractTargetDir, { recursive: true });

        let finalNdaPaths = [];
        if (ndaRaw && ndaRaw.trim() !== '') {
            ndaRaw.split(';').forEach(fp => {
                if (!fp.trim()) return;
                if (!fs.existsSync(fp)) { if(fp.includes('uploads')) finalNdaPaths.push(fp); return; }
                const dest = path.join(ndaTargetDir, path.basename(fp));
                fs.copyFileSync(fp, dest); finalNdaPaths.push(dest);
            });
        }

        let finalContractPaths = [];
        if (contractRaw && contractRaw.trim() !== '') {
            contractRaw.split(';').forEach(fp => {
                if (!fp.trim()) return;
                if (!fs.existsSync(fp)) { if(fp.includes('uploads')) finalContractPaths.push(fp); return; }
                const dest = path.join(contractTargetDir, path.basename(fp));
                fs.copyFileSync(fp, dest); finalContractPaths.push(dest);
            });
        }
        event.reply('save-vendor-files-success', finalNdaPaths.join(';'), finalContractPaths.join(';'));
    } catch (err) {}
});

ipcMain.on('delete-vendor-request', async (event, id) => {
    try {
        const targetId = parseInt(id) || 0;
        const infoRes = await db.execute({ sql: `SELECT name FROM vendors_new WHERE id = ?`, args: [targetId] });
        const vendorName = (infoRes && infoRes.rows && infoRes.rows.length > 0) ? String(infoRes.rows[0].name || '') : '';
        await db.execute({ sql: `DELETE FROM vendors_new WHERE id = ?`, args: [targetId] });
        await db.execute({ sql: `UPDATE assets_new SET vendor_id = 0 WHERE vendor_id = ?`, args: [targetId] });
        // 🗂️ 連動清除該廠商的維護紀錄 (維護單據實體檔案會隨 uploads\<廠商> 一併歸檔)
        await db.execute({ sql: `DELETE FROM vendor_maint_records WHERE vendor_id = ? OR vendor_name = ?`, args: [targetId, vendorName] });
        // 🗂️ 連動處理：把該廠商在上傳區的文件目錄歸檔到 uploads\_已註銷廠商 (可事後人工還原，不直接銷毀)
        let archiveMsg = '';
        if (vendorName) {
            const safeName = vendorName.replace(/[\\/:*?"<>|]/g, '_').trim();
            const sourceDir = path.join(dataDir(), safeName);
            if (safeName && fs.existsSync(sourceDir)) {
                const archiveRoot = path.join(dataDir(), '_已註銷廠商');
                const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const destDir = path.join(archiveRoot, `${safeName}_${stamp}`);
                try {
                    if (!fs.existsSync(archiveRoot)) fs.mkdirSync(archiveRoot, { recursive: true });
                    fs.renameSync(sourceDir, destDir);
                    archiveMsg = `🗂️ 隨附文件目錄已歸檔至 uploads\\_已註銷廠商\\${path.basename(destDir)}`;
                } catch (renameErr) {
                    // 檔案被其他程式鎖定時無法改名 → 改用「複製後刪除」；若仍失敗則保留原目錄並回報，不再默默吞掉
                    try {
                        fs.mkdirSync(destDir, { recursive: true });
                        copyDirRecursive(sourceDir, destDir);
                        fs.rmSync(sourceDir, { recursive: true, force: true });
                        archiveMsg = `🗂️ 隨附文件目錄已複製歸檔至 uploads\\_已註銷廠商\\${path.basename(destDir)}`;
                    } catch (copyErr) {
                        try { if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true }); } catch (e) {}
                        try { if (fs.existsSync(archiveRoot) && fs.readdirSync(archiveRoot).length === 0) fs.rmdirSync(archiveRoot); } catch (e) {}
                        archiveMsg = `⚠️ 隨附文件仍保留在 uploads\\${safeName}（被其他程式鎖定，未能歸檔）：${copyErr.message}`;
                    }
                }
            }
        }
        event.reply('delete-vendor-success', vendorName, archiveMsg);
        await pushAllVendorsToFrontend();
        await pushAllAssetsToFrontend();
    } catch(err) {}
});

ipcMain.on('export-to-excel-csv', async (event, csvContent) => {
    try {
        const { filePath } = await dialog.showSaveDialog({ title: 'Export CSV', defaultPath: path.join(app.getPath('downloads'), `IT_Asset_Inventory_${Date.now()}.csv`), filters: [{ name: 'CSV Files', extensions: ['csv'] }] });
        if (!filePath) return;
        fs.writeFileSync(filePath, csvContent, 'utf-8');
    } catch(err) {}
});

// =================================================================
// 13. 匯出單一資產完整履歷 (配色與排版完全比照「資訊資產盤點總表」)
// =================================================================

ipcMain.on('export-asset-history', async (event, data) => {
    try {
        const assetId = parseInt(data.assetId);
        const assetRes = await db.execute({ sql: `SELECT a.*, v.name as vendor_name FROM assets_new a LEFT JOIN vendors_new v ON a.vendor_id = v.id WHERE a.id = ?`, args: [assetId] });
        if (!assetRes || !assetRes.rows || assetRes.rows.length === 0) { dialog.showMessageBox({ type: 'warning', message: '找不到該資產資料，無法匯出。' }); return; }
        const asset = assetRes.rows[0];
        const repairsRes = await db.execute({ sql: `SELECT * FROM repairs_new WHERE asset_id = ? ORDER BY id DESC`, args: [assetId] });
        const repairs = repairsRes.rows || [];
        const transfersRes = await db.execute({ sql: `SELECT * FROM transfers_new WHERE asset_id = ? ORDER BY id DESC`, args: [assetId] });
        const transfers = transfersRes.rows || [];

        const catNameMap = { hardware: '硬體設備 (HW)', software: '軟體與授權 (SW)', network: '網路設備 (NET)', peripheral: '資訊周邊 (DEV)', credentials: '資訊與資料庫帳密 (SEC)' };
        const statusNameMap = { active: '線上正常使用', inventory: '庫存備用', repair: '維修中', scrapped: '已報廢' };
        const fmtD = (s) => { if (!s) return '未填寫'; const d = new Date(s); return isNaN(d) ? String(s) : `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`; };
        const statusStyleMap = { active: { bg: 'FFDCFCE7', fc: 'FF166534' }, inventory: { bg: 'FFDBEAFE', fc: 'FF1E40AF' }, repair: { bg: 'FFFEF3C7', fc: 'FFB45309' }, scrapped: { bg: 'FFFEE2E2', fc: 'FFB91C1C' } };
        const now = new Date();
        const exportTime = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

        // ===== 共用樣式工具 (與「資訊資產盤點總表」完全相同的配色與框線) =====
        const CLR = { primary: 'FF1F4E78', header: 'FF2E75B6', sub: 'FFDDEBF7', zebra: 'FFF2F7FC', label: 'FFEAF1F9', border: 'FFB4C6E7' };
        const thinBorder = (color) => { const b = { style: 'thin', color: { argb: color || CLR.border } }; return { top: b, left: b, bottom: b, right: b }; };
        const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
        // 標題橫幅 (合併列、深藍底白字)
        const banner = (ws, rowNo, lastCol, text, size) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { bold: true, size: size, color: { argb: 'FFFFFFFF' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = solid(CLR.primary);
            c.border = thinBorder();
            ws.getRow(rowNo).height = size >= 16 ? 32 : 24;
        };
        // 副標題列 (合併列、淺藍底)
        const subBanner = (ws, rowNo, lastCol, text) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { size: 10, italic: true, color: { argb: 'FF555555' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = solid(CLR.sub);
            c.border = thinBorder();
            ws.getRow(rowNo).height = 20;
        };
        // 區段標題 (合併列、中藍底白字)
        const sectionBar = (ws, rowNo, lastCol, text) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
            c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
            c.fill = solid(CLR.header);
            c.border = thinBorder('FF9DC3E6');
            ws.getRow(rowNo).height = 24;
        };
        // 表格欄位標題列 (與盤點總表同一組 header 色)
        const headerCells = (ws, rowNo, headers) => {
            const row = ws.getRow(rowNo);
            headers.forEach((h, i) => {
                const cell = row.getCell(i + 1);
                cell.value = h;
                cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
                cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                cell.fill = solid(CLR.header);
                cell.border = thinBorder('FF9DC3E6');
            });
            row.height = 28;
        };
        // 資料列框線 + 斑馬紋
        const paintRow = (row, cols, zebra) => {
            for (let c = 1; c <= cols; c++) {
                const cell = row.getCell(c);
                cell.border = thinBorder();
                if (zebra) cell.fill = solid(CLR.zebra);
            }
        };
        const labelCell = (cell, text) => {
            cell.value = text;
            cell.font = { bold: true, size: 10, color: { argb: 'FF333333' } };
            cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
            cell.fill = solid(CLR.label);
        };
        const valueCell = (cell, text, wrap) => {
            cell.value = text;
            cell.font = { size: 10 };
            cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: !!wrap };
        };

        const wb = new ExcelJS.Workbook();
        wb.creator = 'IT Asset Manager';
        wb.created = new Date();

        // ===== 工作表 1：資產基本資料 =====
        const s1 = wb.addWorksheet('資產基本資料', { views: [{ state: 'frozen', ySplit: 3 }] });
        s1.columns = [{ width: 20 }, { width: 34 }, { width: 18 }, { width: 30 }];
        const S1_LAST = 4;
        banner(s1, 1, S1_LAST, '📋 資訊資產履歷表', 16);
        subBanner(s1, 2, S1_LAST, `資產編號：${asset.asset_no || ''}　｜　匯出時間：${exportTime}`);
        subBanner(s1, 3, S1_LAST, '※ 本表為單一資產完整維運履歷；維修與轉移明細請參閱後續工作表。');
        sectionBar(s1, 4, S1_LAST, '【一、資產基本資料】');
        const DEPT_NAME_S = { IT: '資訊部門', DR: '院長室,醫師辦公室', TL: '督導', GA: '總務', MO: '行政', PT: '主任', AC: '人事,會計', CK: '廚房', SM: '倉庫', WO: '工務', LA: '檢驗室', OP: '婦科', IN: '兒科', PO: '警衛', OR: '產房', WA: '病房', HE: '申報', BR: '嬰兒室', CH: '病歷室', CO: '櫃台', P1: '藥局' };
        try {
            const _catOptsS = (await db.execute(`SELECT value,label,code FROM field_options WHERE field_type='category'`)).rows || [];
            _catOptsS.forEach(o => { catNameMap[o.value] = `${o.label} (${o.code})`; });
            const _depOptsS = (await db.execute(`SELECT code,label FROM field_options WHERE field_type='department'`)).rows || [];
            _depOptsS.forEach(o => { DEPT_NAME_S[o.code] = o.label; });
        } catch (e) {}
        const deptCodeS = String(asset.department || 'IT').toUpperCase();
        const deptTextS = DEPT_NAME_S[deptCodeS] ? `${deptCodeS} ${DEPT_NAME_S[deptCodeS]}` : deptCodeS;
        const deptT = (code) => { const c = String(code || '').toUpperCase(); return c ? (DEPT_NAME_S[c] ? `${c} ${DEPT_NAME_S[c]}` : c) : '—'; };
        const infoRows = [
            ['資產編號', asset.asset_no || '', '資產大類', catNameMap[asset.category] || asset.category || ''],
            ['設備名稱', asset.name || '', '購買廠商', asset.vendor_name || '其他 (預設)'],
            ['原廠序列號 (S/N)', asset.sn || '未填寫', '當前狀態', statusNameMap[asset.status] || asset.status || ''],
            ['保管使用窗口', asset.custodian || '未填寫', '購置日期', fmtD(asset.purchase_date)],
            ['實體擺放地點', asset.location || '未填寫', '保固到期日', fmtD(asset.warranty_date)],
            ['所屬部門', deptTextS, '部門代碼', deptCodeS]
        ];
        infoRows.forEach((row, i) => {
            const rowObj = s1.getRow(5 + i);
            rowObj.height = 22;
            paintRow(rowObj, S1_LAST, i % 2 === 1);
            labelCell(rowObj.getCell(1), row[0]); valueCell(rowObj.getCell(2), row[1]);
            labelCell(rowObj.getCell(3), row[2]); valueCell(rowObj.getCell(4), row[3]);
            if (i === 2) { // 當前狀態：比照盤點總表使用狀態色塊
                const ss = statusStyleMap[asset.status];
                if (ss) { const sc = rowObj.getCell(4); sc.fill = solid(ss.bg); sc.font = { size: 10, bold: true, color: { argb: ss.fc } }; }
            }
        });

        // 【二、維運備註與報廢資訊】
        const sec2Row = 5 + infoRows.length;
        sectionBar(s1, sec2Row, S1_LAST, '【二、維運備註與報廢資訊】');
        const noteRows = [
            ['資產規格/備註', asset.spec_note || '無'],
            ['維運備註', asset.notes || '無'],
            ['報廢原因', (asset.status === 'scrapped') ? (asset.scrap_reason || '未填寫') : '—']
        ];
        noteRows.forEach((row, i) => {
            const r = sec2Row + 1 + i;
            s1.mergeCells(r, 2, r, S1_LAST);
            const rowObj = s1.getRow(r);
            // 🧾 規格/備註可能較長：依字數自動加高列高（避免內容被截斷）
            const noteTxt = String(row[1] == null ? '' : row[1]);
            const noteLines = Math.max(1, Math.ceil(noteTxt.length / 38));
            rowObj.height = Math.max(24, Math.min(150, noteLines * 16 + 10));
            rowObj.getCell(1).border = thinBorder();
            labelCell(rowObj.getCell(1), row[0]);
            rowObj.getCell(2).border = thinBorder();
            rowObj.getCell(2).fill = solid(i % 2 === 1 ? CLR.zebra : 'FFFFFFFF');
            valueCell(rowObj.getCell(2), row[1], true);
        });

        // 【三、維運統計總覽】
        const sec3Row = sec2Row + 1 + noteRows.length;
        sectionBar(s1, sec3Row, S1_LAST, '【三、維運統計總覽】');
        const statRows = [
            ['維修總次數', `${repairs.length} 次`, '轉移總次數', `${transfers.length} 次`],
            ['已完工維修', `${repairs.filter(r => r.status === 'completed').length} 次`, '維修中工單', `${repairs.filter(r => r.status === 'pending').length} 次`]
        ];
        statRows.forEach((row, i) => {
            const rowObj = s1.getRow(sec3Row + 1 + i);
            rowObj.height = 22;
            paintRow(rowObj, S1_LAST, i % 2 === 1);
            labelCell(rowObj.getCell(1), row[0]); valueCell(rowObj.getCell(2), row[1]);
            labelCell(rowObj.getCell(3), row[2]); valueCell(rowObj.getCell(4), row[3]);
        });
        s1.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };

        // ===== 工作表 2：維修紀錄 =====
        const s2 = wb.addWorksheet('維修紀錄', { views: [{ state: 'frozen', ySplit: 3 }] });
        s2.columns = [{ width: 6 }, { width: 22 }, { width: 32 }, { width: 16 }, { width: 13 }, { width: 13 }, { width: 12 }, { width: 30 }];
        const S2_LAST = 8;
        banner(s2, 1, S2_LAST, `🔧 維修紀錄　共 ${repairs.length} 筆`, 14);
        subBanner(s2, 2, S2_LAST, `資產編號：${asset.asset_no || ''}　｜　匯出時間：${exportTime}`);
        headerCells(s2, 3, ['次數', '資產編號', '故障情形', '維修廠商', '送修日期', '完工/結案', '費用(元)', '狀態 / 備註']);
        const repStatusMap = { pending: '維修中', completed: '已完工', scrapped: '因報廢結案' };
        const repStatusStyleMap = { pending: { bg: 'FFFEF3C7', fc: 'FFB45309' }, completed: { bg: 'FFDCFCE7', fc: 'FF166534' }, scrapped: { bg: 'FFFEE2E2', fc: 'FFB91C1C' } };
        if (repairs.length === 0) {
            s2.mergeCells(4, 1, 4, S2_LAST);
            const ec = s2.getCell(4, 1);
            ec.value = '本資產尚無維修紀錄。';
            ec.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
            ec.alignment = { horizontal: 'center', vertical: 'middle' };
            ec.fill = solid(CLR.sub);
            ec.border = thinBorder();
            s2.getRow(4).height = 24;
        } else {
            repairs.forEach((rp, i) => {
                const row = s2.getRow(4 + i);
                const vals = [
                    repairs.length - i, rp.asset_no || '', rp.fault_description || '', rp.repair_vendor || '未指定',
                    fmtD(rp.reported_date), rp.status === 'pending' ? '—' : fmtD(rp.completed_date),
                    (rp.cost && parseFloat(rp.cost) > 0) ? Number(rp.cost) : 0,
                    (repStatusMap[rp.status] || rp.status || '') + (rp.notes ? `　${rp.notes}` : '')
                ];
                vals.forEach((v, c) => { row.getCell(c + 1).value = v; });
                paintRow(row, S2_LAST, i % 2 === 1);
                row.getCell(1).font = { size: 10, bold: true, color: { argb: CLR.primary } };
                row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
                row.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
                row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
                row.getCell(3).font = { size: 10 };
                row.getCell(3).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
                row.getCell(4).alignment = { horizontal: 'center', vertical: 'middle' };
                row.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
                row.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
                row.getCell(7).numFmt = '#,##0';
                row.getCell(7).alignment = { horizontal: 'right', vertical: 'middle' };
                row.getCell(8).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
                const ss = repStatusStyleMap[rp.status];
                if (ss) { const sc = row.getCell(8); sc.fill = solid(ss.bg); sc.font = { size: 10, bold: true, color: { argb: ss.fc } }; }
            });
        }
        s2.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: S2_LAST } };
        s2.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };

        // ===== 工作表 3：轉移紀錄 =====
        const s3 = wb.addWorksheet('轉移紀錄', { views: [{ state: 'frozen', ySplit: 3 }] });
        s3.columns = [{ width: 6 }, { width: 22 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 16 }, { width: 13 }, { width: 30 }];
        const S3_LAST = 10;
        banner(s3, 1, S3_LAST, `🔄 轉移紀錄　共 ${transfers.length} 筆`, 14);
        subBanner(s3, 2, S3_LAST, `資產編號：${asset.asset_no || ''}　｜　匯出時間：${exportTime}`);
        headerCells(s3, 3, ['次數', '資產編號', '原部門', '新部門', '原保管人', '新保管人', '原位置', '新位置', '轉移日期', '原因 / 備註']);
        if (transfers.length === 0) {
            s3.mergeCells(4, 1, 4, S3_LAST);
            const ec = s3.getCell(4, 1);
            ec.value = '本資產尚無轉移紀錄。';
            ec.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
            ec.alignment = { horizontal: 'center', vertical: 'middle' };
            ec.fill = solid(CLR.sub);
            ec.border = thinBorder();
            s3.getRow(4).height = 24;
        } else {
            transfers.forEach((tf, i) => {
                const row = s3.getRow(4 + i);
                const vals = [
                    transfers.length - i, tf.asset_no || '', deptT(tf.from_department), deptT(tf.to_department),
                    tf.from_custodian || '—', tf.to_custodian || '—',
                    tf.from_location || '—', tf.to_location || '—', fmtD(tf.transfer_date),
                    [tf.reason, tf.notes].filter(x => x && String(x).trim()).join('　') || '—'
                ];
                vals.forEach((v, c) => { row.getCell(c + 1).value = v; });
                paintRow(row, S3_LAST, i % 2 === 1);
                row.getCell(1).font = { size: 10, bold: true, color: { argb: CLR.primary } };
                row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
                row.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
                row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
                [3, 4, 5, 6, 7, 8, 9].forEach(c => { row.getCell(c).font = { size: 10 }; row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' }; });
                // 新部門 / 新保管人 / 新位置 (異動結果) 以主色標示
                [4, 6, 8].forEach(c => { row.getCell(c).font = { size: 10, bold: true, color: { argb: CLR.primary } }; });
                row.getCell(10).font = { size: 10 };
                row.getCell(10).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
            });
        }
        s3.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: S3_LAST } };
        s3.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };

        // 存檔
        const safeNo = String(asset.asset_no || 'asset').replace(/[\\/:*?"<>|]/g, '_');
        const { filePath } = await dialog.showSaveDialog({ title: '匯出資產履歷', defaultPath: path.join(app.getPath('downloads'), `資產履歷_${safeNo}.xlsx`), filters: [{ name: 'Excel Files', extensions: ['xlsx'] }] });
        if (!filePath) return;
        await wb.xlsx.writeFile(filePath);
        dialog.showMessageBox({ type: 'info', message: `✅ 資產履歷已成功匯出！\n${filePath}` });
    } catch(err) {
        dialog.showMessageBox({ type: 'error', message: '匯出資產履歷時發生錯誤：\n' + (err && err.message ? err.message : err) });
    }
});


// =================================================================
// 13-D. 🏷️ 一維條碼產生器 (Code 128，Subset B / C 自動切換)
//       · 純 Node 實作 (zlib + CRC32)，不依賴任何外部套件
//       · 用途：盤點總表「資產條碼貼紙」欄位（上：資產編號　下：一維條碼）
//       · 內容含連續 4 碼以上數字時自動改用 Subset C（每 2 碼只需 1 個符號，條碼更短更好掃）
// =================================================================
const zlib = require('zlib');

// Code 128 標準樣式表（索引 = 符號值；0~102 資料符號、103 StartA、104 StartB、105 StartC、106 Stop）
// 每個樣式以 11 個模組（'1' = 黑條、'0' = 空白）表示；Stop(106) 為 13 個模組
const CODE128_BARS = [
    11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
    10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
    11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
    10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
    11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
    11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
    11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
    10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
    11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
    10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
    11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
    11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
    11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
    10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
    10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
    11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
    10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
    10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
    11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
    10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
    10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
    11010011100, 1100011101011
];
const CODE128_START_B = 104, CODE128_START_C = 105, CODE128_STOP = 106;
const CODE128_MODULO = 103, CODE128_CODE_B = 100, CODE128_CODE_C = 99;
const code128Pattern = (v) => String(CODE128_BARS[v]).padStart(11, '0');

// 文字 → Code 128 符號值序列（含起始碼與檢查碼）
function code128Values(text) {
    const s = String(text == null ? '' : text).replace(/[^\x20-\x7E]/g, '-'); // 非 ASCII 一律以 '-' 取代，避免產生無效條碼
    const src = s === '' ? 'N/A' : s;
    const isDigit = (i) => i < src.length && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57;
    const digitRun = (i) => { let n = 0; while (isDigit(i + n)) n++; return n; };
    const vals = [];
    let i = 0;
    // 起始碼：開頭連續 4 碼以上數字 → Start C，其餘用 Start B
    let setC = digitRun(0) >= 4;
    vals.push(setC ? CODE128_START_C : CODE128_START_B);
    while (i < src.length) {
        if (setC) {
            if (isDigit(i) && isDigit(i + 1)) { vals.push(parseInt(src.substr(i, 2), 10)); i += 2; continue; }
            vals.push(CODE128_CODE_B); setC = false; continue; // 剩單一數字或非數字 → 切回 Subset B
        }
        const run = digitRun(i);
        if (run >= 6 || (i + run === src.length && run >= 4)) { vals.push(CODE128_CODE_C); setC = true; continue; }
        vals.push(src.charCodeAt(i) - 32); // Subset B：ASCII 32~126 對應值 0~94
        i++;
    }
    // 檢查碼 = (起始碼 + Σ(符號值 × 位序)) mod 103
    let sum = vals[0];
    for (let k = 1; k < vals.length; k++) sum += vals[k] * k;
    vals.push(sum % CODE128_MODULO);
    return vals;
}

// 產生條碼模組字串（'1' = 黑條、'0' = 空白；不含左右留白區）
function code128Modules(text) {
    const vals = code128Values(text);
    let mods = '';
    for (let k = 0; k < vals.length; k++) mods += code128Pattern(vals[k]);
    mods += String(CODE128_BARS[CODE128_STOP]); // Stop 樣式（13 模組，含結尾黑條）
    return mods;
}

// ---- 極簡 PNG 產生器（8-bit 灰階、Filter = None）：只為畫出條碼，不依賴任何外部套件 ----
// 🔁 共用 CRC32（PNG 與 ZIP 都用同一套演算法）
const CRC32_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.slice(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}
// 由「已含 filter byte 的每列像素資料」組出 PNG Buffer
function buildGrayPng(width, height, rawRows) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth：8
    ihdr[9] = 0;  // color type：0 = 灰階
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG 檔頭
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(rawRows, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

// 產生一維條碼 PNG（黑條純黑、底純白；左右各留 quietModules 個模組的空白區）
// 建議：moduleWidth 越大、點陣越細，列印越清晰（Excel 會依貼紙尺寸縮放，不影響掃描）
function code128ToPngBuffer(text, opts) {
    const o = opts || {};
    const moduleWidth = Math.max(1, parseInt(o.moduleWidth, 10) || 3);
    const height = Math.max(10, parseInt(o.height, 10) || 150);
    const quiet = (o.quietModules == null ? 10 : Math.max(0, parseInt(o.quietModules, 10)));
    const mods = code128Modules(text);
    const width = (mods.length + quiet * 2) * moduleWidth;
    // 先組出「單列」點陣，再複製到每一列，避免逐列重複計算
    const rowBits = Buffer.alloc(width, 255); // 255 = 白
    for (let i = 0; i < mods.length; i++) {
        if (mods[i] !== '1') continue;
        const x0 = (quiet + i) * moduleWidth;
        rowBits.fill(0, x0, x0 + moduleWidth); // 0 = 黑
    }
    const rowBytes = width + 1; // 每列開頭 1 byte 為 filter type (0 = None)
    const raw = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y++) {
        raw[y * rowBytes] = 0;
        rowBits.copy(raw, y * rowBytes + 1);
    }
    return buildGrayPng(width, height, raw);
}

// =================================================================
// 14. 匯出「全資訊資產盤點總表」 (含統計總結 + 資產條碼貼紙欄)
// =================================================================
ipcMain.on('export-inventory-excel', async () => {
    try {
        const assetRes = await db.execute(`SELECT a.*, v.name as vendor_name FROM assets_new a LEFT JOIN vendors_new v ON a.vendor_id = v.id WHERE a.is_deleted = 0 ORDER BY COALESCE(NULLIF(a.department,''),'IT') ASC, a.asset_no ASC`);
        const assets = assetRes.rows || [];
        if (assets.length === 0) { dialog.showMessageBox({ type: 'warning', message: '目前沒有任何資訊資產資料可匯出。' }); return; }

        // 統計每筆資產的維修/轉移次數 (僅取總結數據)
        const repRes = await db.execute(`SELECT asset_id, COUNT(*) as total, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending FROM repairs_new GROUP BY asset_id`);
        const trRes = await db.execute(`SELECT asset_id, COUNT(*) as total FROM transfers_new GROUP BY asset_id`);
        const repMap = {}; (repRes.rows || []).forEach(r => { repMap[r.asset_id] = { total: r.total || 0, pending: r.pending || 0 }; });
        const trMap = {}; (trRes.rows || []).forEach(r => { trMap[r.asset_id] = r.total || 0; });

        const catNameMap = { hardware: '硬體設備 (HW)', software: '軟體與授權 (SW)', network: '網路設備 (NET)', peripheral: '資訊周邊 (DEV)', credentials: '資訊與資料庫帳密 (SEC)' };
        const statusNameMap = { active: '線上正常使用', inventory: '庫存備用', repair: '維修中', scrapped: '已報廢' };
        const statusStyleMap = { active: { bg: 'FFDCFCE7', fc: 'FF166534' }, inventory: { bg: 'FFDBEAFE', fc: 'FF1E40AF' }, repair: { bg: 'FFFEF3C7', fc: 'FFB45309' }, scrapped: { bg: 'FFFEE2E2', fc: 'FFB91C1C' } };
        const fmtD = (s) => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? String(s) : `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`; };
        const now = new Date();
        const exportTime = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        const CLR = { primary: 'FF1F4E78', header: 'FF2E75B6', sub: 'FFDDEBF7', zebra: 'FFF2F7FC', border: 'FFB4C6E7' };
        const thinBorder = (color) => { const b = { style: 'thin', color: { argb: color || CLR.border } }; return { top: b, left: b, bottom: b, right: b }; };

        const wb = new ExcelJS.Workbook();
        wb.creator = 'IT Asset Manager';
        wb.created = new Date();
        const ws = wb.addWorksheet('資訊資產盤點總表', { views: [{ state: 'frozen', ySplit: 3 }] });
        const DEPT_NAME = { IT: '資訊部門', DR: '院長室,醫師辦公室', TL: '督導', GA: '總務', MO: '行政', PT: '主任', AC: '人事,會計', CK: '廚房', SM: '倉庫', WO: '工務', LA: '檢驗室', OP: '婦科', IN: '兒科', PO: '警衛', OR: '產房', WA: '病房', HE: '申報', BR: '嬰兒室', CH: '病歷室', CO: '櫃台', P1: '藥局' };
        try {
            const _catOpts = (await db.execute(`SELECT value,label,code FROM field_options WHERE field_type='category'`)).rows || [];
            _catOpts.forEach(o => { catNameMap[o.value] = `${o.label} (${o.code})`; });
            const _depOpts = (await db.execute(`SELECT code,label FROM field_options WHERE field_type='department'`)).rows || [];
            _depOpts.forEach(o => { DEPT_NAME[o.code] = o.label; });
        } catch (e) {}
        const deptDisplay = (a) => { const code = String((a && a.department) || 'IT').toUpperCase(); return DEPT_NAME[code] ? `${code} ${DEPT_NAME[code]}` : code; };

        const columns = [
            { header: '項次', width: 6 },
            { header: '資產編號', width: 24 },
            { header: '部門', width: 18 },
            { header: '設備名稱', width: 24 },
            { header: '資產大類', width: 18 },
            { header: '原廠序列號 (S/N)', width: 20 },
            { header: '保管窗口', width: 12 },
            { header: '當前位置', width: 16 },
            { header: '購買廠商', width: 16 },
            { header: '維運狀態', width: 13 },
            { header: '採購日期', width: 13 },
            { header: '保固到期', width: 13 },
            { header: '維修次數', width: 10 },
            { header: '待修中', width: 9 },
            { header: '轉移次數', width: 10 },
            { header: '資產規格/備註', width: 34 },
            { header: '備註事項', width: 30 },
            { header: '資產條碼 (貼紙)', width: 30 }
        ];
        const lastCol = columns.length;
        ws.columns = columns.map(c => ({ width: c.width }));

        ws.mergeCells(1, 1, 1, lastCol);
        const tCell = ws.getCell(1, 1);
        tCell.value = `📋 資訊資產盤點總表　共 ${assets.length} 筆　｜　匯出時間：${exportTime}`;
        tCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
        tCell.alignment = { horizontal: 'center', vertical: 'middle' };
        tCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.primary } };
        ws.getRow(1).height = 32;

        ws.mergeCells(2, 1, 2, lastCol);
        const subCell = ws.getCell(2, 1);
        subCell.value = '※ 本表為全資產盤點總表；最右欄為「資產條碼貼紙」（上：資產編號　下：一維條碼 Code 128），可裁剪列印；列印時建議將縮放設為 100% 以確保條碼清晰可掃。';
        subCell.font = { size: 10, italic: true, color: { argb: 'FF555555' } };
        subCell.alignment = { horizontal: 'center', vertical: 'middle' };
        subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.sub } };
        ws.getRow(2).height = 18;
        const headRow = ws.getRow(3);
        columns.forEach((c, i) => {
            const cell = headRow.getCell(i + 1);
            cell.value = c.header;
            cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.header } };
            cell.border = thinBorder('FF9DC3E6');
        });
        headRow.height = 28;

        // 🏷️ 預先產生每筆資產的一維條碼圖片 (內容 = 資產編號；Code 128)
        const bcBuffers = assets.map(a => {
            try { return code128ToPngBuffer(String(a.asset_no || 'N/A'), { moduleWidth: 3, height: 150, quietModules: 10 }); }
            catch (e) { return null; }
        });

        // 🏷️ 貼紙欄排版設定：上方顯示資產編號（文字）、下方顯示一維條碼（圖片）
        const DATA_ROW_HEIGHT = 82;                          // 資料列高 (pt)
        const STICKER_COL = 17;                              // 0-based 欄索引 = 資產條碼貼紙欄
        const STICKER_IMG_W = 200;                           // 條碼顯示寬度 (px) ≈ 5.3cm（足夠列印掃描）
        const STICKER_IMG_H = 60;                            // 條碼顯示高度 (px) ≈ 1.6cm
        const STICKER_ROW_PX = DATA_ROW_HEIGHT * 96 / 72;    // 資料列高換算為像素
        const STICKER_DY = 20 / STICKER_ROW_PX;              // 條碼圖片下移比例（讓出上方編號文字空間）

        const firstDataRow = 4;
        assets.forEach((a, i) => {
            const r = firstDataRow + i;
            const row = ws.getRow(r);
            row.height = DATA_ROW_HEIGHT;
            const rep = repMap[a.id] || { total: 0, pending: 0 };
            const trCnt = trMap[a.id] || 0;
            const notesVal = (a.status === 'scrapped' && a.scrap_reason) ? `【報廢】${a.scrap_reason}` : (a.notes || '—');
            const vals = [
                i + 1, a.asset_no || '', deptDisplay(a), a.name || '', catNameMap[a.category] || a.category || '',
                a.sn || '—', a.custodian || '—', a.location || '—', a.vendor_name || '其他 (預設)',
                statusNameMap[a.status] || a.status || '', fmtD(a.purchase_date), fmtD(a.warranty_date),
                rep.total, rep.pending, trCnt, (a.spec_note || '—'), notesVal, a.asset_no || ''
            ];
            vals.forEach((v, c) => {
                const cell = row.getCell(c + 1);
                cell.value = v;
                cell.border = thinBorder();
                cell.font = { size: 10 };
                const numeric = (c === 0 || c === 12 || c === 13 || c === 14);
                const leftAlign = (c === 3 || c === 15 || c === 16);
                cell.alignment = { horizontal: numeric ? 'center' : (leftAlign ? 'left' : 'center'), vertical: 'middle', wrapText: leftAlign, indent: leftAlign ? 1 : 0 };
                if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.zebra } };
            });
            row.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
            row.getCell(3).font = { size: 10, bold: true, color: { argb: 'FF6D28D9' } };
            row.getCell(4).font = { size: 10, bold: true };
            const sCell = row.getCell(10);
            const ss = statusStyleMap[a.status];
            if (ss) { sCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ss.bg } }; sCell.font = { size: 10, bold: true, color: { argb: ss.fc } }; }
            if (a.status === 'scrapped' && a.scrap_reason) row.getCell(17).font = { size: 10, color: { argb: 'FFB91C1C' } };
            if (rep.pending > 0) row.getCell(14).font = { size: 10, bold: true, color: { argb: 'FFB45309' } };
            // 🏷️ 貼紙欄：上方顯示資產編號（文字）、下方嵌合一維條碼圖片（寬約 5.3cm）
            const stickerCell = row.getCell(STICKER_COL + 1);
            stickerCell.font = { size: 9, bold: true, color: { argb: 'FF1F4E78' } };
            stickerCell.alignment = { horizontal: 'center', vertical: 'top' };
            if (bcBuffers[i]) {
                const imgId = wb.addImage({ buffer: bcBuffers[i], extension: 'png' });
                ws.addImage(imgId, { tl: { col: STICKER_COL, row: (r - 1) + 0.30 }, br: { col: STICKER_COL + 1, row: (r - 1) + 0.99 }, editAs: 'twoCell' });
            }
        });

        // 總結列
        const totalRow = firstDataRow + assets.length;
        ws.mergeCells(totalRow, 1, totalRow, lastCol);
        const tCell2 = ws.getCell(totalRow, 1);
        const cntActive = assets.filter(a => a.status === 'active').length;
        const cntInv = assets.filter(a => a.status === 'inventory').length;
        const cntRep = assets.filter(a => a.status === 'repair').length;
        const cntScrap = assets.filter(a => a.status === 'scrapped').length;
        const totRep = Object.keys(repMap).reduce((s, k) => s + (repMap[k].total || 0), 0);
        const totTr = Object.keys(trMap).reduce((s, k) => s + (trMap[k] || 0), 0);
        tCell2.value = `📊 總計：共 ${assets.length} 筆　｜　部門數 ${new Set(assets.map(a => String(a.department || 'IT').toUpperCase())).size}　｜　使用中 ${cntActive}　｜　庫存 ${cntInv}　｜　維修中 ${cntRep}　｜　已報廢 ${cntScrap}　｜　維修總次數 ${totRep}　｜　轉移總次數 ${totTr}`;
        tCell2.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        tCell2.alignment = { horizontal: 'center', vertical: 'middle' };
        tCell2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.primary } };
        tCell2.border = thinBorder();
        ws.getRow(totalRow).height = 26;

        ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + assets.length, column: lastCol - 1 } };
        ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };

        const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
        const { filePath } = await dialog.showSaveDialog({ title: '匯出資產盤點總表', defaultPath: path.join(app.getPath('downloads'), `IT_資產盤點總表_${stamp}.xlsx`), filters: [{ name: 'Excel Files', extensions: ['xlsx'] }] });
        if (!filePath) return;
        await wb.xlsx.writeFile(filePath);
        dialog.showMessageBox({ type: 'info', message: `✅ 資產盤點總表已成功匯出！\n共 ${assets.length} 筆資產\n最右欄為「資產條碼貼紙」：上方資產編號、下方一維條碼 (Code 128)\n\n${filePath}\n\n💡 列印貼紙時建議將縮放設為 100%（A4 分頁列印），以確保條碼清晰可掃。` });
    } catch (err) {
        dialog.showMessageBox({ type: 'error', message: '匯出盤點總表時發生錯誤：\n' + (err && err.message ? err.message : err) });
    }
});
// =================================================================
// 15. 匯出「合作廠商清單」 (廠商管理看板專用；配色與排版完全比照資產盤點總表)
// =================================================================
ipcMain.on('export-vendors-excel', async () => {
    try {
        const vendorRes = await db.execute(`SELECT * FROM vendors_new ORDER BY name ASC`);
        const vendors = vendorRes.rows || [];
        if (vendors.length === 0) { dialog.showMessageBox({ type: 'warning', message: '目前沒有任何合作廠商資料可匯出。' }); return; }

        const now = new Date();
        const exportTime = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        const CLR = { primary: 'FF1F4E78', header: 'FF2E75B6', sub: 'FFDDEBF7', zebra: 'FFF2F7FC', border: 'FFB4C6E7' };
        const thinBorder = (color) => { const b = { style: 'thin', color: { argb: color || CLR.border } }; return { top: b, left: b, bottom: b, right: b }; };
        const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
        const splitPaths = (s) => String(s || '').split(';').map(p => p.trim()).filter(p => p !== '');
        // 📅 維護合約狀態判定 (與前端同一套規則；回傳文字與色碼)
        const maintStatus = (start, end) => {
            const s = String(start || '').trim(); const e = String(end || '').trim();
            if (!s && !e) return { text: '未設定維護合約', bg: 'FFF1F5F9', fc: 'FF64748B' };
            if (!s || !e) return { text: '⚠️ 維護合約期間未填完整', bg: 'FFFEF3C7', fc: 'FFB45309' };
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const endD = new Date(e + 'T00:00:00');
            if (isNaN(endD.getTime())) return { text: '⚠️ 維護截止日格式錯誤', bg: 'FFFEF3C7', fc: 'FFB45309' };
            const diff = Math.round((endD - today) / 86400000);
            if (diff < 0) return { text: '🚨 維護合約已到期', bg: 'FFFEE2E2', fc: 'FFB91C1C' };
            if (diff === 0) return { text: '⏰ 維護合約今天到期', bg: 'FFFEF3C7', fc: 'FFB45309' };
            if (diff <= 7) return { text: `⏰ 維護合約${diff}天後到期`, bg: 'FFFEF3C7', fc: 'FFB45309' };
            const startD = new Date(s + 'T00:00:00');
            if (!isNaN(startD.getTime()) && today < startD) return { text: '🕒 維護合約尚未生效', bg: 'FFDBEAFE', fc: 'FF1E40AF' };
            return { text: '✅ 維護合約生效中', bg: 'FFDCFCE7', fc: 'FF166534' };
        };
        const baseName = (p) => String(p).split(/[\\/]/).pop();
        const banner = (ws, rowNo, lastCol, text, size) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { bold: true, size: size, color: { argb: 'FFFFFFFF' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = solid(CLR.primary);
            c.border = thinBorder();
            ws.getRow(rowNo).height = size >= 16 ? 32 : 24;
        };
        const subBanner = (ws, rowNo, lastCol, text) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { size: 10, italic: true, color: { argb: 'FF555555' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = solid(CLR.sub);
            c.border = thinBorder();
            ws.getRow(rowNo).height = 18;
        };
        const headerCells = (ws, rowNo, headers) => {
            const row = ws.getRow(rowNo);
            headers.forEach((h, i) => {
                const cell = row.getCell(i + 1);
                cell.value = h;
                cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
                cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                cell.fill = solid(CLR.header);
                cell.border = thinBorder('FF9DC3E6');
            });
            row.height = 28;
        };
        const totalBar = (ws, rowNo, lastCol, text) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = solid(CLR.primary);
            c.border = thinBorder();
            ws.getRow(rowNo).height = 26;
        };
        const dataRow = (row, vals, zebra, numericCols, leftCols) => {
            vals.forEach((val, c) => {
                const cell = row.getCell(c + 1);
                cell.value = val;
                cell.border = thinBorder();
                cell.font = { size: 10 };
                const left = leftCols.indexOf(c) >= 0;
                cell.alignment = { horizontal: numericCols.indexOf(c) >= 0 ? 'center' : (left ? 'left' : 'center'), vertical: 'middle', wrapText: left, indent: left ? 1 : 0 };
                if (zebra) cell.fill = solid(CLR.zebra);
            });
        };

        const wb = new ExcelJS.Workbook();
        wb.creator = 'IT Asset Manager';
        wb.created = new Date();
        // ===== 工作表 1：合作廠商清單 =====
        const ws = wb.addWorksheet('合作廠商清單', { views: [{ state: 'frozen', ySplit: 3 }] });
        const columns = [
            { header: '項次', width: 6 },
            { header: '廠商名稱', width: 24 },
            { header: '主要服務專員', width: 16 },
            { header: '聯絡窗口電話', width: 18 },
            { header: '通訊地址', width: 26 },
            { header: '資安 NDA 狀態', width: 16 },
            { header: '維護合約服務範疇', width: 30 },
            { header: '維護開始日', width: 14 },
            { header: '維護截止日', width: 14 },
            { header: '維護合約狀態', width: 26 },
            { header: '維護紀錄數', width: 12 },
            { header: 'NDA 文件數', width: 12 },
            { header: '合約文件數', width: 12 },
            { header: '文件狀態', width: 30 }
        ];
        const lastCol = columns.length;
        ws.columns = columns.map(c => ({ width: c.width }));
        banner(ws, 1, lastCol, `🏢 合作廠商清單　共 ${vendors.length} 家　｜　匯出時間：${exportTime}`, 16);
        subBanner(ws, 2, lastCol, '※ 本表為合作廠商總覽清單；隨附文件明細請參閱「隨附文件清單」工作表。');
        headerCells(ws, 3, columns.map(c => c.header));

        // ===== 工作表 2：隨附文件清單 =====
        const ws2 = wb.addWorksheet('隨附文件清單', { views: [{ state: 'frozen', ySplit: 3 }] });
        const docCols = ['項次', '廠商名稱', '文件類型', '編號', '檔案名稱', '檔案狀態', '完整路徑'];
        const docLastCol = docCols.length;
        ws2.columns = [6, 24, 14, 8, 52, 12, 70].map(w => ({ width: w }));
        banner(ws2, 1, docLastCol, `📁 合作廠商隨附文件清單　｜　匯出時間：${exportTime}`, 14);
        subBanner(ws2, 2, docLastCol, '※「檔案狀態」依匯出當下的硬碟實體檔案是否存在判定（✔ 存在 / ✘ 找不到）。');
        headerCells(ws2, 3, docCols);

        // ===== 資料列 =====
        let docRowNo = 4;
        let docCount = 0;
        let totalNda = 0, totalCon = 0, missingTotal = 0, soonCnt = 0, expiredCnt = 0;
        // 🗂️ 廠商維護紀錄 (供「維護紀錄數」欄位與第 3 個工作表使用)
        const mrecRes = await db.execute(`SELECT * FROM vendor_maint_records ORDER BY maint_date DESC, id DESC`);
        const maintRecords = mrecRes.rows || [];
        const maintRecById = {}, maintRecByName = {};
        maintRecords.forEach(r => {
            maintRecById[String(r.vendor_id || 0)] = (maintRecById[String(r.vendor_id || 0)] || 0) + 1;
            maintRecByName[String(r.vendor_name || '')] = (maintRecByName[String(r.vendor_name || '')] || 0) + 1;
        });
        const maintRecCount = (v) => (maintRecById[String(v.id)] || maintRecByName[String(v.name || '')] || 0);
        vendors.forEach((v, i) => {
            const ndaList = splitPaths(v.nda_files);
            const conList = splitPaths(v.contract_files);
            const allFiles = ndaList.concat(conList);
            const missing = allFiles.filter(p => !fs.existsSync(p)).length;
            totalNda += ndaList.length; totalCon += conList.length; missingTotal += missing;

            const row = ws.getRow(4 + i);
            row.height = 24;
            const mStat = maintStatus(v.maint_start, v.maint_end);
            if (mStat.text.indexOf('已到期') >= 0) expiredCnt++;
            if (mStat.text.indexOf('天後到期') >= 0 || mStat.text.indexOf('今天到期') >= 0) soonCnt++;
            const vals = [
                i + 1, v.name || '', v.representative || '—', v.phone || '—', v.address || '—',
                v.has_nda === 1 ? '🔒 已簽署完成' : '⚠️ 尚未簽署', v.service_items || '—',
                v.maint_start || '—', v.maint_end || '—', mStat.text, maintRecCount(v),
                ndaList.length, conList.length,
                allFiles.length === 0 ? '無隨附文件' : (missing > 0 ? `⚠️ 共 ${allFiles.length} 份，其中 ${missing} 份找不到` : `📁 已歸檔 ${allFiles.length} 份`)
            ];
            dataRow(row, vals, i % 2 === 1, [0, 10, 11, 12], [1, 4, 6, 13]);
            row.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
            // 資安 NDA 狀態色塊 (比照資產狀態色塊)
            const ndaCell = row.getCell(6);
            if (v.has_nda === 1) { ndaCell.fill = solid('FFDCFCE7'); ndaCell.font = { size: 10, bold: true, color: { argb: 'FF166534' } }; }
            else { ndaCell.fill = solid('FFFEE2E2'); ndaCell.font = { size: 10, bold: true, color: { argb: 'FFB91C1C' } }; }
            // 📅 維護合約狀態色塊 (綠＝生效中 / 黃＝即將到期 / 紅＝已到期)
            const mCell = row.getCell(10);
            mCell.fill = solid(mStat.bg);
            mCell.font = { size: 10, bold: true, color: { argb: mStat.fc } };

            const writeDocs = (list, typeLabel) => {
                list.forEach((p, idx) => {
                    const exists = fs.existsSync(p);
                    const dRow = ws2.getRow(docRowNo);
                    dRow.height = 20;
                    dataRow(dRow, [i + 1, v.name || '', typeLabel, idx + 1, baseName(p), exists ? '✔ 存在' : '✘ 找不到', p], (docRowNo % 2 === 0), [0, 2, 3, 5], [1, 4, 6]);
                    dRow.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
                    dRow.getCell(6).font = { size: 10, bold: true, color: { argb: exists ? 'FF166534' : 'FFB91C1C' } };
                    docRowNo++; docCount++;
                });
            };
            writeDocs(ndaList, '🔒 NDA 條款');
            writeDocs(conList, '📄 採購合約');
        });
        if (docCount === 0) {
            ws2.mergeCells(4, 1, 4, docLastCol);
            const ec = ws2.getCell(4, 1);
            ec.value = '目前所有合作廠商都沒有隨附文件。';
            ec.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
            ec.alignment = { horizontal: 'center', vertical: 'middle' };
            ec.fill = solid(CLR.sub);
            ec.border = thinBorder();
            ws2.getRow(4).height = 24;
            docRowNo = 5;
        }
        // ===== 工作表 3：廠商維護紀錄 =====
        const ws3 = wb.addWorksheet('廠商維護紀錄', { views: [{ state: 'frozen', ySplit: 3 }] });
        const recCols = ['項次', '維護日期', '廠商名稱', '維護設備', '設備序號', '維護類型', '維護人員', '費用(元)', '簽收', '維護內容 / 備註', '單據數', '單據檔案'];
        const recLastCol = recCols.length;
        ws3.columns = [6, 13, 22, 20, 18, 14, 14, 11, 11, 40, 9, 46].map(w => ({ width: w }));
        banner(ws3, 1, recLastCol, `🗂️ 廠商設備維護紀錄　共 ${maintRecords.length} 筆　｜　匯出時間：${exportTime}`, 16);
        subBanner(ws3, 2, recLastCol, '※ 維護單據實體檔案存放於 uploads/廠商名稱/維護單資訊/維護日期/ 資料夾。');
        headerCells(ws3, 3, recCols);
        if (maintRecords.length === 0) {
            ws3.mergeCells(4, 1, 4, recLastCol);
            const ec3 = ws3.getCell(4, 1);
            ec3.value = '目前尚無廠商維護紀錄。';
            ec3.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
            ec3.alignment = { horizontal: 'center', vertical: 'middle' };
            ec3.fill = solid(CLR.sub);
            ec3.border = thinBorder();
            ws3.getRow(4).height = 24;
        } else {
            maintRecords.forEach((r, i) => {
                const row = ws3.getRow(4 + i);
                row.height = 22;
                const docs = splitPaths(r.doc_files);
                const vals = [
                    i + 1, r.maint_date || '—', r.vendor_name || '—', r.equipment || '—', r.equipment_sn || '—',
                    r.maint_type || '—', r.handler || '—', parseFloat(r.cost) || 0,
                    r.signed === 1 ? '✍️ 已簽收' : '⏳ 未簽收',
                    [r.content, r.notes].filter(x => x && String(x).trim()).join('　') || '—',
                    docs.length, docs.map(p => baseName(p)).join('\n')
                ];
                dataRow(row, vals, i % 2 === 1, [0, 7, 10], [3, 5, 9, 11]);
                row.getCell(3).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
                row.getCell(8).numFmt = '#,##0';
                const sCell = row.getCell(9);
                if (r.signed === 1) { sCell.fill = solid('FFDCFCE7'); sCell.font = { size: 10, bold: true, color: { argb: 'FF166534' } }; }
                else { sCell.fill = solid('FFFEE2E2'); sCell.font = { size: 10, bold: true, color: { argb: 'FFB91C1C' } }; }
                row.getCell(12).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
            });
        }
        const recTotalRow = maintRecords.length === 0 ? 5 : 4 + maintRecords.length;
        const recCostSum = maintRecords.reduce((s, r) => s + (parseFloat(r.cost) || 0), 0);
        const recDocSum = maintRecords.reduce((s, r) => s + splitPaths(r.doc_files).length, 0);
        totalBar(ws3, recTotalRow, recLastCol, `📊 總計：共 ${maintRecords.length} 筆維護紀錄　｜　已簽收 ${maintRecords.filter(r => r.signed === 1).length}　｜　未簽收 ${maintRecords.filter(r => r.signed !== 1).length}　｜　維護費用合計 ${recCostSum.toLocaleString()} 元　｜　單據檔案 ${recDocSum} 份`);
        ws3.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: recLastCol - 1 } };
        ws3.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };

        const cntSigned = vendors.filter(v => v.has_nda === 1).length;
        totalBar(ws, 4 + vendors.length, lastCol, `📊 總計：共 ${vendors.length} 家廠商　｜　已簽 NDA ${cntSigned}　｜　未簽 NDA ${vendors.length - cntSigned}　｜　NDA 文件 ${totalNda} 份　｜　合約文件 ${totalCon} 份　｜　合約即將到期 ${soonCnt}　｜　合約已到期 ${expiredCnt}　｜　維護紀錄 ${maintRecords.length} 筆　｜　找不到的檔案 ${missingTotal} 份`);
        totalBar(ws2, docRowNo, docLastCol, `📊 總計：共 ${docCount} 個隨附檔案（找不到 ${missingTotal} 個）`);

        ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + vendors.length, column: lastCol - 1 } };
        ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
        ws2.autoFilter = { from: { row: 3, column: 1 }, to: { row: Math.max(3, docRowNo - 1), column: docLastCol } };
        ws2.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };

        const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
        const { filePath } = await dialog.showSaveDialog({ title: '匯出合作廠商清單', defaultPath: path.join(app.getPath('downloads'), `IT_合作廠商清單_${stamp}.xlsx`), filters: [{ name: 'Excel Files', extensions: ['xlsx'] }] });
        if (!filePath) return;
        await wb.xlsx.writeFile(filePath);
        dialog.showMessageBox({ type: 'info', message: `✅ 合作廠商清單已成功匯出！\n共 ${vendors.length} 家廠商、${docCount} 個隨附檔案\n${filePath}` });
    } catch (err) {
        dialog.showMessageBox({ type: 'error', message: '匯出合作廠商清單時發生錯誤：\n' + (err && err.message ? err.message : err) });
    }
});

// 10.5 資產維運履歷事件日志系統 (自動記錄每次操作)

async function logAssetHistory(assetId, assetNo, eventType, eventTitle, eventDetail) {
    try {
        await db.execute({ sql: `INSERT INTO asset_history_new (asset_id, asset_no, event_type, event_title, event_detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`, args: [assetId || 0, assetNo || '', eventType, eventTitle, eventDetail, new Date().toISOString()] });
    } catch(err) {}
}

ipcMain.on('get-asset-history', async (event, data) => {
    try {
        const res = await db.execute({ sql: `SELECT * FROM asset_history_new WHERE asset_id = ? ORDER BY id DESC`, args: [parseInt(data.assetId)] });
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('asset-history-reply', { assetId: data.assetId, history: res.rows || [] });
    } catch(err) {}
});

// 取得單一資產的維修週期紀錄 (每筆工單 = 一個 維修→完工/報廢 生命週期)
ipcMain.on('get-asset-repair-cycles', async (event, data) => {
    try {
        const res = await db.execute({ sql: `SELECT * FROM repairs_new WHERE asset_id = ? ORDER BY id DESC`, args: [parseInt(data.assetId)] });
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('asset-repair-cycles-reply', { assetId: data.assetId, cycles: res.rows || [] });
    } catch(err) {}
});

// 取得單一資產的轉移歷程紀錄 (每筆 = 一次 保管人/位置 轉移)
ipcMain.on('get-asset-transfer-cycles', async (event, data) => {
    try {
        const res = await db.execute({ sql: `SELECT * FROM transfers_new WHERE asset_id = ? ORDER BY id DESC`, args: [parseInt(data.assetId)] });
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('asset-transfer-cycles-reply', { assetId: data.assetId, transfers: res.rows || [] });
    } catch(err) {}
});

// 11. 資訊資產維修管理 (全新資料表)
async function pushAllRepairsToFrontend() {
    try {
        const sql = `SELECT * FROM repairs_new ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id DESC`;
        const res = await db.execute(sql);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('all-repairs-data', res.rows || []);
    } catch(err) {}
}

ipcMain.on('get-all-repairs', async () => { await pushAllRepairsToFrontend(); });

ipcMain.on('save-repair', async (event, r) => {
    try {
        const sqlInsert = `INSERT INTO repairs_new (asset_id, asset_no, asset_name, fault_description, repair_vendor, reported_date, completed_date, cost, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.execute({ sql: sqlInsert, args: [r.asset_id, r.asset_no, r.asset_name, r.fault_description, r.repair_vendor, r.reported_date, r.completed_date || '', r.cost, r.status || 'pending', r.notes, new Date().toISOString()] });
        // 報修時自動將資產狀態改為維修中
        if (r.asset_id) await db.execute({ sql: `UPDATE assets_new SET status = 'repair' WHERE id = ?`, args: [parseInt(r.asset_id)] });
        await logAssetHistory(parseInt(r.asset_id), r.asset_no, 'repair', '登記資產維修', `故障:${r.fault_description}${r.repair_vendor ? ' ｜ 廠商:' + r.repair_vendor : ''}`);
        await pushAllRepairsToFrontend();
        await pushAllAssetsToFrontend();
    } catch(err) {}
});

ipcMain.on('complete-repair', async (event, id) => {
    try {
        const completedDate = new Date().toISOString().slice(0, 10);
        const res = await db.execute({ sql: `SELECT asset_id, asset_no FROM repairs_new WHERE id = ?`, args: [parseInt(id)] });
        await db.execute({ sql: `UPDATE repairs_new SET status = 'completed', completed_date = ? WHERE id = ?`, args: [completedDate, parseInt(id)] });
        // 完工時自動將資產狀態復原為使用中
        if (res && res.rows && res.rows.length > 0) {
            await db.execute({ sql: `UPDATE assets_new SET status = 'active' WHERE id = ?`, args: [parseInt(res.rows[0].asset_id)] });
            await logAssetHistory(parseInt(res.rows[0].asset_id), res.rows[0].asset_no, 'complete', '維修完工結案', `完工日期:${completedDate} ｜ 資產已復原為使用中`);
        }
        await pushAllRepairsToFrontend();
        await pushAllAssetsToFrontend();
    } catch(err) {}
});

ipcMain.on('delete-repair', async (event, id) => {
    try {
        await db.execute({ sql: `DELETE FROM repairs_new WHERE id = ?`, args: [parseInt(id)] });
        await pushAllRepairsToFrontend();
    } catch(err) {}
});

// 12. 資訊資產轉移管理 (全新資料表)
async function pushAllTransfersToFrontend() {
    try {
        const sql = `SELECT * FROM transfers_new ORDER BY id DESC`;
        const res = await db.execute(sql);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('all-transfers-data', res.rows || []);
    } catch(err) {}
}

ipcMain.on('get-all-transfers', async () => { await pushAllTransfersToFrontend(); });

ipcMain.on('save-transfer', async (event, t) => {
    try {
        const assetId = parseInt(t.asset_id);
        // 1. 取得目前資產資料
        const curRes = await db.execute({ sql: `SELECT asset_no, name, category, department, custodian, location FROM assets_new WHERE id = ?`, args: [assetId] });
        const cur = (curRes.rows && curRes.rows[0]) || {};
        const fromDept = String(cur.department || 'IT').toUpperCase();
        const fromAssetNo = cur.asset_no || t.asset_no || '';
        const toDept = String(t.to_department || fromDept).toUpperCase();
        // 2. 解析舊編號取得「類別」與「建檔日期」
        let cat = '', datePart = '';
        const m = String(fromAssetNo).match(/^([A-Z0-9]+)-([A-Z0-9]+)-(\d{8})-(\d{4})$/);
        if (m) { cat = m[1]; datePart = m[3]; }
        else {
            const m2 = String(fromAssetNo).match(/^IT-([A-Z0-9]+)-(\d{8})-(\d{4})$/);
            if (m2) { cat = m2[1]; datePart = m2[2]; }
            else {
                const pm = { hardware: 'HW', software: 'SW', network: 'NET', peripheral: 'DEV', credentials: 'SEC' };
                cat = pm[cur.category] || 'AST';
                datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            }
        }
        // 3. 部門有變化才重新編號（依「新部門 + 同類別 + 同建檔日期」的流水號）
        let newAssetNo = fromAssetNo;
        if (toDept !== fromDept) {
            const nextSeq = await computeNextSeqByDept(cat, toDept, assetId);
            newAssetNo = `${cat}-${toDept}-${datePart}-${String(nextSeq).padStart(4, '0')}`;
        }
        // 4. 寫入轉移紀錄（含部門與編號變化）
        const sqlInsert = `INSERT INTO transfers_new (asset_id, asset_no, asset_name, from_custodian, to_custodian, from_location, to_location, from_department, to_department, from_asset_no, to_asset_no, transfer_date, reason, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.execute({ sql: sqlInsert, args: [assetId, newAssetNo, t.asset_name || cur.name || '', t.from_custodian, t.to_custodian, t.from_location, t.to_location, fromDept, toDept, fromAssetNo, newAssetNo, t.transfer_date, t.reason, t.notes, new Date().toISOString()] });
        // 5. 更新資產主表：保管人 / 位置 / 部門 / 編號
        await db.execute({ sql: `UPDATE assets_new SET custodian = ?, location = ?, department = ?, asset_no = ? WHERE id = ?`, args: [t.to_custodian, t.to_location, toDept, newAssetNo, assetId] });
        // 6. 同步關聯表的資產編號
        if (newAssetNo !== fromAssetNo) {
            await db.execute({ sql: `UPDATE repairs_new SET asset_no = ? WHERE asset_id = ?`, args: [newAssetNo, assetId] });
            await db.execute({ sql: `UPDATE transfers_new SET asset_no = ? WHERE asset_id = ?`, args: [newAssetNo, assetId] });
            await db.execute({ sql: `UPDATE asset_history_new SET asset_no = ? WHERE asset_id = ?`, args: [newAssetNo, assetId] });
        }
        // 7. 履歷
        await logAssetHistory(assetId, newAssetNo, 'transfer', '資產轉移登記', `部門:${fromDept} → ${toDept} ｜ 編號:${fromAssetNo} → ${newAssetNo} ｜ 保管人:${t.from_custodian || '無'} → ${t.to_custodian || '無'} ｜ 位置:${t.from_location || '無'} → ${t.to_location || '無'}`);
        await pushAllTransfersToFrontend();
        await pushAllAssetsToFrontend();
    } catch(err) {}
});

ipcMain.on('delete-transfer', async (event, id) => {
    try {
        await db.execute({ sql: `DELETE FROM transfers_new WHERE id = ?`, args: [parseInt(id)] });
        await pushAllTransfersToFrontend();
    } catch(err) {}
});

// 10. 視窗建立與開機總保險絲
function createWindow() {
    mainWindow = new BrowserWindow({ width: 1280, height: 850, title: 'IT 資產管理系統', webPreferences: { nodeIntegration: true, contextIsolation: false } });
    mainWindow.loadFile('index.html');
    mainWindow.webContents.on('did-finish-load', async () => {
        await pushAllAssetsToFrontend();
        await pushAllVendorsToFrontend();
    });
}

// 🆕 開啟「操作說明」視窗（圖文並茂的基本功能操作教學）
function showHelpGuideWindow() {
    try {
        const w = new BrowserWindow({ width: 1040, height: 800, title: '操作說明', autoHideMenuBar: true, backgroundColor: '#f8fafc', webPreferences: { nodeIntegration: false, contextIsolation: true } });
        w.setMenuBarVisibility(false);
        w.loadFile(path.join(__dirname, 'help-guide.html'));
    } catch (e) {}
}

// 🆕 開啟「版本說明」視窗
function showVersionWindow() {
    try {
        const ver = (() => { try { return app.getVersion() || '1.0.0'; } catch (e) { return '1.0.0'; } })();
        const html = `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><style>
        *{box-sizing:border-box;margin:0;padding:0;font-family:"Microsoft JhengHei","Segoe UI",sans-serif;}
        body{background:#f8fafc;padding:24px;color:#0f172a;}
        .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 10px 30px rgba(15,23,42,.08);overflow:hidden;}
        .top{background:linear-gradient(135deg,#1e293b,#334155);color:#fff;padding:22px 24px;}
        .top h1{font-size:20px;}
        .top p{font-size:12px;color:#cbd5e1;margin-top:6px;}
        ul{list-style:none;padding:8px 24px 20px;}
        li{display:flex;gap:10px;padding:12px 0;border-bottom:1px dashed #e2e8f0;font-size:14px;line-height:1.6;}
        li:last-child{border-bottom:none;}
        .k{color:#64748b;min-width:92px;font-weight:bold;}
        .v{color:#0f172a;font-weight:bold;word-break:break-all;}
        .ver{display:inline-block;background:#2563eb;color:#fff;border-radius:999px;padding:2px 12px;font-size:13px;}
        .mail{color:#2563eb;text-decoration:none;}
        .foot{padding:14px 24px;background:#f1f5f9;color:#b45309;font-weight:bold;font-size:13px;text-align:center;}
        </style></head><body><div class="card">
        <div class="top"><h1>📌 版本說明</h1><p>IT 資產管理系統</p></div>
        <ul>
        <li><span class="k">系統開發</span><span class="v">Kevin Chang</span></li>
        <li><span class="k">開發日期</span><span class="v">2026.10.15</span></li>
        <li><span class="k">更新日期</span><span class="v">2026.11.10</span></li>
        <li><span class="k">目前版本</span><span class="v"><span class="ver">v${ver}</span></span></li>
        <li><span class="k">本次更新</span><span class="v">「🔄 版本更新」改為直接讀取 GitHub Releases 最新版本：可自動檢查、下載並安裝，無需自架更新伺服器；仍保留自訂 latest.json 與私有倉庫 Token 設定。</span></li>
        <li><span class="k">聯絡信箱</span><span class="v"><a class="mail" href="mailto:kevin7563@gmail.com">kevin7563@gmail.com</a></span></li>
        <li><span class="k">版權宣告</span><span class="v">版權所有，盜版必究</span></li>
        </ul>
        <div class="foot">© 2026 Kevin Chang · 版權所有，盜版必究</div>
        </div></body></html>`;
        const w = new BrowserWindow({ width: 480, height: 660, title: '版本說明', resizable: false, minimizable: true, maximizable: false, autoHideMenuBar: true, parent: (mainWindow || undefined), modal: !!mainWindow, webPreferences: { nodeIntegration: false, contextIsolation: true } });
        w.setMenuBarVisibility(false);
        w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    } catch (e) {}
}

// 🆕 繁體中文應用程式選單（說明選單僅「操作說明 / 版本說明」兩項）
function buildAppMenu() {
    try {
        const template = [
            { label: '檔案', submenu: [ { role: 'quit', label: '結束' } ] },
            { label: '編輯', submenu: [
                { role: 'undo', label: '復原' }, { role: 'redo', label: '重做' }, { type: 'separator' },
                { role: 'cut', label: '剪下' }, { role: 'copy', label: '複製' }, { role: 'paste', label: '貼上' }, { role: 'selectAll', label: '全選' }
            ] },
            { label: '檢視', submenu: [
                { role: 'reload', label: '重新載入' }, { role: 'toggleDevTools', label: '開發者工具' }, { type: 'separator' },
                { role: 'resetZoom', label: '實際大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '縮小' }, { type: 'separator' },
                { role: 'togglefullscreen', label: '全螢幕' }
            ] },
            { label: '視窗', submenu: [ { role: 'minimize', label: '最小化' }, { role: 'close', label: '關閉' } ] },
            { label: '說明', submenu: [
                { label: '操作說明', click: () => showHelpGuideWindow() },
                { label: '版本說明', click: () => showVersionWindow() }
            ] }
        ];
        Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } catch (e) {}
}

app.whenReady().then(async () => {
    await initDatabase();
    await upgradeDatabaseTables();
    await authEnsureSchema();
    buildAppMenu();
    createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// 🎯 註：單一廠商完整資料反查專線，已統一註冊於上方「8. 廠商修改隨附檔案反查」區段，此處不再重複註冊
//    (重複註冊會導致同一次請求被回覆多次，且各版本回傳格式不一致)
// =================================================================
// 🎯【全新獨立廠商維護分頁 - 後端大腦專線】
// =================================================================

// 1. 網頁下拉選單或點擊確定反查廠商時，一發將所有 8 欄位與檔案字串完好拋回！
ipcMain.on('maintenance-query-vendor-by-id', async (event, vendorId) => {
    try {
        const res = await db.execute({ sql: `SELECT * FROM vendors_new WHERE id = ?`, args: [parseInt(vendorId)] });
        if (res && res.rows && res.rows.length > 0) {
            // 精準把這一列物件陣列原封不動拋還給獨立分頁
            event.reply('maintenance-query-vendor-reply', res.rows);
        }
    } catch(err) {}
});

// 2. 獨立維護頁面刪除隨附檔案後，改由前端重新呼叫 'maintenance-query-vendor-by-id' 反查最新狀態
//    (原本此處重複註冊 get-vendor-detail-for-edit 且回傳陣列，已移除以免格式不一致)

// =================================================================
// 16. 廠商維護紀錄 (廠商設備維護資訊與歷程 + 維護單據文件歸檔)
//     維護單據實體檔案存放規則：uploads\<廠商名稱>\維護單資訊\<維護日期 YYYY-MM-DD>\
// =================================================================
async function pushAllVendorMaintRecordsToFrontend() {
    try {
        const res = await db.execute(`SELECT * FROM vendor_maint_records ORDER BY maint_date DESC, id DESC`);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('all-vendor-maint-records-data', res.rows || []);
    } catch (err) {}
}

ipcMain.on('get-all-vendor-maint-records', async () => { await pushAllVendorMaintRecordsToFrontend(); });

// 16-1. 挑選維護單據多檔 (原生檔案對話框)
ipcMain.on('select-multi-maint-docs', async (event) => {
    try {
        const { canceled, filePaths } = await dialog.showOpenDialog({ title: 'Select Vendor Maintenance Documents', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Docs', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'doc', 'docx', 'xls', 'xlsx'] }] });
        if (!canceled && filePaths && filePaths.length > 0) event.sender.send('multi-maint-docs-reply', filePaths.length, filePaths.join(';'));
    } catch (err) {}
});

// 16-2. 將維護單據複製歸檔至 uploads\<廠商>\維護單資訊\<維護日期>\
ipcMain.on('import-vendor-maint-docs', async (event, data) => {
    try {
        const { vendorName, maintDate, paths } = data || {};
        const cleanName = String(vendorName || '').trim();
        const cleanDate = String(maintDate || '').trim();
        const list = Array.isArray(paths) ? paths : String(paths || '').split(';').map(p => p.trim()).filter(p => p !== '');
        if (cleanName === '' || list.length === 0) { event.reply('import-vendor-maint-docs-reply', { ok: false, paths: [], folder: '', message: '缺少廠商名稱或維護日期/檔案' }); return; }
        const safeVendor = cleanName.replace(/[\\/:*?"<>|]/g, '_').trim();
        const safeDate = (cleanDate === '' ? '未指定日期' : cleanDate).replace(/[\\/:*?"<>|]/g, '_');
        const targetDir = path.join(dataDir(), safeVendor, '維護單資訊', safeDate);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const saved = [];
        list.forEach(fp => {
            try {
                if (!fp || !fs.existsSync(fp)) return;
                // 已在目標資料夾內的檔案直接沿用，不重複複製
                if (path.resolve(fp).toLowerCase().indexOf(path.resolve(targetDir).toLowerCase()) === 0) { saved.push(fp); return; }
                const dest = path.join(targetDir, path.basename(fp));
                fs.copyFileSync(fp, dest);
                saved.push(dest);
            } catch (e) {}
        });
        event.reply('import-vendor-maint-docs-reply', { ok: saved.length > 0, paths: saved, folder: targetDir, message: saved.length === 0 ? '檔案複製失敗或來源檔案不存在' : '' });
    } catch (err) {
        event.reply('import-vendor-maint-docs-reply', { ok: false, paths: [], folder: '', message: (err && err.message) || '匯入失敗' });
    }
});

// 16-3. 新增一筆廠商維護紀錄
ipcMain.on('save-vendor-maint-record', async (event, r) => {
    try {
        const vendorName = String((r && r.vendor_name) || '').trim();
        const maintDate = String((r && r.maint_date) || '').trim();
        if (vendorName === '' || maintDate === '') { event.reply('vendor-maint-record-rejected', 'missing-required'); return; }
        const sqlInsert = `INSERT INTO vendor_maint_records (vendor_id, vendor_name, maint_date, equipment, equipment_sn, maint_type, handler, cost, signed, content, notes, doc_files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await db.execute({ sql: sqlInsert, args: [parseInt(r.vendor_id) || 0, vendorName, maintDate, r.equipment || '', r.equipment_sn || '', r.maint_type || '', r.handler || '', parseFloat(r.cost) || 0, parseInt(r.signed) || 0, r.content || '', r.notes || '', r.doc_files || '', new Date().toISOString()] });
        event.reply('vendor-maint-record-saved');
        await pushAllVendorMaintRecordsToFrontend();
    } catch (err) {}
});

// 16-4. 刪除維護紀錄 (維護單據實體檔會保留在 uploads\<廠商>\維護單資訊\<日期>\，可事後人工處理)
ipcMain.on('delete-vendor-maint-record', async (event, id) => {
    try {
        await db.execute({ sql: `DELETE FROM vendor_maint_records WHERE id = ?`, args: [parseInt(id)] });
        event.reply('vendor-maint-record-deleted');
        await pushAllVendorMaintRecordsToFrontend();
    } catch (err) {}
});

// 16-6. 匯出「單一廠商維護歷程」Excel (配色與排版比照廠商清單/盤點總表)
ipcMain.on('export-vendor-maint-history-excel', async (event, data) => {
    try {
        const vendorName = String((data && data.vendorName) || '').trim();
        if (vendorName === '') { dialog.showMessageBox({ type: 'warning', message: '請先選擇要匯出的廠商。' }); return; }

        const res = await db.execute({ sql: `SELECT * FROM vendor_maint_records WHERE vendor_name = ? ORDER BY maint_date DESC, id DESC`, args: [vendorName] });
        const records = res.rows || [];
        if (records.length === 0) { dialog.showMessageBox({ type: 'warning', message: `廠商「${vendorName}」目前沒有任何維護紀錄可匯出。` }); return; }
        // 📅 維護日期一律由新到舊 (相容 2026/10/16、2026-9-1 等格式；同日期再依 id 由新到舊)
        const dateKeyOf = (s) => {
            const t = String(s || '').trim().replace(/[./]/g, '-');
            const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
            return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : t;
        };
        records.sort((a, b) => {
            const ka = dateKeyOf(a.maint_date), kb = dateKeyOf(b.maint_date);
            if (ka !== kb) { if (ka === '') return 1; if (kb === '') return -1; return ka < kb ? 1 : -1; }
            return (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0);
        });
        const vRes = await db.execute({ sql: `SELECT * FROM vendors_new WHERE name = ? ORDER BY id DESC LIMIT 1`, args: [vendorName] });
        const vendor = (vRes && vRes.rows && vRes.rows[0]) || {};

        const now = new Date();
        const exportTime = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        const CLR = { primary: 'FF1F4E78', header: 'FF2E75B6', sub: 'FFDDEBF7', zebra: 'FFF2F7FC', border: 'FFB4C6E7' };
        const thinBorder = (color) => { const b = { style: 'thin', color: { argb: color || CLR.border } }; return { top: b, left: b, bottom: b, right: b }; };
        const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
        const splitPaths = (s) => String(s || '').split(';').map(p => p.trim()).filter(p => p !== '');
        const baseName = (p) => String(p).split(/[\\/]/).pop();
        const banner = (ws, rowNo, lastCol, text, size) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { bold: true, size: size, color: { argb: 'FFFFFFFF' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = solid(CLR.primary);
            c.border = thinBorder();
            ws.getRow(rowNo).height = size >= 16 ? 32 : 24;
        };
        const subBanner = (ws, rowNo, lastCol, text) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { size: 10, italic: true, color: { argb: 'FF555555' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = solid(CLR.sub);
            c.border = thinBorder();
            ws.getRow(rowNo).height = 18;
        };
        const headerCells = (ws, rowNo, headers) => {
            const row = ws.getRow(rowNo);
            headers.forEach((h, i) => {
                const cell = row.getCell(i + 1);
                cell.value = h;
                cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
                cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                cell.fill = solid(CLR.header);
                cell.border = thinBorder('FF9DC3E6');
            });
            row.height = 28;
        };
        const totalBar = (ws, rowNo, lastCol, text) => {
            ws.mergeCells(rowNo, 1, rowNo, lastCol);
            const c = ws.getCell(rowNo, 1);
            c.value = text;
            c.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = solid(CLR.primary);
            c.border = thinBorder();
            ws.getRow(rowNo).height = 26;
        };
        const dataRow = (row, vals, zebra, numericCols, leftCols) => {
            vals.forEach((val, c) => {
                const cell = row.getCell(c + 1);
                cell.value = val;
                cell.border = thinBorder();
                cell.font = { size: 10 };
                const left = leftCols.indexOf(c) >= 0;
                cell.alignment = { horizontal: numericCols.indexOf(c) >= 0 ? 'center' : (left ? 'left' : 'center'), vertical: 'middle', wrapText: left, indent: left ? 1 : 0 };
                if (zebra) cell.fill = solid(CLR.zebra);
            });
        };

        const wb = new ExcelJS.Workbook();
        wb.creator = 'IT Asset Manager';
        wb.created = new Date();
        const pageSetupLandscape = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
        const cntSigned = records.filter(r => r.signed === 1).length;
        const costSum = records.reduce((s, r) => s + (parseFloat(r.cost) || 0), 0);
        const docSum = records.reduce((s, r) => s + splitPaths(r.doc_files).length, 0);
        const vStatus = (vendor.maint_start || vendor.maint_end)
            ? `維護合約：${vendor.maint_start || '未設定'} ~ ${vendor.maint_end || '未設定'}`
            : '維護合約：未設定';
        // ===== 工作表 1：維護歷程 =====
        const ws = wb.addWorksheet('維護歷程', { views: [{ state: 'frozen', ySplit: 3 }] });
        const recCols = ['項次', '維護日期', '維護設備', '設備序號', '維護類型', '維護人員', '費用(元)', '簽收', '維護內容 / 備註', '單據數', '單據檔案'];
        const recLastCol = recCols.length;
        ws.columns = [6, 13, 20, 18, 14, 14, 11, 11, 40, 9, 46].map(w => ({ width: w }));
        banner(ws, 1, recLastCol, `🗂️ 廠商維護歷程 ｜ ${vendorName}　共 ${records.length} 筆　｜　匯出時間：${exportTime}`, 16);
        subBanner(ws, 2, recLastCol, `維護專員：${vendor.representative || '—'}　｜　聯絡電話：${vendor.phone || '—'}　｜　${vStatus}　｜　資安 NDA：${vendor.has_nda === 1 ? '🔒 已簽署完成' : '⚠️ 尚未簽署'}　｜　服務範疇：${vendor.service_items || '—'}　｜　排序：維護日期由新到舊`);
        headerCells(ws, 3, recCols);
        records.forEach((r, i) => {
            const row = ws.getRow(4 + i);
            row.height = 22;
            const docs = splitPaths(r.doc_files);
            const vals = [
                i + 1, r.maint_date || '—', r.equipment || '—', r.equipment_sn || '—',
                r.maint_type || '—', r.handler || '—', parseFloat(r.cost) || 0,
                r.signed === 1 ? '✍️ 已簽收' : '⏳ 未簽收',
                [r.content, r.notes].filter(x => x && String(x).trim()).join('　') || '—',
                docs.length, docs.map(p => baseName(p)).join('\n')
            ];
            dataRow(row, vals, i % 2 === 1, [0, 6, 9], [2, 4, 8, 10]);
            row.getCell(3).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
            row.getCell(7).numFmt = '#,##0';
            const sCell = row.getCell(8);
            if (r.signed === 1) { sCell.fill = solid('FFDCFCE7'); sCell.font = { size: 10, bold: true, color: { argb: 'FF166534' } }; }
            else { sCell.fill = solid('FFFEE2E2'); sCell.font = { size: 10, bold: true, color: { argb: 'FFB91C1C' } }; }
            row.getCell(11).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
        });
        const recTotalRow = 4 + records.length;
        totalBar(ws, recTotalRow, recLastCol, `📊 總計：共 ${records.length} 筆維護紀錄　｜　已簽收 ${cntSigned}　｜　未簽收 ${records.length - cntSigned}　｜　維護費用合計 ${costSum.toLocaleString()} 元　｜　單據檔案 ${docSum} 份`);
        ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: recLastCol - 1 } };
        ws.pageSetup = pageSetupLandscape;

        // ===== 工作表 2：維護單據清單 =====
        const ws2 = wb.addWorksheet('維護單據清單', { views: [{ state: 'frozen', ySplit: 3 }] });
        const docCols = ['項次', '維護日期', '維護設備', '維護類型', '檔案名稱', '檔案狀態', '完整路徑'];
        const docLastCol = docCols.length;
        ws2.columns = [6, 13, 20, 14, 52, 12, 70].map(w => ({ width: w }));
        banner(ws2, 1, docLastCol, `📁 廠商維護單據清單 ｜ ${vendorName}　｜　匯出時間：${exportTime}`, 14);
        subBanner(ws2, 2, docLastCol, '※「檔案狀態」依匯出當下的硬碟實體檔案是否存在判定（✔ 存在 / ✘ 找不到）。');
        headerCells(ws2, 3, docCols);
        let docRowNo = 4;
        let docFound = 0, docMissing = 0;
        records.forEach(r => {
            splitPaths(r.doc_files).forEach((p, idx) => {
                const exists = fs.existsSync(p);
                if (exists) docFound++; else docMissing++;
                const dRow = ws2.getRow(docRowNo);
                dRow.height = 20;
                dataRow(dRow, [idx + 1, r.maint_date || '—', r.equipment || '—', r.maint_type || '—', baseName(p), exists ? '✔ 存在' : '✘ 找不到', p], (idx % 2 === 1), [0, 3, 5], [2, 6]);
                dRow.getCell(3).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
                dRow.getCell(6).font = { size: 10, bold: true, color: { argb: exists ? 'FF166534' : 'FFB91C1C' } };
                docRowNo++;
            });
        });
        if (docSum === 0) {
            ws2.mergeCells(4, 1, 4, docLastCol);
            const ec = ws2.getCell(4, 1);
            ec.value = `廠商「${vendorName}」目前沒有隨附的維護單據檔案。`;
            ec.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
            ec.alignment = { horizontal: 'center', vertical: 'middle' };
            ec.fill = solid(CLR.sub);
            ec.border = thinBorder();
            ws2.getRow(4).height = 24;
            docRowNo = 5;
        }
        totalBar(ws2, docRowNo, docLastCol, `📊 總計：共 ${docSum} 份維護單據（✔ 存在 ${docFound}　｜　✘ 找不到 ${docMissing}）`);
        ws2.autoFilter = { from: { row: 3, column: 1 }, to: { row: Math.max(3, docRowNo - 1), column: docLastCol } };
        ws2.pageSetup = pageSetupLandscape;

        // ===== 存檔 =====
        const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
        const safeVendor = vendorName.replace(/[\\/:*?"<>|]/g, '_');
        const { filePath } = await dialog.showSaveDialog({ title: '匯出廠商維護歷程', defaultPath: path.join(app.getPath('downloads'), `IT_廠商維護歷程_${safeVendor}_${stamp}.xlsx`), filters: [{ name: 'Excel Files', extensions: ['xlsx'] }] });
        if (!filePath) return;
        await wb.xlsx.writeFile(filePath);
        dialog.showMessageBox({ type: 'info', message: `✅ 廠商「${vendorName}」維護歷程已成功匯出！\n共 ${records.length} 筆維護紀錄、${docSum} 份維護單據\n${filePath}` });
    } catch (err) {
        dialog.showMessageBox({ type: 'error', message: '匯出廠商維護歷程時發生錯誤：\n' + (err && err.message ? err.message : err) });
    }
});

// 16-5. 刪除維護紀錄中的單一單據檔 (硬碟實體移除 + 資料庫字串同步)
ipcMain.on('delete-vendor-maint-record-file', async (event, data) => {
    try {
        const { recordId, fileIndex } = data || {};
        const idRes = await db.execute({ sql: `SELECT id, doc_files FROM vendor_maint_records WHERE id = ?`, args: [parseInt(recordId)] });
        if (!idRes || !idRes.rows || idRes.rows.length === 0) return;
        const files = String(idRes.rows[0].doc_files || '').split(';').map(p => p.trim()).filter(p => p !== '');
        const idx = parseInt(fileIndex);
        if (idx >= 0 && idx < files.length) {
            try { if (fs.existsSync(files[idx])) fs.unlinkSync(files[idx]); } catch (e) {}
            files.splice(idx, 1);
        }
        await db.execute({ sql: `UPDATE vendor_maint_records SET doc_files = ? WHERE id = ?`, args: [files.join(';'), parseInt(recordId)] });
        event.reply('vendor-maint-record-file-deleted', parseInt(recordId));
        await pushAllVendorMaintRecordsToFrontend();
    } catch (err) {}
});


// =================================================================
// 17. ⚙️ 系統管理：資料庫備份 / 還原
//     📦 備份 = 產生「獨立 SQLite 備份檔」(.db)，只含該類別的資料表
//     ♻️ 還原 = 先自動建立「還原前自動備份」，再以備份檔整表覆蓋
//     ⚠️ 資料庫備份不含 uploads 內的實體附件檔 (NDA / 合約 / 維護單據)
// =================================================================
const sqlite3 = require('sqlite3').verbose();
const sysBackupDir = () => path.join(dataDir(), 'backups');
const SYS_TABLE_GROUPS = {
    asset:  { label: '資訊資產資料', fileTag: '資產',   tables: ['assets_new', 'repairs_new', 'transfers_new', 'asset_history_new'] },
    vendor: { label: '廠商資訊資料', fileTag: '廠商',   tables: ['vendors_new', 'vendor_maint_records'] },
    all:    { label: '全部資料',     fileTag: '全備份', tables: ['assets_new', 'vendors_new', 'repairs_new', 'transfers_new', 'asset_history_new', 'vendor_maint_records'] }
};
const SYS_COUNT_LABELS = { assets_new: 'assets', repairs_new: 'repairs', transfers_new: 'transfers', asset_history_new: 'history', vendors_new: 'vendors', vendor_maint_records: 'maint' };

const sysEnsureDir = () => { try { const d = sysBackupDir(); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {} };
const sysStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const sysAll = (conn, sql, args) => new Promise((resolve) => { conn.all(sql, args || [], (err, rows) => resolve(err ? [] : (rows || []))); });
const sysRun = (conn, sql, args) => new Promise((resolve, reject) => { conn.run(sql, args || [], function (err) { if (err) reject(err); else resolve(this); }); });
const sysExec = (conn, sql) => new Promise((resolve, reject) => { conn.exec(sql, (err) => { if (err) reject(err); else resolve(); }); });
const sysSchema = (conn, t) => new Promise((resolve) => { conn.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [t], (err, row) => resolve(err || !row ? null : row.sql)); });
const sysCols = (conn, t) => new Promise((resolve) => { conn.all(`PRAGMA table_info('${t}')`, [], (err, rows) => resolve(err ? [] : (rows || []).map(r => r.name))); });
const sysClose = (conn) => new Promise((resolve) => { try { conn.close(() => resolve()); } catch (e) { resolve(); } });


// =================================================================
// 17-0. 📦 ZIP 打包／解壓（自製實作：deflateRaw + CRC32，不依賴外部套件）
//       僅供本系統備份使用（無 zip64／加密；單檔 < 4GB）
// =================================================================
function zipDosDateTime(d) {
    const dt = d || new Date();
    const year = Math.max(1980, dt.getFullYear());
    return {
        date: (((year - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate()) & 0xFFFF,
        time: ((dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2)) & 0xFFFF
    };
}
// files: [{ name: '相對路徑（用 / 分隔）', srcPath }]
function zipCreateSync(zipPath, files) {
    const parts = [], central = [];
    let offset = 0, rawTotal = 0, compTotal = 0;
    const dos = zipDosDateTime(new Date());
    for (const f of files) {
        const data = fs.readFileSync(f.srcPath);
        const comp = zlib.deflateRawSync(data, { level: 6 });
        const crc = crc32(data);
        const nameBuf = Buffer.from(String(f.name).replace(/\\/g, '/'), 'utf8');
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);   // 本機檔案標頭
        lh.writeUInt16LE(20, 4);           // 解壓所需版本
        lh.writeUInt16LE(0x0800, 6);       // 檔名使用 UTF-8
        lh.writeUInt16LE(8, 8);            // 壓縮方式：deflate
        lh.writeUInt16LE(dos.time, 10);
        lh.writeUInt16LE(dos.date, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(comp.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        parts.push(lh, nameBuf, comp);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);   // 中央目錄項目
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0x0800, 8);
        ch.writeUInt16LE(8, 10);
        ch.writeUInt16LE(dos.time, 12);
        ch.writeUInt16LE(dos.date, 14);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(comp.length, 20);
        ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28);
        ch.writeUInt32LE(offset, 42);
        central.push(ch, nameBuf);
        offset += lh.length + nameBuf.length + comp.length;
        rawTotal += data.length;
        compTotal += comp.length;
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);     // 中央目錄結束記錄
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    fs.writeFileSync(zipPath, Buffer.concat([Buffer.concat(parts), centralBuf, eocd]));
    return { count: files.length, rawBytes: rawTotal, compBytes: compTotal, zipBytes: fs.statSync(zipPath).size };
}
// 解壓縮（僅支援本系統產生的 ZIP：store／deflate、無加密）
function zipExtractSync(zipPath, destDir) {
    const buf = fs.readFileSync(zipPath);
    const rootAbs = path.resolve(destDir);
    let p = 0, done = 0;
    while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
        const method = buf.readUInt16LE(p + 8);
        const crc = buf.readUInt32LE(p + 14);
        const compSize = buf.readUInt32LE(p + 18);
        const size = buf.readUInt32LE(p + 22);
        const nameLen = buf.readUInt16LE(p + 26);
        const extraLen = buf.readUInt16LE(p + 28);
        const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
        const dataStart = p + 30 + nameLen + extraLen;
        const comp = buf.slice(dataStart, dataStart + compSize);
        const out = (method === 0) ? Buffer.from(comp) : zlib.inflateRawSync(comp);
        if (out.length !== size) throw new Error('解壓後檔案大小不符：' + name);
        if (crc32(out) !== crc) throw new Error('檔案內容檢查失敗（CRC32 不符）：' + name);
        p = dataStart + compSize;
        if (/[\\/]$/.test(name)) continue;   // 資料夾項目，略過
        const dest = path.join(rootAbs, path.normalize(name.replace(/\\/g, '/')));
        if (path.resolve(dest).indexOf(rootAbs) !== 0) throw new Error('壓縮檔內含不安全的路徑：' + name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, out);
        done++;
    }
    return done;
}

// 17-0-2. 📎 附件檔（廠商資料夾與文件、維護單據）收集、備份、還原
function sysCollectAttachmentFiles() {
    const root = dataDir();
    const skipTop = { backups: 1, updates: 1 };   // 備份區與更新檔下載區不需再包進附件備份
    const out = [];
    const walk = (dir, rel) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
            if (rel === '' && skipTop[e.name]) continue;
            if (String(e.name).charAt(0) === '.') continue;
            const full = path.join(dir, e.name);
            const relPath = rel === '' ? e.name : rel + '/' + e.name;
            if (e.isDirectory()) walk(full, relPath);
            else if (e.isFile()) {
                if (/\.(db|db-shm|db-wal)$/i.test(e.name)) continue; // 資料庫本體由 .db 備份負責
                out.push({ name: relPath, srcPath: full });
            }
        }
    };
    walk(root, '');
    return out;
}
function sysAttachmentStats() {
    const files = sysCollectAttachmentFiles();
    let bytes = 0;
    files.forEach(f => { try { bytes += fs.statSync(f.srcPath).size; } catch (e) {} });
    return { count: files.length, bytes: bytes };
}
async function sysCreateAttachmentBackupFile(noteTag) {
    sysEnsureDir();
    const filePath = path.join(sysBackupDir(), `backup_附件${noteTag ? '_' + noteTag : ''}_${sysStamp()}.zip`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const files = sysCollectAttachmentFiles();
    const info = zipCreateSync(filePath, files);
    return { filePath: filePath, count: info.count, rawBytes: info.rawBytes, zipBytes: info.zipBytes };
}


// 17-1. 產生備份檔 (noteTag 供「還原前自動備份」等用途標記)
async function sysCreateBackupFile(type, noteTag) {
    sysEnsureDir();
    const grp = SYS_TABLE_GROUPS[type] || SYS_TABLE_GROUPS.all;
    const filePath = path.join(sysBackupDir(), `backup_${grp.fileTag}${noteTag ? '_' + noteTag : ''}_${sysStamp()}.db`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const conn = new sqlite3.Database(filePath);
    const counts = {};
    try {
        for (const t of grp.tables) {
            const schema = await sysSchema(db, t);
            if (!schema) { counts[t] = 0; continue; }
            await sysExec(conn, schema);
            const rows = await sysAll(db, `SELECT * FROM ${t}`);
            const cols = await sysCols(conn, t);
            if (rows.length > 0 && cols.length > 0) {
                const colList = cols.map(c => `"${c}"`).join(', ');
                const ph = cols.map(() => '?').join(', ');
                await sysExec(conn, 'BEGIN');
                for (const row of rows) await sysRun(conn, `INSERT INTO ${t} (${colList}) VALUES (${ph})`, cols.map(c => (Object.prototype.hasOwnProperty.call(row, c) ? row[c] : null)));
                await sysExec(conn, 'COMMIT');
            }
            counts[t] = rows.length;
        }
        await sysExec(conn, `CREATE TABLE IF NOT EXISTS backup_meta (key TEXT PRIMARY KEY, value TEXT)`);
        await sysRun(conn, `INSERT OR REPLACE INTO backup_meta (key, value) VALUES (?, ?)`,
            ['meta', JSON.stringify({ app: 'IT Asset Manager', type: type, label: grp.label, tables: grp.tables, counts: counts, createdAt: new Date().toISOString() })]);
    } finally {
        await sysClose(conn);
    }
    return { filePath, counts };
}

// 17-2. 由備份檔還原 (整表覆蓋；缺表或型別不符會擋下並回報)
async function sysRestoreBackupFile(sourcePath, type) {
    const grp = SYS_TABLE_GROUPS[type] || SYS_TABLE_GROUPS.all;
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('找不到指定的備份檔。');
    const conn = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY);
    const result = {};
    try {
        const present = (await sysAll(conn, `SELECT name FROM sqlite_master WHERE type='table'`)).map(r => r.name);
        const missing = grp.tables.filter(t => present.indexOf(t) < 0);
        if (missing.length > 0) throw new Error(`此備份檔缺少「${missing.join('、')}」資料表，可能選錯備份類型。`);
        for (const t of grp.tables) {
            const rows = await sysAll(conn, `SELECT * FROM ${t}`);
            const liveCols = await sysCols(db, t);
            const usable = liveCols.filter(c => rows.length === 0 || Object.prototype.hasOwnProperty.call(rows[0], c));
            await sysExec(db, 'BEGIN IMMEDIATE');
            try {
                await sysRun(db, `DELETE FROM ${t}`);
                if (rows.length > 0 && usable.length > 0) {
                    const colList = usable.map(c => `"${c}"`).join(', ');
                    const ph = usable.map(() => '?').join(', ');
                    for (const row of rows) await sysRun(db, `INSERT INTO ${t} (${colList}) VALUES (${ph})`, usable.map(c => row[c]));
                }
                await sysExec(db, 'COMMIT');
            } catch (e) {
                try { await sysExec(db, 'ROLLBACK'); } catch (e2) {}
                throw new Error(`還原資料表 ${t} 失敗：` + (e && e.message ? e.message : e));
            }
            result[t] = rows.length;
        }
    } finally {
        await sysClose(conn);
    }
    return result;
}


// 17-3. 還原後把最新資料推回前端 (含資源回收桶)
async function sysPushEverythingToFrontend() {
    await pushAllAssetsToFrontend();
    await pushAllVendorsToFrontend();
    await pushAllRepairsToFrontend();
    await pushAllTransfersToFrontend();
    await pushAllVendorMaintRecordsToFrontend();
    try {
        const del = await db.execute(`SELECT * FROM assets_new WHERE is_deleted = 1 ORDER BY id DESC`);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('deleted-assets-data', del.rows || []);
    } catch (e) {}
}

// 17-4. 備份狀態 (資料筆數 + 備份清單)
async function sysBuildStatus() {
    sysEnsureDir();
    const counts = {};
    for (const t of Object.keys(SYS_COUNT_LABELS)) {
        const r = await db.execute(`SELECT COUNT(*) AS c FROM ${t}`);
        counts[SYS_COUNT_LABELS[t]] = (r.rows && r.rows[0]) ? r.rows[0].c : 0;
    }
    let backups = [];
    try {
        backups = fs.readdirSync(sysBackupDir()).filter(f => /\.(db|zip)$/i.test(f)).map(f => {
            const full = path.join(sysBackupDir(), f);
            let size = 0, mtime = null;
            try { const st = fs.statSync(full); size = st.size; mtime = st.mtime.toISOString(); } catch (e) {}
            const isZip = /\.zip$/i.test(f);
            let type = 'other';
            if (f.indexOf('backup_附件') === 0) type = 'files';
            else if (f.indexOf('backup_資產_') === 0) type = 'asset';
            else if (f.indexOf('backup_廠商_') === 0) type = 'vendor';
            else if (f.indexOf('backup_全備份_') === 0) type = 'all';
            return { name: f, path: full, sizeKb: Math.max(1, Math.round(size / 1024)), sizeMb: Math.round(size / 1048576 * 10) / 10, mtime: mtime, type: type, isZip: isZip };
        }).sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')));
    } catch (e) {}
    return {
        counts: counts, backups: backups, dir: sysBackupDir(), dataDir: dataDir(),
        customDataPath: readCustomDataPath(), defaultDataPath: path.join(app.getPath('userData'), 'uploads'),
        migratedFrom: _dataMigratedFrom, attachmentStats: sysAttachmentStats()
    };
}

ipcMain.on('sys-get-status', async () => {
    try {
        const status = await sysBuildStatus();
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('sys-status-data', status);
    } catch (err) {}
});

ipcMain.on('sys-open-backup-folder', async () => {
    try { sysEnsureDir(); await shell.openPath(sysBackupDir()); } catch (err) {}
});

// 17-5. 執行備份（includeFiles = 全備份時一併打包附件檔）
ipcMain.on('sys-run-backup', async (event, data) => {
    try {
        const type = (data && data.type) || 'all';
        const includeFiles = !!(data && data.includeFiles) && type === 'all';
        const grp = SYS_TABLE_GROUPS[type] || SYS_TABLE_GROUPS.all;
        const out = await sysCreateBackupFile(type, null);
        let att = null, attErr = '';
        if (includeFiles) {
            try { att = await sysCreateAttachmentBackupFile(null); } catch (e) { attErr = String(e && e.message ? e.message : e); }
        }
        await dialog.showMessageBox({
            type: 'info',
            message: `✅ ${grp.label}備份完成！\n${grp.tables.map(t => `　${t}：${out.counts[t] || 0} 筆`).join('\n')}`
                + (att ? `\n\n📎 附件檔（廠商資料夾與文件）：${att.count} 個檔案\n　原始 ${(att.rawBytes / 1048576).toFixed(2)} MB → 壓縮後 ${(att.zipBytes / 1048576).toFixed(2)} MB` : '')
                + (attErr ? `\n\n⚠️ 附件檔備份失敗：${attErr}` : '')
                + `\n檔案位置：\n${out.filePath}` + (att ? `\n${att.filePath}` : '')
        });
        event.reply('sys-backup-done', { type: type, filePath: out.filePath, counts: out.counts, attachment: att });
        const status = await sysBuildStatus();
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('sys-status-data', status);
    } catch (err) {
        dialog.showMessageBox({ type: 'error', message: '備份失敗：\n' + (err && err.message ? err.message : err) });
        event.reply('sys-backup-error', String(err && err.message ? err.message : err));
    }
});

// 17-5-2. 📎 單獨建立「附件檔備份」（廠商資料夾與文件、維護單據，不含資料庫）
ipcMain.on('sys-run-attachment-backup', async (event) => {
    try {
        const out = await sysCreateAttachmentBackupFile(null);
        await dialog.showMessageBox({
            type: 'info',
            message: '✅ 附件檔備份完成！',
            detail: `附件檔：${out.count} 個檔案\n原始大小：${(out.rawBytes / 1048576).toFixed(2)} MB\n壓縮後：${(out.zipBytes / 1048576).toFixed(2)} MB\n\n檔案位置：\n${out.filePath}`
        });
        event.reply('sys-attachment-backup-done', { filePath: out.filePath, count: out.count });
        const status = await sysBuildStatus();
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('sys-status-data', status);
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        dialog.showMessageBox({ type: 'error', message: '附件檔備份失敗：\n' + msg });
        event.reply('sys-attachment-backup-error', msg);
    }
});

// 17-5-3. 📎 還原「附件檔備份」（把 .zip 解壓縮回資料位置，覆蓋同名檔案）
ipcMain.on('sys-run-attachment-restore', async (event, data) => {
    try {
        let zipPath = String((data && data.filePath) || '');
        if (!zipPath) {
            sysEnsureDir();
            const pick = await dialog.showOpenDialog({
                title: '選擇要還原的附件檔備份 (.zip)',
                defaultPath: sysBackupDir(),
                filters: [{ name: '附件檔備份', extensions: ['zip'] }],
                properties: ['openFile']
            });
            if (!pick || pick.canceled || !pick.filePaths || pick.filePaths.length === 0) { event.reply('sys-attachment-restore-cancelled'); return; }
            zipPath = pick.filePaths[0];
        }
        if (!fs.existsSync(zipPath)) throw new Error('找不到指定的備份檔：' + zipPath);
        const ask = await dialog.showMessageBox({
            type: 'question', buttons: ['確認還原附件', '取消'], defaultId: 0, cancelId: 1,
            message: '確定要還原附件檔嗎？',
            detail: `來源：${path.basename(zipPath)}\n還原位置：${dataDir()}\n\n⚠️ 同名檔案會被覆蓋（資料庫記錄不受影響）。`
        });
        if (ask.response !== 0) { event.reply('sys-attachment-restore-cancelled'); return; }
        const n = zipExtractSync(zipPath, dataDir());
        await dialog.showMessageBox({ type: 'info', message: '✅ 附件檔還原完成！', detail: `已還原 ${n} 個檔案到：\n${dataDir()}` });
        event.reply('sys-attachment-restore-done', { count: n, filePath: zipPath });
        const status = await sysBuildStatus();
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('sys-status-data', status);
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        dialog.showMessageBox({ type: 'error', message: '附件檔還原失敗：\n' + msg });
        event.reply('sys-attachment-restore-error', msg);
    }
});

// 17-6. 執行還原 (未指定檔案時跳出原生挑檔對話框)
ipcMain.on('sys-run-restore', async (event, data) => {
    try {
        const type = (data && data.type) || 'all';
        const grp = SYS_TABLE_GROUPS[type] || SYS_TABLE_GROUPS.all;
        let filePath = (data && data.filePath) || '';
        if (!filePath) {
            sysEnsureDir();
            const pick = await dialog.showOpenDialog({ title: `選擇要還原的${grp.label}備份檔`, defaultPath: sysBackupDir(), filters: [{ name: 'SQLite 備份檔', extensions: ['db'] }], properties: ['openFile'] });
            if (!pick || pick.canceled || !pick.filePaths || pick.filePaths.length === 0) { event.reply('sys-restore-cancelled'); return; }
            filePath = pick.filePaths[0];
        }
        // 🛡️ 還原前自動全備份 (保險線；失敗即中止還原)
        const safety = await sysCreateBackupFile('all', '還原前自動備份');
        const counts = await sysRestoreBackupFile(filePath, type);
        await sysPushEverythingToFrontend();
        await dialog.showMessageBox({ type: 'info', message: `♻️ ${grp.label}還原完成！\n來源：${path.basename(filePath)}\n${grp.tables.map(t => `　${t}：${counts[t] || 0} 筆`).join('\n')}\n\n🛡️ 還原前自動備份：\n${safety.filePath}` });
        event.reply('sys-restore-done', { type: type, filePath: filePath, counts: counts });
        const status = await sysBuildStatus();
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('sys-status-data', status);
    } catch (err) {
        dialog.showMessageBox({ type: 'error', message: '還原失敗：\n' + (err && err.message ? err.message : err) });
        event.reply('sys-restore-error', String(err && err.message ? err.message : err));
    }
});

// 17-7. 刪除單一備份檔 (僅限備份資料夾內)
ipcMain.on('sys-delete-backup', async (event, data) => {
    try {
        const target = String((data && data.filePath) || '');
        if (!target || path.dirname(target) !== sysBackupDir() || !fs.existsSync(target)) return;
        fs.unlinkSync(target);
        const status = await sysBuildStatus();
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('sys-status-data', status);
        event.reply('sys-backup-deleted', path.basename(target));
    } catch (err) {}
});



// =================================================================
// 17-8. 📁 資料儲存位置管理 (資料庫 / 附件 / 備份檔的落腳處)
//       預設：%APPDATA%\it-asset-manager\uploads
//       可自訂：使用者可指定 D:\ 等其他磁碟，避免系統槽被資料撐爆
// =================================================================
ipcMain.on('sys-get-data-location', async () => {
    const payload = {
        current: dataDir(),
        custom: readCustomDataPath(),
        defaultPath: path.join(app.getPath('userData'), 'uploads'),
        appDirPath: path.join(__dirname, 'uploads'),
        packaged: !!app.isPackaged,
        configFile: dataLocationConfigFile()
    };
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('sys-data-location-data', payload);
});

ipcMain.on('sys-open-data-folder', async () => {
    try { sysEnsureDir(); await shell.openPath(dataDir()); } catch (err) {}
});

// 變更資料儲存位置 (可選擇是否搬移現有資料)
ipcMain.on('sys-change-data-location', async (event) => {
    try {
        const oldDir = dataDir();
        const pick = await dialog.showOpenDialog({
            title: '選擇資料儲存位置（建議選擇空間充足的磁碟，例如 D:\\）',
            defaultPath: path.dirname(oldDir),
            properties: ['openDirectory', 'createDirectory']
        });
        if (!pick || pick.canceled || !pick.filePaths || pick.filePaths.length === 0) { event.reply('sys-data-location-cancelled'); return; }
        const target = path.join(pick.filePaths[0], 'IT資產管理系統資料');
        if (path.resolve(target) === path.resolve(oldDir)) { event.reply('sys-data-location-same'); return; }
        if (!isWritableDir(target)) {
            dialog.showMessageBox({ type: 'error', message: '此資料夾無法寫入，請改選其他位置：\n' + target });
            event.reply('sys-data-location-failed', '不可寫入的路徑');
            return;
        }
        const ask = await dialog.showMessageBox({
            type: 'question',
            buttons: ['搬移現有資料到新位置', '只變更位置（不搬移）', '取消'],
            defaultId: 0,
            cancelId: 2,
            message: '是否要將現有資料搬移到新的儲存位置？',
            detail: `目前位置：\n${oldDir}\n\n新位置：\n${target}\n\n建議選擇「搬移現有資料」；原資料夾會完整保留一份作為備份，確認無誤後可自行刪除。`
        });
        if (ask.response === 2) { event.reply('sys-data-location-cancelled'); return; }
        let moved = false;
        if (ask.response === 0) {
            try { await db.execute('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
            copyDirRecursive(oldDir, target);
            moved = true;
        }
        const ok = writeCustomDataPath(target);
        if (!ok) throw new Error('無法寫入設定檔');
        await dialog.showMessageBox({
            type: 'info',
            message: '✅ 資料儲存位置已變更，請重新啟動程式以生效。',
            detail: `舊位置：${oldDir}\n新位置：${target}\n${moved ? '\n（現有資料已複製到新位置，舊資料仍保留）' : '\n（未搬移資料，程式重啟後將使用新位置）'}`
        });
        event.reply('sys-data-location-changed', { path: target, moved: moved, oldPath: oldDir });
    } catch (err) {
        dialog.showMessageBox({ type: 'error', message: '變更資料儲存位置失敗：\n' + (err && err.message ? err.message : err) });
        event.reply('sys-data-location-failed', String(err && err.message ? err.message : err));
    }
});

// 回復預設資料儲存位置
ipcMain.on('sys-reset-data-location', async (event) => {
    try {
        const oldDir = dataDir();
        const def = path.join(app.getPath('userData'), 'uploads');
        const ask = await dialog.showMessageBox({
            type: 'question', buttons: ['確認回復預設位置', '取消'], defaultId: 1, cancelId: 1,
            message: '要將資料儲存位置回復為預設值嗎？', detail: `預設位置：${def}\n目前位置：${oldDir}\n\n（不會自動搬移資料，請自行確認預設位置是否已有資料）`
        });
        if (ask.response !== 0) { event.reply('sys-data-location-cancelled'); return; }
        try { fs.unlinkSync(dataLocationConfigFile()); } catch (e) {}
        event.reply('sys-data-location-reset', { defaultPath: def });
    } catch (err) {
        event.reply('sys-data-location-failed', String(err && err.message ? err.message : err));
    }
});

// 重新啟動程式 (套用新的資料儲存位置)
ipcMain.on('sys-restart-app', () => {
    try { app.relaunch(); app.exit(0); } catch (e) { app.exit(0); }
});


// =================================================================
// 18. 🔄 系統管理：版本更新 (線上檢查 → 下載 → 安裝，讓系統可持續更新版本與功能)
//     · 版本來源：更新伺服器上的 latest.json（可由「⚙️ 更新伺服器設定」自訂網址）
//       - 線上：http:// 或 https:// 開頭（支援 302 轉址）
//       - 內網：可直接填寫共用資料夾路徑，或 latest.json 的完整檔案路徑
//     · 下載的安裝檔存放於 <資料儲存位置>\updates
//     · 安裝前系統會自動執行一次「💾 全備份」，確保資料安全
//     · 資料庫與附件都放在資料儲存位置，更新程式不會影響既有資料
// =================================================================
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const UPD_APP_NAME = 'IT資產管理系統';
const UPD_UA_NAME = 'ITAssetManager'; // ⚠️ HTTP Header 只能放 ASCII，不可用中文產品名

// 🐙 預設更新來源：GitHub Releases（Latest）
//    · 公開倉庫：直接讀取 https://api.github.com/repos/<owner>/<repo>/releases/latest
//    · 私有倉庫：需於「更新來源設定」填入 GitHub Token（僅存在本機 update_config.json，不會寫進程式）
const UPD_DEFAULT_GITHUB_REPO = 'Kevin7563/it-asset-manager';
const UPD_DEFAULT_FEED_URL = ''; // 仍支援自訂 latest.json（內網／自架伺服器）
const updGithubApiUrl = (repo) => 'https://api.github.com/repos/' + String(repo || UPD_DEFAULT_GITHUB_REPO).trim() + '/releases/latest';
const updGithubReleasesPage = (repo) => 'https://github.com/' + String(repo || UPD_DEFAULT_GITHUB_REPO).trim() + '/releases';
const updConfigFile = () => path.join(app.getPath('userData'), 'update_config.json'); // 使用者自訂更新伺服器設定
const updStateFile = () => path.join(app.getPath('userData'), 'update_state.json');   // 最近一次檢查結果 (開頁即顯示)
const updAppFeedFile = () => path.join(__dirname, 'update-feed.json');                // 隨程式附帶的更新伺服器設定 (選用)
const updDir = () => path.join(dataDir(), 'updates');
const updEnsureDir = () => { try { const d = updDir(); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {} };
const updReadJsonFile = (p) => { try { return JSON.parse(updStripBom(fs.readFileSync(p, 'utf-8'))); } catch (e) { return null; } };
// 🧹 去除 UTF-8 BOM（用記事本／PowerShell 5.1 產生的 JSON 常帶 BOM，會讓 JSON.parse 失敗）
const updStripBom = (s) => String(s == null ? '' : s).replace(/^\uFEFF/, '');
const updWriteJsonFile = (p, obj) => { try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8'); return true; } catch (e) { return false; } };
const updCurrentVersion = () => { try { return app.getVersion() || '0.0.0'; } catch (e) { return '0.0.0'; } };

// 18-1. 版本號比對 (1.2.10 > 1.2.9；不足位數補 0，非數字段落視為 0)
function updVersionParts(v) {
    return String(v == null ? '' : v).trim().replace(/^v/i, '').split(/[.\-+_]/).filter(s => s !== '').map(s => { const n = parseInt(s, 10); return isNaN(n) ? 0 : n; });
}
function updCompareVersion(a, b) {
    const pa = updVersionParts(a), pb = updVersionParts(b);
    const len = Math.max(pa.length, pb.length, 3);
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

// 18-2. 更新來源設定 (使用者設定 update_config.json > 隨程式附帶 update-feed.json > 內建預設)
//    kind：'github'（GitHub Releases）或 'feed'（自訂 latest.json 網址／內網路徑）
function updConfigInfo() {
    const user = updReadJsonFile(updConfigFile()) || {};
    const shipped = updReadJsonFile(updAppFeedFile()) || {};
    const pick = (key, fallback) => {
        const uv = user[key];
        if (uv !== undefined && uv !== null && String(uv).trim() !== '') return String(uv).trim();
        const sv = shipped[key];
        if (sv !== undefined && sv !== null && String(sv).trim() !== '') return String(sv).trim();
        return fallback;
    };
    const feedUrl = pick('feedUrl', UPD_DEFAULT_FEED_URL) || '';
    let repo = pick('githubRepo', UPD_DEFAULT_GITHUB_REPO) || UPD_DEFAULT_GITHUB_REPO;
    repo = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    const token = pick('githubToken', '') || '';
    let kind = String(pick('source', '') || '').toLowerCase();
    if (kind !== 'github' && kind !== 'feed') kind = (feedUrl !== '') ? 'feed' : 'github';
    if (kind === 'feed' && feedUrl === '') kind = 'github';
    const sourceLabel = (user && (user.feedUrl !== undefined || user.githubRepo !== undefined || user.source !== undefined)) ? 'user'
        : ((shipped && (shipped.feedUrl !== undefined || shipped.githubRepo !== undefined)) ? 'app' : 'default');
    return { kind: kind, repo: repo, token: token, feedUrl: feedUrl, sourceLabel: sourceLabel };
}

function updFeedInfo() {
    const cfg = updConfigInfo();
    if (cfg.kind === 'feed' && cfg.feedUrl !== '') {
        return { kind: 'feed', url: cfg.feedUrl, source: cfg.sourceLabel, githubRepo: cfg.repo, githubToken: cfg.token, repo: cfg.repo, feedUrl: cfg.feedUrl };
    }
    return { kind: 'github', url: updGithubApiUrl(cfg.repo), source: cfg.sourceLabel, githubRepo: cfg.repo, githubToken: cfg.token, repo: cfg.repo, feedUrl: cfg.feedUrl };
}

// 🐙 GitHub Release → 通用版本資訊（挑選安裝檔、SHA256、更新說明）
const updCleanMarkdown = (s) => String(s == null ? '' : s)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function updGithubReleaseToManifest(rel, repo) {
    const r = (rel && typeof rel === 'object') ? rel : {};
    if (r.message) throw new Error('GitHub 回應：' + r.message);
    const version = String(r.tag_name || r.name || '').trim().replace(/^v/i, '');
    if (version === '') throw new Error('GitHub Release 缺少版本標籤（tag_name），無法判斷版本。');
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const score = (a) => {
        const n = String(a.name || '');
        return (/setup/i.test(n) ? 4 : 0) + (/安裝檔/.test(n) ? 3 : 0) + (/x64|amd64/i.test(n) ? 1 : 0) + (/\.exe$/i.test(n) ? 2 : 0);
    };
    const installer = assets.filter(a => /\.(exe|msi)$/i.test(String(a.name || ''))).sort((a, b) => score(b) - score(a))[0] || null;
    if (!installer) {
        throw new Error('GitHub Release v' + version + ' 內沒有可用的安裝檔（.exe / .msi）。請確認已將安裝檔上傳到該 Release。');
    }
    const digest = String(installer.digest || '').trim().toLowerCase();
    const sha256 = digest.indexOf('sha256:') === 0 ? digest.slice(7) : '';
    return {
        version: version,
        releaseDate: String(r.published_at || r.created_at || '').slice(0, 10),
        notes: updCleanMarkdown(r.body || ''),
        downloadUrl: String(installer.browser_download_url || ''),
        fileName: String(installer.name || ''),
        sha256: sha256,
        size: Number(installer.size || 0) || 0,
        homepage: String(r.html_url || updGithubReleasesPage(repo)),
        tag: String(r.tag_name || ''),
        source: 'github'
    };
}

// 🐙 GitHub 常見錯誤 → 中文提示
function updGithubErrorHint(err, opt) {
    const msg = String(err && err.message ? err.message : err);
    const repo = (opt && opt.repo) || UPD_DEFAULT_GITHUB_REPO;
    if (/HTTP 404/.test(msg)) {
        return new Error('找不到 GitHub Release（HTTP 404）。請確認：① 倉庫名稱正確（目前設定：' + repo + '）② 該倉庫已完成「發行（Release）」③ 若倉庫為 Private，請於下方填入 GitHub Token（或改為 Public）。');
    }
    if (/HTTP 401/.test(msg)) return new Error('GitHub Token 無效或已過期（HTTP 401），請重新產生 Token。');
    if (/HTTP 403/.test(msg)) return new Error('GitHub 拒絕存取（HTTP 403）：可能已達匿名 API 次數上限，請稍後再試，或填入 GitHub Token。');
    return err instanceof Error ? err : new Error(msg);
}


// 18-3. 線上取得文字 (JSON)；支援轉址、逾時與自訂標頭（GitHub API 需要）
function updHttpGetText(url, redirectLeft, extraHeaders) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { reject(new Error('更新伺服器網址格式不正確：' + url)); return; }
        const mod = u.protocol === 'http:' ? http : https;
        let settled = false;
        const fail = (err) => { if (!settled) { settled = true; reject(err); } };
        const headers = Object.assign({ 'User-Agent': UPD_UA_NAME + '/' + updCurrentVersion(), 'Cache-Control': 'no-cache' }, extraHeaders || {});
        const req = mod.get(u, { timeout: 15000, headers: headers }, (res) => {
            if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
                res.resume();
                if (redirectLeft <= 0) { fail(new Error('更新伺服器轉址次數過多。')); return; }
                const nextUrl = new URL(res.headers.location, u);
                // 轉到不同網域（例如 GitHub → raw/objects）時不帶自訂標頭，避免簽章驗證失敗
                const nextHeaders = (nextUrl.hostname !== u.hostname) ? {} : (extraHeaders || {});
                updHttpGetText(nextUrl.toString(), redirectLeft - 1, nextHeaders).then(resolve).catch(fail);
                return;
            }
            if (res.statusCode !== 200) { res.resume(); fail(new Error('更新伺服器回應異常（HTTP ' + res.statusCode + '）。')); return; }
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => {
                body += c;
                if (body.length > 2 * 1024 * 1024) { try { req.destroy(); } catch (e) {} fail(new Error('版本資訊檔過大，已中止讀取。')); }
            });
            res.on('end', () => { if (!settled) { settled = true; resolve(body); } });
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} fail(new Error('連線更新伺服器逾時（15 秒）。')); });
        req.on('error', (err) => fail(new Error('無法連線更新伺服器：' + (err && err.message ? err.message : err))));
    });
}

// 18-4. 讀取版本資訊（支援 GitHub Releases API、線上 latest.json、內網共用資料夾）
async function updLoadManifest(feedUrl, opt) {
    const src = String(feedUrl || '').trim();
    const options = opt || {};
    if (src === '') throw new Error('尚未設定更新來源，請先於「⚙️ 更新來源設定」設定 GitHub 倉庫或 latest.json 網址。');
    if (/^https?:\/\//i.test(src)) {
        const isGithubApi = /^https?:\/\/api\.github\.com\//i.test(src);
        const headers = isGithubApi
            ? Object.assign({ 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
                options.token ? { 'Authorization': 'Bearer ' + options.token } : {})
            : {};
        let text = '';
        try {
            text = await updHttpGetText(src, 5, headers);
        } catch (err) {
            throw isGithubApi ? updGithubErrorHint(err, options) : err;
        }
        let raw = null;
        try { raw = JSON.parse(updStripBom(text)); } catch (e) {
            throw new Error(isGithubApi ? 'GitHub 回傳的內容無法解析（JSON 格式錯誤）。' : '更新伺服器回傳的內容不是有效的版本資訊（JSON 格式錯誤）。');
        }
        return isGithubApi ? updGithubReleaseToManifest(raw, options.repo) : raw;
    }
    let p = src.replace(/^file:\/+/i, '');
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'latest.json'); } catch (e) {}
    if (!fs.existsSync(p)) throw new Error('找不到版本資訊檔：' + p);
    const m = updReadJsonFile(p);
    if (!m) throw new Error('版本資訊檔內容不是有效的 JSON：' + p);
    return m;
}

// 18-5. 版本資訊正規化 (相容多種欄位寫法)
function updNormalizeManifest(m, feedUrl) {
    const raw = (m && typeof m === 'object') ? m : {};
    const version = String(raw.version || raw.latestVersion || '').trim();
    if (version === '') throw new Error('版本資訊檔缺少「version」欄位，無法判斷版本。');
    let downloadUrl = String(raw.downloadUrl || raw.url || raw.installerUrl || raw.download || '').trim();
    const isAbsolute = /^https?:\/\//i.test(downloadUrl) || /^file:/i.test(downloadUrl) || /^[a-zA-Z]:[\\/]/.test(downloadUrl) || /^\\\\/.test(downloadUrl);
    if (downloadUrl !== '' && !isAbsolute) {
        // 相對路徑：自動接在版本資訊檔所在位置之後（內網共用資料夾特別好用）
        if (/^https?:\/\//i.test(feedUrl)) downloadUrl = new URL(downloadUrl, feedUrl).toString();
        else {
            const base = /\.json$/i.test(feedUrl) ? path.dirname(feedUrl.replace(/^file:\/+/i, '')) : feedUrl.replace(/^file:\/+/i, '');
            downloadUrl = path.join(base, downloadUrl);
        }
    }
    return {
        version: version,
        releaseDate: String(raw.releaseDate || raw.date || raw.publishDate || ''),
        notes: String(raw.notes || raw.description || raw.changelog || ''),
        downloadUrl: downloadUrl,
        fileName: String(raw.fileName || ''),
        sha256: String(raw.sha256 || raw.hash || '').trim().toLowerCase(),
        size: Number(raw.size || 0) || 0,
        minVersion: String(raw.minVersion || ''),
        mandatory: !!raw.mandatory,
        homepage: String(raw.homepage || raw.releaseUrl || raw.site || ''),
        feedUrl: feedUrl
    };
}

// 18-6. 下載檔名 (優先使用版本資訊指定的檔名)
function updPackageName(man) {
    if (man.fileName) return path.basename(man.fileName);
    if (man.downloadUrl) {
        const base = path.basename(String(man.downloadUrl).replace(/[?#].*$/, '').replace(/\\/g, '/'));
        if (base && /\.(exe|msi|zip)$/i.test(base)) return base;
    }
    return UPD_APP_NAME + '_安裝檔_v' + man.version + '.exe';
}

// 18-7. 計算檔案 SHA256 (版本資訊有提供才驗證)
function updHashFile(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const st = fs.createReadStream(p);
        st.on('data', d => h.update(d));
        st.on('end', () => resolve(h.digest('hex')));
        st.on('error', err => reject(err));
    });
}

// 18-8. 下載狀態 (含進度回報與取消)
const updDownloadState = { active: false, cancelled: false, received: 0, total: 0, fileName: '', lastEmit: 0, abort: null };
function updSendProgress(force) {
    const d = updDownloadState;
    const now = Date.now();
    if (!force && now - d.lastEmit < 200) return;
    d.lastEmit = now;
    const percent = d.total > 0 ? Math.min(100, Math.round(d.received / d.total * 100)) : 0;
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-download-progress', {
        fileName: d.fileName, received: d.received, total: d.total, percent: percent,
        receivedMb: Math.round(d.received / 1048576 * 10) / 10, totalMb: Math.round(d.total / 1048576 * 10) / 10
    });
}
function updDownloadToFile(url, destPath, redirectLeft, extraHeaders) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { reject(new Error('下載網址格式不正確：' + url)); return; }
        const mod = u.protocol === 'http:' ? http : https;
        const tmpPath = destPath + '.part';
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
        let settled = false;
        const fail = (err) => { if (!settled) { settled = true; updDownloadState.active = false; reject(err); } };
        const headers = Object.assign({ 'User-Agent': UPD_UA_NAME + '/' + updCurrentVersion(), 'Accept': '*/*', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }, extraHeaders || {});
        const req = mod.get(u, { timeout: 30000, headers: headers }, (res) => {
            if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
                res.resume();
                if (redirectLeft <= 0) { fail(new Error('下載轉址次數過多。')); return; }
                const nextUrl = new URL(res.headers.location, u);
                // GitHub Release 會轉到 objects.githubusercontent.com（簽章網址），跨網域時不帶 Authorization
                const nextHeaders = (nextUrl.hostname !== u.hostname) ? {} : (extraHeaders || {});
                updDownloadToFile(nextUrl.toString(), destPath, redirectLeft - 1, nextHeaders).then(resolve).catch(fail);
                return;
            }
            if (res.statusCode !== 200) { res.resume(); fail(new Error('下載失敗，伺服器回應 HTTP ' + res.statusCode + '。')); return; }
            const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
            if (total > 0) updDownloadState.total = total;
            updDownloadState.received = 0;
            const ws = fs.createWriteStream(tmpPath);
            updDownloadState.abort = () => {
                try { req.destroy(); } catch (e) {}
                try { ws.destroy(); } catch (e) {}
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
                fail(new Error('已取消下載。'));
            };
            res.on('data', (chunk) => {
                if (updDownloadState.cancelled) { if (updDownloadState.abort) updDownloadState.abort(); return; }
                updDownloadState.received += chunk.length;
                updSendProgress(false);
            });
            res.pipe(ws);
            ws.on('finish', () => {
                if (settled) return;
                settled = true;
                updDownloadState.active = false;
                // 下載完成才把 .part 更名為正式檔名，避免半成品被誤裝
                try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); fs.renameSync(tmpPath, destPath); } catch (e) {}
                resolve(destPath);
            });
            ws.on('error', (err) => { fail(new Error('寫入更新檔失敗：' + (err && err.message ? err.message : err))); });
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} fail(new Error('下載逾時（30 秒無回應）。')); });
        req.on('error', (err) => fail(new Error('下載失敗：' + (err && err.message ? err.message : err))));
    });
}

// 18-9. 本機已下載的更新檔清單
function updListPackages() {
    updEnsureDir();
    let list = [];
    try {
        list = fs.readdirSync(updDir()).filter(f => /\.(exe|msi|zip)$/i.test(f) && !/\.part$/i.test(f)).map(f => {
            const full = path.join(updDir(), f);
            let size = 0, mtime = null;
            try { const st = fs.statSync(full); size = st.size; mtime = st.mtime.toISOString(); } catch (e) {}
            const m = /_v(\d+\.\d+\.\d+(?:\.\d+)?)/i.exec(f);
            return { name: f, path: full, sizeKb: Math.max(1, Math.round(size / 1024)), sizeMb: Math.round(size / 1048576 * 10) / 10, mtime: mtime, version: m ? m[1] : '', ext: path.extname(f).replace('.', '').toLowerCase() };
        }).sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')));
    } catch (e) {}
    return list;
}

// 18-10. 版本更新狀態總表 (提供前端整頁渲染)
function updBuildStatus() {
    const feed = updFeedInfo();
    const st = updReadJsonFile(updStateFile()) || {};
    return {
        appName: UPD_APP_NAME,
        version: updCurrentVersion(),
        packaged: !!app.isPackaged,
        sourceKind: feed.kind,
        githubRepo: feed.githubRepo,
        githubTokenSet: !!feed.githubToken,
        githubReleasesPage: updGithubReleasesPage(feed.githubRepo),
        defaultGithubRepo: UPD_DEFAULT_GITHUB_REPO,
        feedUrl: feed.feedUrl || '',
        effectiveUrl: feed.url,
        feedConfigured: !!feed.url,
        feedSource: feed.source,
        defaultFeedUrl: UPD_DEFAULT_FEED_URL,
        updateDir: updDir(),
        packages: updListPackages(),
        lastCheck: st.lastCheck || null,
        latest: st.latest || null,
        downloading: updDownloadState.active
    };
}
function updPushStatus() {
    try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-status-data', updBuildStatus()); } catch (e) {}
}

// 18-11. 檢查更新 (成功才覆蓋上一次的檢查結果)
async function updRunCheck() {
    const feed = updFeedInfo();
    const current = updCurrentVersion();
    if (!feed.url) {
        return { ok: false, reason: 'no-feed', message: '尚未設定更新來源，請先設定 GitHub 倉庫或 latest.json 網址。', currentVersion: current, feedConfigured: false };
    }
    const m = await updLoadManifest(feed.url, { token: feed.githubToken, repo: feed.githubRepo });
    const man = updNormalizeManifest(m, feed.url);
    man.sourceKind = feed.kind;
    man.githubRepo = feed.kind === 'github' ? feed.githubRepo : '';
    if (!man.homepage && feed.kind === 'github') man.homepage = updGithubReleasesPage(feed.githubRepo);
    const cmp = updCompareVersion(man.version, current);
    updWriteJsonFile(updStateFile(), { lastCheck: new Date().toISOString(), latest: man });
    return {
        ok: true,
        currentVersion: current,
        feedKind: feed.kind,
        githubRepo: feed.kind === 'github' ? feed.githubRepo : '',
        feedUrl: feed.url,
        feedConfigured: true,
        manifest: man,
        updateAvailable: cmp > 0,
        sameVersion: cmp === 0,
        isDowngrade: cmp < 0
    };
}
ipcMain.on('upd-check', async () => {
    try {
        const result = await updRunCheck();
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-check-result', result);
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-check-result', { ok: false, reason: 'error', message: msg, currentVersion: updCurrentVersion(), feedConfigured: updFeedInfo().url !== '' });
    }
    updPushStatus();
});

// 18-12. 下載更新檔 (進度回報 → 完整性驗證)
ipcMain.on('upd-download', async (event, data) => {
    try {
        if (updDownloadState.active) throw new Error('目前已有下載作業進行中，請稍候或先按「⛔ 取消下載」。');
        const feed = updFeedInfo();
        const man = (data && data.manifest && data.manifest.version)
            ? updNormalizeManifest(data.manifest, String(data.manifest.feedUrl || feed.url))
            : updNormalizeManifest(await updLoadManifest(feed.url, { token: feed.githubToken, repo: feed.githubRepo }), feed.url);
        if (!man.downloadUrl) throw new Error('版本資訊檔未提供下載網址（downloadUrl 欄位）。');
        updEnsureDir();
        const fileName = updPackageName(man);
        const destPath = path.join(updDir(), fileName);
        updDownloadState.active = true;
        updDownloadState.cancelled = false;
        updDownloadState.fileName = fileName;
        updDownloadState.total = man.size > 0 ? man.size : 0;
        updDownloadState.received = 0;
        updDownloadState.lastEmit = 0;
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-download-started', { fileName: fileName, version: man.version, total: updDownloadState.total });
        if (/^https?:\/\//i.test(man.downloadUrl)) {
            const extraHeaders = (feed.kind === 'github' && feed.githubToken) ? { 'Authorization': 'Bearer ' + feed.githubToken } : {};
            await updDownloadToFile(man.downloadUrl, destPath, 5, extraHeaders);
        } else {
            // 內網／本機來源：直接複製檔案
            const src = man.downloadUrl.replace(/^file:\/+/i, '');
            if (!fs.existsSync(src)) throw new Error('找不到更新檔：' + src);
            fs.copyFileSync(src, destPath);
            const st = fs.statSync(destPath);
            updDownloadState.received = st.size;
            updDownloadState.total = st.size;
            updSendProgress(true);
        }
        // 🛡️ 完整性驗證（版本資訊檔有提供 sha256 才驗證）
        let hash = '';
        if (man.sha256) {
            hash = await updHashFile(destPath);
            if (hash !== man.sha256) {
                try { fs.unlinkSync(destPath); } catch (e) {}
                throw new Error('更新檔驗證失敗（SHA256 不符），已刪除下載的檔案。請確認更新伺服器上的檔案是否為正確版本。');
            }
        }
        updSendProgress(true);
        const sizeMb = Math.round((fs.existsSync(destPath) ? fs.statSync(destPath).size : 0) / 1048576 * 10) / 10;
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-download-done', { fileName: fileName, filePath: destPath, version: man.version, sizeMb: sizeMb, sha256: hash });
    } catch (err) {
        const cancelled = updDownloadState.cancelled;
        const msg = String(err && err.message ? err.message : err);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send(cancelled ? 'upd-download-cancelled' : 'upd-download-error', msg);
        if (!cancelled) dialog.showMessageBox({ type: 'error', message: '下載更新檔失敗：\n' + msg });
    } finally {
        updDownloadState.active = false;
        updDownloadState.cancelled = false;
        updDownloadState.abort = null;
        updPushStatus();
    }
});

// 18-13. 安裝更新檔（🛡️ 先自動「全備份」→ 二次確認 → 啟動安裝程式 → 關閉本程式）
ipcMain.on('upd-install', async (event, data) => {
    try {
        const filePath = String((data && data.filePath) || '').trim();
        if (filePath === '' || !fs.existsSync(filePath)) throw new Error('找不到要安裝的更新檔，請先「⬇️ 下載更新檔」或按「📂 手動選擇更新檔」。');
        if (!/\.(exe|msi)$/i.test(filePath)) throw new Error('只支援安裝 .exe 或 .msi 格式的更新檔。');
        const verMatch = /_v(\d+\.\d+\.\d+(?:\.\d+)?)/i.exec(path.basename(filePath));
        const ver = String((data && data.version) || '') || (verMatch ? verMatch[1] : '');
        // 🛡️ 安裝前自動全備份（失敗會先詢問使用者，避免更新後資料無法回復）
        let safetyPath = '';
        try {
            const safety = await sysCreateBackupFile('all', '更新前自動備份');
            safetyPath = safety.filePath;
        } catch (e) {
            const fail = await dialog.showMessageBox({
                type: 'error', buttons: ['仍要繼續更新', '取消更新'], defaultId: 1, cancelId: 1,
                message: '更新前自動備份失敗，是否仍要繼續更新？',
                detail: '建議先取消更新，並確認「📁 資料儲存位置」可以寫入。\n錯誤訊息：' + (e && e.message ? e.message : e)
            });
            if (fail.response !== 0) { event.reply('upd-install-cancelled'); return; }
        }
        const ask = await dialog.showMessageBox({
            type: 'question', buttons: ['🚀 立即安裝並重新啟動', '取消'], defaultId: 0, cancelId: 1,
            message: '確定要安裝 ' + UPD_APP_NAME + (ver ? ' v' + ver : '') + ' 更新嗎？',
            detail: '更新檔：' + path.basename(filePath)
                + (safetyPath ? '\n🛡️ 更新前自動備份：' + safetyPath : '')
                + '\n\n安裝程式啟動後，本程式會自動關閉，請依畫面指示完成安裝。'
                + '\n（資料庫與附件都放在資料儲存位置，更新後資料完整保留）'
        });
        if (ask.response !== 0) { event.reply('upd-install-cancelled'); return; }
        const openErr = await shell.openPath(filePath);
        if (openErr) throw new Error('無法啟動安裝程式：' + openErr);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-install-starting', { filePath: filePath, version: ver, safetyPath: safetyPath });
        // 先釋放資料庫連線再結束程式，避免檔案被鎖住
        try { await db.execute('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
        try { await new Promise((resolve) => { try { db.close(() => resolve()); } catch (e) { resolve(); } }); } catch (e) {}
        setTimeout(() => { try { app.exit(0); } catch (e) {} }, 2500);
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        dialog.showMessageBox({ type: 'error', message: '安裝更新失敗：\n' + msg });
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-error', msg);
    }
});

// 18-14. 取消下載
ipcMain.on('upd-cancel-download', () => {
    if (!updDownloadState.active) return;
    updDownloadState.cancelled = true;
    if (updDownloadState.abort) updDownloadState.abort();
});

// 18-15. 手動選擇本機更新檔 (內網／USB 離線更新也可用)
ipcMain.on('upd-pick-package', async () => {
    try {
        updEnsureDir();
        const pick = await dialog.showOpenDialog({ title: '選擇要安裝的更新檔', defaultPath: updDir(), filters: [{ name: '更新安裝檔', extensions: ['exe', 'msi'] }], properties: ['openFile'] });
        if (!pick || pick.canceled || !pick.filePaths || pick.filePaths.length === 0) { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-pick-cancelled'); return; }
        const p = pick.filePaths[0];
        let size = 0;
        try { size = fs.statSync(p).size; } catch (e) {}
        const m = /_v(\d+\.\d+\.\d+(?:\.\d+)?)/i.exec(path.basename(p));
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-package-selected', { fileName: path.basename(p), filePath: p, sizeMb: Math.round(size / 1048576 * 10) / 10, version: m ? m[1] : '' });
    } catch (err) {
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-error', String(err && err.message ? err.message : err));
    }
});

// 18-16. 刪除已下載的更新檔 (僅限 updates 資料夾內)
ipcMain.on('upd-delete-package', async (event, data) => {
    try {
        const target = String((data && data.filePath) || '');
        const base = path.resolve(updDir()).toLowerCase() + path.sep;
        const full = path.resolve(target);
        if (target === '' || full.toLowerCase().indexOf(base) !== 0 || !fs.existsSync(full)) throw new Error('僅能刪除更新檔資料夾內的檔案。');
        if (updDownloadState.active && updDownloadState.fileName === path.basename(full)) throw new Error('此檔案正在下載中，請先取消下載。');
        fs.unlinkSync(full);
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-package-deleted', path.basename(full));
    } catch (err) {
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-error', String(err && err.message ? err.message : err));
    }
    updPushStatus();
});

// 18-17. 開啟更新檔資料夾
ipcMain.on('upd-open-update-folder', async () => {
    try { updEnsureDir(); await shell.openPath(updDir()); } catch (e) {}
});

// 18-18. 開啟更新網站 (優先使用版本資訊檔的 homepage，其次為更新伺服器網址)
ipcMain.on('upd-open-homepage', async () => {
    try {
        const st = updReadJsonFile(updStateFile()) || {};
        const latest = st.latest || {};
        let target = String(latest.homepage || '').trim();
        if (target === '') {
            const feed = updFeedInfo();
            if (feed.kind === 'github') target = updGithubReleasesPage(feed.githubRepo);
            else if (/^https?:\/\//i.test(feed.feedUrl)) target = feed.feedUrl;
        }
        if (target === '') {
            dialog.showMessageBox({ type: 'info', message: '目前沒有可開啟的更新網站網址。', detail: '請先設定 GitHub 倉庫或更新伺服器網址，或於版本資訊檔（latest.json）提供 homepage 欄位。' });
            return;
        }
        await shell.openExternal(target);
    } catch (err) {
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-error', String(err && err.message ? err.message : err));
    }
});

// 18-19. 取得版本更新狀態 (開啟分頁時呼叫)
ipcMain.on('upd-get-status', () => { updEnsureDir(); updPushStatus(); });

// 18-20. 設定更新來源（GitHub 倉庫 / Token / 自訂 latest.json；全部留空＝回到內建預設 GitHub）
ipcMain.on('upd-save-feed', async (event, data) => {
    try {
        const d = data || {};
        const cfg = { savedAt: new Date().toISOString() };
        if (d.source === 'github' || d.source === 'feed') cfg.source = d.source;
        if (d.githubRepo !== undefined) cfg.githubRepo = String(d.githubRepo || '').trim();
        if (d.githubToken !== undefined) cfg.githubToken = String(d.githubToken || '').trim();
        const urlValue = (d.url !== undefined) ? d.url : d.feedUrl;
        if (urlValue !== undefined) cfg.feedUrl = String(urlValue || '').trim();
        const hasConfig = !!(cfg.githubRepo || cfg.githubToken || cfg.feedUrl || cfg.source === 'feed');
        if (!hasConfig) { try { fs.unlinkSync(updConfigFile()); } catch (e) {} }
        else if (!updWriteJsonFile(updConfigFile(), cfg)) throw new Error('無法寫入更新設定檔。');
        const feed = updFeedInfo();
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-feed-saved', {
            source: feed.kind,
            githubRepo: feed.githubRepo,
            feedUrl: feed.feedUrl,
            effectiveUrl: feed.url,
            cleared: !hasConfig
        });
    } catch (err) {
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('upd-error', String(err && err.message ? err.message : err));
    }
    updPushStatus();
});

// =================================================================
// 19. 📥 系統管理：匯入資料表 (空白 Excel 範本下載 + 批次匯入)
//     · 欄位完全對應「➕ 新增資訊資產」與「➕ 新增廠商資訊」的基本欄位
//     · 以「資產編號」／「廠商公司名稱」為鍵：不存在＝新增、已存在＝更新
//     · 🛡️ 更新採「有填才覆蓋」：表中空白的欄位不會清掉資料庫既有內容
//     · 僅支援 .xlsx（請使用本功能下載的空白範本填寫，欄位名稱可自動辨識）
// =================================================================

// 19-1. 欄位定義（單一來源：範本產生、匯入解析、前端欄位對照表都由這裡驅動）
const IMP_ASSET_FIELDS = [
    { header: '設備/項目名稱', key: 'name', required: true, width: 26, note: '必填', alias: ['設備名稱', '項目名稱', '設備'] },
    { header: '資產大類', key: 'category', required: true, width: 20, note: '必填（下拉選單）；同時決定自動產生的資產編號（HW/SW/NET/DEV/SEC）', alias: ['大類', '類別', 'category'] },
    { header: '原廠序列號(S/N)', key: 'sn', width: 22, note: '建議填寫：系統會用它比對資料庫，避免重複匯入', alias: ['原廠序列號', '原廠序號', '序號', 'SN'] },
    { header: '保管使用窗口', key: 'custodian', width: 16, note: '', alias: ['保管窗口', '保管人', 'custodian'] },
    { header: '購置擺放地點', key: 'location', width: 16, note: '', alias: ['當前位置', '位置', '地點', 'location'] },
    { header: '連動合作廠商', key: 'vendor_name', width: 20, note: '填廠商名稱會自動對應；找不到則記為「其他 (預設)」', alias: ['購買廠商', '廠商名稱', '廠商'] },
    { header: '維運狀態', key: 'status', width: 16, note: '空白未填＝預設「庫存備用」', alias: ['目前狀態', '狀態', 'status'] },
    { header: '採購日期', key: 'purchase_date', width: 16, note: '格式 2026/09/29 或 2026-09-29', alias: ['購買日期'] },
    { header: '保固到期日', key: 'warranty_date', width: 16, note: '格式 2026/09/29 或 2026-09-29', alias: ['保固到期', '保固期限'] },
    { header: '報廢原因', key: 'scrap_reason', width: 22, note: '狀態為「已報廢」時建議填寫', alias: ['報廢原因註銷備查'] },
    { header: '資產規格/備註', key: 'spec_note', width: 32, note: '選填：規格、型號、擴充配備等補充說明（會顯示於總覽、履歷與盤點總表）', alias: ['資產規格', '規格', '規格備註', '規格說明', 'spec'] },
    { header: '維運備註說明', key: 'notes', width: 30, note: '資產編號由系統自動產生，不需填寫', alias: ['備註事項', '備註', '說明'] }
];
const IMP_VENDOR_FIELDS = [
    { header: '廠商公司名稱', key: 'name', required: true, width: 26, note: '必填；同名視為更新既有廠商', alias: ['公司名稱', '廠商名稱', '廠商'] },
    { header: '主要服務專員', key: 'representative', width: 16, note: '', alias: ['服務專員', '聯絡人', 'representative'] },
    { header: '聯絡窗口電話', key: 'phone', width: 18, note: '', alias: ['電話', '連絡電話', 'phone'] },
    { header: '通訊地址', key: 'address', width: 34, note: '', alias: ['地址', 'address'] },
    { header: '資安 NDA 狀態', key: 'has_nda', width: 16, note: '可填「已簽署」或「尚未簽署」（或 1 / 0）；空白＝新增時預設未簽署', alias: ['NDA狀態', 'NDA', '資安NDA'] },
    { header: '維護合約服務範疇', key: 'service_items', width: 28, note: '', alias: ['服務範疇', '服務項目', '維護項目'] },
    { header: '維護合約開始日', key: 'maint_start', width: 18, note: '格式 2026/01/01 或 2026-01-01', alias: ['合約開始日', '維護起日'] },
    { header: '維護合約截止日', key: 'maint_end', width: 18, note: '格式 2026/12/31 或 2026-12-31', alias: ['合約截止日', '維護迄日'] }
];

// 19-2. 欄位值對照表（可填代碼或中文，含全形/空白容錯）
const IMP_CATEGORY_TABLE = [
    [['hardware', '硬體'], 'hardware'],
    [['software', '軟體'], 'software'],
    [['network', '網路'], 'network'],
    [['peripheral', '周邊', '週邊', 'peripheral', 'dev'], 'peripheral'],
    [['credentials', '帳密', 'sec'], 'credentials']
];
const IMP_STATUS_TABLE = [
    [['active', '線上', '使用中'], 'active'],
    [['inventory', '庫存', '備用'], 'inventory'],
    [['repair', '維修'], 'repair'],
    [['scrapped', 'scrap', '報廢'], 'scrapped']
];
const IMP_CATEGORY_OPTIONS = ['硬體設備 (HW)', '軟體授權 (SW)', '網路設備 (NET)', '資訊周邊 (DEV)', '帳密安全性 (SEC)'];
const IMP_STATUS_OPTIONS = ['線上正常使用', '庫存備用', '維修中', '已報廢'];
const IMP_NDA_OPTIONS = ['已簽署', '尚未簽署'];

const impKeywords = (raw) => String(raw == null ? '' : raw).replace(/[\s\u3000（）()【】\[\]]/g, '').toLowerCase();
function impMapByKeywords(raw, table, fallback) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return fallback;
    const n = impKeywords(s);
    for (let i = 0; i < table.length; i++) {
        for (let k = 0; k < table[i][0].length; k++) { if (n.indexOf(table[i][0][k]) >= 0) return table[i][1]; }
    }
    return null; // 無法識別
}
function impMapYesNo(raw, fallback) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return fallback;
    const n = impKeywords(s);
    if (/^(1|y|yes|true|是|已簽|已簽署|已簽署完成|簽署完成)$/.test(n)) return 1;
    if (/^(0|n|no|false|否|未簽|尚未簽署|未簽署|無)$/.test(n)) return 0;
    return /已|簽|1|y/.test(n) ? 1 : 0;
}
// 日期正規化：支援 Excel 日期、2026/09/29、2026-09-29、20260929、Excel 序號 (20000~60000)
function impNormalizeDate(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) {
        if (isNaN(v.getTime())) return null;
        const y = v.getFullYear();
        // ⚠️ 若使用者把 8 位數字日期（例 20260930）打在「日期格式」欄位，Excel 會把它當成日期序號
        //    （變成西元 57372 年）→ 這裡反推回原始數字後重新解析，避免匯入離譜的日期
        if (y < 1900 || y > 2150) {
            const serial = Math.round((v.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
            if (/^\d{8}$/.test(String(serial))) {
                const rec = impNormalizeDate(String(serial));
                if (rec !== null && rec !== '') return rec;
            }
            return null;
        }
        const p = (n) => String(n).padStart(2, '0');
        return `${y}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    const s = String(v).trim().replace(/\u3000/g, '');
    if (s === '' || s === '—' || s === '-') return '';
    if (/^\d+(\.\d+)?$/.test(s)) {
        const n = parseFloat(s);
        if (n > 20000 && n < 60000) { // Excel 日期序號
            const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
            const p = (x) => String(x).padStart(2, '0');
            return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
        }
    }
    const m = /^(\d{4})[\/\-\.年]?(\d{1,2})[\/\-\.月]?(\d{1,2})日?$/.exec(s);
    if (!m) return null;
    const mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// 欄位索引轉成 Excel 欄名 (1→A、16→P、27→AA)
function impColLetter(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
}
// 19-2-B. 🏷️ 資產編號自動產生（格式：IT-大類代碼-YYYYMMDD-4 位流水號，例 IT-HW-20261015-0001）
const IMP_ASSET_PREFIX = { hardware: 'HW', software: 'SW', network: 'NET', peripheral: 'DEV', credentials: 'SEC' };
const impTodayStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };
async function impNextAssetNo(category, dateStr) {
    const pfx = IMP_ASSET_PREFIX[category] || 'AST';
    const prefix = 'IT-' + pfx + '-' + dateStr + '-';
    let seq = 1;
    // 取同前綴的最大流水號 +1（不看採購日期，避免匯入舊日期資料時流水號都從 0001 開始而撞號）
    const res = await db.execute({ sql: `SELECT asset_no FROM assets_new WHERE asset_no LIKE ?`, args: [prefix + '%'] });
    (res.rows || []).forEach(r => {
        const m = /-(\d+)\s*$/.exec(String(r.asset_no || ''));
        if (m) seq = Math.max(seq, parseInt(m[1], 10) + 1);
    });
    // 保險：若號碼已被使用（例如人工建立的編號）就往上找一個沒被用過的
    for (let i = 0; i < 10000; i++) {
        const no = prefix + String(seq + i).padStart(4, '0');
        const chk = await db.execute({ sql: `SELECT 1 AS x FROM assets_new WHERE asset_no = ?`, args: [no] });
        if (!chk.rows || chk.rows.length === 0) return no;
    }
    throw new Error('無法產生可用的資產編號（同大類同日流水號已滿），請稍後再試。');
}
// 19-3. 產生空白匯入範本 (xlsx Buffer)：第 1 列標題、第 2 列說明、第 3 列欄位名稱、第 4 列起填寫
const IMP_FIELD_FORMAT_HINT = () => ({
    category: '下拉選單（中文）或代碼：\n' + IMP_CATEGORY_OPTIONS.join('、'),
    status: '下拉選單（中文）或代碼：\n' + IMP_STATUS_OPTIONS.join('、'),
    has_nda: '下拉選單：' + IMP_NDA_OPTIONS.join(' / ') + '（或 1 / 0）',
    purchase_date: '日期：YYYY/MM/DD 或 YYYY-MM-DD',
    warranty_date: '日期：YYYY/MM/DD 或 YYYY-MM-DD',
    maint_start: '日期：YYYY/MM/DD 或 YYYY-MM-DD',
    maint_end: '日期：YYYY/MM/DD 或 YYYY-MM-DD',
    vendor_name: '文字（請填系統內既有廠商名稱）'
});
const IMP_FIELD_EXAMPLE = () => ({
    asset_no: 'IT-HW-20261015-0001', name: 'ASUS 商用電腦', category: '硬體設備 (HW)', sn: 'SN12345678',
    custodian: 'kevin', location: 'B2', vendor_name: '聯強國際', status: '線上正常使用',
    purchase_date: '2026/09/29', warranty_date: '2029/09/29', scrap_reason: '', spec_note: 'i7-12700 / 32GB RAM / 1TB SSD / 含 24 吋螢幕', notes: '資產貼紙已張貼',
    representative: '張工程師', phone: '02-2508-1234', address: '台北市中山區民生東路三段 2 號', has_nda: '已簽署',
    service_items: '伺服器與網路設備維護', maint_start: '2026/01/01', maint_end: '2026/12/31'
});

async function impBuildTemplateBuffer(kind) {
    const isVendor = (kind === 'vendor');
    const fields = isVendor ? IMP_VENDOR_FIELDS : IMP_ASSET_FIELDS;
    const label = isVendor ? '廠商資料' : '資產資料';
    const CLR = { primary: 'FF1F4E78', header: 'FF2E75B6', sub: 'FFDDEBF7', border: 'FFB4C6E7', required: 'FFC0392B' };
    const thin = (c) => { const b = { style: 'thin', color: { argb: c || CLR.border } }; return { top: b, left: b, bottom: b, right: b }; };
    const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb } });
    const wb = new ExcelJS.Workbook();
    wb.creator = 'IT Asset Manager';
    wb.created = new Date();

    // ── 工作表 1：匯入資料 ──
    const ws = wb.addWorksheet('匯入資料', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = fields.map(f => ({ width: f.width || 18 }));
    const last = fields.length;
    ws.mergeCells(1, 1, 1, last);
    const t1 = ws.getCell(1, 1);
    t1.value = (isVendor ? '🏢 廠商資料匯入範本' : '📦 資產資料匯入範本') + '　—　請從「第 4 列」開始填寫資料';
    t1.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    t1.alignment = { horizontal: 'center', vertical: 'middle' };
    t1.fill = solid(CLR.primary);
    ws.getRow(1).height = 28;
    ws.mergeCells(2, 1, 2, last);
    const t2 = ws.getCell(2, 1);
    t2.value = '※ 請勿修改第 3 列的欄位名稱；紅底標示為必填。填寫完成後存成 .xlsx，再回系統「⚙️ 系統管理 → 📥 匯入資料表」匯入。已存在的資料只會覆蓋「有填寫」的欄位，空白欄位不會清空原有內容。';
    t2.font = { size: 10, italic: true, color: { argb: 'FF555555' } };
    t2.alignment = { horizontal: 'center', vertical: 'middle' };
    t2.fill = solid(CLR.sub);
    ws.getRow(2).height = 20;
    const hRow = ws.getRow(3);
    fields.forEach((f, i) => {
        const cell = hRow.getCell(i + 1);
        cell.value = f.header + (f.required ? '(必填)' : '');
        cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = solid(f.required ? CLR.required : CLR.header);
        cell.border = thin('FF9DC3E6');
    });
    hRow.height = 28;
    // 註：不在範本加上「自動篩選」，避免表頭出現篩選箭頭而與下拉選單混淆
    // 讓資料輸入區「看得見」：先給前 200 列加上細框線（同時讓 Excel 的 used range 涵蓋輸入區）
    for (let r = 4; r <= 203; r++) {
        const row = ws.getRow(r);
        fields.forEach((f, ci) => { row.getCell(ci + 1).border = thin('FFD9E2F3'); });
        row.height = 18;
    }
    // 下拉選單：以「隱藏工作表 + 定義名稱」實作（Excel 各版本相容性最好、最穩定）
    const optSheet = wb.addWorksheet('選項清單', { state: 'hidden' });
    optSheet.getCell(1, 1).value = '本工作表為下拉選單的選項來源，請勿刪除或修改';
    const optDefs = isVendor
        ? [{ name: 'VENDOR_NDA_LIST', values: IMP_NDA_OPTIONS }]
        : [{ name: 'ASSET_CATEGORY_LIST', values: IMP_CATEGORY_OPTIONS }, { name: 'ASSET_STATUS_LIST', values: IMP_STATUS_OPTIONS }];
    const optNameByKey = {};
    optDefs.forEach((od, ci) => {
        const L = impColLetter(ci + 1);
        od.values.forEach((v, i) => { optSheet.getCell(i + 2, ci + 1).value = v; });
        optSheet.getColumn(ci + 1).width = 30;
        wb.definedNames.add(`選項清單!$${L}$2:$${L}$${od.values.length + 1}`, od.name);
    });
    if (!isVendor) { optNameByKey.category = 'ASSET_CATEGORY_LIST'; optNameByKey.status = 'ASSET_STATUS_LIST'; }
    else { optNameByKey.has_nda = 'VENDOR_NDA_LIST'; }
    const dvBase = { type: 'list', allowBlank: true, showInputMessage: true, showErrorMessage: true, errorTitle: '請選擇有效值', error: '請點選右側小箭頭從下拉清單選擇，或輸入系統可辨識的中文關鍵字。' };
    fields.forEach((f, i) => {
        const L = impColLetter(i + 1);
        const range = `${L}4:${L}2000`;
        const listName = optNameByKey[f.key];
        if (!listName) return;
        const promptTitle = (f.key === 'category') ? '資產大類' : ((f.key === 'status') ? '維運狀態' : '資安 NDA 狀態');
        const prompt = optDefs.filter(o => o.name === listName)[0].values.join('、');
        ws.dataValidations.add(range, Object.assign({}, dvBase, { formulae: [listName], promptTitle: promptTitle, prompt: prompt }));
    });

    // ── 工作表 2：填寫說明 ──
    const hint = IMP_FIELD_FORMAT_HINT(), example = IMP_FIELD_EXAMPLE();
    const ws2 = wb.addWorksheet('填寫說明');
    ws2.columns = [{ width: 24 }, { width: 10 }, { width: 34 }, { width: 50 }, { width: 26 }];
    ws2.mergeCells(1, 1, 1, 5);
    const h1 = ws2.getCell(1, 1);
    h1.value = (isVendor ? '🏢 廠商資料' : '📦 資產資料') + '匯入範本｜欄位填寫說明';
    h1.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    h1.alignment = { horizontal: 'center', vertical: 'middle' };
    h1.fill = solid(CLR.primary);
    ws2.getRow(1).height = 26;
    ['欄位名稱', '必填', '格式 / 可填值', '說明', '範例'].forEach((x, i) => {
        const c = ws2.getCell(2, i + 1);
        c.value = x;
        c.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.fill = solid(CLR.header);
        c.border = thin();
    });
    fields.forEach((f, i) => {
        const r = 3 + i;
        const vals = [
            f.header,
            f.required ? '✔ 必填' : '選填',
            hint[f.key] || '文字',
            f.note || ('對應「新增' + label + '」的「' + f.header + '」欄位'),
            (example[f.key] === undefined ? '' : example[f.key])
        ];
        vals.forEach((v, c) => {
            const cell = ws2.getCell(r, c + 1);
            cell.value = v;
            cell.font = { size: 10, bold: (c === 0), color: { argb: (c === 1 && f.required) ? 'FFB91C1C' : 'FF334155' } };
            cell.alignment = { horizontal: (c === 1 ? 'center' : 'left'), vertical: 'middle', wrapText: true };
            cell.border = thin();
            if (i % 2 === 1) cell.fill = solid('FFF2F7FC');
        });
        ws2.getRow(r).height = 30;
    });
    const notes = isVendor ? [
        '【下拉選單】「資安 NDA 狀態」可直接點選儲存格右側的小箭頭，從清單中選擇（選項來源在隱藏的「選項清單」工作表，請勿刪除）。',
        '【匯入鍵】廠商公司名稱：不存在＝新增一筆；已存在＝更新該筆資料。',
        '【更新規則】只覆蓋表中有填寫的欄位；空白欄位會保留資料庫原有的內容（不會被清空）；已上傳的 NDA／合約檔案不會受影響。',
        '【重複】同一檔案內若有重複的廠商名稱，只會採用第一筆（其餘列會列入提醒，不會匯入）。',
        '【日期格式】2026/09/29、2026-09-29、20260929 或 Excel 日期格式皆可。',
        '【附件】NDA 與採購合約等實體檔案無法用 Excel 匯入，匯入後請於系統內補上傳。',
        '【檔案格式】僅支援 .xlsx（.xls 或 .csv 請先另存新檔為 .xlsx）。'
    ] : [
        '【下拉選單】「資產大類」與「維運狀態」可直接點選儲存格右側的小箭頭，從清單中選擇（選項來源在隱藏的「選項清單」工作表，請勿刪除）。',
        '【資產編號】不需填寫！匯入後由系統依「資產大類」自動產生（格式：IT-大類代碼-匯入日期-4 位流水號，例 IT-HW-20261015-0001），可避免人工輸入造成編號重複。',
        '【必填欄位】設備/項目名稱、資產大類（下拉選單，請直接選取，勿自行輸入避免選錯）。',
        '【重複匯入防護】原廠序列號(S/N) 有填時，系統會比對資料庫：若已有相同序號的資產，該列會自動略過並列入提醒。',
        '【無 S/N 的資料列】無法自動判斷是否重複，請勿重複匯入同一份檔案，以免產生重複資產。',
        '【同檔重複】同一檔案內若有重複的原廠序列號，只會採用第一筆（其餘列會列入提醒）。',
        '【匯入結果】匯入完成後會產生「…_匯入結果_時間.txt」，內含本批次自動產生的資產編號清單。',
        '【日期格式】2026/09/29、2026-09-29、20260929 或 Excel 日期格式皆可。',
        '【容錯】資產大類與維運狀態可填中文或代碼（hardware / software / network / peripheral / credentials；active / inventory / repair / scrapped）。',
        '【檔案格式】僅支援 .xlsx（.xls 或 .csv 請先另存新檔為 .xlsx）。'
    ];
    notes.forEach((n, i) => {
        const r = 3 + fields.length + 1 + i;
        ws2.mergeCells(r, 1, r, 5);
        const c = ws2.getCell(r, 1);
        c.value = n;
        c.font = { size: 10, color: { argb: 'FF7C3AED' } };
        c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        ws2.getRow(r).height = 22;
    });
    return await wb.xlsx.writeBuffer();
}

// 19-4. 讀取 Excel 檔並依欄位定義轉成資料列（欄位名稱自動辨識、支援多重別名與空白列略過）
async function impParseFile(filePath, fields) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (ext !== '.xlsx') throw new Error('只支援 .xlsx 格式的 Excel 檔；請使用「📥 下載空白範本」的檔案填寫（.xls／.csv 請先另存新檔為 .xlsx）。');
    if (!fs.existsSync(filePath)) throw new Error('找不到檔案：' + filePath);
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.readFile(filePath); }
    catch (e) { throw new Error('無法讀取 Excel 檔（可能損毀、正被其他程式開啟鎖定，或不是有效的 xlsx）：' + (e && e.message ? e.message : e)); }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Excel 檔中找不到任何工作表。');

    const norm = (s) => String(s == null ? '' : s).replace(/[\s\u3000（）()【】\[\]＊*：:、,，.。\/\\\-_#]/g, '').toLowerCase();
    const flat = [];
    fields.forEach(f => [f.header].concat(f.alias || []).forEach(n => { const k = norm(n); if (k) flat.push({ key: f.key, n: k }); }));
    flat.sort((a, b) => b.n.length - a.n.length);
    const readCell = (cell) => {
        let v = cell.value;
        if (v === null || v === undefined) return '';
        if (v instanceof Date) return v;
        if (typeof v === 'object') {
            if (Array.isArray(v.richText)) return v.richText.map(t => t.text || '').join('');
            if (v.text !== undefined && v.text !== null) return v.text;
            if (v.result !== undefined) return v.result;
            return (cell.text !== undefined && cell.text !== null) ? cell.text : '';
        }
        return v;
    };

    // 標題列偵測：前 12 列中辨識出最多欄位的那一列
    let headerRow = 0, best = 0, colMap = {};
    const scanMax = Math.min(ws.rowCount || 0, 12);
    for (let r = 1; r <= scanMax; r++) {
        const row = ws.getRow(r);
        const map = {}; let score = 0;
        row.eachCell({ includeEmpty: false }, (cell, col) => {
            const raw = readCell(cell);
            const h = norm(((raw instanceof Date) ? '' : String(raw)));
            if (h === '') return;
            const hit = flat.find(x => x.n === h) || flat.find(x => x.n.length > 1 && (h.indexOf(x.n) >= 0 || x.n.indexOf(h) >= 0));
            if (hit && map[hit.key] === undefined) { map[hit.key] = col; score++; }
        });
        if (score > best) { best = score; headerRow = r; colMap = map; }
    }
    if (headerRow === 0 || best === 0) throw new Error('找不到可辨識的欄位列。請使用「📥 下載空白範本」的格式填寫（欄位名稱在第 3 列）。');
    const missing = fields.filter(f => f.required && colMap[f.key] === undefined).map(f => f.header);
    if (missing.length > 0) throw new Error('缺少必要欄位：' + missing.join('、') + '，請重新下載空白範本填寫。');

    // 讀取資料列（空白列自動略過）
    const rows = [];
    const maxRow = ws.rowCount || 0;
    for (let r = headerRow + 1; r <= maxRow; r++) {
        const row = ws.getRow(r);
        const data = {}; let hasAny = false;
        fields.forEach(f => {
            const col = colMap[f.key];
            const v = (col ? readCell(row.getCell(col)) : '');
            const val = (typeof v === 'string') ? v.trim() : v;
            data[f.key] = val;
            if (val instanceof Date || String(val).trim() !== '') hasAny = true;
        });
        if (!hasAny) continue;
        rows.push({ rowNo: r, data: data });
    }
    return { rows: rows, headerRow: headerRow, colMap: colMap, sheetName: ws.name || '' };
}

// 19-5. 匯入資產資料（dryRun = true 時只檢查與統計，不寫入資料庫）
async function impImportAssets(filePath, dryRun) {
    const parsed = await impParseFile(filePath, IMP_ASSET_FIELDS);
    const plan = { kind: 'asset', rows: parsed.rows.length, inserted: 0, updated: 0, skipped: 0, errors: [], warnings: [], assigned: [] };
    // 同一檔案內「原廠序列號」重複時只採用第一筆（讓預覽統計與實際結果一致）
    const seenKey = {}, uniqueRows = [];
    parsed.rows.forEach(r => {
        const snk = String(r.data.sn == null ? '' : r.data.sn).trim();
        const key = (snk !== '') ? ('sn:' + snk) : '';
        if (key !== '' && seenKey[key]) { plan.warnings.push({ row: r.rowNo, message: '與第 ' + seenKey[key] + ' 列的原廠序列號重複（' + snk + '），只採用第一筆（此列已略過）' }); plan.skipped++; return; }
        if (key !== '') seenKey[key] = r.rowNo;
        uniqueRows.push(r);
    });
    const vendorRes = await db.execute(`SELECT id, name FROM vendors_new`);
    const vendorMap = {};
    (vendorRes.rows || []).forEach(v => { vendorMap[String(v.name || '').trim()] = v.id; });
    for (let k = 0; k < uniqueRows.length; k++) {
        const rowNo = uniqueRows[k].rowNo, f = uniqueRows[k].data;
        const name = String(f.name == null ? '' : f.name).trim();
        if (name === '') { plan.errors.push({ row: rowNo, message: '缺少必填欄位「設備/項目名稱」' }); continue; }
        const category = impMapByKeywords(f.category, IMP_CATEGORY_TABLE, null);
        if (!category) { plan.errors.push({ row: rowNo, message: '「資產大類」無法識別：' + String(f.category == null ? '（空白）' : f.category) }); continue; }
        const statusRaw = String(f.status == null ? '' : f.status).trim();
        const status = (statusRaw === '') ? 'inventory' : impMapByKeywords(statusRaw, IMP_STATUS_TABLE, null);
        if (!status) { plan.errors.push({ row: rowNo, message: '「維運狀態」無法識別：' + statusRaw }); continue; }
        const pDate = impNormalizeDate(f.purchase_date);
        if (pDate === null) { plan.errors.push({ row: rowNo, message: '「採購日期」格式無法識別：' + f.purchase_date }); continue; }
        const wDate = impNormalizeDate(f.warranty_date);
        if (wDate === null) { plan.errors.push({ row: rowNo, message: '「保固到期日」格式無法識別：' + f.warranty_date }); continue; }
        const sn = String(f.sn == null ? '' : f.sn).trim();
        const custodian = String(f.custodian == null ? '' : f.custodian).trim();
        const location = String(f.location == null ? '' : f.location).trim();
        const notes = String(f.notes == null ? '' : f.notes).trim();
        const specNote = String(f.spec_note == null ? '' : f.spec_note).trim();
        const scrapReason = String(f.scrap_reason == null ? '' : f.scrap_reason).trim();
        if (status === 'scrapped' && scrapReason === '') plan.warnings.push({ row: rowNo, message: '狀態為「已報廢」但未填寫報廢原因' });
        const vName = String(f.vendor_name == null ? '' : f.vendor_name).trim();
        const isOtherVendor = (vName === '' || vName === '其他' || vName === '其他 (預設)' || vName === '其他(預設)');
        let vendorId = 0;
        if (!isOtherVendor) {
            if (vendorMap[vName] !== undefined) vendorId = vendorMap[vName];
            else plan.warnings.push({ row: rowNo, message: '找不到廠商「' + vName + '」，已記為「其他 (預設)」' });
        }
        // 🛡️ 重複匯入防護：原廠序列號有填、且資料庫已有相同序號 → 略過，避免重複匯入
        if (sn !== '') {
            const dup = await db.execute({ sql: `SELECT asset_no FROM assets_new WHERE sn = ? AND sn <> '' LIMIT 1`, args: [sn] });
            if (dup.rows && dup.rows.length > 0) {
                plan.skipped++;
                plan.warnings.push({ row: rowNo, message: '資料庫已有相同原廠序列號的資產（' + dup.rows[0].asset_no + '），本列已略過以避免重複匯入' });
                continue;
            }
        }
        // 🏷️ 資產編號由系統依「資產大類」自動產生（使用者不需填寫，避免人工輸入造成重複）
        let newNo = '';
        if (!dryRun) {
            newNo = await impNextAssetNo(category, impTodayStamp());
            await db.execute({ sql: `INSERT INTO assets_new (asset_no, name, category, sn, custodian, location, vendor_id, status, purchase_date, warranty_date, scrap_reason, spec_note, notes, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, args: [newNo, name, category, sn, custodian, location, vendorId, status, pDate, wDate, scrapReason, specNote, notes] });
            const idRes = await db.execute({ sql: `SELECT id FROM assets_new WHERE asset_no = ?`, args: [newNo] });
            const newId = (idRes.rows && idRes.rows.length > 0) ? idRes.rows[0].id : 0;
            await logAssetHistory(newId, newNo, 'create', '匯入資產資料（新增）', '設備名稱:' + name + ' ｜ 大類:' + category + ' ｜ 來源檔：' + path.basename(filePath));
            plan.assigned.push({ row: rowNo, name: name, asset_no: newNo });
        }
        plan.inserted++;
    }
    if (!dryRun) await pushAllAssetsToFrontend();
    return plan;
}

// 19-6. 匯入廠商資料（dryRun = true 時只檢查與統計；更新時不會動到已上傳的 NDA／合約檔案）
async function impImportVendors(filePath, dryRun) {
    const parsed = await impParseFile(filePath, IMP_VENDOR_FIELDS);
    const plan = { kind: 'vendor', rows: parsed.rows.length, inserted: 0, updated: 0, skipped: 0, errors: [], warnings: [] };
    // 同一檔案內重複的「廠商公司名稱」只採用第一筆（讓預覽統計與實際結果一致）
    const seenKey = {}, uniqueRows = [];
    parsed.rows.forEach(r => {
        const key = String(r.data.name == null ? '' : r.data.name).trim();
        if (key !== '' && seenKey[key]) { plan.warnings.push({ row: r.rowNo, message: '與第 ' + seenKey[key] + ' 列的廠商名稱重複，只採用第一筆（此列已略過）' }); plan.skipped++; return; }
        if (key !== '') seenKey[key] = r.rowNo;
        uniqueRows.push(r);
    });
    for (let k = 0; k < uniqueRows.length; k++) {
        const rowNo = uniqueRows[k].rowNo, f = uniqueRows[k].data;
        const name = String(f.name == null ? '' : f.name).trim();
        if (name === '') { plan.errors.push({ row: rowNo, message: '缺少必填欄位「廠商公司名稱」' }); continue; }
        const rep = String(f.representative == null ? '' : f.representative).trim();
        const phone = String(f.phone == null ? '' : f.phone).trim();
        const address = String(f.address == null ? '' : f.address).trim();
        const items = String(f.service_items == null ? '' : f.service_items).trim();
        const ms = impNormalizeDate(f.maint_start);
        if (ms === null) { plan.errors.push({ row: rowNo, message: '「維護合約開始日」格式無法識別：' + f.maint_start }); continue; }
        const me = impNormalizeDate(f.maint_end);
        if (me === null) { plan.errors.push({ row: rowNo, message: '「維護合約截止日」格式無法識別：' + f.maint_end }); continue; }
        if (ms !== '' && me !== '' && ms > me) plan.warnings.push({ row: rowNo, message: '維護合約開始日（' + ms + '）晚於截止日（' + me + '），請確認' });
        const ndaRaw = String(f.has_nda == null ? '' : f.has_nda).trim();
        const hasNda = impMapYesNo(ndaRaw, 0);
        const found = await db.execute({ sql: `SELECT id FROM vendors_new WHERE name = ? ORDER BY id DESC LIMIT 1`, args: [name] });
        const existId = (found.rows && found.rows.length > 0) ? found.rows[0].id : 0;
        if (existId) {
            const sets = [], args = [];
            if (rep !== '') { sets.push('representative=?'); args.push(rep); }
            if (phone !== '') { sets.push('phone=?'); args.push(phone); }
            if (address !== '') { sets.push('address=?'); args.push(address); }
            if (items !== '') { sets.push('service_items=?'); args.push(items); }
            if (ndaRaw !== '') { sets.push('has_nda=?'); args.push(hasNda); }
            if (ms !== '') { sets.push('maint_start=?'); args.push(ms); }
            if (me !== '') { sets.push('maint_end=?'); args.push(me); }
            if (sets.length === 0) { plan.skipped++; plan.warnings.push({ row: rowNo, message: '此列所有欄位皆為空白，未變更既有廠商資料（已略過）' }); continue; }
            if (!dryRun) { args.push(existId); await db.execute({ sql: `UPDATE vendors_new SET ${sets.join(', ')} WHERE id=?`, args: args }); }
            plan.updated++;
        } else {
            if (!dryRun) {
                await db.execute({ sql: `INSERT INTO vendors_new (name, representative, phone, address, has_nda, service_items, nda_files, contract_files, maint_start, maint_end) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?)`, args: [name, rep, phone, address, hasNda, items, ms, me] });
            }
            plan.inserted++;
        }
    }
    if (!dryRun) await pushAllVendorsToFrontend();
    return plan;
}

// 19-7. 匯入結果報告檔（有錯誤或提醒時，在來源檔旁邊產生一份 txt）
function impWriteResultReport(srcFilePath, plan) {
    try {
        const base = path.basename(srcFilePath).replace(/\.[^.]+$/, '');
        const out = path.join(path.dirname(srcFilePath), base + '_匯入結果_' + sysStamp() + '.txt');
        const L = [];
        L.push('IT 資產管理系統｜匯入結果報告');
        L.push('匯入時間：' + new Date().toLocaleString('zh-TW'));
        L.push('來源檔案：' + srcFilePath);
        L.push('資料類型：' + (plan.kind === 'vendor' ? '廠商資料' : '資產資料'));
        L.push('------------------------------------------------');
        L.push('資料列：' + plan.rows + ' 列');
        L.push('新增：' + plan.inserted + ' 筆　更新：' + plan.updated + ' 筆　略過：' + plan.skipped + ' 筆　失敗：' + plan.errors.length + ' 筆');
        L.push('------------------------------------------------');
        if (plan.errors.length > 0) {
            L.push('【未匯入的資料列】');
            plan.errors.forEach(e => L.push('　第 ' + e.row + ' 列：' + e.message));
            L.push('');
        }
        if (plan.warnings.length > 0) {
            L.push('【提醒事項】');
            plan.warnings.forEach(e => L.push('　第 ' + e.row + ' 列：' + e.message));
        }
        if (Array.isArray(plan.assigned) && plan.assigned.length > 0) {
            L.push('');
            L.push('【本批次自動產生的資產編號（共 ' + plan.assigned.length + ' 組）】');
            plan.assigned.forEach(a => L.push('　' + a.asset_no + '　' + a.name + '（來源第 ' + a.row + ' 列）'));
        }
        fs.writeFileSync(out, '\uFEFF' + L.join('\r\n'), 'utf-8');
        return out;
    } catch (e) { return ''; }
}

// 19-8. 匯入狀態（提供前端顯示欄位對照表與最近一次匯入結果）
const impLastResult = { asset: null, vendor: null };
function impBuildStatus() {
    return {
        lastAsset: impLastResult.asset,
        lastVendor: impLastResult.vendor,
        assetFields: IMP_ASSET_FIELDS.map(f => ({ header: f.header, required: !!f.required, note: f.note || ('對應「新增資訊資產」的「' + f.header + '」欄位') })),
        vendorFields: IMP_VENDOR_FIELDS.map(f => ({ header: f.header, required: !!f.required, note: f.note || ('對應「新增廠商資訊」的「' + f.header + '」欄位') })),
        assetOptions: { category: IMP_CATEGORY_OPTIONS, status: IMP_STATUS_OPTIONS },
        vendorOptions: { has_nda: IMP_NDA_OPTIONS }
    };
}
function impPushStatus() {
    try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('imp-status-data', impBuildStatus()); } catch (e) {}
}

// 19-9. 取得匯入狀態（開啟分頁時呼叫）
ipcMain.on('imp-get-status', () => { impPushStatus(); });

// 19-10. 下載空白匯入範本
ipcMain.on('imp-download-template', async (event, data) => {
    try {
        const kind = ((data && data.kind) === 'vendor') ? 'vendor' : 'asset';
        const label = (kind === 'vendor') ? '廠商資料' : '資產資料';
        const pick = await dialog.showSaveDialog({
            title: '下載空白匯入範本',
            defaultPath: path.join(app.getPath('downloads'), label + '匯入範本.xlsx'),
            filters: [{ name: 'Excel 活頁簿', extensions: ['xlsx'] }]
        });
        if (!pick || pick.canceled || !pick.filePath) { event.reply('imp-template-cancelled'); return; }
        const buf = await impBuildTemplateBuffer(kind);
        fs.writeFileSync(pick.filePath, buf);
        await dialog.showMessageBox({
            type: 'info',
            message: '✅ 空白匯入範本已下載完成！',
            detail: '檔案位置：\n' + pick.filePath + '\n\n請在「匯入資料」工作表從第 4 列開始填寫（欄位名稱請勿修改），完成後回到「⚙️ 系統管理 → 📥 匯入資料表」匯入。'
        });
        event.reply('imp-template-done', { kind: kind, filePath: pick.filePath });
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        dialog.showMessageBox({ type: 'error', message: '產生匯入範本失敗：\n' + msg });
        event.reply('imp-template-error', msg);
    }
});

// 19-11. 匯入資料表（選檔 → 先檢查並顯示統計 → 使用者確認 → 才實際寫入）
ipcMain.on('imp-run-import', async (event, data) => {
    try {
        const kind = ((data && data.kind) === 'vendor') ? 'vendor' : 'asset';
        const label = (kind === 'vendor') ? '廠商資料' : '資產資料';
        const pick = await dialog.showOpenDialog({
            title: '選擇要匯入的' + label + ' Excel 檔',
            defaultPath: app.getPath('downloads'),
            filters: [{ name: 'Excel 活頁簿 (.xlsx)', extensions: ['xlsx'] }],
            properties: ['openFile']
        });
        if (!pick || pick.canceled || !pick.filePaths || pick.filePaths.length === 0) { event.reply('imp-import-cancelled'); return; }
        const filePath = pick.filePaths[0];

        // 1️⃣ 先用 dryRun 完整檢查（不寫入資料庫），並顯示統計給使用者確認
        const dry = (kind === 'vendor') ? await impImportVendors(filePath, true) : await impImportAssets(filePath, true);
        if (dry.rows === 0) {
            dialog.showMessageBox({ type: 'warning', message: '這個檔案裡找不到任何資料列。', detail: '請使用「📥 下載空白範本」的格式，從第 4 列開始填寫資料。' });
            event.reply('imp-import-error', '檔案內沒有可匯入的資料列');
            return;
        }
        const detail = [
            '檔案：' + path.basename(filePath),
            '資料列：' + dry.rows + ' 列',
            '',
            '　新增：' + dry.inserted + ' 筆',
            (kind === 'vendor' ? '　更新：' + dry.updated + ' 筆' : ''),
            '　略過：' + dry.skipped + ' 筆',
            '　失敗：' + dry.errors.length + ' 筆',
            '',
            (kind === 'vendor'
                ? '⚠️ 已存在的廠商只會覆蓋「表中有填寫」的欄位，空白欄位不會清空原有內容。'
                : '🏷️ 資產編號不需填寫，將由系統依「資產大類」自動產生。\n🛡️ 原廠序列號(S/N) 有填時會比對資料庫，已有相同序號的資料列會自動略過。')
        ].filter(x => x !== '');
        if (dry.errors.length > 0) {
            detail.push('', '前幾筆未匯入的原因：');
            dry.errors.slice(0, 5).forEach(e => detail.push('　第 ' + e.row + ' 列：' + e.message));
        }
        const ask = await dialog.showMessageBox({ type: 'question', buttons: ['確認匯入', '取消'], defaultId: 0, cancelId: 1, message: '確定要匯入「' + label + '」嗎？', detail: detail.join('\n') });
        if (ask.response !== 0) { event.reply('imp-import-cancelled'); return; }

        // 2️⃣ 實際寫入資料庫
        const plan = (kind === 'vendor') ? await impImportVendors(filePath, false) : await impImportAssets(filePath, false);
        plan.fileName = path.basename(filePath);
        plan.filePath = filePath;
        plan.importedAt = new Date().toISOString();
        plan.errorReportPath = (plan.inserted > 0 || plan.errors.length > 0 || plan.warnings.length > 0) ? impWriteResultReport(filePath, plan) : '';
        impLastResult[kind] = plan;
        event.reply('imp-import-done', plan);
        impPushStatus();
        await dialog.showMessageBox({
            type: 'info',
            message: '✅ ' + label + '匯入完成！',
            detail: '新增：' + plan.inserted + ' 筆　更新：' + plan.updated + ' 筆　略過：' + plan.skipped + ' 筆　失敗：' + plan.errors.length + ' 筆'
                + (Array.isArray(plan.assigned) && plan.assigned.length > 0
                    ? '\n\n🏷️ 本批次自動產生的資產編號（' + plan.assigned.length + ' 組）：\n'
                        + plan.assigned.slice(0, 5).map(a => '　' + a.asset_no + '　' + a.name).join('\n')
                        + (plan.assigned.length > 5 ? '\n　…其餘 ' + (plan.assigned.length - 5) + ' 組請見匯入結果報告' : '')
                    : '')
                + (plan.errorReportPath ? '\n\n📄 匯入結果報告：\n' + plan.errorReportPath : '')
        });
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        dialog.showMessageBox({ type: 'error', message: '匯入失敗：\n' + msg });
        event.reply('imp-import-error', msg);
    }
});

