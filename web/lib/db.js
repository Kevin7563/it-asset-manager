// =====================================================================
// SQLite 存取（Promise 化）
//   · Web 版 Phase 2 起改為「讀寫」模式（WAL）
//   · withWrite / tx：所有寫入排隊 + BEGIN IMMEDIATE，避免多人同時新增撞號
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

const rawAll = (db, sql, args) => new Promise((resolve, reject) => {
    db.all(sql, args || [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
});
const rawGet = (db, sql, args) => new Promise((resolve, reject) => {
    db.get(sql, args || [], (err, row) => (err ? reject(err) : resolve(row || null)));
});
const rawRun = (db, sql, args) => new Promise((resolve, reject) => {
    db.run(sql, args || [], function (err) {
        if (err) reject(err); else resolve({ changes: this ? this.changes : 0, lastID: this ? this.lastID : 0 });
    });
});
const rawExec = (db, sql) => new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve(true)));
});

// 建立統一操作介面：ctx.all / ctx.get / ctx.run / ctx.tx / ctx.withWrite
function makeCtx(db) {
    const all = (sql, args) => rawAll(db, sql, args);
    const get = (sql, args) => rawGet(db, sql, args);
    const run = (sql, args) => rawRun(db, sql, args);
    const exec = (sql) => rawExec(db, sql);

    let chain = Promise.resolve();
    const withWrite = (fn) => {
        const p = chain.then(() => fn(), () => fn());
        chain = p.then(() => undefined, () => undefined);
        return p;
    };

    // 交易：fn 內使用傳入的 t（t.all / t.get / t.run）
    const tx = (fn) => withWrite(async () => {
        await exec('BEGIN IMMEDIATE');
        try {
            const result = await fn({ all, get, run, exec });
            await exec('COMMIT');
            return result;
        } catch (err) {
            try { await exec('ROLLBACK'); } catch (e) {}
            throw err;
        }
    });

    return { raw: db, all, get, run, exec, withWrite, tx };
}

const close = (db) => new Promise((resolve) => { try { db.close(() => resolve()); } catch (e) { resolve(); } });

module.exports = { openDb, makeCtx, close };

