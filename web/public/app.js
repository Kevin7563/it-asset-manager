// =====================================================================
// Web 版前端：分頁導覽 + 各模組 CRUD（管理者）／查詢（一般使用者）
// =====================================================================
(function () {
    'use strict';

    const FALLBACK_CAT = {
        hardware: '硬體設備 (HW)', software: '軟體授權 (SW)', network: '網路設備 (NET)',
        peripheral: '資訊周邊 (DEV)', credentials: '資訊與資料庫帳密 (SEC)'
    };
    const FALLBACK_DEPT = {
        IT: '資訊部門', DR: '院長室,醫師辦公室', TL: '督導', GA: '總務', MO: '行政', PT: '主任',
        AC: '人事,會計', CK: '廚房', SM: '倉庫', WO: '工務', LA: '檢驗室', OP: '婦科', IN: '兒科',
        PO: '警衛', OR: '產房', WA: '病房', HE: '申報', BR: '嬰兒室', CH: '病歷室', CO: '櫃台', P1: '藥局'
    };
    const STATUS = {
        active: { text: '使用中', cls: 'badge-active' },
        inventory: { text: '庫存備用', cls: 'badge-inventory' },
        repair: { text: '維修中', cls: 'badge-repair' },
        scrapped: { text: '已報廢', cls: 'badge-scrapped' }
    };
    const PAGE_TITLES = {
        dashboard: '📊 總覽看板', 'asset-new': '➕ 新增資訊資產', repairs: '🔧 資訊資產維修',
        transfers: '🔄 資訊資產轉移', recycle: '🗑️ 資源回收桶',
        'vendor-board': '📊 廠商管理看板', vendors: '➕ 新增廠商資訊', 'vendor-edit': '✏️ 廠商資料維護',
        'vendor-maint-log': '🗂️ 廠商維護歷程看板', 'vendor-maint-add': '📝 新增廠商維護紀錄',
        fields: '🧩 欄位管理', users: '👥 帳號管理', tools: '📥 匯入／備份', password: '🔒 修改我的密碼'
    };

    const state = {
        user: null, isAdmin: false,
        assets: [], vendors: [], repairs: [], transfers: [], maint: [], recycle: [], users: [],
        catOpts: [], depOpts: [], categories: {}, departments: {},
        locks: { asset: {}, vendor: {} }, lockedAsset: 0, lockedVendor: 0,
        vendorKeyword: '', vendorEditKeyword: '', maintKeyword: '', pendingVendorId: 0, vendorModalId: 0,
        keyword: '', page: 'dashboard', editingAssetId: 0, editingUserId: 0, editingUpdatedAt: ''
    };

    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const dash = (v) => (v != null && String(v).trim() !== '') ? esc(v) : '<span class="muted">—</span>';
    const money = (n) => (Number(n) || 0).toLocaleString();

    function toast(msg, type) {
        const box = $('toast-box');
        if (!box) return;
        const el = document.createElement('div');
        el.className = 'toast toast-' + (type || 'info');
        el.textContent = String(msg);
        box.appendChild(el);
        setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 4200);
    }

    async function api(path, options) {
        const opts = Object.assign({ credentials: 'same-origin' }, options || {});
        if (opts.body && !opts.headers) opts.headers = { 'Content-Type': 'application/json' };
        const res = await fetch(path, opts);
        let data = null;
        try { data = await res.json(); } catch (e) { data = null; }
        if (!res.ok) {
            const err = new Error((data && data.message) || ('HTTP ' + res.status));
            err.status = res.status;
            throw err;
        }
        return data;
    }
    const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });
    const put = (p, b) => api(p, { method: 'PUT', body: JSON.stringify(b || {}) });
    const del = (p) => api(p, { method: 'DELETE' });
    const confirmBox = (msg) => window.confirm(msg);

    // ── 登入 / 登出 ─────────────────────────────────────
    function showLogin() {
        $('app-view').classList.add('hidden');
        $('login-view').classList.remove('hidden');
        $('login-password').value = '';
        setTimeout(() => { try { $('login-username').focus(); } catch (e) {} }, 80);
    }

    function showApp(user) {
        state.user = user;
        state.isAdmin = user.role === 'admin';
        $('login-view').classList.add('hidden');
        $('app-view').classList.remove('hidden');
        applyRoleUI();
        showPage('dashboard');
    }

    async function doLogin(e) {
        if (e) e.preventDefault();
        const username = $('login-username').value.trim();
        const password = $('login-password').value;
        const errBox = $('login-error');
        const btn = $('login-btn');
        errBox.classList.add('hidden');
        if (!username || !password) { errBox.textContent = '請輸入帳號與密碼。'; errBox.classList.remove('hidden'); return; }
        btn.disabled = true; btn.textContent = '登入中...';
        try {
            const res = await post('/api/login', { username: username, password: password });
            await loadFieldOptions();
            showApp(res.user);
            toast('👋 歡迎回來，' + (res.user.displayName || res.user.username), 'ok');
        } catch (err) {
            errBox.textContent = err.message || '登入失敗。';
            errBox.classList.remove('hidden');
        } finally {
            btn.disabled = false; btn.textContent = '登入系統';
        }
    }

    async function doLogout() {
        try { await post('/api/logout'); } catch (e) {}
        state.user = null; state.isAdmin = false;
        state.assets = []; state.users = [];
        document.querySelectorAll('table tbody').forEach(tb => { tb.innerHTML = ''; });
        ['detail-modal', 'edit-modal', 'vendor-modal', 'files-modal'].forEach(id => { const m = $(id); if (m) m.classList.add('hidden'); });
        toast('👋 您已登出系統。', 'ok');
        showLogin();
    }

    // ── 導覽 / 權限 ─────────────────────────────────────
    function applyRoleUI() {
        document.querySelectorAll('[data-admin]').forEach(el => el.classList.toggle('hidden', !state.isAdmin));
        const label = state.user ? ((state.user.role === 'admin' ? '👑 ' : '👤 ') + (state.user.displayName || state.user.username)) : '—';
        const chip = $('user-chip'); if (chip) chip.textContent = label;
        const side = $('side-user'); if (side) side.textContent = label;
    }

    async function showPage(name) {
        if (!PAGE_TITLES[name]) name = 'dashboard';
        const adminPages = ['asset-new', 'repairs', 'transfers', 'recycle', 'vendor-board', 'vendors', 'vendor-edit', 'vendor-maint-log', 'vendor-maint-add', 'fields', 'users', 'tools'];
        if (!state.isAdmin && adminPages.indexOf(name) >= 0) {
            toast('⛔ 權限不足：此功能僅限管理者使用。', 'warn');
            return;
        }
        // 離開廠商維護頁時釋放編輯鎖
        if (state.lockedVendor && name !== 'vendor-edit') {
            post('/api/locks/release', { entity: 'vendor', id: state.lockedVendor }).catch(() => {});
            state.lockedVendor = 0;
        }
        state.page = name;
        document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
        const target = $('page-' + name);
        if (target) target.classList.remove('hidden');
        document.querySelectorAll('#side-nav .nav-item').forEach(el => el.classList.toggle('active', el.getAttribute('data-page') === name));
        const title = $('page-title'); if (title) title.textContent = PAGE_TITLES[name] || '';
        try { await refreshPage(name); } catch (e) { toast('載入失敗：' + e.message, 'err'); }
    }

    async function refreshPage(name) {
        if (name === 'dashboard') { await Promise.all([loadStats(), loadAssets()]); }
        if (name === 'asset-new') { await loadVendors(); }
        if (name === 'repairs') { await Promise.all([loadAssets(), loadRepairs()]); }
        if (name === 'transfers') { await Promise.all([loadAssets(), loadTransfers()]); }
        if (name === 'recycle') { await loadRecycle(); }
        if (name === 'vendor-board') { await loadVendors(); renderVendorStats(); }
        if (name === 'vendors') { await loadVendors(); clearVendorForm(); }
        if (name === 'vendor-edit') { await loadVendors(); renderVendorPicker(); }
        if (name === 'vendor-maint-log') { await loadMaint(); }
        if (name === 'vendor-maint-add') { await loadVendors(); }
        if (name === 'fields') { await loadFieldOptions(); renderFields(); }
        if (name === 'users') { await loadUsers(); }
        if (name === 'tools') { await loadVersionInfo(); }
    }

    // ── 對照表 / 選單 ───────────────────────────────────
    const catText = (v) => state.categories[v] || FALLBACK_CAT[v] || String(v || '—');
    const deptText = (code) => {
        const c = String(code || 'IT').toUpperCase();
        return state.departments[c] ? c + ' ' + state.departments[c] : (FALLBACK_DEPT[c] ? c + ' ' + FALLBACK_DEPT[c] : c);
    };
    const statusBadge = (code) => {
        const st = STATUS[code] || { text: code || '—', cls: '' };
        return '<span class="badge ' + st.cls + '">' + esc(st.text) + '</span>';
    };
    const lockIcon = (id, entity) => {
        const who = state.locks[entity] && state.locks[entity][id];
        return who ? '<span title="' + esc(who) + ' 編輯中" style="color:#b45309;">🔒</span> ' : '';
    };

    async function loadFieldOptions() {
        try {
            const res = await api('/api/field-options');
            state.catOpts = res.categories || [];
            state.depOpts = res.departments || [];
            state.categories = {};
            state.departments = {};
            state.catOpts.forEach(o => { state.categories[o.value] = o.label + ' (' + o.code + ')'; });
            state.depOpts.forEach(o => { state.departments[o.code] = o.label; });
            fillFieldSelects();
        } catch (e) { /* 使用預設對照 */ }
    }

    function fillFieldSelects() {
        const catSel = $('a-category');
        if (catSel) catSel.innerHTML = '<option value="">-- 請選擇 --</option>' + state.catOpts.map(o => `<option value="${esc(o.value)}">${esc(o.label)} (${esc(o.code)})</option>`).join('');
        const depOptions = state.depOpts.map(o => `<option value="${esc(o.code)}">${esc(o.label)} (${esc(o.code)})</option>`).join('');
        const aDep = $('a-department');
        if (aDep) aDep.innerHTML = depOptions;
        const tDep = $('t-to-dept');
        if (tDep) tDep.innerHTML = '<option value="">-- 請選擇新部門 --</option>' + depOptions;
    }

    function fillVendorSelects() {
        const opts = state.vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
        const aV = $('a-vendor'); if (aV) aV.innerHTML = '<option value="0">其他 (預設)</option>' + opts;
        const eV = $('e-vendor'); if (eV) eV.innerHTML = '<option value="0">其他 (預設)</option>' + opts;
        const mV = $('m-vendor'); if (mV) mV.innerHTML = '<option value="">-- 請選擇廠商 --</option>' + state.vendors.map(v => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
    }

    function fillAssetSelects() {
        const html = '<option value="">-- 請選擇資產 --</option>' + state.assets.map(a =>
            `<option value="${a.id}">[${esc(a.asset_no)}] ${esc(a.name)}（${esc(deptText(a.department))}）</option>`).join('');
        ['r-asset', 't-asset'].forEach(id => { const el = $(id); if (el) el.innerHTML = html; });
    }

    // ── 資料載入 ───────────────────────────────────────
    async function loadAssets() {
        const res = await api('/api/assets');
        state.assets = res.assets || [];
        try {
            const l = await api('/api/locks?entity=asset');
            state.locks.asset = {};
            (l.locks || []).forEach(x => { state.locks.asset[x.id] = x.username; });
        } catch (e) { state.locks.asset = {}; }
        fillAssetSelects();
        renderAssetTable();
    }

    async function loadStats() {
        const s = await api('/api/stats');
        const cnt = (k) => { const f = (s.byStatus || []).find(x => x.status === k); return f ? f.c : 0; };
        const cards = [
            { label: '資產總數', value: s.total, cls: 'stat-blue' },
            { label: '使用中', value: cnt('active'), cls: 'stat-green' },
            { label: '庫存備用', value: cnt('inventory'), cls: 'stat-cyan' },
            { label: '維修中', value: cnt('repair'), cls: 'stat-orange' },
            { label: '已報廢', value: cnt('scrapped'), cls: 'stat-red' },
            { label: '待處理維修', value: s.pendingRepairs, cls: 'stat-orange' },
            { label: '廠商數', value: s.vendors, cls: 'stat-blue' },
            { label: '回收桶', value: s.recycle, cls: 'stat-gray' }
        ];
        const box = $('stat-cards');
        if (box) box.innerHTML = cards.map(c => `<div class="stat-card ${c.cls}"><div class="stat-value">${c.value}</div><div class="stat-label">${c.label}</div></div>`).join('');
    }

    async function loadVendors() {
        const res = await api('/api/vendors');
        state.vendors = res.vendors || [];
        try {
            const l = await api('/api/locks?entity=vendor');
            state.locks.vendor = {};
            (l.locks || []).forEach(x => { state.locks.vendor[x.id] = x.username; });
        } catch (e) { state.locks.vendor = {}; }
        fillVendorSelects();
        renderVendors();
    }

    async function loadRepairs() {
        const res = await api('/api/repairs');
        state.repairs = res.repairs || [];
        renderRepairs();
    }

    async function loadTransfers() {
        const res = await api('/api/transfers');
        state.transfers = res.transfers || [];
        renderTransfers();
    }

    async function loadMaint() {
        const res = await api('/api/vendor-maint');
        state.maint = res.records || [];
        renderMaint();
    }

    async function loadRecycle() {
        const res = await api('/api/recycle');
        state.recycle = res.assets || [];
        renderRecycle();
    }

    async function loadUsers() {
        const res = await api('/api/users');
        state.users = res.users || [];
        renderUsers();
    }

    // ── 總覽表格 ───────────────────────────────────────
    function assetMatches(a, kw) {
        if (!kw) return true;
        const hay = [a.asset_no, a.name, a.custodian, a.location, a.sn, a.spec_note, a.notes, a.vendor_name,
            deptText(a.department), catText(a.category)].join(' ').toLowerCase();
        return hay.indexOf(kw) >= 0;
    }

    function renderAssetTable() {
        const tbody = document.querySelector('#asset-table tbody');
        if (!tbody) return;
        const kw = state.keyword.trim().toLowerCase();
        const list = state.assets.filter(a => assetMatches(a, kw));
        tbody.innerHTML = '';
        const label = $('count-label');
        if (label) label.textContent = kw ? ('符合 ' + list.length + ' / ' + state.assets.length + ' 筆') : ('共 ' + state.assets.length + ' 筆');
        const empty = $('empty-state'); if (empty) empty.classList.toggle('hidden', list.length > 0);
        list.forEach(item => {
            let notesHtml = item.notes ? esc(item.notes) : '<span class="muted">—</span>';
            if (item.status === 'scrapped' && item.scrap_reason) notesHtml += '<div style="color:#b91c1c;font-size:12px;margin-top:4px;">🚨 ' + esc(item.scrap_reason) + '</div>';
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td><span class="asset-no">' + esc(item.asset_no) + '</span></td>'
                + '<td><span class="dept">' + esc(deptText(item.department)) + '</span></td>'
                + '<td>' + lockIcon(item.id, 'asset') + '<a href="#" class="name-link">' + esc(item.name || '') + '</a></td>'
                + '<td>' + esc(catText(item.category)) + '</td>'
                + '<td>' + dash(item.custodian) + '</td>'
                + '<td>' + (item.vendor_name ? '🏢 ' + esc(item.vendor_name) : '<span class="muted">其他 (預設)</span>') + '</td>'
                + '<td style="text-align:center;">' + statusBadge(item.status) + '</td>'
                + '<td>' + (item.location ? '📍 ' + esc(item.location) : '<span class="muted">未標註</span>') + '</td>'
                + '<td style="font-size:12.5px;">' + dash(item.spec_note) + '</td>'
                + '<td style="font-size:12.5px;">' + notesHtml + '</td>';
            tr.querySelector('.name-link').addEventListener('click', (e) => { e.preventDefault(); openDetail(item.id); });
            tbody.appendChild(tr);
        });
    }

    function closeDetail() { $('detail-modal').classList.add('hidden'); }
    function closeEdit() {
        const id = state.lockedAsset;
        if (id) { post('/api/locks/release', { entity: 'asset', id: id }).catch(() => {}); state.lockedAsset = 0; }
        $('edit-modal').classList.add('hidden');
    }

    async function openDetail(id) {
        try {
            const res = await api('/api/assets/' + id);
            const a = res.asset || {};
            state.editingAssetId = a.id;
            $('modal-title').textContent = '📋 資產維運履歷 ｜ ' + (a.asset_no || '');
            $('modal-info').innerHTML =
                '<div><b>📦 設備名稱：</b>' + dash(a.name) + '</div>'
                + '<div><b>🏷️ 資產大類：</b>' + esc(catText(a.category)) + '</div>'
                + '<div><b>🏢 所屬部門：</b><span class="dept">' + esc(deptText(a.department)) + '</span></div>'
                + '<div><b>👤 保管窗口：</b>' + dash(a.custodian) + '</div>'
                + '<div><b>🏢 購買廠商：</b>' + (a.vendor_name ? esc(a.vendor_name) : '<span class="muted">其他 (預設)</span>') + '</div>'
                + '<div><b>🔢 原廠序列號：</b>' + dash(a.sn) + '</div>'
                + '<div><b>📊 當前狀態：</b>' + statusBadge(a.status) + '</div>'
                + '<div><b>📅 購置日期：</b>' + dash(a.purchase_date) + '</div>'
                + '<div><b>🛡️ 保固到期：</b>' + dash(a.warranty_date) + '</div>'
                + '<div><b>📍 實體擺放地點：</b>' + dash(a.location) + '</div>'
                + (a.spec_note ? '<div class="full"><b>🧾 資產規格/備註：</b>' + esc(a.spec_note) + '</div>' : '')
                + (a.notes ? '<div class="full"><b>📝 維運備註：</b>' + esc(a.notes) + '</div>' : '')
                + ((a.status === 'scrapped' && a.scrap_reason) ? '<div class="full" style="color:#b91c1c;"><b>🚨 報廢原因：</b>' + esc(a.scrap_reason) + '</div>' : '');

            const rep = res.repairs || [];
            $('modal-repairs').innerHTML = rep.length === 0 ? '<div class="mini-empty">本資產尚無維修紀錄。</div>' :
                rep.map(r => {
                    const stText = r.status === 'completed' ? '✅ 已完工' : (r.status === 'scrapped' ? '🚨 因報廢結案' : '🟡 維修中');
                    const cost = (r.cost && Number(r.cost) > 0) ? ('　｜　💰 ' + money(r.cost) + ' 元') : '';
                    return '<div class="mini-item"><div class="row1"><span>' + esc(r.fault_description || '(未填寫)') + '</span><span>' + stText + '</span></div>'
                        + '<div class="sub">🔧 ' + esc(r.repair_vendor || '未指定') + cost + '　｜　📅 送修 ' + esc(r.reported_date || '—') + '　完工 ' + esc(r.completed_date || '—') + '</div>'
                        + (r.notes ? '<div class="sub">📝 ' + esc(r.notes) + '</div>' : '') + '</div>';
                }).join('');

            const trs = res.transfers || [];
            $('modal-transfers').innerHTML = trs.length === 0 ? '<div class="mini-empty">本資產尚無轉移紀錄。</div>' :
                trs.map(t => {
                    const reason = [t.reason, t.notes].filter(x => x && String(x).trim()).join('　');
                    return '<div class="mini-item"><div class="row1"><span>🏢 ' + esc(deptText(t.from_department)) + ' → ' + esc(deptText(t.to_department)) + '</span><span>📅 ' + esc(t.transfer_date || '—') + '</span></div>'
                        + '<div class="sub">👤 ' + esc(t.from_custodian || '—') + ' → ' + esc(t.to_custodian || '—') + '　｜　📍 ' + esc(t.from_location || '—') + ' → ' + esc(t.to_location || '—') + '</div>'
                        + (reason ? '<div class="sub">📝 ' + esc(reason) + '</div>' : '') + '</div>';
                }).join('');

            const editBtn = $('modal-edit-btn');
            if (editBtn) editBtn.style.display = state.isAdmin ? '' : 'none';
            $('detail-modal').classList.remove('hidden');
        } catch (err) { toast('❌ 載入履歷失敗：' + err.message, 'err'); }
    }

    async function openEditFromDetail() {
        const a = state.assets.find(x => x.id === state.editingAssetId);
        if (!a) return;
        try {
            await post('/api/locks/acquire', { entity: 'asset', id: a.id });
            state.lockedAsset = a.id;
        } catch (err) {
            toast(err.message || '目前無法編輯（可能有人正在編輯）。', 'warn');
            return;
        }
        closeDetail();
        state.editingUpdatedAt = a.updated_at || '';
        $('edit-title').textContent = '✏️ 編輯資產 ｜ ' + a.asset_no;
        $('e-no').value = a.asset_no || '';
        $('e-name').value = a.name || '';
        $('e-sn').value = a.sn || '';
        $('e-vendor').value = String(a.vendor_id || 0);
        $('e-status').value = a.status || 'active';
        $('e-scrap').value = a.scrap_reason || '';
        $('e-purchase').value = (a.purchase_date || '').slice(0, 10);
        $('e-warranty').value = (a.warranty_date || '').slice(0, 10);
        $('e-spec').value = a.spec_note || '';
        $('e-notes').value = a.notes || '';
        $('edit-modal').classList.remove('hidden');
    }

    async function submitEditAsset(e) {
        e.preventDefault();
        const id = state.editingAssetId;
        if (!id) return;
        try {
            await put('/api/assets/' + id, {
                name: $('e-name').value.trim(), sn: $('e-sn').value.trim(),
                vendor_id: parseInt($('e-vendor').value, 10) || 0,
                status: $('e-status').value, scrap_reason: $('e-scrap').value.trim(),
                purchase_date: $('e-purchase').value, warranty_date: $('e-warranty').value,
                spec_note: $('e-spec').value.trim(), notes: $('e-notes').value.trim(),
                expectedUpdatedAt: state.editingUpdatedAt
            });
            closeEdit();
            toast('💾 資產已更新。', 'ok');
            await loadAssets();
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function deleteCurrentAsset() {
        const id = state.editingAssetId;
        if (!id) return;
        if (!confirmBox('🗑️ 確定要將此資產移至資源回收桶嗎？')) return;
        try {
            await del('/api/assets/' + id);
            closeEdit();
            toast('🗑️ 已移至資源回收桶。', 'ok');
            await loadAssets();
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 匯出 Excel ─────────────────────────────────────
    async function doExport() {
        const btn = $('export-btn');
        const old = btn.textContent;
        btn.disabled = true; btn.textContent = '⏳ 產生中...';
        try {
            const res = await fetch('/api/export/inventory.xlsx', { credentials: 'same-origin' });
            if (!res.ok) {
                let msg = '匯出失敗（HTTP ' + res.status + '）';
                try { const d = await res.json(); if (d && d.message) msg = d.message; } catch (e) {}
                throw new Error(msg);
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'IT_資產盤點總表.xlsx';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 8000);
            toast('✅ 盤點總表已開始下載（含條碼貼紙欄）', 'ok');
        } catch (err) {
            toast('❌ ' + (err.message || '匯出失敗'), 'err');
        } finally {
            btn.disabled = false; btn.textContent = old;
        }
    }

    // ── 維修 / 轉移列表 ────────────────────────────────
    function renderRepairs() {
        const tbody = document.querySelector('#repairs-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!state.repairs.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">目前沒有維修紀錄。</td></tr>'; return; }
        state.repairs.forEach(r => {
            const stText = r.status === 'completed' ? '<span class="badge badge-active">已完工</span>'
                : (r.status === 'scrapped' ? '<span class="badge badge-scrapped">因報廢結案</span>' : '<span class="badge badge-repair">維修中</span>');
            const tr = document.createElement('tr');
            tr.innerHTML = '<td><span class="asset-no">' + esc(r.asset_no) + '</span></td>'
                + '<td><strong>' + esc(r.asset_name || '') + '</strong><div class="sub">' + esc(r.fault_description || '') + (r.notes ? '　📝 ' + esc(r.notes) : '') + '</div></td>'
                + '<td>' + esc(r.repair_vendor || '未指定') + '</td>'
                + '<td>' + esc(r.reported_date || '—') + '</td>'
                + '<td>' + esc(r.completed_date || '—') + '</td>'
                + '<td style="text-align:right;">' + (Number(r.cost) > 0 ? money(r.cost) : '—') + '</td>'
                + '<td style="text-align:center;">' + stText + '</td>'
                + '<td style="text-align:center;white-space:nowrap;">'
                + (r.status === 'pending' ? '<button class="btn btn-success btn-sm" data-complete="' + r.id + '">✅ 完工</button> ' : '')
                + '<button class="btn btn-danger btn-sm" data-del-repair="' + r.id + '">🗑️</button></td>';
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-complete]').forEach(btn => btn.addEventListener('click', () => completeRepair(Number(btn.getAttribute('data-complete')))));
        tbody.querySelectorAll('[data-del-repair]').forEach(btn => btn.addEventListener('click', () => removeRepair(Number(btn.getAttribute('data-del-repair')))));
    }

    async function completeRepair(id) {
        if (!confirmBox('✅ 確認此維修已完工？資產狀態會回復為「使用中」。')) return;
        try { await post('/api/repairs/' + id + '/complete'); toast('✅ 已完工，資產回復使用中。', 'ok'); await Promise.all([loadRepairs(), loadAssets()]); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function removeRepair(id) {
        if (!confirmBox('🗑️ 確定刪除此維修紀錄？')) return;
        try { await del('/api/repairs/' + id); toast('🗑️ 已刪除維修紀錄。', 'ok'); await loadRepairs(); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    function renderTransfers() {
        const tbody = document.querySelector('#transfers-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!state.transfers.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">目前沒有轉移紀錄。</td></tr>'; return; }
        state.transfers.forEach(t => {
            const tr = document.createElement('tr');
            const reason = [t.reason, t.notes].filter(x => x && String(x).trim()).join('　');
            tr.innerHTML = '<td><span class="asset-no">' + esc(t.asset_no) + '</span></td>'
                + '<td>' + esc(t.asset_name || '') + '</td>'
                + '<td>' + esc(deptText(t.from_department)) + ' → <strong>' + esc(deptText(t.to_department)) + '</strong></td>'
                + '<td>' + esc(t.from_custodian || '—') + ' → <strong>' + esc(t.to_custodian || '—') + '</strong></td>'
                + '<td>' + esc(t.transfer_date || '—') + '</td>'
                + '<td class="sub">' + (reason ? esc(reason) : '—') + '</td>'
                + '<td style="text-align:center;"><button class="btn btn-danger btn-sm" data-del-transfer="' + t.id + '">🗑️ 刪除</button></td>';
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-del-transfer]').forEach(btn => btn.addEventListener('click', () => removeTransfer(Number(btn.getAttribute('data-del-transfer')))));
    }

    async function removeTransfer(id) {
        if (!confirmBox('🗑️ 確定刪除此轉移紀錄？（不會還原資產目前狀態）')) return;
        try { await del('/api/transfers/' + id); toast('🗑️ 已刪除轉移紀錄。', 'ok'); await loadTransfers(); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 廠商 / 維護紀錄 / 回收桶 ───────────────────────
    // ── 廠商管理看板 ────────────────────────────────────
    function vendorMatches(v, kw) {
        if (!kw) return true;
        const hay = [v.name, v.representative, v.phone, v.address, v.service_items].join(' ').toLowerCase();
        return hay.indexOf(kw) >= 0;
    }

    function vendorMaintBadge(start, end) {
        if (!end) return '<span class="badge badge-inventory">未設定合約</span>';
        const today = new Date().toISOString().slice(0, 10);
        if (end < today) return '<span class="badge badge-scrapped">⚠️ 合約已到期</span>';
        const soonLimit = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
        if (end <= soonLimit) return '<span class="badge badge-repair">🕒 60 天內到期</span>';
        return '<span class="badge badge-active">✅ 合約有效</span>';
    }

    function renderVendors() {
        const tbody = document.querySelector('#vendors-table tbody');
        if (!tbody) return;
        const kw = String(state.vendorKeyword || '').trim().toLowerCase();
        const list = state.vendors.filter(v => vendorMatches(v, kw));
        tbody.innerHTML = '';
        const label = $('vendor-count-label');
        if (label) label.textContent = kw ? ('符合 ' + list.length + ' / ' + state.vendors.length + ' 家') : ('共 ' + state.vendors.length + ' 家');
        const empty = $('vendors-empty'); if (empty) empty.classList.toggle('hidden', list.length > 0);
        if (!list.length) return;
        list.forEach(v => {
            const nda = v.has_nda ? '<span class="badge badge-active">已簽署</span>' : '<span class="badge badge-scrapped">未簽署</span>';
            const period = (v.maint_start || v.maint_end) ? (esc(v.maint_start || '—') + ' ~ ' + esc(v.maint_end || '—')) : '<span class="muted">未設定</span>';
            const tr = document.createElement('tr');
            tr.innerHTML = '<td>' + lockIcon(v.id, 'vendor') + '<a href="#" class="name-link" data-view-vendor="' + v.id + '" title="點擊查看完整資訊">' + esc(v.name) + '</a>' + (v.address ? '<div class="sub">' + esc(v.address) + '</div>' : '') + '</td>'
                + '<td>' + dash(v.representative) + '</td>'
                + '<td>' + dash(v.phone) + '</td>'
                + '<td style="text-align:center;">' + nda + '</td>'
                + '<td style="font-size:12px;">' + vendorMaintBadge(v.maint_start, v.maint_end) + '<div class="sub" style="margin-top:3px;font-size:11.5px;">📅 ' + period + '</div></td>'
                + '<td style="text-align:center;white-space:nowrap;">'
                + '<button class="btn btn-ghost btn-sm" data-goto-edit="' + v.id + '">✏️ 維護</button> '
                + '<button class="btn btn-primary btn-sm" data-files-vendor="' + v.id + '">📎</button> '
                + '<button class="btn btn-danger btn-sm" data-del-vendor="' + v.id + '">🗑️</button></td>';
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-view-vendor]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); openVendorDetail(Number(a.getAttribute('data-view-vendor'))); }));
        tbody.querySelectorAll('[data-goto-edit]').forEach(btn => btn.addEventListener('click', () => gotoVendorEdit(Number(btn.getAttribute('data-goto-edit')))));
        tbody.querySelectorAll('[data-files-vendor]').forEach(btn => btn.addEventListener('click', () => openVendorFiles(Number(btn.getAttribute('data-files-vendor')))));
        tbody.querySelectorAll('[data-del-vendor]').forEach(btn => btn.addEventListener('click', () => removeVendor(Number(btn.getAttribute('data-del-vendor')))));
    }

    function renderVendorStats() {
        const box = $('vendor-stats');
        if (!box) return;
        const total = state.vendors.length;
        const noNda = state.vendors.filter(v => !v.has_nda).length;
        const today = new Date().toISOString().slice(0, 10);
        const soon = state.vendors.filter(v => v.maint_end && v.maint_end >= today && v.maint_end <= new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)).length;
        const expired = state.vendors.filter(v => v.maint_end && v.maint_end < today).length;
        const cards = [
            { label: '廠商總數', value: total, cls: 'stat-blue' },
            { label: '未簽 NDA', value: noNda, cls: 'stat-red' },
            { label: '合約 60 天內到期', value: soon, cls: 'stat-orange' },
            { label: '合約已到期', value: expired, cls: 'stat-gray' }
        ];
        box.innerHTML = cards.map(c => '<div class="stat-card ' + c.cls + '"><div class="stat-value">' + c.value + '</div><div class="stat-label">' + c.label + '</div></div>').join('');
    }

    // ── 廠商資料維護（獨立頁面）────────────────────────
    async function gotoVendorEdit(id) {
        state.pendingVendorId = id;
        await showPage('vendor-edit');
    }

    function renderVendorPicker(keyword) {
        const sel = $('vendor-edit-select');
        if (!sel) return;
        const kw = String(keyword == null ? (state.vendorEditKeyword || '') : keyword).trim().toLowerCase();
        const list = state.vendors.filter(v => vendorMatches(v, kw));
        const cur = sel.value;
        sel.innerHTML = '<option value="">-- 請選擇廠商（共 ' + list.length + ' 家）--</option>' +
            list.map(v => '<option value="' + v.id + '">' + esc(v.name) + (v.phone ? '（' + esc(v.phone) + '）' : '') + '</option>').join('');
        if (cur && list.some(v => String(v.id) === cur)) sel.value = cur;
        if (state.pendingVendorId) {
            const target = state.pendingVendorId;
            state.pendingVendorId = 0;
            sel.value = String(target);
            loadVendorIntoEdit(target);
        }
    }

    async function loadVendorIntoEdit(id) {
        const v = state.vendors.find(x => x.id === Number(id));
        if (!v) { toast('⚠️ 請先選擇廠商。', 'warn'); return; }
        if (state.lockedVendor && state.lockedVendor !== v.id) {
            await post('/api/locks/release', { entity: 'vendor', id: state.lockedVendor }).catch(() => {});
            state.lockedVendor = 0;
        }
        try {
            await post('/api/locks/acquire', { entity: 'vendor', id: v.id });
            state.lockedVendor = v.id;
        } catch (err) { toast(err.message, 'warn'); return; }
        $('ve-id').value = v.id;
        $('ve-name').value = v.name || '';
        $('ve-rep').value = v.representative || '';
        $('ve-phone').value = v.phone || '';
        $('ve-address').value = v.address || '';
        $('ve-nda').value = String(v.has_nda ? 1 : 0);
        $('ve-items').value = v.service_items || '';
        $('ve-start').value = (v.maint_start || '').slice(0, 10);
        $('ve-end').value = (v.maint_end || '').slice(0, 10);
        $('form-vendor-edit').classList.remove('hidden');
        const note = $('vendor-edit-note');
        if (note) { note.className = 'tip-mini'; note.textContent = '✏️ 正在維護：' + v.name + '（已取得編輯鎖，其他人無法同時編輯）'; }
        const sel = $('vendor-edit-select'); if (sel) sel.value = String(v.id);
    }

    function clearVendorEditForm() {
        if (state.lockedVendor) {
            post('/api/locks/release', { entity: 'vendor', id: state.lockedVendor }).catch(() => {});
            state.lockedVendor = 0;
        }
        ['ve-id', 've-name', 've-rep', 've-phone', 've-address', 've-items', 've-start', 've-end'].forEach(id => { const el = $(id); if (el) el.value = ''; });
        const nda = $('ve-nda'); if (nda) nda.value = '1';
        const f = $('form-vendor-edit'); if (f) f.classList.add('hidden');
        const note = $('vendor-edit-note');
        if (note) { note.className = 'tip-mini'; note.textContent = 'ℹ️ 請先選擇要維護的廠商（也可從「📊 廠商管理看板」按 ✏️ 直接帶入）。'; }
    }

    async function submitVendorEdit(e) {
        e.preventDefault();
        const id = parseInt($('ve-id').value, 10) || 0;
        if (!id) { toast('⚠️ 請先選擇廠商。', 'warn'); return; }
        try {
            await put('/api/vendors/' + id, {
                name: $('ve-name').value.trim(),
                representative: $('ve-rep').value.trim(),
                phone: $('ve-phone').value.trim(),
                address: $('ve-address').value.trim(),
                has_nda: $('ve-nda').value === '1',
                service_items: $('ve-items').value.trim(),
                maint_start: $('ve-start').value,
                maint_end: $('ve-end').value
            });
            toast('💾 廠商資料已更新。', 'ok');
            state.lockedVendor = 0;
            await loadVendors();
            clearVendorEditForm();
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function deleteVendorFromEdit() {
        const id = parseInt($('ve-id').value, 10) || 0;
        if (!id) return;
        const v = state.vendors.find(x => x.id === id);
        if (!confirmBox('🗑️ 確定要註銷「' + (v ? v.name : '') + '」？\n（相關資產會改為「其他 (預設)」，維護紀錄一併刪除）')) return;
        try {
            await del('/api/vendors/' + id);
            toast('🗑️ 已註銷廠商。', 'ok');
            state.lockedVendor = 0;
            clearVendorEditForm();
            await loadVendors();
            await showPage('vendor-board');
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    function clearVendorForm() {
        ['v-name', 'v-rep', 'v-phone', 'v-address', 'v-items', 'v-start', 'v-end'].forEach(id => { const el = $(id); if (el) el.value = ''; });
        const nda = $('v-nda'); if (nda) nda.value = '1';
    }


    async function removeVendor(id) {
        if (!confirmBox('🗑️ 確定要刪除此廠商？\n（相關資產會改為「其他 (預設)」，維護紀錄一併刪除）')) return;
        try { await del('/api/vendors/' + id); toast('🗑️ 已刪除廠商。', 'ok'); await Promise.all([loadVendors(), loadMaint()]); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    function renderMaint() {
        const tbody = document.querySelector('#maint-table tbody');
        if (!tbody) return;
        const kw = String(state.maintKeyword || '').trim().toLowerCase();
        const list = state.maint.filter(r => {
            if (!kw) return true;
            return [r.vendor_name, r.equipment, r.equipment_sn, r.maint_type, r.content, r.notes, r.handler].join(' ').toLowerCase().indexOf(kw) >= 0;
        });
        tbody.innerHTML = '';
        const label = $('maint-count-label');
        if (label) label.textContent = kw ? ('符合 ' + list.length + ' / ' + state.maint.length + ' 筆') : ('共 ' + state.maint.length + ' 筆');
        const empty = $('maint-empty'); if (empty) empty.classList.toggle('hidden', list.length > 0);
        if (!list.length) return;
        list.forEach(r => {
            const tr = document.createElement('tr');
            const content = [r.content, r.notes].filter(x => x && String(x).trim()).join('　');
            tr.innerHTML = '<td>' + esc(r.maint_date || '—') + '</td>'
                + '<td>' + ((r.vendor_id && state.vendors.some(x => x.id === r.vendor_id))
                    ? '<a href="#" class="name-link" data-view-vendor="' + r.vendor_id + '" title="點擊查看廠商完整資訊">' + esc(r.vendor_name || '') + '</a>'
                    : esc(r.vendor_name || '')) + '</td>'
                + '<td><strong>' + esc(r.equipment || '') + '</strong>' + (r.equipment_sn ? ' <span class="sub">(' + esc(r.equipment_sn) + ')</span>' : '')
                + (content ? '<div class="sub">' + esc(content) + '</div>' : '') + '</td>'
                + '<td>' + dash(r.maint_type) + '</td>'
                + '<td style="text-align:right;">' + (Number(r.cost) > 0 ? money(r.cost) : '—') + '</td>'
                + '<td style="text-align:center;">' + (r.signed ? '✅' : '—') + '</td>'
                + '<td style="text-align:center;white-space:nowrap;">'
                + '<button class="btn btn-primary btn-sm" data-files-maint="' + r.id + '">📎</button> '
                + '<button class="btn btn-danger btn-sm" data-del-maint="' + r.id + '">🗑️</button></td>';
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-files-maint]').forEach(btn => btn.addEventListener('click', () => openMaintDocs(Number(btn.getAttribute('data-files-maint')))));
        tbody.querySelectorAll('[data-view-vendor]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); openVendorDetail(Number(a.getAttribute('data-view-vendor'))); }));
        tbody.querySelectorAll('[data-del-maint]').forEach(btn => btn.addEventListener('click', () => removeMaint(Number(btn.getAttribute('data-del-maint')))));
    }

    async function removeMaint(id) {
        if (!confirmBox('🗑️ 確定刪除此維護紀錄？')) return;
        try { await del('/api/vendor-maint/' + id); toast('🗑️ 已刪除維護紀錄。', 'ok'); await loadMaint(); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    function renderRecycle() {
        const tbody = document.querySelector('#recycle-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        const empty = $('recycle-empty'); if (empty) empty.classList.toggle('hidden', state.recycle.length > 0);
        if (!state.recycle.length) return;
        state.recycle.forEach(a => {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td><span class="asset-no">' + esc(a.asset_no) + '</span></td>'
                + '<td>' + esc(a.name || '') + '</td>'
                + '<td><span class="dept">' + esc(deptText(a.department)) + '</span></td>'
                + '<td>' + esc(catText(a.category)) + '</td>'
                + '<td>' + dash(a.custodian) + '</td>'
                + '<td style="text-align:center;"><button class="btn btn-success btn-sm" data-restore="' + a.id + '">🔄 還原</button></td>';
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', () => restoreAsset(Number(btn.getAttribute('data-restore')))));
    }

    async function restoreAsset(id) {
        if (!confirmBox('🔄 確定要將此資產還原到總覽？')) return;
        try { await post('/api/assets/' + id + '/restore'); toast('🔄 已還原資產。', 'ok'); await loadRecycle(); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 欄位管理 ───────────────────────────────────────
    function renderFields() {
        const catBody = document.querySelector('#fields-cat-table tbody');
        if (catBody) {
            catBody.innerHTML = state.catOpts.length ? '' : '<tr><td colspan="3" class="empty">尚無選項。</td></tr>';
            state.catOpts.forEach(o => {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td>' + esc(o.label) + '</td><td>' + esc(o.code) + '</td>'
                    + '<td style="text-align:center;"><button class="btn btn-danger btn-sm" data-del-field="' + o.id + '">🗑️</button></td>';
                catBody.appendChild(tr);
            });
            catBody.querySelectorAll('[data-del-field]').forEach(btn => btn.addEventListener('click', () => removeField(Number(btn.getAttribute('data-del-field')))));
        }
        const depBody = document.querySelector('#fields-dep-table tbody');
        if (depBody) {
            depBody.innerHTML = state.depOpts.length ? '' : '<tr><td colspan="3" class="empty">尚無選項。</td></tr>';
            state.depOpts.forEach(o => {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td>' + esc(o.label) + '</td><td>' + esc(o.code) + '</td>'
                    + '<td style="text-align:center;"><button class="btn btn-danger btn-sm" data-del-field="' + o.id + '">🗑️</button></td>';
                depBody.appendChild(tr);
            });
            depBody.querySelectorAll('[data-del-field]').forEach(btn => btn.addEventListener('click', () => removeField(Number(btn.getAttribute('data-del-field')))));
        }
    }

    async function addField(type) {
        const label = $(type === 'category' ? 'fc-label' : 'fd-label').value.trim();
        const code = $(type === 'category' ? 'fc-code' : 'fd-code').value.trim().toUpperCase();
        if (!label || !code) { toast('⚠️ 請填寫名稱與代號。', 'warn'); return; }
        try {
            await post('/api/field-options', { type: type, label: label, code: code });
            toast('✅ 已新增' + (type === 'category' ? '資產大類' : '部門') + '：' + label + '（' + code + '）', 'ok');
            $(type === 'category' ? 'fc-label' : 'fd-label').value = '';
            $(type === 'category' ? 'fc-code' : 'fd-code').value = '';
            await loadFieldOptions();
            renderFields();
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function removeField(id) {
        if (!confirmBox('🗑️ 確定刪除此選項？（既有資產不受影響，但之後新增時無法再選用）')) return;
        try { await del('/api/field-options/' + id); toast('🗑️ 已刪除選項。', 'ok'); await loadFieldOptions(); renderFields(); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 帳號管理 ───────────────────────────────────────
    function renderUsers() {
        const tbody = document.querySelector('#users-table tbody');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!state.users.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">尚無帳號。</td></tr>'; return; }
        state.users.forEach(u => {
            const self = state.user && u.id === state.user.id;
            const roleBadge = u.role === 'admin' ? '<span class="role-pill role-admin">👑 管理者</span>' : '<span class="role-pill role-user">👤 一般</span>';
            const activeBadge = u.is_active ? '<span class="badge badge-active">啟用</span>' : '<span class="badge badge-scrapped">停用</span>';
            const tr = document.createElement('tr');
            tr.innerHTML = '<td><strong>' + esc(u.username) + '</strong>' + (self ? '<div class="sub" style="color:#2563eb;">（目前登入）</div>' : '') + '</td>'
                + '<td>' + esc(u.display_name || '') + '</td>'
                + '<td style="text-align:center;">' + roleBadge + '</td>'
                + '<td style="text-align:center;">' + activeBadge + '</td>'
                + '<td style="font-size:12px;" class="sub">' + (u.last_login ? esc(String(u.last_login).slice(0, 19).replace('T', ' ')) : '—') + '</td>'
                + '<td style="text-align:center;white-space:nowrap;">'
                + '<button class="btn btn-ghost btn-sm" data-edit-user="' + u.id + '">✏️</button> '
                + '<button class="btn btn-primary btn-sm" data-reset-pw="' + u.id + '">🔑</button> '
                + '<button class="btn btn-ghost btn-sm" data-toggle-role="' + u.id + '">🔁</button> '
                + '<button class="btn btn-sm" style="background:' + (u.is_active ? '#f59e0b' : '#10b981') + ';color:#fff;" data-toggle-active="' + u.id + '">' + (u.is_active ? '⛔' : '✅') + '</button> '
                + '<button class="btn btn-danger btn-sm" data-del-user="' + u.id + '">🗑️</button></td>';
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-edit-user]').forEach(b => b.addEventListener('click', () => startEditUser(Number(b.getAttribute('data-edit-user')))));
        tbody.querySelectorAll('[data-reset-pw]').forEach(b => b.addEventListener('click', () => resetUserPassword(Number(b.getAttribute('data-reset-pw')))));
        tbody.querySelectorAll('[data-toggle-role]').forEach(b => b.addEventListener('click', () => toggleRole(Number(b.getAttribute('data-toggle-role')))));
        tbody.querySelectorAll('[data-toggle-active]').forEach(b => b.addEventListener('click', () => toggleActive(Number(b.getAttribute('data-toggle-active')))));
        tbody.querySelectorAll('[data-del-user]').forEach(b => b.addEventListener('click', () => removeUser(Number(b.getAttribute('data-del-user')))));
    }

    function startEditUser(id) {
        if (!state.isAdmin) return;
        const u = state.users.find(x => x.id === id);
        if (!u) return;
        state.editingUserId = u.id;
        $('u-id').value = u.id;
        $('u-username').value = u.username;
        $('u-username').readOnly = true;
        $('u-display').value = u.display_name || '';
        $('u-password').value = '';
        $('u-password').placeholder = '留空＝不變更密碼';
        $('u-role').value = u.role;
        $('u-active').value = u.is_active ? '1' : '0';
        $('u-submit').textContent = '💾 儲存修改';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function clearUserForm() {
        state.editingUserId = 0;
        $('u-id').value = '';
        $('u-username').value = '';
        $('u-username').readOnly = false;
        $('u-display').value = '';
        $('u-password').value = '';
        $('u-password').placeholder = '至少 4 碼';
        $('u-role').value = 'user';
        $('u-active').value = '1';
        $('u-submit').textContent = '➕ 新增帳號';
    }

    async function submitUserForm(e) {
        e.preventDefault();
        const username = $('u-username').value.trim();
        const displayName = $('u-display').value.trim();
        const password = $('u-password').value;
        const role = $('u-role').value;
        const isActive = $('u-active').value === '1';
        try {
            if (state.editingUserId) {
                await put('/api/users/' + state.editingUserId, { displayName: displayName, role: role, isActive: isActive });
                if (password) await post('/api/users/' + state.editingUserId + '/password', { newPassword: password });
                toast('✅ 帳號已更新。', 'ok');
            } else {
                if (!password) { toast('⚠️ 新增帳號需設定密碼（至少 4 碼）。', 'warn'); return; }
                await post('/api/users', { username: username, displayName: displayName, password: password, role: role, isActive: isActive });
                toast('✅ 已新增帳號：' + username, 'ok');
            }
            clearUserForm();
            await loadUsers();
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function resetUserPassword(id) {
        const u = state.users.find(x => x.id === id);
        const pw = window.prompt('🔑 請輸入「' + (u ? u.username : '') + '」的新密碼（至少 4 碼）');
        if (pw === null) return;
        if (String(pw).length < 4) { toast('⚠️ 密碼長度至少 4 碼。', 'warn'); return; }
        try { await post('/api/users/' + id + '/password', { newPassword: pw }); toast('🔑 已重設密碼。', 'ok'); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function toggleRole(id) {
        const u = state.users.find(x => x.id === id);
        if (!u) return;
        const next = u.role === 'admin' ? 'user' : 'admin';
        if (!confirmBox('🔁 將「' + u.username + '」改為「' + (next === 'admin' ? '管理者' : '一般使用者') + '」？')) return;
        try { await put('/api/users/' + id, { role: next }); toast('✅ 角色已更新。', 'ok'); await loadUsers(); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function toggleActive(id) {
        const u = state.users.find(x => x.id === id);
        if (!u) return;
        const next = !u.is_active;
        if (!confirmBox((next ? '✅ 啟用' : '⛔ 停用') + '帳號「' + u.username + '」？')) return;
        try { await put('/api/users/' + id, { isActive: next }); toast('✅ 狀態已更新。', 'ok'); await loadUsers(); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function removeUser(id) {
        const u = state.users.find(x => x.id === id);
        if (!u) return;
        if (!confirmBox('🗑️ 確定刪除帳號「' + u.username + '」？此動作無法復原。')) return;
        try { await del('/api/users/' + id); toast('🗑️ 已刪除帳號。', 'ok'); await loadUsers(); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 新增資產 ───────────────────────────────────────
    async function submitAssetForm(e) {
        e.preventDefault();
        try {
            const res = await post('/api/assets', {
                category: $('a-category').value,
                department: $('a-department').value || 'IT',
                name: $('a-name').value.trim(),
                sn: $('a-sn').value.trim(),
                custodian: $('a-custodian').value.trim(),
                location: $('a-location').value.trim(),
                vendor_id: parseInt($('a-vendor').value, 10) || 0,
                status: $('a-status').value,
                purchase_date: $('a-purchase').value,
                warranty_date: $('a-warranty').value,
                spec_note: $('a-spec').value.trim(),
                notes: $('a-notes').value.trim()
            });
            toast('💾 已新增資產：' + (res.asset_no || ''), 'ok');
            ['a-name', 'a-sn', 'a-custodian', 'a-location', 'a-purchase', 'a-warranty', 'a-spec', 'a-notes'].forEach(id => { const el = $(id); if (el) el.value = ''; });
            await loadAssets();
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 維修 ───────────────────────────────────────────
    async function submitRepairForm(e) {
        e.preventDefault();
        const assetId = parseInt($('r-asset').value, 10) || 0;
        if (!assetId) { toast('⚠️ 請選擇要維修的資產。', 'warn'); return; }
        try {
            await post('/api/repairs', {
                asset_id: assetId,
                fault_description: $('r-fault').value.trim(),
                repair_vendor: $('r-vendor').value.trim(),
                reported_date: $('r-date').value,
                cost: parseFloat($('r-cost').value) || 0,
                notes: $('r-notes').value.trim()
            });
            toast('🔧 已登記維修，資產轉為「維修中」。', 'ok');
            ['r-vendor', 'r-fault', 'r-date', 'r-cost', 'r-notes'].forEach(id => { const el = $(id); if (el) el.value = ''; });
            $('r-asset').value = '';
            await Promise.all([loadRepairs(), loadAssets()]);
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 轉移 ───────────────────────────────────────────
    function updateTransferHint() {
        const id = parseInt($('t-asset').value, 10) || 0;
        const a = state.assets.find(x => x.id === id);
        const hint = $('t-hint');
        const from = $('t-from');
        if (!a) {
            if (from) from.value = '';
            if (hint) { hint.className = 'form-full tip-mini'; hint.textContent = 'ℹ️ 選擇不同部門時，資產編號會依「類別-新部門-日期-流水號」重新產生。'; }
            return;
        }
        if (from) from.value = deptText(a.department) + ' / ' + (a.custodian || '—') + ' / ' + (a.location || '—');
        const toDept = $('t-to-dept').value;
        if (hint) {
            if (toDept && toDept !== String(a.department || 'IT').toUpperCase()) {
                hint.className = 'form-full tip-mini warn';
                hint.textContent = '⚠️ 部門變更：儲存後會自動重新編號（原編號 ' + a.asset_no + '）。';
            } else {
                hint.className = 'form-full tip-mini';
                hint.textContent = 'ℹ️ 同部門轉移：僅更新保管人／位置，資產編號不變。';
            }
        }
    }

    async function submitTransferForm(e) {
        e.preventDefault();
        const assetId = parseInt($('t-asset').value, 10) || 0;
        if (!assetId) { toast('⚠️ 請選擇要轉移的資產。', 'warn'); return; }
        try {
            const res = await post('/api/transfers', {
                asset_id: assetId,
                to_department: $('t-to-dept').value,
                to_custodian: $('t-custodian').value.trim(),
                to_location: $('t-location').value.trim(),
                transfer_date: $('t-date').value,
                reason: $('t-reason').value.trim(),
                notes: $('t-notes').value.trim()
            });
            toast(res.renumbered ? ('🔄 轉移完成，已重新編號為 ' + res.asset_no) : '🔄 轉移完成（編號不變）', 'ok');
            ['t-custodian', 't-location', 't-date', 't-reason', 't-notes'].forEach(id => { const el = $(id); if (el) el.value = ''; });
            $('t-asset').value = ''; $('t-to-dept').value = '';
            updateTransferHint();
            await Promise.all([loadTransfers(), loadAssets()]);
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 廠商 / 維護紀錄 ────────────────────────────────
    async function submitCreateVendor(e) {
        e.preventDefault();
        const payload = {
            name: $('v-name').value.trim(),
            representative: $('v-rep').value.trim(),
            phone: $('v-phone').value.trim(),
            address: $('v-address').value.trim(),
            has_nda: $('v-nda').value === '1',
            service_items: $('v-items').value.trim(),
            maint_start: $('v-start').value,
            maint_end: $('v-end').value
        };
        if (!payload.name) { toast('⚠️ 請填寫廠商公司名稱。', 'warn'); return; }
        try {
            const res = await post('/api/vendors', payload);
            toast((res.created ? '✅ 已新增廠商：' : '💾 已更新既有廠商：') + payload.name, 'ok');
            clearVendorForm();
            await loadVendors();
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function submitMaintForm(e) {
        e.preventDefault();
        try {
            await post('/api/vendor-maint', {
                vendor_name: $('m-vendor').value,
                maint_date: $('m-date').value,
                equipment: $('m-equipment').value.trim(),
                equipment_sn: $('m-sn').value.trim(),
                maint_type: $('m-type').value.trim(),
                handler: $('m-handler').value.trim(),
                cost: parseFloat($('m-cost').value) || 0,
                signed: $('m-signed').value,
                content: $('m-content').value.trim(),
                notes: $('m-notes').value.trim()
            });
            toast('🗂️ 維護紀錄已儲存。', 'ok');
            ['m-date', 'm-equipment', 'm-sn', 'm-type', 'm-handler', 'm-cost', 'm-content', 'm-notes'].forEach(id => { const el = $(id); if (el) el.value = ''; });
            await showPage('vendor-maint-log');
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 我的密碼 ───────────────────────────────────────
    async function submitMyPassword(e) {
        e.preventDefault();
        const cur = $('mp-current').value;
        const n1 = $('mp-new').value;
        const n2 = $('mp-confirm').value;
        if (String(n1).length < 4) { toast('⚠️ 新密碼長度至少 4 碼。', 'warn'); return; }
        if (n1 !== n2) { toast('⚠️ 兩次輸入的新密碼不一致。', 'warn'); return; }
        try {
            await post('/api/me/password', { currentPassword: cur, newPassword: n1 });
            toast('🔒 密碼已更新，下次登入請使用新密碼。', 'ok');
            ['mp-current', 'mp-new', 'mp-confirm'].forEach(id => { const el = $(id); if (el) el.value = ''; });
        } catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    // ── 匯入 / 備份 ────────────────────────────────────
    async function importAssets() {
        const input = $('import-file');
        const file = input && input.files && input.files[0];
        if (!file) { toast('⚠️ 請先選擇 .xlsx 檔案。', 'warn'); return; }
        if (!/\.xlsx$/i.test(file.name)) { toast('⚠️ 僅支援 .xlsx 格式。', 'warn'); return; }
        const btn = $('import-btn');
        btn.disabled = true; btn.textContent = '⏳ 匯入中...';
        const box = $('import-result');
        try {
            const dataBase64 = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => {
                    const s = String(fr.result || '');
                    resolve(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s);
                };
                fr.onerror = () => reject(new Error('讀取檔案失敗。'));
                fr.readAsDataURL(file);
            });
            const res = await post('/api/import/assets', { fileName: file.name, dataBase64: dataBase64 });
            const errs = res.errors || [];
            if (box) {
                box.classList.remove('hidden');
                box.innerHTML = '<strong>✅ 匯入完成</strong><div>檔案：' + esc(res.fileName || file.name) + '</div>'
                    + '<div>新增 <b>' + res.inserted + '</b> 筆　｜　略過（重複序號）<b>' + res.skipped + '</b> 筆　｜　失敗 <b>' + errs.length + '</b> 筆</div>'
                    + (errs.length ? '<div style="margin-top:8px;color:#b91c1c;">' + errs.slice(0, 10).map(x => '第 ' + x.row + ' 列：' + esc(x.message)).join('<br>') + (errs.length > 10 ? '<br>…還有 ' + (errs.length - 10) + ' 筆' : '') + '</div>' : '');
            }
            toast('✅ 匯入完成：新增 ' + res.inserted + ' 筆', 'ok');
            input.value = '';
            await loadAssets();
        } catch (err) {
            if (box) { box.classList.remove('hidden'); box.innerHTML = '<strong style="color:#b91c1c;">❌ 匯入失敗</strong><div>' + esc(err.message) + '</div>'; }
            toast('❌ 匯入失敗：' + err.message, 'err');
        } finally {
            btn.disabled = false; btn.textContent = '📂 開始匯入';
        }
    }

    async function downloadBackup() {
        const btn = $('backup-btn');
        const old = btn.textContent;
        btn.disabled = true; btn.textContent = '⏳ 準備中...';
        try {
            const res = await fetch('/api/backup/db', { credentials: 'same-origin' });
            if (!res.ok) {
                let msg = '備份失敗（HTTP ' + res.status + '）';
                try { const d = await res.json(); if (d && d.message) msg = d.message; } catch (e) {}
                throw new Error(msg);
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const a = document.createElement('a');
            a.href = url; a.download = 'asset_data_backup_' + stamp + '.db';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 8000);
            toast('💾 資料庫備份已開始下載。', 'ok');
        } catch (err) {
            toast('❌ ' + (err.message || '備份失敗'), 'err');
        } finally {
            btn.disabled = false; btn.textContent = old;
        }
    }

    // ── 附件管理（廠商 NDA／合約、維護單據）────────────
    const splitPaths = (s) => String(s || '').split(';').map(x => x.trim()).filter(Boolean);
    const fileBaseName = (p) => String(p || '').split(/[\\/]/).pop();

    function readFilesAsBase64(fileList) {
        const list = Array.prototype.slice.call(fileList || []);
        return Promise.all(list.map(f => new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => {
                const s = String(fr.result || '');
                resolve({ name: f.name, dataBase64: s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s });
            };
            fr.onerror = () => reject(new Error('讀取檔案失敗：' + f.name));
            fr.readAsDataURL(f);
        })));
    }

    async function openVendorFiles(id) {
        const v = state.vendors.find(x => x.id === id);
        if (!v) return;
        const groups = [
            { kind: 'nda', title: '🔒 NDA 資安條款', files: splitPaths(v.nda_files) },
            { kind: 'contract', title: '📄 採購合約', files: splitPaths(v.contract_files) }
        ];
        renderFilesModal('📎 廠商附件 ｜ ' + v.name, 'vendor', id, groups);
        $('files-modal').classList.remove('hidden');
    }

    // ── 廠商完整資訊彈窗（唯讀檢視，點廠商名稱開啟）────
    function closeVendorModal() {
        const m = $('vendor-modal'); if (m) m.classList.add('hidden');
        state.vendorModalId = 0;
    }

    function vendorFileLinks(list) {
        if (!list.length) return '<span class="muted">未上傳</span>';
        return '<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">' + list.map(p => {
            const name = '📄 ' + esc(fileBaseName(p));
            const title = ' title="' + esc(fileBaseName(p)) + '"';
            return state.isAdmin
                ? '<a class="file-chip" href="/api/files?path=' + encodeURIComponent(p) + '" target="_blank" rel="noopener"' + title + '>' + name + '</a>'
                : '<span class="file-chip plain"' + title + '>' + name + '</span>';
        }).join('') + '</div>';
    }

    async function openVendorDetail(id) {
        const v = state.vendors.find(x => x.id === Number(id));
        if (!v) { toast('⚠️ 找不到廠商資料（可能已被刪除）。', 'warn'); return; }
        state.vendorModalId = v.id;
        const ndaFiles = splitPaths(v.nda_files);
        const conFiles = splitPaths(v.contract_files);
        const periodText = (v.maint_start || v.maint_end)
            ? (esc(v.maint_start || '未設定') + ' ~ ' + esc(v.maint_end || '未設定'))
            : '<span class="muted">未設定</span>';
        const archived = ndaFiles.length + conFiles.length;

        const title = $('vendor-modal-title');
        if (title) title.textContent = '🏢 合作廠商詳細資訊 ｜ ' + (v.name || '');
        $('vendor-modal-info').innerHTML =
            '<div class="full"><b>🏢 廠商公司名稱：</b>' + esc(v.name || '') + '</div>'
            + '<div><b>👤 主要服務專員：</b>' + dash(v.representative) + '</div>'
            + '<div><b>📞 聯絡窗口電話：</b>' + (v.phone ? '<a href="tel:' + esc(v.phone) + '" class="name-link">' + esc(v.phone) + '</a>' : '<span class="muted">—</span>') + '</div>'
            + '<div class="full"><b>📍 通訊地址：</b>' + dash(v.address) + '</div>'
            + '<div class="full"><b>💡 主要維護服務範疇：</b>' + dash(v.service_items) + '</div>'
            + '<div><b>📅 維護合約期間：</b>' + periodText + '</div>'
            + '<div><b>📊 維護合約狀態：</b>' + vendorMaintBadge(v.maint_start, v.maint_end) + '</div>'
            + '<div><b>🔒 資安 NDA 狀態：</b>' + (v.has_nda ? '<span class="badge badge-active">🔒 已簽署</span>' : '<span class="badge badge-scrapped">⚠️ 未簽署</span>') + '</div>'
            + '<div><b>📁 附件歸檔：</b>' + (archived ? '<span class="badge badge-inventory">已歸檔 ' + ndaFiles.length + ' 份 NDA／' + conFiles.length + ' 份合約</span>' : '<span class="muted">無隨附文件</span>') + '</div>'
            + '<div class="full"><b>🔒 NDA 資安條款文件：</b>' + vendorFileLinks(ndaFiles) + '</div>'
            + '<div class="full"><b>📄 採購合約文件：</b>' + vendorFileLinks(conFiles) + '</div>';

        const box = $('vendor-modal-maint');
        box.innerHTML = '<div class="mini-empty">載入維護紀錄中...</div>';
        $('vendor-modal').classList.remove('hidden');

        try {
            if (!state.maint.length) {
                const res = await api('/api/vendor-maint');
                state.maint = res.records || [];
                renderMaint();
            }
            const rows = state.maint.filter(r => (r.vendor_id && r.vendor_id === v.id) || r.vendor_name === v.name);
            box.innerHTML = rows.length ? rows.slice(0, 10).map(r => {
                const meta = [r.maint_type, r.handler ? '👤 ' + r.handler : '', Number(r.cost) > 0 ? '💰 ' + money(r.cost) + ' 元' : ''].filter(x => x && String(x).trim()).join('　｜　');
                const content = [r.content, r.notes].filter(x => x && String(x).trim()).join('　');
                return '<div class="mini-item"><div class="row1"><span><strong>' + esc(r.equipment || '(未填設備)') + '</strong>'
                    + (r.equipment_sn ? ' <span class="sub">(' + esc(r.equipment_sn) + ')</span>' : '') + '</span>'
                    + '<span>📅 ' + esc(r.maint_date || '—') + '</span></div>'
                    + (meta ? '<div class="sub">' + esc(meta) + '</div>' : '')
                    + (content ? '<div class="sub">📝 ' + esc(content) + '</div>' : '') + '</div>';
            }).join('') + (rows.length > 10 ? '<div class="sub">（僅顯示最近 10 筆，共 ' + rows.length + ' 筆）</div>' : '')
                : '<div class="mini-empty">此廠商尚無維護紀錄。</div>';
        } catch (err) {
            box.innerHTML = '<div class="mini-empty">無法載入維護紀錄：' + esc(err.message) + '</div>';
        }
    }

    async function openMaintDocs(id) {
        const rec = state.maint.find(x => x.id === id);
        if (!rec) return;
        const groups = [{ kind: 'maint', title: '📎 維護單據', files: splitPaths(rec.doc_files) }];
        renderFilesModal('🗂️ 維護單據 ｜ ' + (rec.equipment || ''), 'maint', id, groups);
        $('files-modal').classList.remove('hidden');
    }

    function renderFilesModal(title, type, id, groups) {
        $('files-title').textContent = title;
        const body = $('files-body');
        body.innerHTML = groups.map(g => {
            const list = g.files.length
                ? g.files.map(p => '<div class="mini-item" style="display:flex;justify-content:space-between;gap:10px;align-items:center;">'
                    + '<a href="/api/files?path=' + encodeURIComponent(p) + '" target="_blank" style="color:#2563eb;font-weight:bold;text-decoration:none;">📄 ' + esc(fileBaseName(p)) + '</a>'
                    + '<button type="button" class="btn btn-danger btn-sm" data-del-file="' + esc(p) + '" data-kind="' + g.kind + '">🗑️</button></div>').join('')
                : '<div class="mini-empty">尚無檔案。</div>';
            return '<div style="margin-bottom:18px;">'
                + '<div style="font-weight:bold;color:#334155;margin-bottom:8px;">' + g.title + '</div>'
                + '<div class="mini-list" style="margin-bottom:10px;">' + list + '</div>'
                + '<div class="inline-form"><input type="file" multiple data-upload="' + g.kind + '" style="flex-grow:1;"></div>'
                + '</div>';
        }).join('');

        body.querySelectorAll('[data-del-file]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const p = btn.getAttribute('data-del-file');
                const kind = btn.getAttribute('data-kind') || 'nda';
                if (!confirmBox('🗑️ 確定要刪除此附件檔案？')) return;
                try {
                    if (type === 'vendor') await post('/api/vendors/' + id + '/files/delete', { kind: kind, path: p });
                    else await post('/api/vendor-maint/' + id + '/docs/delete', { path: p });
                    toast('🗑️ 已刪除附件。', 'ok');
                    await reloadFilesContext(type, id);
                } catch (err) { toast('❌ ' + err.message, 'err'); }
            });
        });

        body.querySelectorAll('[data-upload]').forEach(input => {
            input.addEventListener('change', async () => {
                if (!input.files || !input.files.length) return;
                const kind = input.getAttribute('data-upload');
                try {
                    const files = await readFilesAsBase64(input.files);
                    if (type === 'vendor') await post('/api/vendors/' + id + '/files', { kind: kind, files: files });
                    else await post('/api/vendor-maint/' + id + '/docs', { files: files });
                    toast('📎 已上傳 ' + files.length + ' 個檔案。', 'ok');
                    await reloadFilesContext(type, id);
                } catch (err) { toast('❌ 上傳失敗：' + err.message, 'err'); }
            });
        });
    }

    async function reloadFilesContext(type, id) {
        if (type === 'vendor') { await loadVendors(); await openVendorFiles(id); }
        else { await loadMaint(); await openMaintDocs(id); }
    }

    function closeFilesModal() { $('files-modal').classList.add('hidden'); }

    // ── 報表下載 / 工具 ────────────────────────────────
    async function downloadBlob(url, fallbackName) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
            let msg = '下載失敗（HTTP ' + res.status + '）';
            try { const d = await res.json(); if (d && d.message) msg = d.message; } catch (e) {}
            throw new Error(msg);
        }
        const blob = await res.blob();
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u; a.download = fallbackName || 'download';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 8000);
    }

    async function exportAssetHistory(id) {
        if (!id) return;
        try { await downloadBlob('/api/export/asset-history/' + id + '.xlsx', '資產履歷.xlsx'); toast('📤 資產履歷已開始下載。', 'ok'); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }
    async function exportVendors() {
        try { await downloadBlob('/api/export/vendors.xlsx', '合作廠商清單.xlsx'); toast('📥 廠商清單已開始下載。', 'ok'); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }
    async function exportMaint() {
        try { await downloadBlob('/api/export/vendor-maint.xlsx', '廠商維護歷程.xlsx'); toast('📥 維護歷程已開始下載。', 'ok'); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function importVendorsExcel() {
        const input = $('import-vendor-file');
        const file = input && input.files && input.files[0];
        if (!file) { toast('⚠️ 請先選擇 .xlsx 檔案。', 'warn'); return; }
        const btn = $('import-vendor-btn');
        const box = $('import-vendor-result');
        btn.disabled = true; btn.textContent = '⏳ 匯入中...';
        try {
            const files = await readFilesAsBase64([file]);
            const res = await post('/api/import/vendors', { fileName: file.name, dataBase64: files[0].dataBase64 });
            const errs = res.errors || [];
            if (box) {
                box.classList.remove('hidden');
                box.innerHTML = '<strong>✅ 匯入完成</strong><div>檔案：' + esc(res.fileName || file.name) + '</div>'
                    + '<div>新增 <b>' + res.inserted + '</b> 家　｜　更新 <b>' + res.updated + '</b> 家　｜　略過（重複）<b>' + res.skipped + '</b> 家　｜　失敗 <b>' + errs.length + '</b> 家</div>'
                    + (errs.length ? '<div style="margin-top:8px;color:#b91c1c;">' + errs.slice(0, 10).map(x => '第 ' + x.row + ' 列：' + esc(x.message)).join('<br>') + '</div>' : '');
            }
            toast('✅ 廠商匯入完成：新增 ' + res.inserted + '、更新 ' + res.updated, 'ok');
            input.value = '';
            await loadVendors();
        } catch (err) {
            if (box) { box.classList.remove('hidden'); box.innerHTML = '<strong style="color:#b91c1c;">❌ 匯入失敗</strong><div>' + esc(err.message) + '</div>'; }
            toast('❌ 匯入失敗：' + err.message, 'err');
        } finally {
            btn.disabled = false; btn.textContent = '📂 開始匯入';
        }
    }

    async function downloadAttachmentsZip() {
        try { await downloadBlob('/api/backup/files', 'vendor_files.zip'); toast('🗜️ 附件 ZIP 已開始下載。', 'ok'); }
        catch (err) { toast('❌ ' + err.message, 'err'); }
    }

    async function restoreDatabase() {
        const input = $('restore-file');
        const box = $('restore-result');
        const file = input && input.files && input.files[0];
        if (!file) { toast('⚠️ 請先選擇 .db 備份檔。', 'warn'); return; }
        if (String($('restore-confirm').value || '').trim().toUpperCase() !== 'RESTORE') {
            toast('⚠️ 請在確認欄輸入 RESTORE。', 'warn'); return;
        }
        if (!confirmBox('♻️ 確定要還原資料庫嗎？\n目前所有資料將被此備份檔覆蓋！\n（系統會先自動備份目前資料庫）')) return;
        const btn = $('restore-btn');
        btn.disabled = true; btn.textContent = '⏳ 還原中...';
        try {
            const files = await readFilesAsBase64([file]);
            const res = await post('/api/backup/restore', { fileName: file.name, dataBase64: files[0].dataBase64, confirm: 'RESTORE' });
            if (box) {
                box.classList.remove('hidden');
                box.innerHTML = '<strong style="color:#15803d;">✅ 資料庫已還原</strong><div>還原前備份：<code>' + esc(res.safety || '') + '</code></div><div>頁面將重新載入...</div>';
            }
            toast('✅ 資料庫已還原，重新載入中...', 'ok');
            setTimeout(() => window.location.reload(), 1800);
        } catch (err) {
            if (box) { box.classList.remove('hidden'); box.innerHTML = '<strong style="color:#b91c1c;">❌ 還原失敗</strong><div>' + esc(err.message) + '</div>'; }
            toast('❌ 還原失敗：' + err.message, 'err');
        } finally {
            btn.disabled = false; btn.textContent = '♻️ 執行還原';
        }
    }

    async function loadVersionInfo() {
        const box = $('version-info');
        if (!box) return;
        try {
            const v = await api('/api/version');
            const c = v.counts || {};
            box.innerHTML = '<div><strong>系統版本：</strong>v' + esc(v.version) + '（Web 版）</div>'
                + '<div><strong>執行環境：</strong>' + esc(v.server) + '</div>'
                + '<div><strong>啟動時間：</strong>' + esc(String(v.startedAt || '').slice(0, 19).replace('T', ' ')) + '</div>'
                + '<div><strong>資料庫：</strong><code>' + esc(v.dbPath) + '</code></div>'
                + '<div><strong>資料筆數：</strong>資產 ' + (c.assets || 0) + '　廠商 ' + (c.vendors || 0) + '　維修 ' + (c.repairs || 0) + '　轉移 ' + (c.transfers || 0) + '　帳號 ' + (c.users || 0) + '</div>'
                + '<div><strong>版本紀錄：</strong><a href="' + esc(v.github || '') + '" target="_blank" style="color:#2563eb;">GitHub Releases</a></div>';
        } catch (e) {
            box.textContent = '無法取得版本資訊：' + e.message;
        }
    }


    function bind() {
        $('login-form').addEventListener('submit', doLogin);
        $('logout-btn').addEventListener('click', doLogout);

        document.querySelectorAll('#side-nav .nav-item').forEach(el => {
            el.addEventListener('click', () => showPage(el.getAttribute('data-page')));
        });

        const search = $('search');
        if (search) search.addEventListener('input', (e) => { state.keyword = e.target.value || ''; renderAssetTable(); });
        const refresh = $('refresh-btn');
        if (refresh) refresh.addEventListener('click', async () => { toast('🔄 重新載入資料...', 'info'); await refreshPage(state.page); });
        const exportBtn = $('export-btn');
        if (exportBtn) exportBtn.addEventListener('click', doExport);

        // 彈窗
        $('modal-close').addEventListener('click', closeDetail);
        $('modal-edit-btn').addEventListener('click', openEditFromDetail);
        $('edit-close').addEventListener('click', closeEdit);
        $('form-edit-asset').addEventListener('submit', submitEditAsset);
        $('e-delete').addEventListener('click', deleteCurrentAsset);
        $('detail-modal').addEventListener('click', (e) => { if (e.target && e.target.id === 'detail-modal') closeDetail(); });
        $('edit-modal').addEventListener('click', (e) => { if (e.target && e.target.id === 'edit-modal') closeEdit(); });
        $('vendor-modal-close').addEventListener('click', closeVendorModal);
        $('vendor-modal').addEventListener('click', (e) => { if (e.target && e.target.id === 'vendor-modal') closeVendorModal(); });
        $('vendor-modal-edit').addEventListener('click', () => {
            const id = state.vendorModalId;
            closeVendorModal();
            if (id) gotoVendorEdit(id);
        });
        $('vendor-modal-files').addEventListener('click', () => {
            const id = state.vendorModalId;
            closeVendorModal();
            if (id) openVendorFiles(id);
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDetail(); closeEdit(); closeVendorModal(); closeFilesModal(); } });

        // 表單
        $('form-asset').addEventListener('submit', submitAssetForm);
        $('form-repair').addEventListener('submit', submitRepairForm);
        $('form-transfer').addEventListener('submit', submitTransferForm);
        $('t-asset').addEventListener('change', updateTransferHint);
        $('t-to-dept').addEventListener('change', updateTransferHint);
        $('form-vendor').addEventListener('submit', submitCreateVendor);
        $('v-cancel').addEventListener('click', clearVendorForm);
        $('form-vendor-edit').addEventListener('submit', submitVendorEdit);
        $('ve-delete').addEventListener('click', deleteVendorFromEdit);
        $('ve-cancel').addEventListener('click', clearVendorEditForm);
        $('ve-files').addEventListener('click', () => { const id = parseInt($('ve-id').value, 10) || 0; if (!id) { toast('⚠️ 請先選擇廠商。', 'warn'); return; } openVendorFiles(id); });
        $('vendor-edit-load').addEventListener('click', () => loadVendorIntoEdit($('vendor-edit-select').value));
        $('vendor-edit-select').addEventListener('change', () => { const v = $('vendor-edit-select').value; if (v) loadVendorIntoEdit(v); });
        $('vendor-edit-search').addEventListener('input', (e) => { state.vendorEditKeyword = e.target.value; renderVendorPicker(e.target.value); });
        $('vendor-search').addEventListener('input', (e) => { state.vendorKeyword = e.target.value; renderVendors(); });
        $('goto-vendor-add').addEventListener('click', () => showPage('vendors'));
        $('goto-maint-add').addEventListener('click', () => showPage('vendor-maint-add'));
        $('maint-search').addEventListener('input', (e) => { state.maintKeyword = e.target.value; renderMaint(); });
        $('m-cancel').addEventListener('click', () => { ['m-date', 'm-equipment', 'm-sn', 'm-type', 'm-handler', 'm-cost', 'm-content', 'm-notes'].forEach(id => { const el = $(id); if (el) el.value = ''; }); });
        $('form-maint').addEventListener('submit', submitMaintForm);
        $('form-field-cat').addEventListener('submit', (e) => { e.preventDefault(); addField('category'); });
        $('form-field-dep').addEventListener('submit', (e) => { e.preventDefault(); addField('department'); });
        $('form-user').addEventListener('submit', submitUserForm);
        $('u-cancel').addEventListener('click', clearUserForm);
        $('form-my-password').addEventListener('submit', submitMyPassword);

        // 工具
        $('import-btn').addEventListener('click', importAssets);
        $('backup-btn').addEventListener('click', downloadBackup);
        $('goto-dashboard').addEventListener('click', () => showPage('dashboard'));
        $('import-vendor-btn').addEventListener('click', importVendorsExcel);
        $('backup-files-btn').addEventListener('click', downloadAttachmentsZip);
        $('restore-btn').addEventListener('click', restoreDatabase);
        $('tpl-assets-btn').addEventListener('click', () => { downloadBlob('/api/template/assets.xlsx', '資產資料匯入範本.xlsx').catch(e => toast('❌ ' + e.message, 'err')); });
        $('tpl-vendors-btn').addEventListener('click', () => { downloadBlob('/api/template/vendors.xlsx', '廠商資料匯入範本.xlsx').catch(e => toast('❌ ' + e.message, 'err')); });

        // 報表與附件
        $('export-vendors-btn').addEventListener('click', exportVendors);
        $('export-maint-btn').addEventListener('click', exportMaint);
        $('modal-export-btn').addEventListener('click', () => exportAssetHistory(state.editingAssetId));
        $('files-close').addEventListener('click', closeFilesModal);
        $('files-modal').addEventListener('click', (e) => { if (e.target && e.target.id === 'files-modal') closeFilesModal(); });
    }

    async function boot() {
        try {
            const me = await api('/api/me');
            if (me && me.user) {
                await loadFieldOptions();
                showApp(me.user);
                return;
            }
        } catch (e) { /* 未登入 */ }
        showLogin();
    }

    document.addEventListener('DOMContentLoaded', () => {
        try { bind(); } catch (e) { console.error('bind failed', e); }
        boot();
    });
})();














