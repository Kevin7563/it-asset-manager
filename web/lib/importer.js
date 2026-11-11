// =====================================================================
// 匯入「單機版備份」→ Web 版資料庫
//   · 可接受 backup_全備份_*.db、backup_附件_*.zip，或整包資料夾 ZIP
//   · 資料表：覆蓋 assets_new / vendors_new / repairs_new / transfers_new
//             / asset_history_new / vendor_maint_records（可選 field_options）
//   · 帳號（app_users）與登入狀態（web_sessions）一律保留，不會被蓋掉
//   · 匯入前自動備份目前資料庫到 <資料庫資料夾>\backups\
//   · 附件解壓到 <資料庫資料夾>\vendor_files\，並把資料庫內的舊絕對路徑改指向新位置
// =====================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbLib = require('./db');
const filesLib = require('./files');
const { readZip } = require('./zip-read');

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const DATA_TABLES = ['assets_new', 'vendors_new', 'repairs_new', 'transfers_new', 'asset_history_new', 'vendor_maint_records'];
const FILE_COLUMNS = { vendors_new: ['nda_files', 'contract_files'], vendor_maint_records: ['doc_files'] };
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');

const isSqlite = (buf) => !!buf && buf.length >= 16 && buf.slice(0, 16).toString('latin1') === SQLITE_MAGIC;
const colListSql = (cols) => cols.map(c => '"' + c + '"').join(', ');
const placeholders = (cols) => cols.map(() => '?').join(', ');

// ── ZIP 內容分類 ───────────────────────────────────────
function collectFromZip(buffer) {
    const entries = readZip(buffer);
    const dbCandidates = [];
    const files = [];
    entries.forEach(e => {
        const base = e.name.split('/').pop();
        if (/\.db$/i.test(base)) { dbCandidates.push({ name: e.name, size: e.data.length, data: e.data }); return; }
        if (/\.(db-wal|db-shm)$/i.test(base)) return;
        if (/^(backups|updates)\//i.test(e.name)) return;
        const idx = e.name.toLowerCase().indexOf('vendor_files/');
        if (idx < 0) return;                       // 資料庫只會參照 vendor_files，其餘忽略
        files.push({ rel: e.name.slice(idx), size: e.data.length, data: e.data });
    });
    return { dbCandidates: dbCandidates, files: files };
}

// ── 匯入前備份 ─────────────────────────────────────────
async function backupCurrent(ctx, dbPath) {
    const dir = path.dirname(dbPath);
    const backupsDir = path.join(dir, 'backups');
    filesLib.ensureDir(backupsDir);
    try { await ctx.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
    const target = path.join(backupsDir, 'asset_data_before_import_' + stamp() + '.db');
    fs.copyFileSync(dbPath, target);
    return target;
}

// ── 複製單一資料表（欄位取交集，相容新舊版 schema）──────
async function copyTable(srcCtx, ctx, table) {
    const srcCols = (await srcCtx.all(`SELECT name FROM pragma_table_info('${table}')`)).map(c => c.name);
    const destCols = (await ctx.all(`SELECT name FROM pragma_table_info('${table}')`)).map(c => c.name);
    const cols = srcCols.filter(c => destCols.indexOf(c) >= 0);
    if (!cols.length) return 0;
    const total = (await srcCtx.get(`SELECT COUNT(*) AS c FROM "${table}"`)).c || 0;
    const list = colListSql(cols);
    const ph = placeholders(cols);
    await ctx.tx(async (t) => {
        await t.exec(`DELETE FROM "${table}"`);
        const batch = 300;
        for (let off = 0; off < total; off += batch) {
            const rows = await srcCtx.all(`SELECT ${list} FROM "${table}" ORDER BY rowid LIMIT ${batch} OFFSET ${off}`);
            for (const row of rows) {
                await t.run(`INSERT INTO "${table}" (${list}) VALUES (${ph})`, cols.map(c => (row[c] === undefined ? null : row[c])));
            }
        }
    });
    return total;
}

// ── 附件路徑改指向新資料夾 ─────────────────────────────
function makePathMapper(dataDir, written) {
    const byBase = {};
    written.forEach(w => { if (!byBase[w.base]) byBase[w.base] = w.abs; });
    return function mapPath(oldPath) {
        const p = String(oldPath || '').trim();
        if (!p) return p;
        const m = /vendor_files[\\/](.+)$/i.exec(p);
        if (m) {
            const candidate = path.join(dataDir, 'vendor_files', m[1].replace(/[\\/]/g, path.sep));
            if (filesLib.isInside(dataDir, candidate) && fs.existsSync(candidate)) return candidate;
        }
        const base = path.basename(p).toLowerCase();
        if (byBase[base]) return byBase[base];
        return p;                                  // 找不到就保留原字串（檔案名稱仍可顯示）
    };
}

async function repointFilePaths(ctx, dataDir, written) {
    const mapPath = makePathMapper(dataDir, written);
    let changed = 0;
    const tables = Object.keys(FILE_COLUMNS);
    for (const table of tables) {
        const cols = FILE_COLUMNS[table];
        const rows = await ctx.all(`SELECT id, ${colListSql(cols)} FROM "${table}"`);
        const updates = [];
        rows.forEach(r => {
            const next = {};
            let dirty = false;
            cols.forEach(c => {
                const cur = String(r[c] || '');
                if (!cur.trim()) return;
                const mapped = cur.split(';').map(s => s.trim()).filter(Boolean).map(mapPath).join(';');
                if (mapped !== cur) { next[c] = mapped; dirty = true; }
            });
            if (dirty) updates.push({ id: r.id, next: next });
        });
        if (!updates.length) continue;
        await ctx.tx(async (t) => {
            for (const u of updates) {
                const keys = Object.keys(u.next);
                const sets = keys.map(k => '"' + k + '" = ?').join(', ');
                await t.run(`UPDATE "${table}" SET ${sets} WHERE id = ?`, keys.map(k => u.next[k]).concat([u.id]));
            }
        });
        changed += updates.reduce((n, u) => n + Object.keys(u.next).length, 0);
    }
    return changed;
}

// ── 主流程 ─────────────────────────────────────────────
async function importDesktopBackup(opts) {
    const ctx = opts.ctx;
    const dataDir = opts.dataDir;
    const dbPath = opts.dbPath;
    const importFields = opts.importFields !== false;
    const uploads = opts.files || [];

    const dbBuffers = [];
    let attachments = [];
    uploads.forEach(f => {
        const buf = f.buffer;
        if (!buf || !buf.length) return;
        if (/\.zip$/i.test(f.name || '')) {
            const r = collectFromZip(buf);
            r.dbCandidates.forEach(d => dbBuffers.push(d));
            attachments = attachments.concat(r.files);
        } else if (/\.db$/i.test(f.name || '')) {
            dbBuffers.push({ name: f.name, size: buf.length, data: buf });
        } else {
            throw new Error('只支援 .zip 或 .db 檔（收到：' + (f.name || '未命名') + '）');
        }
    });
    if (!dbBuffers.length && !attachments.length) {
        throw new Error('檔案內找不到資料庫（.db）或附件（vendor_files），請確認是單機版的備份檔。');
    }

    const result = {
        dbImported: false, dbName: '', tables: {},
        attachments: 0, repointed: 0, safety: '', warnings: []
    };

    // 1) 資料表
    let srcDb = null, srcCtx = null, tmpPath = '';
    try {
        if (dbBuffers.length) {
            const src = dbBuffers.sort((a, b) => b.size - a.size)[0];
            if (!isSqlite(src.data)) throw new Error('找到的 .db 不是有效的 SQLite 資料庫：' + src.name);
            tmpPath = path.join(os.tmpdir(), 'itam_import_' + stamp() + '_' + process.pid + '.db');
            fs.writeFileSync(tmpPath, src.data);
            srcDb = await dbLib.openDb(tmpPath, { readOnly: true });
            srcCtx = dbLib.makeCtx(srcDb);

            const srcTables = (await srcCtx.all(`SELECT name FROM sqlite_master WHERE type='table'`)).map(r => r.name);
            const wanted = DATA_TABLES.filter(t => srcTables.indexOf(t) >= 0);
            if (importFields && srcTables.indexOf('field_options') >= 0) wanted.push('field_options');
            if (!wanted.length) throw new Error('備份檔內沒有可匯入的資料表（assets_new／vendors_new…），請確認檔案正確。');

            result.safety = await backupCurrent(ctx, dbPath);
            for (const table of wanted) {
                if (table === 'field_options') {
                    const n = (await srcCtx.get('SELECT COUNT(*) AS c FROM field_options')).c || 0;
                    if (!n) { result.tables[table] = 0; continue; }   // 來源沒有欄位資料就不動
                }
                result.tables[table] = await copyTable(srcCtx, ctx, table);
            }
            result.dbImported = true;
            result.dbName = src.name;
            // 匯入後舊編輯鎖已無意義
            try { await ctx.exec('DELETE FROM edit_locks'); } catch (e) {}
        }

        // 2) 附件檔
        const written = [];
        attachments.forEach(f => {
            const dest = path.join(dataDir, f.rel.replace(/\//g, path.sep));
            if (!filesLib.isInside(dataDir, dest)) { result.warnings.push('略過不安全路徑：' + f.rel); return; }
            try {
                filesLib.ensureDir(path.dirname(dest));
                fs.writeFileSync(dest, f.data);
            } catch (err) {
                result.warnings.push('附件寫入失敗：' + f.rel + '（' + (err.code || err.message) + '）');
                return;
            }
            written.push({ rel: f.rel, abs: dest, base: path.basename(dest).toLowerCase() });
        });
        result.attachments = written.length;

        // 3) 附件路徑改指向新位置
        if (written.length) result.repointed = await repointFilePaths(ctx, dataDir, written);

        return result;
    } finally {
        if (srcDb) { try { await dbLib.close(srcDb); } catch (e) {} }
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
    }
}

module.exports = { importDesktopBackup, collectFromZip };

