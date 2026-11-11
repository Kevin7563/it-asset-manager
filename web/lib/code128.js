// =====================================================================
// Code 128 一維條碼 → PNG（純 JS，與單機版 main.js 完全相同的演算法）
// 用於「盤點總表」貼紙欄，輸出 Buffer 供 ExcelJS 嵌入
// =====================================================================
const zlib = require('zlib');

const CODE128_BARS = [
    11011001100, 11001101100, 11001100110, 10010011000, 10010001100,
    10001001100, 10011001000, 10011000100, 10001100100, 11001001000,
    11001000100, 11000100100, 10110011100, 10011011100, 10011001110,
    10111001100, 10011101100, 10011100110, 11001110010, 11001011100,
    11001001110, 11011100100, 11001110100, 11101101110, 11101001100,
    11100101100, 11100100110, 11101100100, 11100110100, 11100110010,
    11011011000, 11011000110, 11000110110, 10100011000, 10001011000,
    10001000110, 10110001000, 10001101000, 10001100010, 11010001000,
    11000101000, 11000100010, 10110111000, 10110001110, 10001101110,
    10111011000, 10111000110, 10001110110, 11101110110, 11010001110,
    11000101110, 11011101000, 11011100010, 11011101110, 11101011000,
    11101000110, 11100010110, 11101101000, 11101100010, 11100011010,
    11101111010, 11001000010, 11110001010, 10100110000, 10100001100,
    10010110000, 10010000110, 10000101100, 10000100110, 10110010000,
    10110000100, 10011010000, 10011000010, 10000110100, 10000110010,
    11000010010, 11001010000, 11110111010, 11000010100, 10001111010,
    10100111100, 10010111100, 10010011110, 10111100100, 10011110100,
    10011110010, 11110100100, 11110010100, 11110010010, 11011011110,
    11011110110, 11110110110, 10101111000, 10100011110, 10001011110,
    10111101000, 10111100010, 11110101000, 11110100010, 10111011110,
    10111101110, 11101011110, 11110101110, 11010000100, 11010010000,
    11010011100, 1100011101011
];
const CODE128_START_B = 104, CODE128_START_C = 105, CODE128_STOP = 106;
const CODE128_MODULO = 103, CODE128_CODE_B = 100, CODE128_CODE_C = 99;
const code128Pattern = (v) => String(CODE128_BARS[v]).padStart(11, '0');

function code128Values(text) {
    const s = String(text == null ? '' : text).replace(/[^\x20-\x7E]/g, '-');
    const src = s === '' ? 'N/A' : s;
    const isDigit = (i) => i < src.length && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57;
    const digitRun = (i) => { let n = 0; while (isDigit(i + n)) n++; return n; };
    const vals = [];
    let i = 0;
    let setC = digitRun(0) >= 4;
    vals.push(setC ? CODE128_START_C : CODE128_START_B);
    while (i < src.length) {
        if (setC) {
            if (isDigit(i) && isDigit(i + 1)) { vals.push(parseInt(src.substr(i, 2), 10)); i += 2; continue; }
            vals.push(CODE128_CODE_B); setC = false; continue;
        }
        const run = digitRun(i);
        if (run >= 6 || (i + run === src.length && run >= 4)) { vals.push(CODE128_CODE_C); setC = true; continue; }
        vals.push(src.charCodeAt(i) - 32);
        i++;
    }
    let sum = vals[0];
    for (let k = 1; k < vals.length; k++) sum += vals[k] * k;
    vals.push(sum % CODE128_MODULO);
    return vals;
}

function code128Modules(text) {
    const vals = code128Values(text);
    let mods = '';
    for (let k = 0; k < vals.length; k++) mods += code128Pattern(vals[k]);
    mods += String(CODE128_BARS[CODE128_STOP]);
    return mods;
}

// ---- 極簡 PNG（8-bit 灰階、Filter = None）----
const CRC32_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.slice(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}
function buildGrayPng(width, height, rawRows) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(rawRows, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function code128ToPngBuffer(text, opts) {
    const o = opts || {};
    const moduleWidth = Math.max(1, parseInt(o.moduleWidth, 10) || 3);
    const height = Math.max(10, parseInt(o.height, 10) || 150);
    const quiet = (o.quietModules == null ? 10 : Math.max(0, parseInt(o.quietModules, 10)));
    const mods = code128Modules(text);
    const width = (mods.length + quiet * 2) * moduleWidth;
    const rowBits = Buffer.alloc(width, 255);
    for (let i = 0; i < mods.length; i++) {
        if (mods[i] !== '1') continue;
        const x0 = (quiet + i) * moduleWidth;
        rowBits.fill(0, x0, x0 + moduleWidth);
    }
    const rowBytes = width + 1;
    const raw = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y++) {
        raw[y * rowBytes] = 0;
        rowBits.copy(raw, y * rowBytes + 1);
    }
    return buildGrayPng(width, height, raw);
}

module.exports = { code128ToPngBuffer, code128Modules };
