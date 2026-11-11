// =====================================================================
// Web 版商業邏輯（與單機版規則一致）
//   · 資料表建立 / 升級（既有 DB 直接沿用，不影響資料）
//   · 資產編號：類別-部門-YYYYMMDD-流水號，於交易內取 max+1（避免併發撞號）
//   · 維修會將資產改為「維修中」；完工回復「使用中」
//   · 轉移若跨部門會自動重新編號，並同步關聯表的資產編號
// =====================================================================
const crypto = require('crypto');
const filesLib = require('./files');

const CAT_PREFIX_FALLBACK = { hardware: 'HW', software: 'SW', network: 'NET', peripheral: 'DEV', credentials: 'SEC' };
const DEFAULT_CATEGORIES = [
    { value: 'hardware', label: '硬體設備', code: 'HW' },
    { value: 'software', label: '軟體授權', code: 'SW' },
    { value: 'network', label: '網路設備', code: 'NET' },
    { value: 'peripheral', label: '資訊周邊', code: 'DEV' },
    { value: 'credentials', label: '帳密安全性', code: 'SEC' }
];
const DEFAULT_DEPARTMENTS = [
    ['IT', '資訊部門'], ['DR', '院長室,醫師辦公室'], ['TL', '督導'], ['GA', '總務'], ['MO', '行政'], ['PT', '主任'],
    ['AC', '人事,會計'], ['CK', '廚房'], ['SM', '倉庫'], ['WO', '工務'], ['LA', '檢驗室'], ['OP', '婦科'],
    ['IN', '兒科'], ['PO', '警衛'], ['OR', '產房'], ['WA', '病房'], ['HE', '申報'], ['BR', '嬰兒室'],
    ['CH', '病歷室'], ['CO', '櫃台'], ['P1', '藥局']
];
const STATUS_VALUES = ['active', 'inventory', 'repair', 'scrapped'];
const ROLE_VALUES = ['admin', 'user'];

const hashPassword = (password, salt) => crypto.scryptSync(String(password), String(salt), 64).toString('hex');

async function ensureSchema(ctx) {
    await ctx.exec(`CREATE TABLE IF NOT EXISTS assets_new (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_no TEXT UNIQUE, name TEXT, category TEXT, sn TEXT, custodian TEXT, location TEXT, vendor_id INTEGER DEFAULT 0, status TEXT, purchase_date TEXT, warranty_date TEXT, scrap_reason TEXT, spec_note TEXT, notes TEXT, department TEXT DEFAULT 'IT', is_deleted INTEGER DEFAULT 0)`);
    await ctx.exec(`CREATE TABLE IF NOT EXISTS vendors_new (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, representative TEXT, phone TEXT, address TEXT, has_nda INTEGER DEFAULT 0, service_items TEXT, nda_files TEXT, contract_files TEXT, maint_start TEXT, maint_end TEXT)`);
    await ctx.exec(`CREATE TABLE IF NOT EXISTS repairs_new (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER DEFAULT 0, asset_no TEXT, asset_name TEXT, fault_description TEXT, repair_vendor TEXT, reported_date TEXT, completed_date TEXT, cost REAL DEFAULT 0, status TEXT DEFAULT 'pending', notes TEXT, created_at TEXT)`);
    await ctx.exec(`CREATE TABLE IF NOT EXISTS asset_history_new (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER DEFAULT 0, asset_no TEXT, event_type TEXT, event_title TEXT, event_detail TEXT, created_at TEXT)`);
    await ctx.exec(`CREATE TABLE IF NOT EXISTS transfers_new (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER DEFAULT 0, asset_no TEXT, asset_name TEXT, from_custodian TEXT, to_custodian TEXT, from_location TEXT, to_location TEXT, from_department TEXT, to_department TEXT, from_asset_no TEXT, to_asset_no TEXT, transfer_date TEXT, reason TEXT, notes TEXT, created_at TEXT)`);
    await ctx.exec(`CREATE TABLE IF NOT EXISTS vendor_maint_records (id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id INTEGER DEFAULT 0, vendor_name TEXT, maint_date TEXT, equipment TEXT, equipment_sn TEXT, maint_type TEXT, handler TEXT, cost REAL DEFAULT 0, signed INTEGER DEFAULT 0, content TEXT, notes TEXT, doc_files TEXT, created_at TEXT)`);
    await ctx.exec(`CREATE TABLE IF NOT EXISTS field_options (id INTEGER PRIMARY KEY AUTOINCREMENT, field_type TEXT, value TEXT, label TEXT, code TEXT, sort_order INTEGER DEFAULT 0, builtin INTEGER DEFAULT 0)`);
    await ctx.exec(`CREATE TABLE IF NOT EXISTS app_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT, password_hash TEXT, password_salt TEXT, role TEXT DEFAULT 'user', is_active INTEGER DEFAULT 1, created_at TEXT, last_login TEXT)`);
    // 🔐 Session 持久化（重啟不掉登入）
    await ctx.exec(`CREATE TABLE IF NOT EXISTS web_sessions (sid TEXT PRIMARY KEY, user_id INTEGER, username TEXT, display_name TEXT, role TEXT, created_at INTEGER, expires INTEGER)`);
    // ✏️ 編輯鎖定（避免兩人同時編輯同一筆）
    await ctx.exec(`CREATE TABLE IF NOT EXISTS edit_locks (entity TEXT, entity_id INTEGER, username TEXT, sid TEXT, acquired INTEGER, expires INTEGER, PRIMARY KEY (entity, entity_id))`);

    // 🧩 舊版資料庫相容升級
    const aCols = (await ctx.all(`SELECT name FROM pragma_table_info('assets_new')`)).map(c => c.name);
    if (aCols.indexOf('department') < 0) await ctx.exec(`ALTER TABLE assets_new ADD COLUMN department TEXT DEFAULT 'IT'`);
    if (aCols.indexOf('spec_note') < 0) await ctx.exec(`ALTER TABLE assets_new ADD COLUMN spec_note TEXT`);
    const tCols = (await ctx.all(`SELECT name FROM pragma_table_info('transfers_new')`)).map(c => c.name);
    if (tCols.indexOf('from_department') < 0) await ctx.exec(`ALTER TABLE transfers_new ADD COLUMN from_department TEXT`);
    if (tCols.indexOf('to_department') < 0) await ctx.exec(`ALTER TABLE transfers_new ADD COLUMN to_department TEXT`);
    if (tCols.indexOf('from_asset_no') < 0) await ctx.exec(`ALTER TABLE transfers_new ADD COLUMN from_asset_no TEXT`);
    if (tCols.indexOf('to_asset_no') < 0) await ctx.exec(`ALTER TABLE transfers_new ADD COLUMN to_asset_no TEXT`);
    const vCols = (await ctx.all(`SELECT name FROM pragma_table_info('vendors_new')`)).map(c => c.name);
    if (vCols.indexOf('maint_start') < 0) await ctx.exec(`ALTER TABLE vendors_new ADD COLUMN maint_start TEXT`);
    if (vCols.indexOf('maint_end') < 0) await ctx.exec(`ALTER TABLE vendors_new ADD COLUMN maint_end TEXT`);
    // ✏️ 併發編輯偵測用
    if (aCols.indexOf('updated_at') < 0) await ctx.exec(`ALTER TABLE assets_new ADD COLUMN updated_at TEXT`);
    if (vCols.indexOf('updated_at') < 0) await ctx.exec(`ALTER TABLE vendors_new ADD COLUMN updated_at TEXT`);

    // 預設選項（僅在空表時寫入）
    const catCount = await ctx.get(`SELECT COUNT(*) AS c FROM field_options WHERE field_type='category'`);
    if (!catCount || !catCount.c) {
        let i = 0;
        for (const o of DEFAULT_CATEGORIES) {
            i++;
            await ctx.run(`INSERT INTO field_options (field_type, value, label, code, sort_order, builtin) VALUES ('category', ?, ?, ?, ?, 1)`, [o.value, o.label, o.code, i]);
        }
    }
    const depCount = await ctx.get(`SELECT COUNT(*) AS c FROM field_options WHERE field_type='department'`);
    if (!depCount || !depCount.c) {
        let i = 0;
        for (const p of DEFAULT_DEPARTMENTS) {
            i++;
            await ctx.run(`INSERT INTO field_options (field_type, value, label, code, sort_order, builtin) VALUES ('department', ?, ?, ?, ?, 1)`, [p[0], p[1], p[0], i]);
        }
    }
    // 預設帳號（僅在空表時寫入）
    const userCount = await ctx.get(`SELECT COUNT(*) AS c FROM app_users`);
    if (!userCount || !userCount.c) {
        await createUserRecord(ctx, { username: 'admin', displayName: '系統管理員', password: '5508888', role: 'admin' });
        await createUserRecord(ctx, { username: 'User', displayName: '一般使用者', password: '1234', role: 'user' });
    }
}

// ── 共用小工具 ─────────────────────────────────────────
const errMsg = (e) => String(e && e.message ? e.message : e);
const nowISO = () => new Date().toISOString();
const todayStamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };
const str = (v) => String(v == null ? '' : v).trim();

async function logAssetHistory(q, assetId, assetNo, type, title, detail) {
    try {
        await q.run(`INSERT INTO asset_history_new (asset_id, asset_no, event_type, event_title, event_detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [parseInt(assetId) || 0, assetNo || '', type, title, detail || '', nowISO()]);
    } catch (e) {}
}

async function catCodeOf(q, category) {
    const rows = await q.all(`SELECT code FROM field_options WHERE field_type='category' AND value = ? LIMIT 1`, [category]);
    if (rows[0] && rows[0].code) return String(rows[0].code).toUpperCase();
    return CAT_PREFIX_FALLBACK[category] || 'AST';
}

// 取得下一個資產編號（必須在 tx 內呼叫）
async function nextAssetNo(q, category, department) {
    const pfx = await catCodeOf(q, category);
    const dept = String(department || 'IT').toUpperCase();
    const row = await q.get(`SELECT MAX(CAST(substr(asset_no, -4) AS INTEGER)) AS mx FROM assets_new WHERE asset_no LIKE ?`, [pfx + '-' + dept + '-%']);
    const seq = (parseInt(row && row.mx, 10) || 0) + 1;
    let no = `${pfx}-${dept}-${todayStamp()}-${String(seq).padStart(4, '0')}`;
    for (let i = 0; i < 10000; i++) {
        const exists = await q.get(`SELECT 1 AS x FROM assets_new WHERE asset_no = ?`, [no]);
        if (!exists) return no;
        const n = seq + i + 1;
        no = `${pfx}-${dept}-${todayStamp()}-${String(n).padStart(4, '0')}`;
    }
    throw new Error('無法產生可用的資產編號（流水號已滿）。');
}

// ── 欄位管理 ──────────────────────────────────────────
async function listFieldOptions(ctx) {
    const categories = await ctx.all(`SELECT id, value, label, code, sort_order, builtin FROM field_options WHERE field_type='category' ORDER BY sort_order ASC, id ASC`);
    const departments = await ctx.all(`SELECT id, value, label, code, sort_order, builtin FROM field_options WHERE field_type='department' ORDER BY sort_order ASC, id ASC`);
    return { categories: categories, departments: departments };
}

async function addFieldOption(ctx, data) {
    const type = (data && data.type === 'department') ? 'department' : 'category';
    const label = str(data && data.label);
    const code = str(data && data.code).toUpperCase();
    if (!label || !code) throw new Error('名稱與代號皆為必填。');
    if (!/^[A-Z0-9]{1,8}$/.test(code)) throw new Error('代號請使用 1~8 位英文或數字（例：OT、MON、HW）。');
    return ctx.tx(async (t) => {
        const dup = await t.get(`SELECT id FROM field_options WHERE field_type = ? AND code = ?`, [type, code]);
        if (dup) throw new Error('代號「' + code + '」已存在，請改用其他代號。');
        const mx = await t.get(`SELECT COALESCE(MAX(sort_order),0) AS m FROM field_options WHERE field_type = ?`, [type]);
        const next = (parseInt(mx && mx.m, 10) || 0) + 1;
        await t.run(`INSERT INTO field_options (field_type, value, label, code, sort_order, builtin) VALUES (?, ?, ?, ?, ?, 0)`, [type, code, label, code, next]);
        return { type: type, label: label, code: code };
    });
}

async function deleteFieldOption(ctx, id) {
    const target = await ctx.get(`SELECT * FROM field_options WHERE id = ?`, [parseInt(id) || 0]);
    if (!target) throw new Error('找不到該選項。');
    await ctx.run(`DELETE FROM field_options WHERE id = ?`, [target.id]);
    return target;
}

// ── 資產 ──────────────────────────────────────────────
const ASSET_SELECT = `SELECT a.*, COALESCE(v.name, '') AS vendor_name FROM assets_new a LEFT JOIN vendors_new v ON a.vendor_id = v.id`;

const listAssets = (ctx) => ctx.all(`${ASSET_SELECT} WHERE a.is_deleted = 0 ORDER BY COALESCE(NULLIF(a.department, ''), 'IT') ASC, a.asset_no ASC`);
const listRecycle = (ctx) => ctx.all(`${ASSET_SELECT} WHERE a.is_deleted = 1 ORDER BY a.id DESC`);

function normalizeStatus(v, fallback) {
    return STATUS_VALUES.indexOf(v) >= 0 ? v : fallback;
}

async function createAsset(ctx, data, user) {
    const name = str(data && data.name);
    const category = str(data && data.category);
    const department = str((data && data.department) || 'IT').toUpperCase();
    if (!name) throw new Error('「設備 / 項目名稱」為必填。');
    if (!category) throw new Error('請選擇「資產大類」。');
    const status = normalizeStatus(str(data && data.status), 'active');
    const scrapReason = str(data && data.scrap_reason);
    if (status === 'scrapped' && !scrapReason) throw new Error('報廢資產必須填寫報廢原因。');
    const vendorId = parseInt(data && data.vendor_id, 10) || 0;

    return ctx.tx(async (t) => {
        const assetNo = await nextAssetNo(t, category, department);
        await t.run(`INSERT INTO assets_new (asset_no, name, category, sn, custodian, location, vendor_id, status, purchase_date, warranty_date, scrap_reason, spec_note, notes, department, is_deleted, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            [assetNo, name, category, str(data.sn), str(data.custodian), str(data.location), vendorId, status,
                str(data.purchase_date), str(data.warranty_date), scrapReason, str(data.spec_note), str(data.notes), department, nowISO()]);
        const row = await t.get(`SELECT id FROM assets_new WHERE asset_no = ?`, [assetNo]);
        await logAssetHistory(t, row.id, assetNo, 'create', '資產建立登記',
            '設備名稱:' + name + ' ｜ 大類:' + category + ' ｜ 部門:' + department + ' ｜ 建立者:' + user.username);
        if (status === 'scrapped') {
            await logAssetHistory(t, row.id, assetNo, 'scrap', '資產報廢註銷', '報廢原因:' + scrapReason);
        }
        return { id: row.id, asset_no: assetNo };
    });
}

async function updateAsset(ctx, id, data, user) {
    const target = await ctx.get(`SELECT * FROM assets_new WHERE id = ?`, [parseInt(id) || 0]);
    if (!target) throw new Error('找不到該資產。');
    const name = str(data && data.name) || target.name;
    const status = normalizeStatus(str(data && data.status), target.status);
    const scrapReason = str(data && data.scrap_reason);
    if (status === 'scrapped' && !scrapReason) throw new Error('報廢資產必須填寫報廢原因。');
    const vendorId = (data && data.vendor_id !== undefined) ? (parseInt(data.vendor_id, 10) || 0) : target.vendor_id;

    // ✏️ 編輯鎖 + 併發偵測（避免兩人同時編輯）
    await assertLockOwned(ctx, 'asset', target.id, user);
    if (data && data.expectedUpdatedAt !== undefined && String(target.updated_at || '') !== String(data.expectedUpdatedAt || '')) {
        const err = new Error('此資產已被其他人修改，請關閉後重新整理再編輯。');
        err.status = 409;
        throw err;
    }

    await ctx.tx(async (t) => {
        await t.run(`UPDATE assets_new SET name = ?, sn = ?, vendor_id = ?, status = ?, purchase_date = ?, warranty_date = ?, scrap_reason = ?, spec_note = ?, notes = ?, updated_at = ? WHERE id = ?`,
            [name, str(data.sn), vendorId, status, str(data.purchase_date), str(data.warranty_date), scrapReason, str(data.spec_note), str(data.notes), nowISO(), target.id]);
        await logAssetHistory(t, target.id, target.asset_no, 'edit', '資產資料編輯修改',
            '設備名稱:' + name + ' ｜ 狀態:' + status + ' ｜ 修改者:' + user.username);
        if (status === 'scrapped') {
            await logAssetHistory(t, target.id, target.asset_no, 'scrap', '資產報廢註銷', '報廢原因:' + scrapReason);
            const today = new Date().toISOString().slice(0, 10);
            await t.run(`UPDATE repairs_new SET status = 'scrapped', completed_date = ? WHERE asset_id = ? AND status = 'pending'`, [today, target.id]);
        }
    });
    try { await releaseLock(ctx, 'asset', target.id, user); } catch (e) {}
    return { id: target.id, asset_no: target.asset_no };
}

async function deleteAsset(ctx, id, user) {
    const target = await ctx.get(`SELECT * FROM assets_new WHERE id = ?`, [parseInt(id) || 0]);
    if (!target) throw new Error('找不到該資產。');
    await ctx.tx(async (t) => {
        await t.run(`UPDATE assets_new SET is_deleted = 1 WHERE id = ?`, [target.id]);
        await logAssetHistory(t, target.id, target.asset_no, 'recycle', '移至資源回收桶', '設備名稱:' + target.name + ' ｜ 操作者:' + user.username);
    });
    return target;
}

async function restoreAsset(ctx, id, user) {
    const target = await ctx.get(`SELECT * FROM assets_new WHERE id = ?`, [parseInt(id) || 0]);
    if (!target) throw new Error('找不到該資產。');
    await ctx.tx(async (t) => {
        await t.run(`UPDATE assets_new SET is_deleted = 0 WHERE id = ?`, [target.id]);
        await logAssetHistory(t, target.id, target.asset_no, 'restore', '從回收桶還原', '設備名稱:' + target.name + ' ｜ 操作者:' + user.username);
    });
    return target;
}

async function getAssetDetail(ctx, id) {
    const rows = await ctx.all(`${ASSET_SELECT} WHERE a.id = ?`, [parseInt(id) || 0]);
    const asset = rows[0] || null;
    if (!asset) throw new Error('找不到該資產。');
    const repairs = await ctx.all(`SELECT * FROM repairs_new WHERE asset_id = ? ORDER BY id DESC`, [asset.id]);
    const transfers = await ctx.all(`SELECT * FROM transfers_new WHERE asset_id = ? ORDER BY id DESC`, [asset.id]);
    const history = await ctx.all(`SELECT * FROM asset_history_new WHERE asset_id = ? ORDER BY id DESC LIMIT 50`, [asset.id]);
    return { asset: asset, repairs: repairs, transfers: transfers, history: history };
}

// ── 維修 ──────────────────────────────────────────────
const listRepairs = (ctx) => ctx.all(`SELECT * FROM repairs_new ORDER BY id DESC`);

async function createRepair(ctx, data, user) {
    const assetId = parseInt(data && data.asset_id, 10) || 0;
    const fault = str(data && data.fault_description);
    if (!assetId) throw new Error('請選擇要維修的資產。');
    if (!fault) throw new Error('請填寫「故障情形描述」。');
    const asset = await ctx.get(`SELECT * FROM assets_new WHERE id = ? AND is_deleted = 0`, [assetId]);
    if (!asset) throw new Error('找不到該資產。');
    const reported = str(data.reported_date) || new Date().toISOString().slice(0, 10);
    const cost = parseFloat(data && data.cost) || 0;

    return ctx.tx(async (t) => {
        await t.run(`INSERT INTO repairs_new (asset_id, asset_no, asset_name, fault_description, repair_vendor, reported_date, completed_date, cost, status, notes, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, '', ?, 'pending', ?, ?)`,
            [asset.id, asset.asset_no, asset.name, fault, str(data.repair_vendor), reported, cost, str(data.notes), nowISO()]);
        await t.run(`UPDATE assets_new SET status = 'repair' WHERE id = ?`, [asset.id]);
        await logAssetHistory(t, asset.id, asset.asset_no, 'repair', '登記資產維修',
            '故障:' + fault + (str(data.repair_vendor) ? ' ｜ 廠商:' + str(data.repair_vendor) : '') + ' ｜ 操作者:' + user.username);
        const row = await t.get(`SELECT id FROM repairs_new WHERE asset_id = ? ORDER BY id DESC LIMIT 1`, [asset.id]);
        return { id: row ? row.id : 0, asset_no: asset.asset_no };
    });
}

async function completeRepair(ctx, id, user) {
    const repair = await ctx.get(`SELECT * FROM repairs_new WHERE id = ?`, [parseInt(id) || 0]);
    if (!repair) throw new Error('找不到該維修紀錄。');
    const today = new Date().toISOString().slice(0, 10);
    await ctx.tx(async (t) => {
        await t.run(`UPDATE repairs_new SET status = 'completed', completed_date = ? WHERE id = ?`, [today, repair.id]);
        if (repair.asset_id) {
            await t.run(`UPDATE assets_new SET status = 'active' WHERE id = ?`, [repair.asset_id]);
            await logAssetHistory(t, repair.asset_id, repair.asset_no, 'complete', '維修完工結案',
                '完工日期:' + today + ' ｜ 資產已復原為使用中 ｜ 操作者:' + user.username);
        }
    });
    return { id: repair.id, completed_date: today };
}

async function deleteRepair(ctx, id) {
    const repair = await ctx.get(`SELECT * FROM repairs_new WHERE id = ?`, [parseInt(id) || 0]);
    if (!repair) throw new Error('找不到該維修紀錄。');
    await ctx.run(`DELETE FROM repairs_new WHERE id = ?`, [repair.id]);
    return repair;
}

// ── 轉移 ──────────────────────────────────────────────
const listTransfers = (ctx) => ctx.all(`SELECT * FROM transfers_new ORDER BY id DESC`);

async function createTransfer(ctx, data, user) {
    const assetId = parseInt(data && data.asset_id, 10) || 0;
    if (!assetId) throw new Error('請選擇要轉移的資產。');
    const toCustodian = str(data && data.to_custodian);
    const toLocation = str(data && data.to_location);
    const toDept = str(data && data.to_department).toUpperCase();
    if (!toCustodian) throw new Error('請填寫「新保管窗口」。');
    if (!toLocation) throw new Error('請填寫「新擺放地點」。');
    if (!toDept) throw new Error('請選擇「轉移後部門」。');

    return ctx.tx(async (t) => {
        const asset = await t.get(`SELECT * FROM assets_new WHERE id = ? AND is_deleted = 0`, [assetId]);
        if (!asset) throw new Error('找不到該資產。');
        const fromDept = String(asset.department || 'IT').toUpperCase();
        const fromAssetNo = asset.asset_no;
        let newAssetNo = fromAssetNo;
        if (toDept !== fromDept) {
            newAssetNo = await nextAssetNo(t, asset.category, toDept);
        }
        const transferDate = str(data.transfer_date) || new Date().toISOString().slice(0, 10);

        await t.run(`INSERT INTO transfers_new (asset_id, asset_no, asset_name, from_custodian, to_custodian, from_location, to_location, from_department, to_department, from_asset_no, to_asset_no, transfer_date, reason, notes, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [assetId, newAssetNo, asset.name, asset.custodian || '', toCustodian, asset.location || '', toLocation,
                fromDept, toDept, fromAssetNo, newAssetNo, transferDate, str(data.reason), str(data.notes), nowISO()]);

        await t.run(`UPDATE assets_new SET custodian = ?, location = ?, department = ?, asset_no = ? WHERE id = ?`,
            [toCustodian, toLocation, toDept, newAssetNo, assetId]);

        if (newAssetNo !== fromAssetNo) {
            await t.run(`UPDATE repairs_new SET asset_no = ? WHERE asset_id = ?`, [newAssetNo, assetId]);
            await t.run(`UPDATE asset_history_new SET asset_no = ? WHERE asset_id = ?`, [newAssetNo, assetId]);
            await t.run(`UPDATE transfers_new SET asset_no = ? WHERE asset_id = ?`, [newAssetNo, assetId]);
        }
        await logAssetHistory(t, assetId, newAssetNo, 'transfer', '資產轉移',
            fromDept + '→' + toDept + ' ｜ 保管人:' + (asset.custodian || '—') + '→' + toCustodian
            + ' ｜ 位置:' + (asset.location || '—') + '→' + toLocation
            + (newAssetNo !== fromAssetNo ? ' ｜ 編號:' + fromAssetNo + '→' + newAssetNo : ' ｜ 編號不變')
            + ' ｜ 操作者:' + user.username);
        return { asset_no: newAssetNo, renumbered: newAssetNo !== fromAssetNo, from_asset_no: fromAssetNo };
    });
}

async function deleteTransfer(ctx, id) {
    const row = await ctx.get(`SELECT * FROM transfers_new WHERE id = ?`, [parseInt(id) || 0]);
    if (!row) throw new Error('找不到該轉移紀錄。');
    await ctx.run(`DELETE FROM transfers_new WHERE id = ?`, [row.id]);
    return row;
}

// ── 廠商 ──────────────────────────────────────────────
const listVendors = (ctx) => ctx.all(`SELECT * FROM vendors_new ORDER BY id DESC`);

async function saveVendor(ctx, data, user) {
    const name = str(data && data.name);
    if (!name) throw new Error('「廠商公司名稱」為必填。');
    return ctx.tx(async (t) => {
        let id = parseInt(data && data.id, 10) || 0;
        if (!id) {
            const ex = await t.get(`SELECT id FROM vendors_new WHERE name = ?`, [name]);
            if (ex) id = ex.id;
        }
        const args = [str(data.representative), str(data.phone), str(data.address), (data.has_nda ? 1 : 0), str(data.service_items), str(data.maint_start), str(data.maint_end)];
        if (id) {
            if (user && user.sid) await assertLockOwned(ctx, 'vendor', id, user);
            await t.run(`UPDATE vendors_new SET representative = ?, phone = ?, address = ?, has_nda = ?, service_items = ?, maint_start = ?, maint_end = ?, updated_at = ? WHERE id = ?`, args.concat([nowISO(), id]));
            const cur = await t.get(`SELECT name FROM vendors_new WHERE id = ?`, [id]);
            if (cur && cur.name !== name) {
                const dup = await t.get(`SELECT id FROM vendors_new WHERE name = ? AND id != ?`, [name, id]);
                if (dup) throw new Error('廠商名稱「' + name + '」已存在。');
                await t.run(`UPDATE vendors_new SET name = ? WHERE id = ?`, [name, id]);
            }
            if (user && user.sid) { try { await releaseLock(ctx, 'vendor', id, user); } catch (e) {} }
            return { id: id, created: false };
        }
        await t.run(`INSERT INTO vendors_new (name, representative, phone, address, has_nda, service_items, maint_start, maint_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [name].concat(args).concat([nowISO()]));
        const row = await t.get(`SELECT id FROM vendors_new WHERE name = ?`, [name]);
        return { id: row.id, created: true };
    });
}

async function deleteVendor(ctx, id) {
    const vendor = await ctx.get(`SELECT * FROM vendors_new WHERE id = ?`, [parseInt(id) || 0]);
    if (!vendor) throw new Error('找不到該廠商。');
    await ctx.tx(async (t) => {
        await t.run(`DELETE FROM vendors_new WHERE id = ?`, [vendor.id]);
        await t.run(`UPDATE assets_new SET vendor_id = 0 WHERE vendor_id = ?`, [vendor.id]);
        await t.run(`DELETE FROM vendor_maint_records WHERE vendor_id = ? OR vendor_name = ?`, [vendor.id, vendor.name]);
    });
    return vendor;
}

// ── 廠商維護紀錄 ──────────────────────────────────────
const listVendorMaint = (ctx) => ctx.all(`SELECT * FROM vendor_maint_records ORDER BY maint_date DESC, id DESC`);

async function createVendorMaint(ctx, data, user) {
    const vendorName = str(data && data.vendor_name);
    const maintDate = str(data && data.maint_date);
    const equipment = str(data && data.equipment);
    if (!vendorName || !maintDate || !equipment) throw new Error('請填寫「維護廠商」「維護日期」「維護設備 / 項目」。');
    return ctx.tx(async (t) => {
        let vendorId = parseInt(data && data.vendor_id, 10) || 0;
        if (!vendorId) {
            const v = await t.get(`SELECT id FROM vendors_new WHERE name = ?`, [vendorName]);
            if (v) vendorId = v.id;
        }
        await t.run(`INSERT INTO vendor_maint_records (vendor_id, vendor_name, maint_date, equipment, equipment_sn, maint_type, handler, cost, signed, content, notes, doc_files, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
            [vendorId, vendorName, maintDate, equipment, str(data.equipment_sn), str(data.maint_type), str(data.handler),
                parseFloat(data.cost) || 0, parseInt(data.signed, 10) || 0, str(data.content), str(data.notes), nowISO()]);
        const row = await t.get(`SELECT id FROM vendor_maint_records ORDER BY id DESC LIMIT 1`);
        return { id: row ? row.id : 0 };
    });
}

async function deleteVendorMaint(ctx, id) {
    const row = await ctx.get(`SELECT * FROM vendor_maint_records WHERE id = ?`, [parseInt(id) || 0]);
    if (!row) throw new Error('找不到該維護紀錄。');
    await ctx.run(`DELETE FROM vendor_maint_records WHERE id = ?`, [row.id]);
    return row;
}

// ── 帳號 ──────────────────────────────────────────────
const listUsers = (ctx) => ctx.all(`SELECT id, username, display_name, role, is_active, created_at, last_login FROM app_users ORDER BY (role = 'admin') DESC, id ASC`);

function verifyPasswordRaw(password, salt, storedHash) {
    try {
        const calc = Buffer.from(hashPassword(password, salt), 'hex');
        const stored = Buffer.from(String(storedHash || ''), 'hex');
        return calc.length === stored.length && crypto.timingSafeEqual(calc, stored);
    } catch (e) { return false; }
}

async function createUserRecord(q, u) {
    const salt = crypto.randomBytes(16).toString('hex');
    await q.run(`INSERT INTO app_users (username, display_name, password_hash, password_salt, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [u.username, u.displayName || u.username, hashPassword(u.password, salt), salt,
            (u.role === 'admin') ? 'admin' : 'user', (u.isActive === false) ? 0 : 1, nowISO()]);
}

async function createUserAccount(ctx, data) {
    const username = str(data && data.username);
    const password = String((data && data.password) || '');
    const role = (data && data.role === 'admin') ? 'admin' : 'user';
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) throw new Error('帳號請使用 3~32 位英文、數字或 . _ -。');
    if (password.length < 4) throw new Error('密碼長度至少 4 碼。');
    const dup = await ctx.get(`SELECT id FROM app_users WHERE username = ? COLLATE NOCASE`, [username]);
    if (dup) throw new Error('帳號「' + username + '」已存在。');
    await createUserRecord(ctx, { username: username, displayName: str(data.displayName) || username, password: password, role: role, isActive: !(data && data.isActive === false) });
    return { username: username, role: role };
}

async function updateUserAccount(ctx, id, data, actor) {
    const target = await ctx.get(`SELECT * FROM app_users WHERE id = ?`, [parseInt(id) || 0]);
    if (!target) throw new Error('找不到該帳號。');
    const displayName = str(data && data.displayName) || target.display_name || target.username;
    const role = (data && data.role === 'admin') ? 'admin' : ((data && data.role === 'user') ? 'user' : target.role);
    const isActive = (data && data.isActive !== undefined) ? !!data.isActive : !!target.is_active;
    if (actor && actor.id === target.id && (role !== 'admin' || !isActive)) throw new Error('不可停用或降級「目前登入中」的帳號。');
    if (target.role === 'admin' && target.is_active && (role !== 'admin' || !isActive)) {
        const others = await ctx.get(`SELECT COUNT(*) AS c FROM app_users WHERE role = 'admin' AND is_active = 1 AND id != ?`, [target.id]);
        if (!others || !others.c) throw new Error('系統至少要保留一個啟用中的管理者帳號。');
    }
    await ctx.run(`UPDATE app_users SET display_name = ?, role = ?, is_active = ? WHERE id = ?`, [displayName, role, isActive ? 1 : 0, target.id]);
    return { id: target.id, username: target.username };
}

async function resetUserPassword(ctx, id, newPassword) {
    const target = await ctx.get(`SELECT * FROM app_users WHERE id = ?`, [parseInt(id) || 0]);
    if (!target) throw new Error('找不到該帳號。');
    const pw = String(newPassword || '');
    if (pw.length < 4) throw new Error('密碼長度至少 4 碼。');
    const salt = crypto.randomBytes(16).toString('hex');
    await ctx.run(`UPDATE app_users SET password_hash = ?, password_salt = ? WHERE id = ?`, [hashPassword(pw, salt), salt, target.id]);
    return { username: target.username };
}

async function changeOwnPassword(ctx, actorId, currentPassword, newPassword) {
    const target = await ctx.get(`SELECT * FROM app_users WHERE id = ?`, [parseInt(actorId) || 0]);
    if (!target) throw new Error('找不到帳號。');
    if (!verifyPasswordRaw(currentPassword, target.password_salt, target.password_hash)) throw new Error('目前密碼不正確。');
    const pw = String(newPassword || '');
    if (pw.length < 4) throw new Error('新密碼長度至少 4 碼。');
    const salt = crypto.randomBytes(16).toString('hex');
    await ctx.run(`UPDATE app_users SET password_hash = ?, password_salt = ? WHERE id = ?`, [hashPassword(pw, salt), salt, target.id]);
    return { username: target.username };
}

async function deleteUserAccount(ctx, id, actor) {
    const target = await ctx.get(`SELECT * FROM app_users WHERE id = ?`, [parseInt(id) || 0]);
    if (!target) throw new Error('找不到該帳號。');
    if (actor && actor.id === target.id) throw new Error('不可刪除「目前登入中」的帳號。');
    if (target.role === 'admin') {
        const others = await ctx.get(`SELECT COUNT(*) AS c FROM app_users WHERE role = 'admin' AND is_active = 1 AND id != ?`, [target.id]);
        if (!others || !others.c) throw new Error('系統至少要保留一個啟用中的管理者帳號。');
    }
    await ctx.run(`DELETE FROM app_users WHERE id = ?`, [target.id]);
    return { username: target.username };
}

// ── 儀表板統計 ────────────────────────────────────────
async function getStats(ctx) {
    const total = await ctx.get(`SELECT COUNT(*) AS c FROM assets_new WHERE is_deleted = 0`);
    const byStatus = await ctx.all(`SELECT status, COUNT(*) AS c FROM assets_new WHERE is_deleted = 0 GROUP BY status`);
    const byDept = await ctx.all(`SELECT COALESCE(NULLIF(department, ''), 'IT') AS dept, COUNT(*) AS c FROM assets_new WHERE is_deleted = 0 GROUP BY dept ORDER BY c DESC`);
    const pending = await ctx.get(`SELECT COUNT(*) AS c FROM repairs_new WHERE status = 'pending'`);
    const vendors = await ctx.get(`SELECT COUNT(*) AS c FROM vendors_new`);
    const recycle = await ctx.get(`SELECT COUNT(*) AS c FROM assets_new WHERE is_deleted = 1`);
    return {
        total: (total && total.c) || 0,
        byStatus: byStatus || [],
        byDept: byDept || [],
        pendingRepairs: (pending && pending.c) || 0,
        vendors: (vendors && vendors.c) || 0,
        recycle: (recycle && recycle.c) || 0
    };
}

// ── 匯入資產（Excel）──────────────────────────────────
const ExcelJS = require('exceljs');

const IMP_ALIASES = {
    name: ['設備/項目名稱', '設備名稱', '項目名稱', '設備'],
    category: ['資產大類', '大類', '類別'],
    sn: ['原廠序列號(s/n)', '原廠序列號', '原廠序號', '序號', 'sn'],
    custodian: ['保管使用窗口', '保管窗口', '保管人'],
    location: ['購置擺放地點', '當前位置', '位置', '地點'],
    vendor_name: ['連動合作廠商', '購買廠商', '廠商名稱', '廠商'],
    status: ['維運狀態', '目前狀態', '狀態'],
    purchase_date: ['採購日期', '購買日期'],
    warranty_date: ['保固到期日', '保固到期'],
    scrap_reason: ['報廢原因'],
    spec_note: ['資產規格/備註', '資產規格', '規格'],
    notes: ['維運備註說明', '備註事項', '備註']
};
const normHeader = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
const cellText = (v) => {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map(x => x.text || '').join('');
        if (v.text != null) return String(v.text);
        if (v.result != null) return String(v.result);
        return '';
    }
    return String(v);
};
const normDate = (v) => {
    if (v == null || v === '') return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v).trim().replace(/[.\-]/g, '/');
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

async function importAssetsFromXlsx(ctx, buffer, fileName, user) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('匯入資料') || wb.worksheets[0];
    if (!ws) throw new Error('Excel 檔內沒有工作表。');

    let headerRowNo = 0, colMap = {};
    const maxScan = Math.min(ws.rowCount, 15);
    for (let r = 1; r <= maxScan; r++) {
        const map = {};
        ws.getRow(r).eachCell((cell, colNo) => {
            const h = normHeader(cellText(cell.value));
            if (!h) return;
            Object.keys(IMP_ALIASES).forEach(key => {
                if (map[key] !== undefined) return;
                if (IMP_ALIASES[key].some(a => { const na = normHeader(a); return h === na || h.indexOf(na) >= 0; })) map[key] = colNo;
            });
        });
        if (map.name && map.category) { headerRowNo = r; colMap = map; break; }
    }
    if (!headerRowNo) throw new Error('找不到欄位標題列（需包含「設備/項目名稱」與「資產大類」）；請使用系統下載的範本。');

    const options = await ctx.all(`SELECT field_type, value, label, code FROM field_options`);
    const catLookup = [];
    options.filter(o => o.field_type === 'category').forEach(o => {
        catLookup.push({ key: normHeader(o.value), value: o.value });
        catLookup.push({ key: normHeader(o.label), value: o.value });
        catLookup.push({ key: normHeader(o.code), value: o.value });
        catLookup.push({ key: normHeader(o.label + '(' + o.code + ')'), value: o.value });
    });
    const mapCategory = (raw) => {
        const h = normHeader(raw);
        if (!h) return '';
        const exact = catLookup.find(x => x.key && x.key === h);
        if (exact) return exact.value;
        const partial = catLookup.find(x => x.key && (h.indexOf(x.key) >= 0 || x.key.indexOf(h) >= 0));
        return partial ? partial.value : '';
    };
    const mapStatus = (raw) => {
        const h = normHeader(raw);
        if (!h) return 'inventory';
        if (h.indexOf('報廢') >= 0 || h.indexOf('scrap') >= 0) return 'scrapped';
        if (h.indexOf('維修') >= 0 || h.indexOf('repair') >= 0) return 'repair';
        if (h.indexOf('庫存') >= 0 || h.indexOf('備用') >= 0 || h.indexOf('inventory') >= 0) return 'inventory';
        return 'active';
    };

    const vendorRows = await ctx.all(`SELECT id, name FROM vendors_new`);
    const vendorMap = {};
    vendorRows.forEach(v => { vendorMap[normHeader(v.name)] = v.id; });

    const items = [];
    const errors = [];
    let skipped = 0;
    for (let r = headerRowNo + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const val = (key) => colMap[key] ? cellText(row.getCell(colMap[key]).value) : '';
        const name = str(val('name'));
        if (!name) continue;
        const category = mapCategory(val('category'));
        if (!category) { errors.push({ row: r, message: '「資產大類」無法識別：' + (val('category') || '(空白)') }); continue; }
        const status = mapStatus(val('status'));
        const scrapReason = str(val('scrap_reason'));
        if (status === 'scrapped' && !scrapReason) { errors.push({ row: r, message: '狀態為已報廢但未填寫報廢原因' }); continue; }
        const sn = str(val('sn'));
        if (sn) {
            const dup = await ctx.get(`SELECT asset_no FROM assets_new WHERE sn = ? AND sn <> '' LIMIT 1`, [sn]);
            if (dup) { skipped++; continue; }
        }
        const vName = str(val('vendor_name'));
        const vendorId = (vName && vendorMap[normHeader(vName)]) ? vendorMap[normHeader(vName)] : 0;
        items.push({
            row: r, name: name, category: category, sn: sn,
            custodian: str(val('custodian')), location: str(val('location')),
            vendor_id: vendorId, status: status, scrap_reason: scrapReason,
            purchase_date: normDate(val('purchase_date')), warranty_date: normDate(val('warranty_date')),
            spec_note: str(val('spec_note')), notes: str(val('notes')),
            department: 'IT'
        });
    }

    const inserted = await ctx.tx(async (t) => {
        for (const it of items) {
            const no = await nextAssetNo(t, it.category, it.department);
            await t.run(`INSERT INTO assets_new (asset_no, name, category, sn, custodian, location, vendor_id, status, purchase_date, warranty_date, scrap_reason, spec_note, notes, department, is_deleted)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                [no, it.name, it.category, it.sn, it.custodian, it.location, it.vendor_id, it.status, it.purchase_date, it.warranty_date, it.scrap_reason, it.spec_note, it.notes, it.department]);
            const row = await t.get(`SELECT id FROM assets_new WHERE asset_no = ?`, [no]);
            await logAssetHistory(t, row.id, no, 'create', '匯入資產資料（新增）',
                '設備名稱:' + it.name + ' ｜ 來源檔：' + (fileName || 'Excel') + ' ｜ 操作者:' + user.username);
        }
        return items.length;
    });

    return { rows: Math.max(0, ws.rowCount - headerRowNo), inserted: inserted, skipped: skipped, errors: errors, fileName: fileName };
}

// ── 編輯鎖定（避免兩人同時編輯同一筆）──────────────────
const LOCK_TTL_MS = 10 * 60 * 1000;   // 10 分鐘未動作自動釋放
const normEntity = (e) => (e === 'vendor') ? 'vendor' : 'asset';
const lockErr = (holder) => { const err = new Error('🔒 此資料目前由「' + (holder || '其他人') + '」編輯中，請稍後再試。'); err.status = 409; return err; };

async function acquireLock(ctx, entity, id, session) {
    const e = normEntity(entity);
    const eid = parseInt(id, 10) || 0;
    if (!eid) throw new Error('缺少資料編號。');
    const now = Date.now();
    await ctx.run(`DELETE FROM edit_locks WHERE expires <= ?`, [now]);
    return ctx.tx(async (t) => {
        const cur = await t.get(`SELECT * FROM edit_locks WHERE entity = ? AND entity_id = ?`, [e, eid]);
        if (cur && cur.sid !== session.sid) throw lockErr(cur.username);
        const acquired = (cur && cur.acquired) ? cur.acquired : now;
        await t.run(`INSERT OR REPLACE INTO edit_locks (entity, entity_id, username, sid, acquired, expires) VALUES (?, ?, ?, ?, ?, ?)`,
            [e, eid, session.username, session.sid, acquired, now + LOCK_TTL_MS]);
        return { entity: e, id: eid, username: session.username, expires: now + LOCK_TTL_MS };
    });
}

async function releaseLock(ctx, entity, id, session) {
    const e = normEntity(entity);
    const eid = parseInt(id, 10) || 0;
    if (!eid || !session || !session.sid) return { released: false };
    const r = await ctx.run(`DELETE FROM edit_locks WHERE entity = ? AND entity_id = ? AND sid = ?`, [e, eid, session.sid]);
    return { released: (r && r.changes) ? true : false };
}

async function listLocks(ctx, entity) {
    await ctx.run(`DELETE FROM edit_locks WHERE expires <= ?`, [Date.now()]);
    return ctx.all(`SELECT entity, entity_id AS id, username, acquired, expires FROM edit_locks WHERE entity = ?`, [normEntity(entity)]);
}

async function assertLockOwned(ctx, entity, id, session) {
    const e = normEntity(entity);
    const eid = parseInt(id, 10) || 0;
    const cur = await ctx.get(`SELECT * FROM edit_locks WHERE entity = ? AND entity_id = ?`, [e, eid]);
    if (cur && session && cur.sid !== session.sid) throw lockErr(cur.username);
    return true;
}

// ── 匯入廠商（Excel）────────────────────────────────
const IMP_VENDOR_ALIASES = {
    name: ['廠商公司名稱', '公司名稱', '廠商名稱', '廠商'],
    representative: ['主要服務專員', '服務專員', '聯絡人'],
    phone: ['聯絡窗口電話', '電話', '連絡電話'],
    address: ['通訊地址', '地址'],
    has_nda: ['資安nda狀態', 'nda狀態', 'nda'],
    service_items: ['維護合約服務範疇', '服務範疇', '服務項目', '維護項目'],
    maint_start: ['維護合約開始日', '合約開始日', '維護起日'],
    maint_end: ['維護合約截止日', '合約截止日', '維護迄日']
};

async function importVendorsFromXlsx(ctx, buffer, fileName, user) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('匯入資料') || wb.worksheets[0];
    if (!ws) throw new Error('Excel 檔內沒有工作表。');

    let headerRowNo = 0, colMap = {};
    for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
        const map = {};
        ws.getRow(r).eachCell((cell, colNo) => {
            const h = normHeader(cellText(cell.value));
            if (!h) return;
            Object.keys(IMP_VENDOR_ALIASES).forEach(key => {
                if (map[key] !== undefined) return;
                if (IMP_VENDOR_ALIASES[key].some(a => { const na = normHeader(a); return h === na || h.indexOf(na) >= 0; })) map[key] = colNo;
            });
        });
        if (map.name) { headerRowNo = r; colMap = map; break; }
    }
    if (!headerRowNo) throw new Error('找不到欄位標題列（需包含「廠商公司名稱」）；請使用系統下載的範本。');

    const mapNda = (raw) => {
        const h = normHeader(raw);
        if (!h) return null;
        if (h.indexOf('已簽') >= 0 || h === '1' || h.indexOf('是') === 0) return 1;
        if (h.indexOf('未') >= 0 || h === '0' || h.indexOf('否') === 0) return 0;
        return null;
    };

    const plan = { kind: 'vendor', rows: 0, inserted: 0, updated: 0, skipped: 0, errors: [], fileName: fileName };
    const seen = {};
    for (let r = headerRowNo + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const val = (key) => colMap[key] ? cellText(row.getCell(colMap[key]).value) : '';
        const name = str(val('name'));
        if (!name) continue;
        plan.rows++;
        if (seen[name]) { plan.skipped++; continue; }
        seen[name] = true;
        const existing = await ctx.get(`SELECT * FROM vendors_new WHERE name = ?`, [name]);
        const nda = mapNda(val('has_nda'));
        try {
            if (existing) {
                const pick = (v, old) => (str(v) !== '') ? str(v) : (old == null ? '' : String(old));
                await ctx.run(`UPDATE vendors_new SET representative = ?, phone = ?, address = ?, has_nda = ?, service_items = ?, maint_start = ?, maint_end = ? WHERE id = ?`, [
                    pick(val('representative'), existing.representative),
                    pick(val('phone'), existing.phone),
                    pick(val('address'), existing.address),
                    (nda === null) ? existing.has_nda : nda,
                    pick(val('service_items'), existing.service_items),
                    pick(normDate(val('maint_start')), existing.maint_start),
                    pick(normDate(val('maint_end')), existing.maint_end),
                    existing.id
                ]);
                plan.updated++;
            } else {
                await ctx.run(`INSERT INTO vendors_new (name, representative, phone, address, has_nda, service_items, maint_start, maint_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                    name, str(val('representative')), str(val('phone')), str(val('address')),
                    (nda === null ? 0 : nda), str(val('service_items')),
                    normDate(val('maint_start')), normDate(val('maint_end'))
                ]);
                plan.inserted++;
            }
        } catch (e) {
            plan.errors.push({ row: r, message: errMsg(e) });
        }
    }
    return plan;
}

// ── 廠商附件（NDA / 合約）────────────────────────────
async function addVendorFiles(ctx, dataDir, vendorId, kind, files) {
    const vendor = await ctx.get(`SELECT * FROM vendors_new WHERE id = ?`, [parseInt(vendorId) || 0]);
    if (!vendor) throw new Error('找不到該廠商。');
    const k = (kind === 'contract') ? 'contract' : 'nda';
    const col = (k === 'contract') ? 'contract_files' : 'nda_files';
    const saved = filesLib.saveFiles(dataDir, ['vendor_files', k, String(vendor.id)], files);
    const cur = String(vendor[col] || '').split(';').map(s => s.trim()).filter(Boolean);
    const next = cur.concat(saved);
    await ctx.run(`UPDATE vendors_new SET ${col} = ? WHERE id = ?`, [next.join(';'), vendor.id]);
    return { saved: saved, count: next.length };
}

async function removeVendorFile(ctx, dataDir, vendorId, kind, targetPath) {
    const vendor = await ctx.get(`SELECT * FROM vendors_new WHERE id = ?`, [parseInt(vendorId) || 0]);
    if (!vendor) throw new Error('找不到該廠商。');
    const k = (kind === 'contract') ? 'contract' : 'nda';
    const col = (k === 'contract') ? 'contract_files' : 'nda_files';
    const cur = String(vendor[col] || '').split(';').map(s => s.trim()).filter(Boolean);
    if (cur.indexOf(targetPath) < 0) throw new Error('此檔案不屬於該廠商。');
    filesLib.deleteFile(dataDir, targetPath);
    const next = cur.filter(p => p !== targetPath);
    await ctx.run(`UPDATE vendors_new SET ${col} = ? WHERE id = ?`, [next.join(';'), vendor.id]);
    return { count: next.length };
}

// ── 廠商維護單據 ──────────────────────────────────────
async function addMaintDocs(ctx, dataDir, recordId, files) {
    const rec = await ctx.get(`SELECT * FROM vendor_maint_records WHERE id = ?`, [parseInt(recordId) || 0]);
    if (!rec) throw new Error('找不到該維護紀錄。');
    const saved = filesLib.saveFiles(dataDir, ['vendor_files', 'maint', String(rec.id)], files);
    const cur = String(rec.doc_files || '').split(';').map(s => s.trim()).filter(Boolean);
    const next = cur.concat(saved);
    await ctx.run(`UPDATE vendor_maint_records SET doc_files = ? WHERE id = ?`, [next.join(';'), rec.id]);
    return { saved: saved, count: next.length };
}

async function removeMaintDoc(ctx, dataDir, recordId, targetPath) {
    const rec = await ctx.get(`SELECT * FROM vendor_maint_records WHERE id = ?`, [parseInt(recordId) || 0]);
    if (!rec) throw new Error('找不到該維護紀錄。');
    const cur = String(rec.doc_files || '').split(';').map(s => s.trim()).filter(Boolean);
    if (cur.indexOf(targetPath) < 0) throw new Error('此檔案不屬於該維護紀錄。');
    filesLib.deleteFile(dataDir, targetPath);
    const next = cur.filter(p => p !== targetPath);
    await ctx.run(`UPDATE vendor_maint_records SET doc_files = ? WHERE id = ?`, [next.join(';'), rec.id]);
    return { count: next.length };
}

module.exports = {
    ensureSchema,
    listFieldOptions, addFieldOption, deleteFieldOption,
    listAssets, listRecycle, createAsset, updateAsset, deleteAsset, restoreAsset, getAssetDetail,
    listRepairs, createRepair, completeRepair, deleteRepair,
    listTransfers, createTransfer, deleteTransfer,
    listVendors, saveVendor, deleteVendor,
    listVendorMaint, createVendorMaint, deleteVendorMaint,
    listUsers, createUserAccount, updateUserAccount, resetUserPassword, changeOwnPassword, deleteUserAccount,
    getStats, importAssetsFromXlsx, importVendorsFromXlsx,
    addVendorFiles, removeVendorFile, addMaintDocs, removeMaintDoc,
    acquireLock, releaseLock, listLocks, assertLockOwned,
    nextAssetNo, catCodeOf
};








