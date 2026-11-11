// =====================================================================
// IT 資產管理系統 — Web 版（Phase 1：唯讀查詢 + 匯出報表）
//   · 直接讀取與單機版相同的 asset_data.db（以 READONLY 開啟，不會寫入）
//   · 不引入任何額外 npm 套件（Node 內建 http + 既有 exceljs / sqlite3）
//   · 啟動：npm run web   （或 node web/server.js）
//   · 環境變數：WEB_PORT（預設 3010）、WEB_HOST、WEB_DB（資料庫路徑）
// =====================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const dbLib = require('./lib/db');
const auth = require('./lib/auth');
const service = require('./lib/service');
const { buildInventoryXlsx } = require('./lib/export-inventory');
const extras = require('./lib/export-extras');
const filesLib = require('./lib/files');
const importer = require('./lib/importer');

const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_NAME = 'IT 資產管理系統';
const APP_VERSION = (() => { try { return require('../package.json').version; } catch (e) { return '0.0.0'; } })();

// ── 設定 ───────────────────────────────────────────────
function loadConfig() {
    let fileCfg = {};
    try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')); } catch (e) {}
    const envPort = parseInt(process.env.WEB_PORT, 10);
    const envDb = String(process.env.WEB_DB || '').trim();
    const cfgDb = String(fileCfg.dbPath || '').trim();
    let dbPath = '', dbSource = '';
    if (envDb !== '') { dbPath = envDb; dbSource = 'env'; }
    else if (cfgDb !== '') { dbPath = cfgDb; dbSource = 'config'; }
    else { dbPath = path.join(__dirname, '..', 'uploads', 'asset_data.db'); dbSource = 'default'; }
    return {
        port: envPort || parseInt(fileCfg.port, 10) || 3010,
        host: process.env.WEB_HOST || fileCfg.host || '0.0.0.0',
        dbPath: dbPath,
        dbSource: dbSource,
        readOnly: false
    };
}
const CONFIG = loadConfig();
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'uploads', 'asset_data.db');
const DB_SOURCE_LABEL = { env: '環境變數 WEB_DB', config: 'web/config.json', default: '預設（專案內 uploads）' };

let db = null;
let ctx = null;
let dbq = null;

// ── HTTP 小工具 ─────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
};

function baseHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf-8');
    baseHeaders(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
}

function readJsonBody(req, limit) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > (limit || 65536)) { reject(new Error('請求內容過大。')); try { req.destroy(); } catch (e) {} return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
            catch (e) { reject(new Error('請求內容格式錯誤（需為 JSON）。')); }
        });
        req.on('error', (err) => reject(err));
    });
}

function clientIp(req) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

const publicUser = (s) => ({
    username: s.username,
    displayName: s.displayName,
    role: (s.perms || []).indexOf('all') >= 0 ? 'admin' : 'user',
    perms: Array.isArray(s.perms) && s.perms.length ? s.perms : ((s.role === 'admin') ? ['all'] : ['query'])
});

// ── 靜態檔案（白名單，避免路徑穿越）────────────────────
const STATIC_FILES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/app.js': 'app.js',
    '/styles.css': 'styles.css'
};

function serveStatic(req, res, pathname) {
    const name = STATIC_FILES[pathname];
    if (!name) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const full = path.join(PUBLIC_DIR, name);
    fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
        baseHeaders(res);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Content-Length': data.length });
        res.end(data);
    });
}

// ── API：登入 / 登出 ─────────────────────────────────────
async function handleLogin(req, res) {
    const ip = clientIp(req);
    if (auth.isBlocked(ip)) {
        const sec = auth.remainingBlockSeconds(ip);
        return sendJson(res, 429, { ok: false, message: `嘗試次數過多，請於 ${sec} 秒後再試。` });
    }
    let body = null;
    try { body = await readJsonBody(req, 8192); } catch (e) { return sendJson(res, 400, { ok: false, message: e.message }); }
    const username = String((body && body.username) || '').trim();
    const password = String((body && body.password) || '');
    if (!username || !password) return sendJson(res, 400, { ok: false, message: '請輸入帳號與密碼。' });

    let row = null;
    try {
        const rows = await dbq.all(`SELECT * FROM app_users WHERE username = ? COLLATE NOCASE LIMIT 1`, [username]);
        row = rows[0] || null;
    } catch (e) {
        return sendJson(res, 500, { ok: false, message: '讀取帳號資料失敗：' + (e.message || e) });
    }
    if (!row || !row.is_active || !auth.verifyPassword(password, row.password_salt, row.password_hash)) {
        const blocked = auth.recordFailure(ip);
        return sendJson(res, 401, { ok: false, message: blocked ? '嘗試次數過多，請稍後再試。' : '帳號或密碼錯誤。' });
    }
    auth.clearFailures(ip);
    const session = auth.createSession(row);
    baseHeaders(res);
    res.setHeader('Set-Cookie', auth.cookieHeader(session.sid));
    console.log(`[login] ${session.username} (${session.role}) from ${ip}`);
    return sendJson(res, 200, { ok: true, user: publicUser(session) });
}

function handleLogout(req, res) {
    const s = auth.getSession(req);
    if (s) { auth.destroySession(s.sid); console.log(`[logout] ${s.username}`); }
    baseHeaders(res);
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    return sendJson(res, 200, { ok: true });
}

// ── API：資產清單 ────────────────────────────────────────
async function handleAssets(res) {
    const rows = await dbq.all(`
        SELECT a.id, a.asset_no, a.name, a.category, a.sn, a.custodian, a.location,
               a.vendor_id, a.status, a.purchase_date, a.warranty_date, a.scrap_reason,
               a.spec_note, a.notes, a.department, COALESCE(v.name, '') AS vendor_name
        FROM assets_new a
        LEFT JOIN vendors_new v ON a.vendor_id = v.id
        WHERE a.is_deleted = 0
        ORDER BY COALESCE(NULLIF(a.department, ''), 'IT') ASC, a.asset_no ASC`);
    return sendJson(res, 200, { ok: true, count: rows.length, assets: rows });
}

// ── API：欄位選項（大類／部門中文名稱）──────────────────
async function handleFieldOptions(res) {
    let categories = [], departments = [];
    try { categories = await dbq.all(`SELECT value, label, code, sort_order FROM field_options WHERE field_type = 'category' ORDER BY sort_order ASC, id ASC`); } catch (e) {}
    try { departments = await dbq.all(`SELECT value, label, code, sort_order FROM field_options WHERE field_type = 'department' ORDER BY sort_order ASC, id ASC`); } catch (e) {}
    return sendJson(res, 200, { ok: true, categories: categories, departments: departments });
}

// ── API：單一資產履歷（基本資料 + 維修 + 轉移）───────────
async function handleAssetDetail(res, id) {
    const rows = await dbq.all(`
        SELECT a.*, COALESCE(v.name, '') AS vendor_name
        FROM assets_new a LEFT JOIN vendors_new v ON a.vendor_id = v.id
        WHERE a.id = ? AND a.is_deleted = 0`, [id]);
    const asset = rows[0] || null;
    if (!asset) return sendJson(res, 404, { ok: false, message: '找不到該資產。' });
    const repairs = await dbq.all(`SELECT id, asset_no, fault_description, repair_vendor, reported_date, completed_date, cost, status, notes FROM repairs_new WHERE asset_id = ? ORDER BY id DESC`, [id]);
    const transfers = await dbq.all(`SELECT id, asset_no, from_custodian, to_custodian, from_location, to_location, from_department, to_department, transfer_date, reason, notes FROM transfers_new WHERE asset_id = ? ORDER BY id DESC`, [id]);
    return sendJson(res, 200, { ok: true, asset: asset, repairs: repairs, transfers: transfers });
}

// ── API：匯出盤點總表（xlsx 直接下載）────────────────────
async function handleExportInventory(res, session) {
    const result = await buildInventoryXlsx(dbq);
    const asciiName = 'IT_Asset_Inventory_' + result.stamp + '.xlsx';
    const cnName = 'IT_資產盤點總表_' + result.stamp + '.xlsx';
    baseHeaders(res);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(cnName));
    res.setHeader('Content-Length', result.buffer.length);
    console.log(`[export] inventory by ${session.username}: ${result.count} assets, ${result.buffer.length} bytes`);
    res.end(result.buffer);
}

// ── Session 持久化介面（web_sessions 表）────────────────
function makeSessionStore(c) {
    return {
        loadAll: async (now) => {
            try { await c.run(`DELETE FROM web_sessions WHERE expires <= ?`, [now]); } catch (e) {}
            const rows = await c.all(`SELECT sid, user_id, username, display_name, role, perms, created_at, expires FROM web_sessions`);
            return rows.map(r => ({ sid: r.sid, id: r.user_id, username: r.username, displayName: r.display_name, role: r.role, perms: service.parsePerms(r.perms || (r.role === 'admin' ? 'all' : 'query')), createdAt: r.created_at, expires: r.expires }));
        },
        insert: (s) => c.run(`INSERT OR REPLACE INTO web_sessions (sid, user_id, username, display_name, role, perms, created_at, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [s.sid, s.id, s.username, s.displayName, s.role, service.permsToText(s.perms || []), s.createdAt, s.expires]),
        remove: (sid) => c.run(`DELETE FROM web_sessions WHERE sid = ?`, [sid]),
        removeByUser: (id) => c.run(`DELETE FROM web_sessions WHERE user_id = ?`, [id])
    };
}

// ── 資料庫還原 / 重新開啟 ───────────────────────────────
async function reopenDb() {
    const dbPath = path.resolve(CONFIG.dbPath);
    db = await dbLib.openDb(dbPath, { readOnly: false });
    ctx = dbLib.makeCtx(db);
    dbq = ctx;
    try { await ctx.exec('PRAGMA journal_mode = WAL'); } catch (e) {}
    await service.ensureSchema(ctx);
    await auth.init(makeSessionStore(ctx));   // 重新載入（還原後同步）
}

async function handleRestoreDb(req, res, session) {
    if (!isAdmin(session)) return denyReadOnly(res);
    const d = await body(req, 300 * 1024 * 1024);
    if (String(d.confirm || '').trim().toUpperCase() !== 'RESTORE') throw new Error('請在確認欄輸入 RESTORE 才會執行還原。');
    const buf = Buffer.from(String(d.dataBase64 || ''), 'base64');
    if (buf.length < 512) throw new Error('檔案內容為空或過小。');
    if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new Error('檔案不是有效的 SQLite 資料庫。');

    const dbPath = path.resolve(CONFIG.dbPath);
    const dir = path.dirname(dbPath);
    const backupsDir = path.join(dir, 'backups');
    filesLib.ensureDir(backupsDir);
    const stampTxt = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const safety = path.join(backupsDir, 'asset_data_before_restore_' + stampTxt + '.db');

    try { await ctx.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    fs.copyFileSync(dbPath, safety);
    await dbLib.close(db);
    ['-wal', '-shm'].forEach(s => { try { const p = dbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} });
    fs.writeFileSync(dbPath, buf);
    await reopenDb();
    console.log(`[restore] db restored by ${session.username}; safety backup: ${safety}`);
    return ok(res, { restored: true, safety: safety });
}

// ── 匯入單機版備份（.zip／.db）────────────────────────────
async function handleImportDesktopBackup(req, res, session) {
    if (!isAdmin(session)) return denyReadOnly(res);
    const d = await body(req, 400 * 1024 * 1024);
    const list = Array.isArray(d.files) ? d.files : [];
    if (!list.length) throw new Error('請選擇要匯入的檔案（.zip 或 .db）。');
    const files = list
        .map(f => ({ name: String((f && f.name) || ''), buffer: Buffer.from(String((f && f.dataBase64) || ''), 'base64') }))
        .filter(f => f.buffer.length);
    if (!files.length) throw new Error('檔案內容為空。');

    const dbPath = path.resolve(CONFIG.dbPath);
    const dataDir = path.dirname(dbPath);
    const result = await importer.importDesktopBackup({
        ctx: ctx, dataDir: dataDir, dbPath: dbPath,
        files: files, importFields: d.importFields !== false
    });
    console.log(`[import] desktop backup by ${session.username}: db=${result.dbImported ? result.dbName : '(none)'} tables=${JSON.stringify(result.tables)} attachments=${result.attachments} repointed=${result.repointed}`);
    return ok(res, result);
}

// ── 附件路徑狀態／修復（上傳單機版附件資料夾 ZIP）──────────
async function handleAttachmentsStatus(res, session) {
    if (!isAdmin(session)) return denyReadOnly(res);
    const dataDir = path.dirname(path.resolve(CONFIG.dbPath));
    return ok(res, await importer.checkStoredPaths(ctx, dataDir));
}

async function handleRepairAttachments(req, res, session) {
    if (!isAdmin(session)) return denyReadOnly(res);
    const d = await body(req, 400 * 1024 * 1024);
    const list = Array.isArray(d.files) ? d.files : [];
    const files = list
        .map(f => ({ name: String((f && f.name) || ''), buffer: Buffer.from(String((f && f.dataBase64) || ''), 'base64') }))
        .filter(f => f.buffer.length);
    if (list.length && !files.length) throw new Error('檔案內容為空。');
    const dataDir = path.dirname(path.resolve(CONFIG.dbPath));
    const result = await importer.repairAttachments({ ctx: ctx, dataDir: dataDir, files: files });
    console.log(`[attachments] repair by ${session.username}: extracted=${result.extracted} repointed=${result.repointed} valid=${result.after.existing}/${result.after.total}`);
    return ok(res, result);
}

// ── 版本資訊 ───────────────────────────────────────────
async function handleVersionInfo(res, session) {
    if (!isAdmin(session)) return denyReadOnly(res);
    let counts = {};
    try {
        counts.assets = (await ctx.get(`SELECT COUNT(*) AS c FROM assets_new WHERE is_deleted = 0`)).c;
        counts.vendors = (await ctx.get(`SELECT COUNT(*) AS c FROM vendors_new`)).c;
        counts.repairs = (await ctx.get(`SELECT COUNT(*) AS c FROM repairs_new`)).c;
        counts.transfers = (await ctx.get(`SELECT COUNT(*) AS c FROM transfers_new`)).c;
        counts.users = (await ctx.get(`SELECT COUNT(*) AS c FROM app_users`)).c;
    } catch (e) {}
    return ok(res, {
        version: APP_VERSION,
        server: 'Node ' + process.version,
        startedAt: STARTED_AT,
        dataDir: path.dirname(path.resolve(CONFIG.dbPath)),
        dbPath: path.resolve(CONFIG.dbPath),
        counts: counts,
        github: 'https://github.com/Kevin7563/it-asset-manager/releases'
    });
}

// ── 附件下載 / ZIP 備份 ────────────────────────────────
async function handleFileDownload(req, res, session, query) {
    const target = String(query.get('path') || '');
    const info = filesLib.readFileForDownload(path.dirname(path.resolve(CONFIG.dbPath)), target);
    baseHeaders(res);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(info.name));
    res.setHeader('Content-Length', info.size);
    fs.createReadStream(info.fullPath).pipe(res);
}

async function handleFilesZip(res, session) {
    if (!isAdmin(session)) return denyReadOnly(res);
    const dataDir = path.dirname(path.resolve(CONFIG.dbPath));
    const zip = filesLib.zipFolder(dataDir, 'vendor_files');
    if (!zip.count) return sendJson(res, 404, { ok: false, message: '目前沒有附件檔可備份。' });
    const stampTxt = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    baseHeaders(res);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="vendor_files_' + stampTxt + '.zip"');
    res.setHeader('Content-Length', zip.buffer.length);
    console.log(`[backup] attachments zip by ${session.username}: ${zip.count} files, ${zip.buffer.length} bytes`);
    res.end(zip.buffer);
}

const STARTED_AT = new Date().toISOString();

function sendXlsx(res, buffer, cnName, asciiName) {
    baseHeaders(res);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + (asciiName || 'export.xlsx') + '"; filename*=UTF-8\'\'' + encodeURIComponent(cnName || 'export.xlsx'));
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
}

// ── 權限判斷（勾選式：all / query / vendor / asset）──────
function permsOf(session) {
    if (session && Array.isArray(session.perms) && session.perms.length) return session.perms;
    return (session && session.role === 'admin') ? ['all'] : ['query'];
}
function hasPerm(session, perm) {
    const list = permsOf(session);
    return list.indexOf('all') >= 0 || list.indexOf(perm) >= 0;
}
// 「全功能」＝系統管理員（帳號管理、欄位管理、備份還原／版本資訊）
function isAdmin(session) { return hasPerm(session, 'all'); }
function denyPerm(res, label) {
    return sendJson(res, 403, { ok: false, message: '權限不足：需要「' + label + '」權限。' });
}
function need(res, session, perm, label) {
    if (hasPerm(session, perm)) return true;
    denyPerm(res, label);
    return false;
}
function denyReadOnly(res) { return denyPerm(res, '全功能'); }
function ok(res, data) { return sendJson(res, 200, Object.assign({ ok: true }, data || {})); }
async function body(req, limit) {
    try { return await readJsonBody(req, limit || (4 * 1024 * 1024)); }
    catch (e) { throw new Error(e.message || '請求內容格式錯誤。'); }
}

// ── 寫入 API（依權限勾選判斷）───────────────────────────
async function handleWriteApi(req, res, session, p) {
    const m = req.method;
    let mm;
    const canAsset = () => need(res, session, 'asset', '資產管理');
    const canVendor = () => need(res, session, 'vendor', '廠商管理');
    const canAdmin = () => need(res, session, 'all', '全功能');

    // 資產（資產管理權限）
    if (m === 'POST' && p === '/api/assets') { if (!canAsset()) return; return ok(res, await service.createAsset(ctx, await body(req), session)); }
    if (m === 'PUT' && (mm = /^\/api\/assets\/(\d+)$/.exec(p))) { if (!canAsset()) return; return ok(res, await service.updateAsset(ctx, mm[1], await body(req), session)); }
    if (m === 'DELETE' && (mm = /^\/api\/assets\/(\d+)$/.exec(p))) { if (!canAsset()) return; return ok(res, { asset: await service.deleteAsset(ctx, mm[1], session) }); }
    if (m === 'POST' && (mm = /^\/api\/assets\/(\d+)\/restore$/.exec(p))) { if (!canAsset()) return; return ok(res, { asset: await service.restoreAsset(ctx, mm[1], session) }); }

    // 維修（資產管理權限）
    if (m === 'POST' && p === '/api/repairs') { if (!canAsset()) return; return ok(res, await service.createRepair(ctx, await body(req), session)); }
    if (m === 'POST' && (mm = /^\/api\/repairs\/(\d+)\/complete$/.exec(p))) { if (!canAsset()) return; return ok(res, await service.completeRepair(ctx, mm[1], session)); }
    if (m === 'DELETE' && (mm = /^\/api\/repairs\/(\d+)$/.exec(p))) { if (!canAsset()) return; return ok(res, { repair: await service.deleteRepair(ctx, mm[1]) }); }

    // 轉移（資產管理權限）
    if (m === 'POST' && p === '/api/transfers') { if (!canAsset()) return; return ok(res, await service.createTransfer(ctx, await body(req), session)); }
    if (m === 'DELETE' && (mm = /^\/api\/transfers\/(\d+)$/.exec(p))) { if (!canAsset()) return; return ok(res, { transfer: await service.deleteTransfer(ctx, mm[1]) }); }

    // 廠商（廠商管理權限）
    if (m === 'POST' && p === '/api/vendors') { if (!canVendor()) return; return ok(res, await service.saveVendor(ctx, await body(req), session)); }
    if (m === 'PUT' && (mm = /^\/api\/vendors\/(\d+)$/.exec(p))) {
        if (!canVendor()) return;
        const d = await body(req); d.id = parseInt(mm[1], 10);
        return ok(res, await service.saveVendor(ctx, d, session));
    }
    if (m === 'DELETE' && (mm = /^\/api\/vendors\/(\d+)$/.exec(p))) { if (!canVendor()) return; return ok(res, { vendor: await service.deleteVendor(ctx, mm[1]) }); }

    // 廠商維護紀錄（廠商管理權限）
    if (m === 'POST' && p === '/api/vendor-maint') { if (!canVendor()) return; return ok(res, await service.createVendorMaint(ctx, await body(req), session)); }
    if (m === 'DELETE' && (mm = /^\/api\/vendor-maint\/(\d+)$/.exec(p))) { if (!canVendor()) return; return ok(res, { record: await service.deleteVendorMaint(ctx, mm[1]) }); }

    // 欄位管理（全功能）
    if (m === 'POST' && p === '/api/field-options') { if (!canAdmin()) return; return ok(res, await service.addFieldOption(ctx, await body(req))); }
    if (m === 'DELETE' && (mm = /^\/api\/field-options\/(\d+)$/.exec(p))) { if (!canAdmin()) return; return ok(res, { option: await service.deleteFieldOption(ctx, mm[1]) }); }

    // 帳號管理（全功能）
    if (m === 'POST' && p === '/api/users') { if (!canAdmin()) return; return ok(res, await service.createUserAccount(ctx, await body(req))); }
    if (m === 'PUT' && (mm = /^\/api\/users\/(\d+)$/.exec(p))) {
        if (!canAdmin()) return;
        const uid = parseInt(mm[1], 10);
        const out = await service.updateUserAccount(ctx, uid, await body(req), { id: session.id });
        if (out && out.isActive === false) auth.invalidateUser(uid);            // 停用 → 立即踢出
        else auth.updateUserSessions(uid, { perms: out.perms, role: out.role }); // 改權限 → 直接生效
        return ok(res, out);
    }
    if (m === 'POST' && (mm = /^\/api\/users\/(\d+)\/password$/.exec(p))) {
        if (!canAdmin()) return;
        const uid = parseInt(mm[1], 10);
        const d = await body(req);
        const out = await service.resetUserPassword(ctx, uid, d.newPassword);
        if (uid !== session.id) auth.invalidateUser(uid);   // 重設密碼 → 舊登入失效
        return ok(res, out);
    }
    if (m === 'DELETE' && (mm = /^\/api\/users\/(\d+)$/.exec(p))) {
        if (!canAdmin()) return;
        const uid = parseInt(mm[1], 10);
        const out = await service.deleteUserAccount(ctx, uid, { id: session.id });
        auth.invalidateUser(uid);
        return ok(res, out);
    }

    // 匯入資產（Excel，base64）→ 資產管理
    if (m === 'POST' && p === '/api/import/assets') {
        if (!canAsset()) return;
        const d = await body(req, 24 * 1024 * 1024);
        const b64 = String(d.dataBase64 || '');
        if (!b64) throw new Error('沒有收到檔案內容。');
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) throw new Error('檔案內容為空。');
        const result = await service.importAssetsFromXlsx(ctx, buf, d.fileName || 'import.xlsx', session);
        console.log(`[import] assets by ${session.username}: +${result.inserted}, skipped ${result.skipped}, errors ${result.errors.length}`);
        return ok(res, result);
    }

    // 匯入廠商（Excel，base64）→ 廠商管理
    if (m === 'POST' && p === '/api/import/vendors') {
        if (!canVendor()) return;
        const d = await body(req, 24 * 1024 * 1024);
        const buf = Buffer.from(String(d.dataBase64 || ''), 'base64');
        if (!buf.length) throw new Error('沒有收到檔案內容。');
        const result = await service.importVendorsFromXlsx(ctx, buf, d.fileName || 'vendors.xlsx', session);
        console.log(`[import] vendors by ${session.username}: +${result.inserted}, updated ${result.updated}, errors ${result.errors.length}`);
        return ok(res, result);
    }

    // 廠商附件（NDA / 合約）→ 廠商管理
    const dataDir = path.dirname(path.resolve(CONFIG.dbPath));
    if (m === 'POST' && (mm = /^\/api\/vendors\/(\d+)\/files$/.exec(p))) {
        if (!canVendor()) return;
        const d = await body(req, 60 * 1024 * 1024);
        const kind = (d.kind === 'contract') ? 'contract' : 'nda';
        const result = await service.addVendorFiles(ctx, dataDir, mm[1], kind, d.files || []);
        return ok(res, result);
    }
    if (m === 'POST' && (mm = /^\/api\/vendors\/(\d+)\/files\/delete$/.exec(p))) {
        if (!canVendor()) return;
        const d = await body(req);
        const kind = (d.kind === 'contract') ? 'contract' : 'nda';
        return ok(res, await service.removeVendorFile(ctx, dataDir, mm[1], kind, d.path));
    }

    // 廠商維護單據 → 廠商管理
    if (m === 'POST' && (mm = /^\/api\/vendor-maint\/(\d+)\/docs$/.exec(p))) {
        if (!canVendor()) return;
        const d = await body(req, 60 * 1024 * 1024);
        return ok(res, await service.addMaintDocs(ctx, dataDir, mm[1], d.files || []));
    }
    if (m === 'POST' && (mm = /^\/api\/vendor-maint\/(\d+)\/docs\/delete$/.exec(p))) {
        if (!canVendor()) return;
        const d = await body(req);
        return ok(res, await service.removeMaintDoc(ctx, dataDir, mm[1], d.path));
    }

    // 編輯鎖定（依實體對應權限）
    if (m === 'POST' && p === '/api/locks/acquire') {
        const d = await body(req);
        if (!need(res, session, d.entity === 'vendor' ? 'vendor' : 'asset', d.entity === 'vendor' ? '廠商管理' : '資產管理')) return;
        return ok(res, await service.acquireLock(ctx, d.entity, d.id, session));
    }
    if (m === 'POST' && p === '/api/locks/release') {
        const d = await body(req);
        return ok(res, await service.releaseLock(ctx, d.entity, d.id, session));
    }

    // 資料庫還原（全功能）
    if (m === 'POST' && p === '/api/backup/restore') { if (!canAdmin()) return; return await handleRestoreDb(req, res, session); }

    // 📥 匯入單機版備份（.zip／.db）（全功能）
    if (m === 'POST' && p === '/api/import/desktop-backup') { if (!canAdmin()) return; return await handleImportDesktopBackup(req, res, session); }
    // 🔧 附件路徑修復（全功能）
    if (m === 'POST' && p === '/api/import/attachments') { if (!canAdmin()) return; return await handleRepairAttachments(req, res, session); }

    return sendJson(res, 404, { ok: false, message: '找不到 API。' });
}

// ── 備份下載（管理者）──────────────────────────────────
async function handleBackupDownload(res, session) {
    if (!isAdmin(session)) return denyReadOnly(res);
    try { await ctx.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    const dbPath = path.resolve(CONFIG.dbPath);
    if (!fs.existsSync(dbPath)) { return sendJson(res, 404, { ok: false, message: '找不到資料庫檔案。' }); }
    const stat = fs.statSync(dbPath);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '');
    const ascii = 'asset_data_backup_' + stamp + '.db';
    baseHeaders(res);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + ascii + '"');
    res.setHeader('Content-Length', stat.size);
    console.log(`[backup] db download by ${session.username} (${stat.size} bytes)`);
    fs.createReadStream(dbPath).pipe(res);
}



// ── 路由 ────────────────────────────────────────────────
async function requestHandler(req, res) {
    let parsed = null;
    try { parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
    catch (e) { return sendJson(res, 400, { ok: false, message: '網址格式錯誤。' }); }
    const p = parsed.pathname;

    try {
        if (p === '/api/health') {
            return sendJson(res, 200, { ok: true, app: APP_NAME, version: APP_VERSION, db: !!db, mode: 'read-write', time: new Date().toISOString() });
        }
        if (p === '/api/login') {
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '請使用 POST。' });
            return await handleLogin(req, res);
        }
        if (p === '/api/logout') return handleLogout(req, res);

        if (p.indexOf('/api/') === 0) {
            const session = auth.getSession(req);
            if (!session) return sendJson(res, 401, { ok: false, error: 'unauthenticated', message: '請先登入。' });

            // ── 讀取 ──
            if (req.method === 'GET') {
                if (p === '/api/me') return sendJson(res, 200, { ok: true, user: publicUser(session) });
                if (p === '/api/assets') { const assets = await service.listAssets(ctx); return ok(res, { count: assets.length, assets: assets }); }
                if (p === '/api/recycle') { if (!need(res, session, 'asset', '資產管理')) return; const list = await service.listRecycle(ctx); return ok(res, { count: list.length, assets: list }); }
                if (p === '/api/stats') return ok(res, await service.getStats(ctx));
                if (p === '/api/field-options') return ok(res, await service.listFieldOptions(ctx));
                if (p === '/api/repairs') return ok(res, { repairs: await service.listRepairs(ctx) });
                if (p === '/api/transfers') return ok(res, { transfers: await service.listTransfers(ctx) });
                if (p === '/api/vendors') {
                    if (!hasPerm(session, 'vendor') && !hasPerm(session, 'asset')) return denyPerm(res, '廠商管理 或 資產管理');
                    return ok(res, { vendors: await service.listVendors(ctx) });
                }
                if (p === '/api/vendor-maint') { if (!need(res, session, 'vendor', '廠商管理')) return; return ok(res, { records: await service.listVendorMaint(ctx) }); }
                if (p === '/api/users') { if (!isAdmin(session)) return denyReadOnly(res); return ok(res, { users: await service.listUsers(ctx) }); }
                if (p === '/api/export/inventory.xlsx') {
                    if (!hasPerm(session, 'query') && !hasPerm(session, 'asset')) return denyPerm(res, '一般查詢與報表匯出 或 資產管理');
                    return await handleExportInventory(res, session);
                }
                if (p === '/api/backup/db') return await handleBackupDownload(res, session);
                if (p === '/api/backup/files') return await handleFilesZip(res, session);
                if (p === '/api/version') return await handleVersionInfo(res, session);
                if (p === '/api/attachments/status') return await handleAttachmentsStatus(res, session);
                if (p === '/api/files') {
                    if (!need(res, session, 'vendor', '廠商管理')) return;
                    return await handleFileDownload(req, res, session, parsed.searchParams);
                }
                if (p === '/api/export/vendors.xlsx') {
                    if (!hasPerm(session, 'query') && !hasPerm(session, 'vendor')) return denyPerm(res, '一般查詢與報表匯出 或 廠商管理');
                    const r2 = await extras.buildVendorListXlsx(ctx);
                    return sendXlsx(res, r2.buffer, 'IT_合作廠商清單_' + r2.stamp + '.xlsx', 'IT_Vendor_List_' + r2.stamp + '.xlsx');
                }
                if (p === '/api/export/vendor-maint.xlsx') {
                    if (!hasPerm(session, 'query') && !hasPerm(session, 'vendor')) return denyPerm(res, '一般查詢與報表匯出 或 廠商管理');
                    const name = String(parsed.searchParams.get('name') || '');
                    const r2 = await extras.buildVendorMaintXlsx(ctx, name);
                    return sendXlsx(res, r2.buffer, '廠商維護歷程' + (name ? '_' + name : '') + '_' + r2.stamp + '.xlsx', 'Vendor_Maint_' + r2.stamp + '.xlsx');
                }
                if (p === '/api/template/assets.xlsx') {
                    if (!need(res, session, 'asset', '資產管理')) return;
                    const r2 = await extras.buildAssetTemplateXlsx();
                    return sendXlsx(res, r2.buffer, '資產資料匯入範本.xlsx', 'Asset_Import_Template.xlsx');
                }
                if (p === '/api/template/vendors.xlsx') {
                    if (!need(res, session, 'vendor', '廠商管理')) return;
                    const r2 = await extras.buildVendorTemplateXlsx();
                    return sendXlsx(res, r2.buffer, '廠商資料匯入範本.xlsx', 'Vendor_Import_Template.xlsx');
                }
                const mHist = /^\/api\/export\/asset-history\/(\d+)\.xlsx$/.exec(p);
                if (mHist) {
                    if (!hasPerm(session, 'query') && !hasPerm(session, 'asset')) return denyPerm(res, '一般查詢與報表匯出 或 資產管理');
                    const r2 = await extras.buildAssetHistoryXlsx(ctx, mHist[1]);
                    return sendXlsx(res, r2.buffer, '資產履歷_' + r2.assetNo + '.xlsx', 'Asset_History_' + r2.stamp + '.xlsx');
                }
                const mDetail = /^\/api\/assets\/(\d+)$/.exec(p);
                if (mDetail) return ok(res, await service.getAssetDetail(ctx, mDetail[1]));
                if (p === '/api/locks') return ok(res, { locks: await service.listLocks(ctx, parsed.searchParams.get('entity') || 'asset') });
                return sendJson(res, 404, { ok: false, message: '找不到 API。' });
            }

            // ── 修改自己的密碼（一般使用者也可）──
            if (req.method === 'POST' && p === '/api/me/password') {
                const d = await body(req);
                return ok(res, await service.changeOwnPassword(ctx, session.id, d.currentPassword, d.newPassword));
            }

            // ── 其他寫入（需管理者）──
            return await handleWriteApi(req, res, session, p);
        }

        return serveStatic(req, res, p);
    } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        const status = (err && err.status) ? err.status : 500;
        console.error('[error] ' + p + ' -> ' + msg);
        if (!res.headersSent) return sendJson(res, status, { ok: false, message: msg });
        try { res.end(); } catch (e) {}
    }
}

// ── 啟動 ────────────────────────────────────────────────
async function start() {
    let dbPath = path.resolve(CONFIG.dbPath);
    if (!fs.existsSync(dbPath)) {
        console.error('❌ 找不到資料庫檔案：' + dbPath);
        console.error('   設定來源：' + (DB_SOURCE_LABEL[CONFIG.dbSource] || CONFIG.dbSource));
        const fallback = path.resolve(DEFAULT_DB_PATH);
        if (process.env.WEB_DB_STRICT !== '1' && CONFIG.dbSource !== 'default' && fs.existsSync(fallback)) {
            console.warn('⚠️ 已自動改用預設資料庫：' + fallback);
            console.warn('   （若這是先前測試留下的設定，可清除環境變數：Remove-Item Env:WEB_DB）');
            console.warn('   （若要強制使用上方指定路徑，請設定 WEB_DB_STRICT=1）');
            CONFIG.dbPath = fallback;
            CONFIG.dbSource = 'default';
            dbPath = fallback;
        } else {
            console.error('   請確認檔案存在，或設定環境變數 WEB_DB 指向正確的 asset_data.db');
            console.error('   例：$env:WEB_DB = "D:\\IT資產管理系統資料\\asset_data.db"');
            console.error('   若這是先前的測試路徑，請清除：Remove-Item Env:WEB_DB');
            console.error('   預設資料庫位置：' + fallback + '（' + (fs.existsSync(fallback) ? '存在' : '不存在') + '）');
            process.exit(1);
        }
    }
    db = await dbLib.openDb(dbPath, { readOnly: false });
    ctx = dbLib.makeCtx(db);
    dbq = ctx;
    try { await ctx.exec('PRAGMA journal_mode = WAL'); } catch (e) {}
    await service.ensureSchema(ctx);
    const sessionCount = await auth.init(makeSessionStore(ctx));

    const server = http.createServer((req, res) => { requestHandler(req, res); });
    server.on('error', (err) => {
        console.error('❌ 伺服器啟動失敗：' + (err && err.message ? err.message : err));
        process.exit(1);
    });
    server.listen(CONFIG.port, CONFIG.host, () => {
        console.log('=========================================================');
        console.log('  ' + APP_NAME + ' — Web 版（完整功能）v' + APP_VERSION);
        console.log('  本機網址：http://localhost:' + CONFIG.port);
        console.log('  區網網址：http://<本機IP>:' + CONFIG.port);
        console.log('  資料庫  ：' + dbPath + '（' + (DB_SOURCE_LABEL[CONFIG.dbSource] || CONFIG.dbSource) + '）');
        console.log('  預設帳號：admin / 5508888（管理者）、User / 1234（一般使用者）');
        console.log('  登入狀態：已載入 ' + sessionCount + ' 筆有效 Session（重啟不掉登入）');
        console.log('=========================================================');
    });

    const shutdown = async () => {
        console.log('\n正在關閉 Web 服務...');
        try { server.close(); } catch (e) {}
        try { await dbLib.close(db); } catch (e) {}
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

process.on('uncaughtException', (err) => { console.error('[uncaught]', err && err.message ? err.message : err); });
process.on('unhandledRejection', (err) => { console.error('[unhandledRejection]', err && err.message ? err.message : err); });

start().catch((err) => {
    console.error('❌ 啟動失敗：' + (err && err.message ? err.message : err));
    process.exit(1);
});


