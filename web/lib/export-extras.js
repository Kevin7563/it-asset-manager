// =====================================================================
// 額外報表：單筆資產履歷 / 廠商清單 / 廠商維護歷程 / 匯入範本
// 版面沿用單機版配色（深藍標題列 + 淺藍表頭 + 斑馬紋）
// =====================================================================
const ExcelJS = require('exceljs');

const CLR = { primary: 'FF1F4E78', header: 'FF2E75B6', sub: 'FFDDEBF7', zebra: 'FFF2F7FC', label: 'FFEAF1F9', border: 'FFB4C6E7' };
const thinBorder = (color) => { const b = { style: 'thin', color: { argb: color || CLR.border } }; return { top: b, left: b, bottom: b, right: b }; };
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb } });

const CAT_NAMES = {
    hardware: '硬體設備 (HW)', software: '軟體授權 (SW)', network: '網路設備 (NET)',
    peripheral: '資訊周邊 (DEV)', credentials: '資訊與資料庫帳密 (SEC)'
};
const STATUS_NAMES = { active: '線上正常使用', inventory: '庫存備用', repair: '維修中', scrapped: '已報廢' };
const DEPT_NAMES = {
    IT: '資訊部門', DR: '院長室,醫師辦公室', TL: '督導', GA: '總務', MO: '行政', PT: '主任',
    AC: '人事,會計', CK: '廚房', SM: '倉庫', WO: '工務', LA: '檢驗室', OP: '婦科', IN: '兒科',
    PO: '警衛', OR: '產房', WA: '病房', HE: '申報', BR: '嬰兒室', CH: '病歷室', CO: '櫃台', P1: '藥局'
};

const fmtD = (s) => {
    if (!s) return '—';
    const d = new Date(s);
    return isNaN(d) ? String(s) : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};
const nowText = () => {
    const d = new Date();
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fileNameStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '');

function banner(ws, rowNo, lastCol, text, size) {
    ws.mergeCells(rowNo, 1, rowNo, lastCol);
    const c = ws.getCell(rowNo, 1);
    c.value = text;
    c.font = { bold: true, size: size || 14, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.fill = solid(CLR.primary);
    ws.getRow(rowNo).height = (size >= 16) ? 32 : 24;
}
function subBanner(ws, rowNo, lastCol, text) {
    ws.mergeCells(rowNo, 1, rowNo, lastCol);
    const c = ws.getCell(rowNo, 1);
    c.value = text;
    c.font = { size: 10, italic: true, color: { argb: 'FF555555' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.fill = solid(CLR.sub);
    ws.getRow(rowNo).height = 20;
}
function sectionBar(ws, rowNo, lastCol, text) {
    ws.mergeCells(rowNo, 1, rowNo, lastCol);
    const c = ws.getCell(rowNo, 1);
    c.value = text;
    c.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    c.fill = solid(CLR.header);
    c.border = thinBorder('FF9DC3E6');
    ws.getRow(rowNo).height = 24;
}
function headerCells(ws, rowNo, headers) {
    const row = ws.getRow(rowNo);
    headers.forEach((h, i) => {
        const cell = row.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = solid(CLR.header);
        cell.border = thinBorder('FF9DC3E6');
    });
    row.height = 28;
}
function paintRow(row, cols, zebra) {
    for (let c = 1; c <= cols; c++) {
        const cell = row.getCell(c);
        cell.border = thinBorder();
        if (zebra) cell.fill = solid(CLR.zebra);
    }
}
function labelCell(cell, text) {
    cell.value = text;
    cell.font = { bold: true, size: 10, color: { argb: 'FF333333' } };
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    cell.fill = solid(CLR.label);
}
function valueCell(cell, text, wrap) {
    cell.value = text;
    cell.font = { size: 10 };
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1, wrapText: !!wrap };
}

async function mapOptions(ctx) {
    const cats = Object.assign({}, CAT_NAMES);
    const deps = Object.assign({}, DEPT_NAMES);
    try {
        (await ctx.all(`SELECT value,label,code FROM field_options WHERE field_type='category'`)).forEach(o => { cats[o.value] = o.label + ' (' + o.code + ')'; });
        (await ctx.all(`SELECT code,label FROM field_options WHERE field_type='department'`)).forEach(o => { deps[o.code] = o.label; });
    } catch (e) {}
    return { cats, deps };
}
const deptText = (deps, code) => {
    const c = String(code || 'IT').toUpperCase();
    return deps[c] ? c + ' ' + deps[c] : c;
};

async function buildAssetHistoryXlsx(ctx, assetId) {
    const rows = await ctx.all(`SELECT a.*, COALESCE(v.name,'') AS vendor_name FROM assets_new a LEFT JOIN vendors_new v ON a.vendor_id = v.id WHERE a.id = ?`, [parseInt(assetId) || 0]);
    const asset = rows[0];
    if (!asset) throw new Error('找不到該資產。');
    const repairs = await ctx.all(`SELECT * FROM repairs_new WHERE asset_id = ? ORDER BY id DESC`, [asset.id]);
    const transfers = await ctx.all(`SELECT * FROM transfers_new WHERE asset_id = ? ORDER BY id DESC`, [asset.id]);
    const { cats, deps } = await mapOptions(ctx);
    const exportTime = nowText();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'IT Asset Manager (Web)';
    wb.created = new Date();

    // ===== 工作表 1：資產基本資料 =====
    const s1 = wb.addWorksheet('資產基本資料', { views: [{ state: 'frozen', ySplit: 3 }] });
    s1.columns = [{ width: 20 }, { width: 34 }, { width: 18 }, { width: 30 }];
    const L1 = 4;
    banner(s1, 1, L1, '📋 資訊資產履歷表', 16);
    subBanner(s1, 2, L1, `資產編號：${asset.asset_no || ''}　｜　匯出時間：${exportTime}`);
    subBanner(s1, 3, L1, '※ 本表為單一資產完整維運履歷；維修與轉移明細請參閱後續工作表。');
    sectionBar(s1, 4, L1, '【一、資產基本資料】');

    const infoRows = [
        ['資產編號', asset.asset_no || '', '資產大類', cats[asset.category] || asset.category || ''],
        ['設備名稱', asset.name || '', '購買廠商', asset.vendor_name || '其他 (預設)'],
        ['原廠序列號 (S/N)', asset.sn || '未填寫', '當前狀態', STATUS_NAMES[asset.status] || asset.status || ''],
        ['保管使用窗口', asset.custodian || '未填寫', '購置日期', fmtD(asset.purchase_date)],
        ['實體擺放地點', asset.location || '未填寫', '保固到期日', fmtD(asset.warranty_date)],
        ['所屬部門', deptText(deps, asset.department), '部門代碼', String(asset.department || 'IT').toUpperCase()]
    ];
    infoRows.forEach((row, i) => {
        const rowObj = s1.getRow(5 + i);
        rowObj.height = 22;
        paintRow(rowObj, L1, i % 2 === 1);
        labelCell(rowObj.getCell(1), row[0]); valueCell(rowObj.getCell(2), row[1]);
        labelCell(rowObj.getCell(3), row[2]); valueCell(rowObj.getCell(4), row[3]);
    });

    const sec2 = 5 + infoRows.length;
    sectionBar(s1, sec2, L1, '【二、資產規格、維運備註與報廢資訊】');
    const noteRows = [
        ['資產規格/備註', asset.spec_note || '無'],
        ['維運備註', asset.notes || '無'],
        ['報廢原因', (asset.status === 'scrapped') ? (asset.scrap_reason || '未填寫') : '—']
    ];
    noteRows.forEach((row, i) => {
        const r = sec2 + 1 + i;
        s1.mergeCells(r, 2, r, L1);
        const rowObj = s1.getRow(r);
        const txt = String(row[1] == null ? '' : row[1]);
        rowObj.height = Math.max(24, Math.min(150, Math.max(1, Math.ceil(txt.length / 38)) * 16 + 10));
        rowObj.getCell(1).border = thinBorder();
        labelCell(rowObj.getCell(1), row[0]);
        rowObj.getCell(2).border = thinBorder();
        rowObj.getCell(2).fill = solid(i % 2 === 1 ? CLR.zebra : 'FFFFFFFF');
        valueCell(rowObj.getCell(2), row[1], true);
    });

    const sec3 = sec2 + 1 + noteRows.length;
    sectionBar(s1, sec3, L1, '【三、維運統計總覽】');
    const statRows = [
        ['維修總次數', `${repairs.length} 次`, '轉移總次數', `${transfers.length} 次`],
        ['已完工維修', `${repairs.filter(r => r.status === 'completed').length} 次`, '維修中工單', `${repairs.filter(r => r.status === 'pending').length} 次`]
    ];
    statRows.forEach((row, i) => {
        const rowObj = s1.getRow(sec3 + 1 + i);
        rowObj.height = 22;
        paintRow(rowObj, L1, i % 2 === 1);
        labelCell(rowObj.getCell(1), row[0]); valueCell(rowObj.getCell(2), row[1]);
        labelCell(rowObj.getCell(3), row[2]); valueCell(rowObj.getCell(4), row[3]);
    });
    s1.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };

    // ===== 工作表 2：維修紀錄 =====
    const s2 = wb.addWorksheet('維修紀錄', { views: [{ state: 'frozen', ySplit: 3 }] });
    s2.columns = [{ width: 6 }, { width: 22 }, { width: 32 }, { width: 16 }, { width: 13 }, { width: 13 }, { width: 12 }, { width: 30 }];
    const S2 = 8;
    banner(s2, 1, S2, `🔧 維修紀錄　共 ${repairs.length} 筆`, 14);
    subBanner(s2, 2, S2, `資產編號：${asset.asset_no || ''}　｜　匯出時間：${exportTime}`);
    headerCells(s2, 3, ['次數', '資產編號', '故障情形', '維修廠商', '送修日期', '完工/結案', '費用(元)', '狀態 / 備註']);
    const repStatus = { pending: '維修中', completed: '已完工', scrapped: '因報廢結案' };
    if (!repairs.length) {
        s2.mergeCells(4, 1, 4, S2);
        const ec = s2.getCell(4, 1);
        ec.value = '本資產尚無維修紀錄。';
        ec.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
        ec.alignment = { horizontal: 'center', vertical: 'middle' };
        ec.fill = solid(CLR.sub);
        ec.border = thinBorder();
        s2.getRow(4).height = 24;
    } else {
        repairs.forEach((rp, i) => {
            const row = s2.getRow(4 + i);
            const vals = [
                repairs.length - i, rp.asset_no || '', rp.fault_description || '', rp.repair_vendor || '未指定',
                fmtD(rp.reported_date), rp.status === 'pending' ? '—' : fmtD(rp.completed_date),
                (rp.cost && Number(rp.cost) > 0) ? Number(rp.cost) : 0,
                (repStatus[rp.status] || rp.status || '') + (rp.notes ? `　${rp.notes}` : '')
            ];
            vals.forEach((v, c) => { row.getCell(c + 1).value = v; });
            paintRow(row, S2, i % 2 === 1);
            [1, 2, 5, 6, 7].forEach(c => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' }; });
            row.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
            row.getCell(3).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
            row.getCell(7).numFmt = '#,##0';
            row.getCell(8).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
        });
    }
    s2.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: S2 } };
    s2.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };

    // ===== 工作表 3：轉移紀錄 =====
    const s3 = wb.addWorksheet('轉移紀錄', { views: [{ state: 'frozen', ySplit: 3 }] });
    s3.columns = [{ width: 6 }, { width: 22 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 16 }, { width: 13 }, { width: 30 }];
    const S3 = 10;
    banner(s3, 1, S3, `🔄 轉移紀錄　共 ${transfers.length} 筆`, 14);
    subBanner(s3, 2, S3, `資產編號：${asset.asset_no || ''}　｜　匯出時間：${exportTime}`);
    headerCells(s3, 3, ['次數', '資產編號', '原部門', '新部門', '原保管人', '新保管人', '原位置', '新位置', '轉移日期', '原因 / 備註']);
    if (!transfers.length) {
        s3.mergeCells(4, 1, 4, S3);
        const ec = s3.getCell(4, 1);
        ec.value = '本資產尚無轉移紀錄。';
        ec.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
        ec.alignment = { horizontal: 'center', vertical: 'middle' };
        ec.fill = solid(CLR.sub);
        ec.border = thinBorder();
        s3.getRow(4).height = 24;
    } else {
        transfers.forEach((tf, i) => {
            const row = s3.getRow(4 + i);
            const vals = [
                transfers.length - i, tf.asset_no || '', deptText(deps, tf.from_department), deptText(deps, tf.to_department),
                tf.from_custodian || '—', tf.to_custodian || '—', tf.from_location || '—', tf.to_location || '—',
                fmtD(tf.transfer_date), [tf.reason, tf.notes].filter(x => x && String(x).trim()).join('　') || '—'
            ];
            vals.forEach((v, c) => { row.getCell(c + 1).value = v; });
            paintRow(row, S3, i % 2 === 1);
            row.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
            [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach(c => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' }; });
            row.getCell(10).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
        });
    }
    s3.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: S3 } };
    s3.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };

    const buffer = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), assetNo: asset.asset_no || String(asset.id), stamp: fileNameStamp() };
}

// ── 廠商清單 ──────────────────────────────────────────
async function buildVendorListXlsx(ctx) {
    const vendors = await ctx.all(`
        SELECT v.*,
          (SELECT COUNT(*) FROM assets_new a WHERE a.vendor_id = v.id AND a.is_deleted = 0) AS asset_count,
          (SELECT COUNT(*) FROM vendor_maint_records m WHERE m.vendor_id = v.id OR m.vendor_name = v.name) AS maint_count
        FROM vendors_new v ORDER BY v.id DESC`);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'IT Asset Manager (Web)';
    const ws = wb.addWorksheet('合作廠商清單', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = [{ width: 6 }, { width: 24 }, { width: 16 }, { width: 18 }, { width: 26 }, { width: 12 }, { width: 22 }, { width: 28 }, { width: 10 }, { width: 10 }];
    const LAST = 10;
    banner(ws, 1, LAST, `🏢 合作廠商清單　共 ${vendors.length} 家　｜　匯出時間：${nowText()}`, 16);
    subBanner(ws, 2, LAST, '※ 本表為廠商基本資料、NDA 與維護合約狀態；詳細維護紀錄請見「廠商維護歷程」報表。');
    headerCells(ws, 3, ['項次', '廠商名稱', '主要服務專員', '聯絡窗口電話', '通訊地址', '資安 NDA', '維護合約期間', '服務範疇', '使用資產數', '維護紀錄數']);
    if (!vendors.length) {
        ws.mergeCells(4, 1, 4, LAST);
        const ec = ws.getCell(4, 1);
        ec.value = '目前沒有廠商資料。';
        ec.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
        ec.alignment = { horizontal: 'center', vertical: 'middle' };
        ec.fill = solid(CLR.sub);
        ec.border = thinBorder();
    } else {
        vendors.forEach((v, i) => {
            const row = ws.getRow(4 + i);
            const period = (v.maint_start || v.maint_end) ? (fmtD(v.maint_start) + ' ~ ' + fmtD(v.maint_end)) : '未設定';
            const vals = [i + 1, v.name || '', v.representative || '—', v.phone || '—', v.address || '—',
                v.has_nda ? '已簽署' : '未簽署', period, v.service_items || '—', v.asset_count || 0, v.maint_count || 0];
            vals.forEach((val, c) => { row.getCell(c + 1).value = val; });
            paintRow(row, LAST, i % 2 === 1);
            row.getCell(2).font = { size: 10, bold: true, color: { argb: 'FF1F4E78' } };
            [1, 6, 9, 10].forEach(c => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' }; });
            [5, 8].forEach(c => { row.getCell(c).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 }; });
            const nda = row.getCell(6);
            nda.fill = solid(v.has_nda ? 'FFDCFCE7' : 'FFFEE2E2');
            nda.font = { size: 10, bold: true, color: { argb: v.has_nda ? 'FF166534' : 'FFB91C1C' } };
        });
    }
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: LAST } };
    ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
    const buffer = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), count: vendors.length, stamp: fileNameStamp() };
}

// ── 廠商維護歷程（可指定廠商）────────────────────────
async function buildVendorMaintXlsx(ctx, vendorName) {
    const name = String(vendorName || '').trim();
    const rows = name
        ? await ctx.all(`SELECT * FROM vendor_maint_records WHERE vendor_name = ? ORDER BY maint_date DESC, id DESC`, [name])
        : await ctx.all(`SELECT * FROM vendor_maint_records ORDER BY maint_date DESC, id DESC`);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'IT Asset Manager (Web)';
    const ws = wb.addWorksheet('廠商維護歷程', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = [{ width: 6 }, { width: 12 }, { width: 20 }, { width: 24 }, { width: 18 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 8 }, { width: 30 }, { width: 24 }];
    const LAST = 11;
    banner(ws, 1, LAST, `🗂️ 廠商維護歷程${name ? '　' + name : ''}　共 ${rows.length} 筆　｜　匯出時間：${nowText()}`, 16);
    subBanner(ws, 2, LAST, '※ 本表為廠商設備維護紀錄（日期、設備、類型、費用、簽收與內容）。');
    headerCells(ws, 3, ['項次', '維護日期', '廠商', '設備 / 項目', '設備序號', '維護類型', '處理人員', '費用(元)', '簽收', '維護內容', '備註']);
    if (!rows.length) {
        ws.mergeCells(4, 1, 4, LAST);
        const ec = ws.getCell(4, 1);
        ec.value = '目前沒有維護紀錄。';
        ec.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
        ec.alignment = { horizontal: 'center', vertical: 'middle' };
        ec.fill = solid(CLR.sub);
        ec.border = thinBorder();
    } else {
        rows.forEach((r, i) => {
            const row = ws.getRow(4 + i);
            const vals = [i + 1, fmtD(r.maint_date), r.vendor_name || '', r.equipment || '', r.equipment_sn || '',
                r.maint_type || '—', r.handler || '—', Number(r.cost) || 0, r.signed ? '✔' : '', r.content || '', r.notes || ''];
            vals.forEach((val, c) => { row.getCell(c + 1).value = val; });
            paintRow(row, LAST, i % 2 === 1);
            [1, 2, 8, 9].forEach(c => { row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' }; });
            row.getCell(4).font = { size: 10, bold: true };
            row.getCell(8).numFmt = '#,##0';
            [10, 11].forEach(c => { row.getCell(c).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 }; });
        });
    }
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: LAST } };
    ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
    const buffer = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer), count: rows.length, stamp: fileNameStamp() };
}

// ── 匯入範本 ──────────────────────────────────────────
function styleTemplateSheet(ws, title, headers, widths, example) {
    ws.columns = widths.map(w => ({ width: w }));
    const last = headers.length;
    ws.mergeCells(1, 1, 1, last);
    const t = ws.getCell(1, 1);
    t.value = title + '　—　請從「第 4 列」開始填寫資料';
    t.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    t.alignment = { horizontal: 'center', vertical: 'middle' };
    t.fill = solid(CLR.primary);
    ws.getRow(1).height = 30;

    ws.mergeCells(2, 1, 2, last);
    const s = ws.getCell(2, 1);
    s.value = '※ 請勿修改第 3 列的欄位名稱；填寫完成後存成 .xlsx，回到系統「📥 匯入／備份」上傳匯入。';
    s.font = { size: 10, italic: true, color: { argb: 'FF555555' } };
    s.alignment = { horizontal: 'center', vertical: 'middle' };
    s.fill = solid(CLR.sub);
    ws.getRow(2).height = 20;

    headerCells(ws, 3, headers);
    const ex = ws.getRow(4);
    example.forEach((v, i) => { ex.getCell(i + 1).value = v; });
    paintRow(ex, last, false);
    ex.eachCell(c => { c.font = { size: 10, color: { argb: 'FF888888' }, italic: true }; });
    ws.views = [{ state: 'frozen', ySplit: 3 }];
    return headerCells;
}

async function buildAssetTemplateXlsx() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'IT Asset Manager (Web)';
    const ws = wb.addWorksheet('匯入資料');
    styleTemplateSheet(ws,
        '📦 資產資料匯入範本',
        ['設備/項目名稱', '資產大類', '原廠序列號(S/N)', '保管使用窗口', '購置擺放地點', '連動合作廠商', '維運狀態', '採購日期', '保固到期日', '報廢原因', '資產規格/備註', '維運備註說明'],
        [26, 20, 22, 16, 16, 20, 16, 16, 16, 22, 32, 30],
        ['ASUS 商用電腦', '硬體設備 (HW)', 'SN12345678', 'kevin', 'B2', '聯強國際', '線上正常使用', '2026/09/29', '2029/09/29', '', 'i7-12700 / 32GB / 1TB SSD', '資產貼紙已張貼']);

    const note = wb.addWorksheet('填寫說明');
    note.columns = [{ width: 24 }, { width: 12 }, { width: 40 }, { width: 34 }];
    headerCells(note, 1, ['欄位名稱', '必填', '可填值 / 格式', '說明']);
    const rows = [
        ['設備/項目名稱', '✔', '文字', '必填'],
        ['資產大類', '✔', '硬體設備 (HW)、軟體授權 (SW)、網路設備 (NET)、資訊周邊 (DEV)、帳密安全性 (SEC)，或 hardware/software…', '必填；決定資產編號前綴'],
        ['原廠序列號(S/N)', '', '文字', '重複序號會自動略過'],
        ['保管使用窗口', '', '文字', ''],
        ['購置擺放地點', '', '文字', ''],
        ['連動合作廠商', '', '系統內既有廠商名稱', '找不到則記為「其他 (預設)」'],
        ['維運狀態', '', '線上正常使用 / 庫存備用 / 維修中 / 已報廢（空白＝庫存備用）', ''],
        ['採購日期', '', 'YYYY/MM/DD 或 YYYY-MM-DD', ''],
        ['保固到期日', '', 'YYYY/MM/DD 或 YYYY-MM-DD', ''],
        ['報廢原因', '', '文字', '狀態為已報廢時建議填寫'],
        ['資產規格/備註', '', '文字', '會顯示於總覽、履歷與盤點總表'],
        ['維運備註說明', '', '文字', '']
    ];
    rows.forEach((r, i) => {
        const row = note.getRow(2 + i);
        r.forEach((v, c) => { row.getCell(c + 1).value = v; });
        paintRow(row, 4, i % 2 === 1);
        row.getCell(1).font = { size: 10, bold: true };
        [3, 4].forEach(c => { row.getCell(c).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 }; });
        row.height = 30;
    });

    const buffer = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer) };
}

async function buildVendorTemplateXlsx() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'IT Asset Manager (Web)';
    const ws = wb.addWorksheet('匯入資料');
    styleTemplateSheet(ws,
        '🏢 廠商資料匯入範本',
        ['廠商公司名稱', '主要服務專員', '聯絡窗口電話', '通訊地址', '資安 NDA 狀態', '維護合約服務範疇', '維護合約開始日', '維護合約截止日'],
        [26, 16, 18, 34, 16, 28, 18, 18],
        ['聯強國際', '張工程師', '02-2508-1234', '台北市中山區民生東路三段 2 號', '已簽署', '伺服器與網路設備維護', '2026/01/01', '2026/12/31']);

    const note = wb.addWorksheet('填寫說明');
    note.columns = [{ width: 24 }, { width: 12 }, { width: 40 }, { width: 34 }];
    headerCells(note, 1, ['欄位名稱', '必填', '可填值 / 格式', '說明']);
    const rows = [
        ['廠商公司名稱', '✔', '文字', '同名視為更新既有廠商'],
        ['主要服務專員', '', '文字', ''],
        ['聯絡窗口電話', '', '文字', ''],
        ['通訊地址', '', '文字', ''],
        ['資安 NDA 狀態', '', '已簽署 / 尚未簽署（或 1 / 0）', '空白＝新增時預設未簽署'],
        ['維護合約服務範疇', '', '文字', ''],
        ['維護合約開始日', '', 'YYYY/MM/DD 或 YYYY-MM-DD', ''],
        ['維護合約截止日', '', 'YYYY/MM/DD 或 YYYY-MM-DD', '']
    ];
    rows.forEach((r, i) => {
        const row = note.getRow(2 + i);
        r.forEach((v, c) => { row.getCell(c + 1).value = v; });
        paintRow(row, 4, i % 2 === 1);
        row.getCell(1).font = { size: 10, bold: true };
        [3, 4].forEach(c => { row.getCell(c).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 }; });
        row.height = 28;
    });

    const buffer = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buffer) };
}

module.exports = {
    buildAssetHistoryXlsx,
    buildVendorListXlsx,
    buildVendorMaintXlsx,
    buildAssetTemplateXlsx,
    buildVendorTemplateXlsx
};




