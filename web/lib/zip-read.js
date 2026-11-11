// =====================================================================
// 極簡 ZIP 讀取（不引入外部套件）
//   · 支援 store(0) / deflate(8)，有／沒有中央目錄（循序掃描）皆可
//   · 支援 UTF-8 檔名（單機版與 Windows 壓縮皆適用）
//   · 不支援 ZIP64、加密、分割壓縮檔
// =====================================================================
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;   // 解壓後上限 2GB（防 ZIP 炸彈）

function findEocd(buf) {
    const min = Math.max(0, buf.length - 22 - 0xFFFF);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) return i;
    }
    return -1;
}

// 清理檔名：移除磁碟機代號／開頭斜線，阻擋 .. 路徑穿越
function safeEntryName(name) {
    let n = String(name || '').replace(/\\/g, '/');
    n = n.replace(/^[a-zA-Z]:/, '');
    n = n.replace(/^\/+/, '');
    const parts = n.split('/').filter(p => p !== '' && p !== '.');
    if (parts.some(p => p === '..')) throw new Error('壓縮檔內含不安全的路徑：' + name);
    return parts.join('/');
}

function inflateEntry(method, comp, name) {
    if (method === 0) return Buffer.from(comp);
    if (method === 8) return zlib.inflateRawSync(comp);
    throw new Error('不支援的壓縮方式（' + method + '）：' + name);
}

// 判斷是否為「資料夾項目」：有些工具（.NET Compress-Archive）不加結尾斜線，只靠屬性標記
function isDirectoryEntry(buf, cdStart, rawName) {
    if (/[\\/]$/.test(rawName)) return true;
    const versionMadeBy = buf.readUInt16LE(cdStart + 4);
    const extAttrs = buf.readUInt32LE(cdStart + 38);
    if ((extAttrs & 0x10) !== 0) return true;                  // DOS 目錄屬性
    const host = versionMadeBy >> 8;
    if (host === 3 || host === 19) {                           // Unix / macOS
        const mode = (extAttrs >>> 16) & 0xFFFF;
        if ((mode & 0xF000) === 0x4000) return true;
    }
    return false;
}

function readByCentralDirectory(buf, eocd) {
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
        throw new Error('不支援 ZIP64 格式的壓縮檔，請改用一般 ZIP。');
    }
    const entries = [];
    let p = cdOffset;
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) throw new Error('壓縮檔中央目錄格式錯誤。');
        const cdStart = p;
        const flags = buf.readUInt16LE(cdStart + 8);
        const method = buf.readUInt16LE(cdStart + 10);
        const compSize = buf.readUInt32LE(cdStart + 20);
        const size = buf.readUInt32LE(cdStart + 24);
        const nameLen = buf.readUInt16LE(cdStart + 28);
        const extraLen = buf.readUInt16LE(cdStart + 30);
        const commentLen = buf.readUInt16LE(cdStart + 32);
        const localOff = buf.readUInt32LE(cdStart + 42);
        const rawName = buf.slice(cdStart + 46, cdStart + 46 + nameLen).toString('utf8');
        p = cdStart + 46 + nameLen + extraLen + commentLen;
        if (flags & 0x0001) throw new Error('不支援加密的 ZIP：' + rawName);
        if (isDirectoryEntry(buf, cdStart, rawName)) continue;
        if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error('壓縮檔本機標頭格式錯誤：' + rawName);
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const comp = buf.slice(dataStart, dataStart + compSize);
        const data = inflateEntry(method, comp, rawName);
        total += data.length;
        if (total > MAX_TOTAL) throw new Error('壓縮檔解壓後過大（超過 2GB），請分批匯入。');
        const name = safeEntryName(rawName);
        if (!name) continue;
        entries.push({ name: name, size: data.length, data: data });
    }
    return entries;
}

// 沒有中央目錄時（極簡 ZIP）：循序讀取本機標頭
function readSequentially(buf) {
    const entries = [];
    let p = 0;
    let total = 0;
    while (p + 30 <= buf.length && buf.readUInt32LE(p) === SIG_LOCAL) {
        const method = buf.readUInt16LE(p + 8);
        const compSize = buf.readUInt32LE(p + 18);
        const nameLen = buf.readUInt16LE(p + 26);
        const extraLen = buf.readUInt16LE(p + 28);
        const rawName = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
        const dataStart = p + 30 + nameLen + extraLen;
        const comp = buf.slice(dataStart, dataStart + compSize);
        p = dataStart + compSize;
        if (/\/$/.test(rawName)) continue;
        const data = inflateEntry(method, comp, rawName);
        total += data.length;
        if (total > MAX_TOTAL) throw new Error('壓縮檔解壓後過大（超過 2GB），請分批匯入。');
        const name = safeEntryName(rawName);
        if (!name) continue;
        entries.push({ name: name, size: data.length, data: data });
    }
    return entries;
}

// buffer → [{ name, size, data }]
function readZip(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
    if (buf.length < 22) throw new Error('檔案太小，不是有效的 ZIP。');
    if (buf.readUInt32LE(0) !== SIG_LOCAL && findEocd(buf) < 0) throw new Error('檔案不是有效的 ZIP 格式。');
    const eocd = findEocd(buf);
    let entries;
    if (eocd >= 0) {
        try { entries = readByCentralDirectory(buf, eocd); }
        catch (err) {
            if (buf.readUInt32LE(0) === SIG_LOCAL) entries = readSequentially(buf);
            else throw err;
        }
    } else {
        entries = readSequentially(buf);
    }
    if (!entries.length) throw new Error('ZIP 內沒有任何檔案。');
    // 保險：0 byte 且是其他項目上層路徑者視為資料夾，避免被當成檔案寫入
    const names = entries.map(e => e.name);
    const cleaned = entries.filter(e => {
        if (e.size !== 0) return true;
        return !names.some(n => n !== e.name && n.indexOf(e.name + '/') === 0);
    });
    if (!cleaned.length) throw new Error('ZIP 內沒有任何檔案。');
    return cleaned;
}

module.exports = { readZip, safeEntryName };
