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
//  · vendor_files/**  → 附件區（維持原路徑）
//  · 其他檔案（例如單機版自訂的 D:\CITRMS\... 資料夾）
//    → 解壓到 <資料庫資料夾>\imported_files\<原相對路徑>，再由路徑比對自動接回
const SKIP_FILE = /(^|\/)(thumbs\.db|desktop\.ini|\.ds_store)$/i;
function collectFromZip(buffer) {
    const entries = readZip(buffer);
    const dbCandidates = [];
    const files = [];
    entries.forEach(e => {
        const base = e.name.split('/').pop();
        if (/\.db$/i.test(base)) { dbCandidates.push({ name: e.name, size: e.data.length, data: e.data }); return; }
        if (/\.(db-wal|db-shm)$/i.test(base)) return;
        if (/^(backups|updates|imported_files)\//i.test(e.name)) return;   // 備份區／更新區／已匯入區不重複處理
        if (SKIP_FILE.test(e.name)) return;
        if (/^\./.test(base)) return;
        const isVendor = /vendor_files\//i.test(e.name);
        const idx = e.name.toLowerCase().indexOf('vendor_files/');
        const rel = isVendor ? e.name.slice(idx) : e.name;
        files.push({ rel: rel, kind: isVendor ? 'vendor' : 'other', size: e.data.length, data: e.data });
    });
    return { dbCandidates: dbCandidates, files: files };
}

// ── 附件落地 ───────────────────────────────────────────
function writeAttachments(dataDir, files) {
    const written = [];
    const warnings = [];
    (files || []).forEach(f => {
        const rel = String(f.rel || '').replace(/\//g, path.sep);
        const dest = (f.kind === 'vendor')
            ? path.join(dataDir, rel)
            : path.join(dataDir, 'imported_files', rel);
        if (!filesLib.isInside(dataDir, dest)) { warnings.push('略過不安全路徑：' + f.rel); return; }
        try {
            filesLib.ensureDir(path.dirname(dest));
            fs.writeFileSync(dest, f.data);
        } catch (err) {
            warnings.push('附件寫入失敗：' + f.rel + '（' + (err.code || err.message) + '）');
            return;
        }
        written.push({
            rel: String(f.rel || '').replace(/\\/g, '/'),
            abs: dest,
            base: path.basename(dest).toLowerCase(),
            kind: f.kind || 'other'
        });
    });
    return { written: written, warnings: warnings };
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
//   比對順序：① vendor_files 相對路徑 ② 尾段路徑（最長優先）③ 檔名
function makePathMapper(dataDir, written) {
    const byBase = {};
    const byRel = [];
    written.forEach(w => {
        if (!byBase[w.base]) byBase[w.base] = w.abs;
        byRel.push({ relLower: String(w.rel || '').toLowerCase(), abs: w.abs, depth: String(w.rel || '').split('/').length });
    });
    byRel.sort((a, b) => b.depth - a.depth);

    const splitSegs = (p) => String(p).replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..');

    return function mapPath(oldPath) {
        const p = String(oldPath || '').trim();
        if (!p) return p;

        // ① 標準附件區（vendor_files/...）
        const m = /vendor_files[\\/](.+)$/i.exec(p);
        if (m) {
            const candidate = path.join(dataDir, 'vendor_files', m[1].replace(/[\\/]/g, path.sep));
            if (filesLib.isInside(dataDir, candidate) && fs.existsSync(candidate)) return candidate;
        }

        // ② 尾段路徑比對（例：舊 D:\CITRMS\...\客服部-XX\相關文件\保密條款\a.pdf ↔ 客服部-XX/相關文件/保密條款/a.pdf）
        const segs = splitSegs(p);
        for (let k = Math.min(segs.length, 8); k >= 2; k--) {
            const suffix = '/' + segs.slice(-k).join('/').toLowerCase();
            const hit = byRel.find(w => w.relLower === suffix.slice(1) || w.relLower.endsWith(suffix));
            if (hit) return hit.abs;
        }

        // ③ 檔名比對
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
        let pathChanged = 0;
        rows.forEach(r => {
            const next = {};
            let dirty = false;
            cols.forEach(c => {
                const cur = String(r[c] || '');
                if (!cur.trim()) return;
                const before = cur.split(';').map(s => s.trim()).filter(Boolean);
                const after = before.map(mapPath);
                pathChanged += after.filter((v, i) => v !== before[i]).length;
                const mapped = after.join(';');
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
        changed += pathChanged;
    }
    return changed;
}

// ── 已放在資料夾內的附件（手動複製也能重新對應）────────
function listPlacedFiles(dataDir) {
    const out = [];
    const walk = (root, kind, relBase) => {
        if (!fs.existsSync(root)) return;
        const stack = [{ dir: root, rel: '' }];
        while (stack.length) {
            const cur = stack.pop();
            let items = [];
            try { items = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch (e) { continue; }
            items.forEach(d => {
                const full = path.join(cur.dir, d.name);
                const rel = cur.rel ? (cur.rel + '/' + d.name) : d.name;
                if (d.isDirectory()) stack.push({ dir: full, rel: rel });
                else if (d.isFile()) {
                    if (/\.(db|db-wal|db-shm)$/i.test(d.name)) return;
                    out.push({
                        rel: (relBase ? (relBase + '/' + rel) : rel),
                        abs: full,
                        base: d.name.toLowerCase(),
                        kind: kind
                    });
                }
            });
        }
    };
    walk(path.join(dataDir, 'vendor_files'), 'vendor', 'vendor_files');
    walk(path.join(dataDir, 'imported_files'), 'other', '');   // imported_files 之下即為原資料夾結構
    return out;
}

// ── 附件可用性檢查 ─────────────────────────────────────
async function checkStoredPaths(ctx, dataDir) {
    let total = 0, existing = 0;
    const missing = [];
    for (const table of Object.keys(FILE_COLUMNS)) {
        const cols = FILE_COLUMNS[table];
        const rows = await ctx.all(`SELECT id, ${colListSql(cols)} FROM "${table}"`);
        rows.forEach(r => cols.forEach(c => {
            String(r[c] || '').split(';').map(s => s.trim()).filter(Boolean).forEach(p => {
                total++;
                if (filesLib.isInside(dataDir, p) && fs.existsSync(p)) existing++;
                else missing.push(p);
            });
        }));
    }
    return { total: total, existing: existing, missing: missing.length, samples: missing.slice(0, 5) };
}

// ── 附件路徑修復（上傳單機版附件資料夾 ZIP，重新對應 DB 內路徑）──
async function repairAttachments(opts) {
    const ctx = opts.ctx;
    const dataDir = opts.dataDir;
    const uploads = opts.files || [];
    let attachments = [];
    uploads.forEach(f => {
        if (!/\.zip$/i.test(f.name || '')) throw new Error('附件修復請上傳 .zip 檔（可一次多選）。');
        attachments = attachments.concat(collectFromZip(f.buffer).files);
    });
    const before = await checkStoredPaths(ctx, dataDir);
    const w = writeAttachments(dataDir, attachments);

    // 已放在 vendor_files／imported_files 的檔案（手動複製的也納入比對）
    const index = [];
    const seen = {};
    w.written.concat(listPlacedFiles(dataDir)).forEach(x => {
        const key = String(x.abs).toLowerCase();
        if (seen[key]) return;
        seen[key] = 1;
        index.push(x);
    });

    const repointed = index.length ? await repointFilePaths(ctx, dataDir, index) : 0;
    const after = await checkStoredPaths(ctx, dataDir);
    return {
        extracted: w.written.length,
        placed: index.length,
        repointed: repointed,
        before: before, after: after, warnings: w.warnings
    };
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
        const w = writeAttachments(dataDir, attachments);
        result.attachments = w.written.length;
        if (w.warnings.length) result.warnings = result.warnings.concat(w.warnings);

        // 3) 附件路徑改指向新位置
        if (w.written.length) result.repointed = await repointFilePaths(ctx, dataDir, w.written);

        // 4) 附件可用性統計
        result.fileStatus = await checkStoredPaths(ctx, dataDir);

        return result;
    } finally {
        if (srcDb) { try { await dbLib.close(srcDb); } catch (e) {} }
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
    }
}

module.exports = { importDesktopBackup, repairAttachments, checkStoredPaths, collectFromZip, writeAttachments, listPlacedFiles };

