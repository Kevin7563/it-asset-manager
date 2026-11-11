// =====================================================================
// 匯出「資訊資產盤點總表」→ xlsx Buffer
// 版面、配色、條碼貼紙欄與單機版 main.js 完全相同
// =====================================================================
const ExcelJS = require('exceljs');
const { code128ToPngBuffer } = require('./code128');

const DEFAULT_CAT_NAMES = {
    hardware: '硬體設備 (HW)', software: '軟體與授權 (SW)', network: '網路設備 (NET)',
    peripheral: '資訊周邊 (DEV)', credentials: '資訊與資料庫帳密 (SEC)'
};
const STATUS_NAMES = { active: '線上正常使用', inventory: '庫存備用', repair: '維修中', scrapped: '已報廢' };
const STATUS_STYLE = {
    active: { bg: 'FFDCFCE7', fc: 'FF166534' },
    inventory: { bg: 'FFDBEAFE', fc: 'FF1E40AF' },
    repair: { bg: 'FFFEF3C7', fc: 'FFB45309' },
    scrapped: { bg: 'FFFEE2E2', fc: 'FFB91C1C' }
};
const DEPT_NAMES = {
    IT: '資訊部門', DR: '院長室,醫師辦公室', TL: '督導', GA: '總務', MO: '行政', PT: '主任',
    AC: '人事,會計', CK: '廚房', SM: '倉庫', WO: '工務', LA: '檢驗室', OP: '婦科', IN: '兒科',
    PO: '警衛', OR: '產房', WA: '病房', HE: '申報', BR: '嬰兒室', CH: '病歷室', CO: '櫃台', P1: '藥局'
};

async function buildInventoryXlsx(db) {
    const assets = await db.all(`SELECT a.*, v.name AS vendor_name FROM assets_new a LEFT JOIN vendors_new v ON a.vendor_id = v.id WHERE a.is_deleted = 0 ORDER BY COALESCE(NULLIF(a.department,''),'IT') ASC, a.asset_no ASC`);
    if (!assets.length) throw new Error('目前沒有任何資訊資產資料可匯出。');

    const repRows = await db.all(`SELECT asset_id, COUNT(*) AS total, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending FROM repairs_new GROUP BY asset_id`);
    const trRows = await db.all(`SELECT asset_id, COUNT(*) AS total FROM transfers_new GROUP BY asset_id`);
    const repMap = {};
    repRows.forEach(r => { repMap[r.asset_id] = { total: r.total || 0, pending: r.pending || 0 }; });
    const trMap = {};
    trRows.forEach(r => { trMap[r.asset_id] = r.total || 0; });

    const catNameMap = Object.assign({}, DEFAULT_CAT_NAMES);
    const deptNameMap = Object.assign({}, DEPT_NAMES);
    try {
        (await db.all(`SELECT value,label,code FROM field_options WHERE field_type='category'`)).forEach(o => { catNameMap[o.value] = `${o.label} (${o.code})`; });
        (await db.all(`SELECT code,label FROM field_options WHERE field_type='department'`)).forEach(o => { deptNameMap[o.code] = o.label; });
    } catch (e) { /* 舊資料庫可能沒有 field_options */ }

    const fmtD = (s) => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? String(s) : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };
    const now = new Date();
    const exportTime = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const CLR = { primary: 'FF1F4E78', header: 'FF2E75B6', sub: 'FFDDEBF7', zebra: 'FFF2F7FC', border: 'FFB4C6E7' };
    const thinBorder = (color) => { const b = { style: 'thin', color: { argb: color || CLR.border } }; return { top: b, left: b, bottom: b, right: b }; };

    const wb = new ExcelJS.Workbook();
    wb.creator = 'IT Asset Manager (Web)';
    wb.created = new Date();
    const ws = wb.addWorksheet('資訊資產盤點總表', { views: [{ state: 'frozen', ySplit: 3 }] });

    const deptDisplay = (a) => {
        const code = String((a && a.department) || 'IT').toUpperCase();
        return deptNameMap[code] ? `${code} ${deptNameMap[code]}` : code;
    };

    const columns = [
        { header: '項次', width: 6 },
        { header: '資產編號', width: 24 },
        { header: '部門', width: 18 },
        { header: '設備名稱', width: 24 },
        { header: '資產大類', width: 18 },
        { header: '原廠序列號 (S/N)', width: 20 },
        { header: '保管窗口', width: 12 },
        { header: '當前位置', width: 16 },
        { header: '購買廠商', width: 16 },
        { header: '維運狀態', width: 13 },
        { header: '採購日期', width: 13 },
        { header: '保固到期', width: 13 },
        { header: '維修次數', width: 10 },
        { header: '待修中', width: 9 },
        { header: '轉移次數', width: 10 },
        { header: '資產規格/備註', width: 34 },
        { header: '備註事項', width: 30 },
        { header: '資產條碼 (貼紙)', width: 30 }
    ];
    const lastCol = columns.length;
    ws.columns = columns.map(c => ({ width: c.width }));

    ws.mergeCells(1, 1, 1, lastCol);
    const tCell = ws.getCell(1, 1);
    tCell.value = `📋 資訊資產盤點總表　共 ${assets.length} 筆　｜　匯出時間：${exportTime}`;
    tCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    tCell.alignment = { horizontal: 'center', vertical: 'middle' };
    tCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.primary } };
    ws.getRow(1).height = 32;

    ws.mergeCells(2, 1, 2, lastCol);
    const subCell = ws.getCell(2, 1);
    subCell.value = '※ 本表為全資產盤點總表；最右欄為「資產條碼貼紙」（上：資產編號　下：一維條碼 Code 128），可裁剪列印；列印時建議將縮放設為 100% 以確保條碼清晰可掃。';
    subCell.font = { size: 10, italic: true, color: { argb: 'FF555555' } };
    subCell.alignment = { horizontal: 'center', vertical: 'middle' };
    subCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.sub } };
    ws.getRow(2).height = 18;

    const headRow = ws.getRow(3);
    columns.forEach((c, i) => {
        const cell = headRow.getCell(i + 1);
        cell.value = c.header;
        cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.header } };
        cell.border = thinBorder('FF9DC3E6');
    });
    headRow.height = 28;

    const bcBuffers = assets.map(a => {
        try { return code128ToPngBuffer(String(a.asset_no || 'N/A'), { moduleWidth: 3, height: 150, quietModules: 10 }); }
        catch (e) { return null; }
    });

    const DATA_ROW_HEIGHT = 82;
    const STICKER_COL = 17;
    const firstDataRow = 4;

    assets.forEach((a, i) => {
        const r = firstDataRow + i;
        const row = ws.getRow(r);
        row.height = DATA_ROW_HEIGHT;
        const rep = repMap[a.id] || { total: 0, pending: 0 };
        const trCnt = trMap[a.id] || 0;
        const notesVal = (a.status === 'scrapped' && a.scrap_reason) ? `【報廢】${a.scrap_reason}` : (a.notes || '—');
        const vals = [
            i + 1, a.asset_no || '', deptDisplay(a), a.name || '', catNameMap[a.category] || a.category || '',
            a.sn || '—', a.custodian || '—', a.location || '—', a.vendor_name || '其他 (預設)',
            STATUS_NAMES[a.status] || a.status || '', fmtD(a.purchase_date), fmtD(a.warranty_date),
            rep.total, rep.pending, trCnt, (a.spec_note || '—'), notesVal, a.asset_no || ''
        ];
        vals.forEach((v, c) => {
            const cell = row.getCell(c + 1);
            cell.value = v;
            cell.border = thinBorder();
            cell.font = { size: 10 };
            const numeric = (c === 0 || c === 12 || c === 13 || c === 14);
            const leftAlign = (c === 3 || c === 15 || c === 16);
            cell.alignment = { horizontal: numeric ? 'center' : (leftAlign ? 'left' : 'center'), vertical: 'middle', wrapText: leftAlign, indent: leftAlign ? 1 : 0 };
            if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.zebra } };
        });
        row.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
        row.getCell(3).font = { size: 10, bold: true, color: { argb: 'FF6D28D9' } };
        row.getCell(4).font = { size: 10, bold: true };
        const ss = STATUS_STYLE[a.status];
        if (ss) { const sc = row.getCell(10); sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ss.bg } }; sc.font = { size: 10, bold: true, color: { argb: ss.fc } }; }
        if (a.status === 'scrapped' && a.scrap_reason) row.getCell(17).font = { size: 10, color: { argb: 'FFB91C1C' } };
        if (rep.pending > 0) row.getCell(14).font = { size: 10, bold: true, color: { argb: 'FFB45309' } };
        const stickerCell = row.getCell(STICKER_COL + 1);
        stickerCell.font = { size: 9, bold: true, color: { argb: 'FF1F4E78' } };
        stickerCell.alignment = { horizontal: 'center', vertical: 'top' };
        if (bcBuffers[i]) {
            const imgId = wb.addImage({ buffer: bcBuffers[i], extension: 'png' });
            ws.addImage(imgId, { tl: { col: STICKER_COL, row: (r - 1) + 0.30 }, br: { col: STICKER_COL + 1, row: (r - 1) + 0.99 }, editAs: 'twoCell' });
        }
    });

    const totalRow = firstDataRow + assets.length;
    ws.mergeCells(totalRow, 1, totalRow, lastCol);
    const tCell2 = ws.getCell(totalRow, 1);
    const cnt = (st) => assets.filter(a => a.status === st).length;
    const totRep = Object.keys(repMap).reduce((s, k) => s + (repMap[k].total || 0), 0);
    const totTr = Object.keys(trMap).reduce((s, k) => s + (trMap[k] || 0), 0);
    tCell2.value = `📊 總計：共 ${assets.length} 筆　｜　部門數 ${new Set(assets.map(a => String(a.department || 'IT').toUpperCase())).size}　｜　使用中 ${cnt('active')}　｜　庫存 ${cnt('inventory')}　｜　維修中 ${cnt('repair')}　｜　已報廢 ${cnt('scrapped')}　｜　維修總次數 ${totRep}　｜　轉移總次數 ${totTr}`;
    tCell2.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    tCell2.alignment = { horizontal: 'center', vertical: 'middle' };
    tCell2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CLR.primary } };
    tCell2.border = thinBorder();
    ws.getRow(totalRow).height = 26;

    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + assets.length, column: lastCol - 1 } };
    ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };

    const buffer = await wb.xlsx.writeBuffer();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    return { buffer: Buffer.from(buffer), count: assets.length, stamp: stamp };
}

module.exports = { buildInventoryXlsx };

