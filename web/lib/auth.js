// =====================================================================
// 登入驗證與 Session（Web 版）
//   · 密碼：scrypt + 隨機 salt（讀取 app_users）
//   · Session：記憶體快取 + 資料庫持久化（web_sessions），重啟不掉登入
//   · 登入失敗 5 次鎖定該 IP 60 秒
// =====================================================================
const crypto = require('crypto');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8 小時
const COOKIE_NAME = 'itam_sid';
const MAX_FAILS = 5;
const BLOCK_MS = 60 * 1000;

const sessions = new Map();     // sid -> session（記憶體快取）
const attempts = new Map();     // ip -> { count, blockedUntil }
let store = null;               // 持久化介面（由 server 注入）

const scryptHash = (password, salt) => crypto.scryptSync(String(password), String(salt), 64).toString('hex');

function verifyPassword(password, salt, storedHash) {
    try {
        const calc = Buffer.from(scryptHash(password, salt), 'hex');
        const stored = Buffer.from(String(storedHash || ''), 'hex');
        return calc.length === stored.length && crypto.timingSafeEqual(calc, stored);
    } catch (e) { return false; }
}

// 啟動時載入未過期的 Session（由 server 在 DB 就緒後呼叫）
async function init(sessionStore) {
    store = sessionStore || null;
    sessions.clear();
    if (!store) return 0;
    try {
        const rows = await store.loadAll(Date.now());
        (rows || []).forEach(r => {
            if (!r || !r.sid) return;
            if (Number(r.expires) <= Date.now()) return;
            sessions.set(r.sid, r);
        });
    } catch (e) { /* 讀取失敗就以空 Session 啟動 */ }
    return sessions.size;
}

async function reload() { return init(store); }

const PERM_CODES = ['all', 'query', 'vendor', 'asset'];
function normalizeSessionPerms(input, role) {
    let list = Array.isArray(input) ? input.slice() : String(input == null ? '' : input).split(',');
    list = list.map(s => String(s || '').trim().toLowerCase()).filter(s => PERM_CODES.indexOf(s) >= 0);
    if (list.indexOf('all') >= 0) return ['all'];
    const out = PERM_CODES.filter(c => c !== 'all' && list.indexOf(c) >= 0);
    if (out.length) return out;
    return role === 'admin' ? ['all'] : ['query'];
}

function createSession(user) {
    const sid = crypto.randomBytes(32).toString('hex');
    const perms = normalizeSessionPerms(user.perms, user.role);
    const session = {
        sid: sid,
        id: user.id,
        username: user.username,
        displayName: user.display_name || user.username,
        role: perms.indexOf('all') >= 0 ? 'admin' : 'user',
        perms: perms,
        createdAt: Date.now(),
        expires: Date.now() + SESSION_TTL_MS
    };
    sessions.set(sid, session);
    if (store) { try { store.insert(session).catch(() => {}); } catch (e) {} }
    return session;
}

// 權限調整後同步既有 Session（不必強制重新登入）
function updateUserSessions(userId, patch) {
    const id = parseInt(userId, 10) || 0;
    if (!id || !patch) return 0;
    const target = Array.from(sessions.values()).filter(s => s.id === id);
    target.forEach(s => {
        if (patch.perms) s.perms = normalizeSessionPerms(patch.perms, patch.role);
        s.role = (s.perms && s.perms.indexOf('all') >= 0) ? 'admin' : 'user';
        if (store) { try { store.insert(s).catch(() => {}); } catch (e) {} }
    });
    return target.length;
}

function parseCookies(req) {
    const out = {};
    const raw = String(req.headers.cookie || '');
    raw.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx < 0) return;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}

function getSession(req) {
    const sid = parseCookies(req)[COOKIE_NAME];
    if (!sid) return null;
    const s = sessions.get(sid);
    if (!s) return null;
    if (s.expires < Date.now()) { destroySession(sid); return null; }
    return s;
}

function destroySession(sid) {
    if (!sid) return;
    sessions.delete(sid);
    if (store) { try { store.remove(sid).catch(() => {}); } catch (e) {} }
}

// 讓某個使用者的所有 Session 失效（停用／改角色／刪除帳號時）
function invalidateUser(userId) {
    const id = parseInt(userId, 10) || 0;
    if (!id) return;
    Array.from(sessions.values()).filter(s => s.id === id).forEach(s => destroySession(s.sid));
    if (store) { try { store.removeByUser(id).catch(() => {}); } catch (e) {} }
}

function cookieHeader(sid) {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    return COOKIE_NAME + '=' + encodeURIComponent(sid) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}
const clearCookieHeader = () => COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

// 簡易防暴力破解（依來源 IP）
function isBlocked(ip) {
    const a = attempts.get(ip);
    if (!a) return false;
    if (a.blockedUntil && a.blockedUntil > Date.now()) return true;
    if (a.blockedUntil && a.blockedUntil <= Date.now()) { attempts.delete(ip); return false; }
    return false;
}
function recordFailure(ip) {
    const a = attempts.get(ip) || { count: 0, blockedUntil: 0 };
    a.count += 1;
    if (a.count >= MAX_FAILS) { a.blockedUntil = Date.now() + BLOCK_MS; a.count = 0; }
    attempts.set(ip, a);
    return a.blockedUntil > Date.now();
}
function clearFailures(ip) { attempts.delete(ip); }
function remainingBlockSeconds(ip) {
    const a = attempts.get(ip);
    if (!a || !a.blockedUntil) return 0;
    return Math.max(0, Math.ceil((a.blockedUntil - Date.now()) / 1000));
}

module.exports = {
    SESSION_TTL_MS, COOKIE_NAME,
    init, reload, verifyPassword, createSession, getSession, destroySession, invalidateUser, updateUserSessions,
    cookieHeader, clearCookieHeader, parseCookies,
    isBlocked, recordFailure, clearFailures, remainingBlockSeconds
};

