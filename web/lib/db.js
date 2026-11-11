// =====================================================================
// SQLite 存取（Promise 化）— Web 版 Phase 1 以「唯讀」開啟，
// 直接讀取與單機版相同的 asset_data.db，不會寫入任何資料。
// =====================================================================
const sqlite3 = require('sqlite3');

function openDb(dbPath, options) {
    const opts = options || {};
    const mode = (opts.readOnly === false) ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY;
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, mode, (err) => {
            if (err) reject(err); else resolve(db);
        });
    });
}

const all = (db, sql, args) => new Promise((resolve, reject) => {
    db.all(sql, args || [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
});

const get = (db, sql, args) => new Promise((resolve, reject) => {
    db.get(sql, args || [], (err, row) => (err ? reject(err) : resolve(row || null)));
});

const run = (db, sql, args) => new Promise((resolve, reject) => {
    db.run(sql, args || [], function (err) {
        if (err) reject(err); else resolve({ changes: this ? this.changes : 0, lastID: this ? this.lastID : 0 });
    });
});

const close = (db) => new Promise((resolve) => { try { db.close(() => resolve()); } catch (e) { resolve(); } });

module.exports = { openDb, all, get, run, close };
