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

const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_NAME = 'IT 資產管理系統';
const APP_VERSION = (() => { try { return require('../package.json').version; } catch (e) { return '0.0.0'; } })();

// ── 設定 ───────────────────────────────────────────────
function loadConfig() {
    let fileCfg = {};
    try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')); } catch (e) {}
    const envPort = parseInt(process.env.WEB_PORT, 10);
    return {
        port: envPort || parseInt(fileCfg.port, 10) || 3010,
        host: process.env.WEB_HOST || fileCfg.host || '0.0.0.0',
        dbPath: process.env.WEB_DB || fileCfg.dbPath || path.join(__dirname, '..', 'uploads', 'asset_data.db'),
        readOnly: false
    };
}
const CONFIG = loadConfig();

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

const publicUser = (s) => ({ username: s.username, displayName: s.displayName, role: s.role });

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

// ── 權限 / 共用 ─────────────────────────────────────────
function isAdmin(session) { return !!(session && session.role === 'admin'); }
function denyReadOnly(res) { return sendJson(res, 403, { ok: false, message: '權限不足：此操作僅限管理者執行。' }); }
function ok(res, data) { return sendJson(res, 200, Object.assign({ ok: true }, data || {})); }
async function body(req, limit) {
    try { return await readJsonBody(req, limit || (4 * 1024 * 1024)); }
    catch (e) { throw new Error(e.message || '請求內容格式錯誤。'); }
}

// ── 寫入 API（一律需管理者）─────────────────────────────
async function handleWriteApi(req, res, session, p) {
    if (!isAdmin(session)) return denyReadOnly(res);
    const m = req.method;
    let mm;

    // 資產
    if (m === 'POST' && p === '/api/assets') return ok(res, await service.createAsset(ctx, await body(req), session));
    if (m === 'PUT' && (mm = /^\/api\/assets\/(\d+)$/.exec(p))) return ok(res, await service.updateAsset(ctx, mm[1], await body(req), session));
    if (m === 'DELETE' && (mm = /^\/api\/assets\/(\d+)$/.exec(p))) return ok(res, { asset: await service.deleteAsset(ctx, mm[1], session) });
    if (m === 'POST' && (mm = /^\/api\/assets\/(\d+)\/restore$/.exec(p))) return ok(res, { asset: await service.restoreAsset(ctx, mm[1], session) });

    // 維修
    if (m === 'POST' && p === '/api/repairs') return ok(res, await service.createRepair(ctx, await body(req), session));
    if (m === 'POST' && (mm = /^\/api\/repairs\/(\d+)\/complete$/.exec(p))) return ok(res, await service.completeRepair(ctx, mm[1], session));
    if (m === 'DELETE' && (mm = /^\/api\/repairs\/(\d+)$/.exec(p))) return ok(res, { repair: await service.deleteRepair(ctx, mm[1]) });

    // 轉移
    if (m === 'POST' && p === '/api/transfers') return ok(res, await service.createTransfer(ctx, await body(req), session));
    if (m === 'DELETE' && (mm = /^\/api\/transfers\/(\d+)$/.exec(p))) return ok(res, { transfer: await service.deleteTransfer(ctx, mm[1]) });

    // 廠商
    if (m === 'POST' && p === '/api/vendors') return ok(res, await service.saveVendor(ctx, await body(req), session));
    if (m === 'PUT' && (mm = /^\/api\/vendors\/(\d+)$/.exec(p))) {
        const d = await body(req); d.id = parseInt(mm[1], 10);
        return ok(res, await service.saveVendor(ctx, d, session));
    }
    if (m === 'DELETE' && (mm = /^\/api\/vendors\/(\d+)$/.exec(p))) return ok(res, { vendor: await service.deleteVendor(ctx, mm[1]) });

    // 廠商維護紀錄
    if (m === 'POST' && p === '/api/vendor-maint') return ok(res, await service.createVendorMaint(ctx, await body(req), session));
    if (m === 'DELETE' && (mm = /^\/api\/vendor-maint\/(\d+)$/.exec(p))) return ok(res, { record: await service.deleteVendorMaint(ctx, mm[1]) });

    // 欄位管理
    if (m === 'POST' && p === '/api/field-options') return ok(res, await service.addFieldOption(ctx, await body(req)));
    if (m === 'DELETE' && (mm = /^\/api\/field-options\/(\d+)$/.exec(p))) return ok(res, { option: await service.deleteFieldOption(ctx, mm[1]) });

    // 帳號管理
    if (m === 'POST' && p === '/api/users') return ok(res, await service.createUserAccount(ctx, await body(req)));
    if (m === 'PUT' && (mm = /^\/api\/users\/(\d+)$/.exec(p))) return ok(res, await service.updateUserAccount(ctx, mm[1], await body(req), { id: session.id }));
    if (m === 'POST' && (mm = /^\/api\/users\/(\d+)\/password$/.exec(p))) {
        const d = await body(req);
        return ok(res, await service.resetUserPassword(ctx, mm[1], d.newPassword));
    }
    if (m === 'DELETE' && (mm = /^\/api\/users\/(\d+)$/.exec(p))) return ok(res, await service.deleteUserAccount(ctx, mm[1], { id: session.id }));

    // 匯入資產（Excel，base64）
    if (m === 'POST' && p === '/api/import/assets') {
        const d = await body(req, 24 * 1024 * 1024);
        const b64 = String(d.dataBase64 || '');
        if (!b64) throw new Error('沒有收到檔案內容。');
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) throw new Error('檔案內容為空。');
        const result = await service.importAssetsFromXlsx(ctx, buf, d.fileName || 'import.xlsx', session);
        console.log(`[import] assets by ${session.username}: +${result.inserted}, skipped ${result.skipped}, errors ${result.errors.length}`);
        return ok(res, result);
    }

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
                if (p === '/api/recycle') { if (!isAdmin(session)) return denyReadOnly(res); const list = await service.listRecycle(ctx); return ok(res, { count: list.length, assets: list }); }
                if (p === '/api/stats') return ok(res, await service.getStats(ctx));
                if (p === '/api/field-options') return ok(res, await service.listFieldOptions(ctx));
                if (p === '/api/repairs') return ok(res, { repairs: await service.listRepairs(ctx) });
                if (p === '/api/transfers') return ok(res, { transfers: await service.listTransfers(ctx) });
                if (p === '/api/vendors') return ok(res, { vendors: await service.listVendors(ctx) });
                if (p === '/api/vendor-maint') return ok(res, { records: await service.listVendorMaint(ctx) });
                if (p === '/api/users') { if (!isAdmin(session)) return denyReadOnly(res); return ok(res, { users: await service.listUsers(ctx) }); }
                if (p === '/api/export/inventory.xlsx') return await handleExportInventory(res, session);
                if (p === '/api/backup/db') return await handleBackupDownload(res, session);
                const mDetail = /^\/api\/assets\/(\d+)$/.exec(p);
                if (mDetail) return ok(res, await service.getAssetDetail(ctx, mDetail[1]));
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
        console.error('[error] ' + p + ' -> ' + msg);
        if (!res.headersSent) return sendJson(res, 500, { ok: false, message: msg });
        try { res.end(); } catch (e) {}
    }
}

// ── 啟動 ────────────────────────────────────────────────
async function start() {
    const dbPath = path.resolve(CONFIG.dbPath);
    if (!fs.existsSync(dbPath)) {
        console.error('❌ 找不到資料庫檔案：' + dbPath);
        console.error('   請先以單機版建立資料，或設定環境變數 WEB_DB 指向 asset_data.db');
        process.exit(1);
    }
    db = await dbLib.openDb(dbPath, { readOnly: false });
    ctx = dbLib.makeCtx(db);
    dbq = ctx;
    try { await ctx.exec('PRAGMA journal_mode = WAL'); } catch (e) {}
    await service.ensureSchema(ctx);

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
        console.log('  資料庫  ：' + dbPath + '（讀寫模式 WAL）');
        console.log('  預設帳號：admin / 5508888（管理者）、User / 1234（一般使用者）');
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


