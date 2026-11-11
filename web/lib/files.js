// =====================================================================
// 附件檔案處理（廠商 NDA／合約／維護單據）
//   · 檔案實際位置：<資料庫所在資料夾>\vendor_files\<類型>\<id>\<時間>_<檔名>
//   · 資料庫欄位存「絕對路徑」（以分號分隔），與單機版相容
//   · 所有下載／刪除都驗證路徑必須在資料夾內，避免路徑穿越
// =====================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const safeName = (name) => String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');

function isInside(baseDir, target) {
    try {
        const base = path.resolve(baseDir).toLowerCase();
        const t = path.resolve(target).toLowerCase();
        return t === base || t.indexOf(base + path.sep) === 0;
    } catch (e) { return false; }
}

function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }

// 儲存上傳檔案（files: [{ name, dataBase64 }]）→ 回傳絕對路徑陣列
function saveFiles(dataDir, subParts, files) {
    const dir = path.join.apply(path, [dataDir].concat(subParts));
    ensureDir(dir);
    const saved = [];
    (files || []).forEach((f, i) => {
        const b64 = String((f && f.dataBase64) || '');
        if (!b64) return;
        const buf = Buffer.from(b64, 'base64');
        if (!buf.length) return;
        const name = safeName(f.name || ('file_' + i));
        const target = path.join(dir, stamp() + '_' + name);
        fs.writeFileSync(target, buf);
        saved.push(target);
    });
    return saved;
}

function deleteFile(dataDir, absPath) {
    if (!absPath || !isInside(dataDir, absPath)) throw new Error('檔案路徑不合法。');
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    return true;
}

function readFileForDownload(dataDir, absPath) {
    if (!absPath || !isInside(dataDir, absPath)) throw new Error('檔案路徑不合法。');
    if (!fs.existsSync(absPath)) throw new Error('找不到檔案。');
    return { fullPath: absPath, name: path.basename(absPath), size: fs.statSync(absPath).size };
}

// ---- 極簡 ZIP（STORE，不壓縮）：用於「附件檔備份」 ----
const CRC32_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    entries.forEach(e => {
        const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
        const data = e.data;
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);   // UTF-8 flag
        local.writeUInt16LE(0, 8);        // store
        local.writeUInt16LE(0, 10);       // time
        local.writeUInt16LE(0, 12);       // date
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBuf, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([central, nameBuf]));

        offset += local.length + nameBuf.length + data.length;
    });
    const localPart = Buffer.concat(locals);
    const centralPart = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralPart.length, 12);
    end.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, end]);
}

// 收集資料夾內所有檔案 → ZIP Buffer
function zipFolder(baseDir, folder) {
    const root = path.join(baseDir, folder);
    const entries = [];
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
            const full = path.join(dir, d.name);
            if (d.isDirectory()) walk(full);
            else if (d.isFile()) {
                entries.push({ name: path.relative(root, full), data: fs.readFileSync(full) });
            }
        });
    };
    walk(root);
    return { buffer: buildZip(entries), count: entries.length };
}

module.exports = { saveFiles, deleteFile, readFileForDownload, isInside, zipFolder, ensureDir, safeName };
