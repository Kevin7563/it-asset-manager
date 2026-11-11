// =====================================================================
// 登入驗證與 Session（Web 版）
//   · 密碼演算法與單機版完全相同：scrypt + 隨機 salt（讀取 app_users 表）
//   · Session 存在伺服器記憶體（重啟即失效），以 HttpOnly Cookie 保存
// =====================================================================
const crypto = require('crypto');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8 小時
const COOKIE_NAME = 'itam_sid';
const MAX_FAILS = 5;                          // 連續失敗次數上限
const BLOCK_MS = 60 * 1000;                   // 封鎖時間 60 秒

const sessions = new Map();     // sid -> session
const attempts = new Map();     // ip -> { count, blockedUntil }

const scryptHash = (password, salt) => crypto.scryptSync(String(password), String(salt), 64).toString('hex');

function verifyPassword(password, salt, storedHash) {
    try {
        const calc = Buffer.from(scryptHash(password, salt), 'hex');
        const stored = Buffer.from(String(storedHash || ''), 'hex');
        return calc.length === stored.length && crypto.timingSafeEqual(calc, stored);
    } catch (e) { return false; }
}

function createSession(user) {
    const sid = crypto.randomBytes(32).toString('hex');
    const session = {
        sid: sid,
        id: user.id,
        username: user.username,
        displayName: user.display_name || user.username,
        role: (user.role === 'admin') ? 'admin' : 'user',
        createdAt: Date.now(),
        expires: Date.now() + SESSION_TTL_MS
    };
    sessions.set(sid, session);
    return session;
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
    if (s.expires < Date.now()) { sessions.delete(sid); return null; }
    return s;
}

function destroySession(sid) { if (sid) sessions.delete(sid); }

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
    verifyPassword, createSession, getSession, destroySession,
    cookieHeader, clearCookieHeader, parseCookies,
    isBlocked, recordFailure, clearFailures, remainingBlockSeconds
};
