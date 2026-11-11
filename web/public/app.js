// =====================================================================
// Web 版前端（Phase 1：唯讀查詢 + 匯出）
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

    const state = { user: null, assets: [], categories: {}, departments: {}, keyword: '' };
    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const orDash = (v) => (v != null && String(v).trim() !== '') ? esc(v) : '<span class="muted">—</span>';

    function toast(msg, type) {
        const box = $('toast-box');
        if (!box) return;
        const el = document.createElement('div');
        el.className = 'toast toast-' + (type || 'info');
        el.textContent = String(msg);
        box.appendChild(el);
        setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 4000);
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
            err.data = data;
            throw err;
        }
        return data;
    }

    // ── 登入 / 登出 ─────────────────────────────────────
    function showLogin() {
        $('app-view').classList.add('hidden');
        $('login-view').classList.remove('hidden');
        $('login-password').value = '';
        setTimeout(() => { try { $('login-username').focus(); } catch (e) {} }, 80);
    }

    function showApp(user) {
        state.user = user;
        $('login-view').classList.add('hidden');
        $('app-view').classList.remove('hidden');
        $('user-chip').textContent = (user.role === 'admin' ? '👑 ' : '👤 ') + (user.displayName || user.username);
        loadAll();
    }

    async function doLogin(e) {
        if (e) e.preventDefault();
        const username = $('login-username').value.trim();
        const password = $('login-password').value;
        const errBox = $('login-error');
        const btn = $('login-btn');
        errBox.classList.add('hidden');
        if (!username || !password) {
            errBox.textContent = '請輸入帳號與密碼。';
            errBox.classList.remove('hidden');
            return;
        }
        btn.disabled = true; btn.textContent = '登入中...';
        try {
            const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: username, password: password }) });
            showApp(res.user);
            toast('👋 歡迎回來，' + (res.user.displayName || res.user.username), 'ok');
            $('search').value = '';
            state.keyword = '';
        } catch (err) {
            errBox.textContent = err.message || '登入失敗。';
            errBox.classList.remove('hidden');
        } finally {
            btn.disabled = false; btn.textContent = '登入系統';
        }
    }

    async function doLogout() {
        try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
        state.user = null;
        state.assets = [];
        $('asset-table').querySelector('tbody').innerHTML = '';
        toast('👋 您已登出系統。', 'ok');
        showLogin();
    }

    // ── 資料載入 ───────────────────────────────────────
    async function loadFieldOptions() {
        try {
            const res = await api('/api/field-options');
            state.categories = {};
            state.departments = {};
            (res.categories || []).forEach(o => { state.categories[o.value] = o.label + ' (' + o.code + ')'; });
            (res.departments || []).forEach(o => { state.departments[o.code] = o.label; });
        } catch (e) { /* 使用預設對照表 */ }
    }

    const catText = (v) => state.categories[v] || FALLBACK_CAT[v] || String(v || '—');
    const deptText = (code) => {
        const c = String(code || 'IT').toUpperCase();
        return state.departments[c] ? c + ' ' + state.departments[c] : (FALLBACK_DEPT[c] ? c + ' ' + FALLBACK_DEPT[c] : c);
    };

    async function loadAssets() {
        try {
            const res = await api('/api/assets');
            state.assets = res.assets || [];
            renderTable();
        } catch (err) {
            if (err.status === 401) { showLogin(); return; }
            toast('❌ 載入資產失敗：' + err.message, 'err');
        }
    }

    async function loadAll() {
        await loadFieldOptions();
        await loadAssets();
    }

    // ── 表格渲染 / 搜尋 ─────────────────────────────────
    function matches(a, kw) {
        if (!kw) return true;
        const hay = [
            a.asset_no, a.name, a.custodian, a.location, a.sn, a.spec_note, a.notes, a.vendor_name,
            deptText(a.department), catText(a.category)
        ].join(' ').toLowerCase();
        return hay.indexOf(kw) >= 0;
    }

    function renderTable() {
        const tbody = document.querySelector('#asset-table tbody');
        const kw = state.keyword.trim().toLowerCase();
        const list = state.assets.filter(a => matches(a, kw));
        tbody.innerHTML = '';
        const label = $('count-label');
        if (label) label.textContent = kw ? ('符合 ' + list.length + ' / ' + state.assets.length + ' 筆') : ('共 ' + state.assets.length + ' 筆');
        $('empty-state').classList.toggle('hidden', list.length > 0);

        list.forEach(item => {
            const st = STATUS[item.status] || { text: item.status || '—', cls: '' };
            let notesHtml = item.notes ? esc(item.notes) : '<span class="muted">—</span>';
            if (item.status === 'scrapped' && item.scrap_reason) {
                notesHtml += '<div style="color:#b91c1c;font-size:12px;margin-top:4px;">🚨 報廢原因：' + esc(item.scrap_reason) + '</div>';
            }
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td><span class="asset-no">' + esc(item.asset_no) + '</span></td>'
                + '<td><span class="dept">' + esc(deptText(item.department)) + '</span></td>'
                + '<td><a href="#" class="name-link">' + esc(item.name || '') + '</a></td>'
                + '<td>' + esc(catText(item.category)) + '</td>'
                + '<td>' + orDash(item.custodian) + '</td>'
                + '<td>' + (item.vendor_name ? '🏢 ' + esc(item.vendor_name) : '<span class="muted">其他 (預設)</span>') + '</td>'
                + '<td style="text-align:center;"><span class="badge ' + st.cls + '">' + esc(st.text) + '</span></td>'
                + '<td>' + (item.location ? '📍 ' + esc(item.location) : '<span class="muted">未標註</span>') + '</td>'
                + '<td style="font-size:12.5px;">' + orDash(item.spec_note) + '</td>'
                + '<td style="font-size:12.5px;">' + notesHtml + '</td>';
            tr.querySelector('.name-link').addEventListener('click', (e) => {
                e.preventDefault();
                openDetail(item.id);
            });
            tbody.appendChild(tr);
        });
    }

    // ── 資產履歷 ───────────────────────────────────────
    function closeDetail() {
        $('detail-modal').classList.add('hidden');
    }

    function statusBadge(code) {
        const st = STATUS[code] || { text: code || '—', cls: '' };
        return '<span class="badge ' + st.cls + '">' + esc(st.text) + '</span>';
    }

    async function openDetail(id) {
        try {
            const res = await api('/api/assets/' + id);
            const a = res.asset || {};
            $('modal-title').textContent = '📋 資產維運履歷 ｜ ' + (a.asset_no || '');
            $('modal-info').innerHTML =
                '<div><b>📦 設備名稱：</b>' + orDash(a.name) + '</div>'
                + '<div><b>🏷️ 資產大類：</b>' + esc(catText(a.category)) + '</div>'
                + '<div><b>🏢 所屬部門：</b><span class="dept">' + esc(deptText(a.department)) + '</span></div>'
                + '<div><b>👤 保管窗口：</b>' + orDash(a.custodian) + '</div>'
                + '<div><b>🏢 購買廠商：</b>' + (a.vendor_name ? esc(a.vendor_name) : '<span class="muted">其他 (預設)</span>') + '</div>'
                + '<div><b>🔢 原廠序列號：</b>' + orDash(a.sn) + '</div>'
                + '<div><b>📊 當前狀態：</b>' + statusBadge(a.status) + '</div>'
                + '<div><b>📅 購置日期：</b>' + orDash(a.purchase_date) + '</div>'
                + '<div><b>🛡️ 保固到期：</b>' + orDash(a.warranty_date) + '</div>'
                + '<div><b>📍 實體擺放地點：</b>' + orDash(a.location) + '</div>'
                + (a.spec_note ? '<div class="full"><b>🧾 資產規格/備註：</b>' + esc(a.spec_note) + '</div>' : '')
                + (a.notes ? '<div class="full"><b>📝 維運備註：</b>' + esc(a.notes) + '</div>' : '')
                + ((a.status === 'scrapped' && a.scrap_reason) ? '<div class="full" style="color:#b91c1c;"><b>🚨 報廢原因：</b>' + esc(a.scrap_reason) + '</div>' : '');

            const rep = res.repairs || [];
            $('modal-repairs').innerHTML = rep.length === 0
                ? '<div class="mini-empty">本資產尚無維修紀錄。</div>'
                : rep.map(r => {
                    const stText = r.status === 'completed' ? '✅ 已完工' : (r.status === 'scrapped' ? '🚨 因報廢結案' : '🟡 維修中');
                    const cost = (r.cost && Number(r.cost) > 0) ? ('　｜　💰 ' + Number(r.cost).toLocaleString() + ' 元') : '';
                    return '<div class="mini-item"><div class="row1"><span>' + esc(r.fault_description || '(未填寫故障描述)') + '</span><span>' + stText + '</span></div>'
                        + '<div class="sub">🔧 ' + esc(r.repair_vendor || '未指定') + cost + '</div>'
                        + '<div class="sub">📅 送修 ' + esc(r.reported_date || '—') + '　｜　完工 ' + esc(r.completed_date || '—') + '</div>'
                        + (r.notes ? '<div class="sub">📝 ' + esc(r.notes) + '</div>' : '') + '</div>';
                }).join('');

            const trs = res.transfers || [];
            $('modal-transfers').innerHTML = trs.length === 0
                ? '<div class="mini-empty">本資產尚無轉移紀錄。</div>'
                : trs.map(t => {
                    const reason = [t.reason, t.notes].filter(x => x && String(x).trim()).join('　');
                    return '<div class="mini-item"><div class="row1"><span>🏢 ' + esc(deptText(t.from_department)) + ' → ' + esc(deptText(t.to_department)) + '</span><span>📅 ' + esc(t.transfer_date || '—') + '</span></div>'
                        + '<div class="sub">👤 ' + esc(t.from_custodian || '—') + ' → ' + esc(t.to_custodian || '—') + '　｜　📍 ' + esc(t.from_location || '—') + ' → ' + esc(t.to_location || '—') + '</div>'
                        + (reason ? '<div class="sub">📝 ' + esc(reason) + '</div>' : '') + '</div>';
                }).join('');

            $('detail-modal').classList.remove('hidden');
        } catch (err) {
            toast('❌ 載入履歷失敗：' + err.message, 'err');
        }
    }

    // ── 匯出 Excel ─────────────────────────────────────
    async function doExport() {
        const btn = $('export-btn');
        const old = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ 產生中...';
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
            a.href = url;
            a.download = 'IT_資產盤點總表.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 8000);
            toast('✅ 盤點總表已開始下載（含條碼貼紙欄）', 'ok');
        } catch (err) {
            if (err && err.message === 'Failed to fetch') {
                toast('❌ 匯出失敗：無法連線伺服器，請確認連線狀態。', 'err');
            } else {
                toast('❌ ' + err.message, 'err');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = old;
        }
    }

    // ── 事件綁定 ───────────────────────────────────────
    function bind() {
        $('login-form').addEventListener('submit', doLogin);
        $('logout-btn').addEventListener('click', doLogout);
        $('export-btn').addEventListener('click', doExport);
        $('refresh-btn').addEventListener('click', () => {
            toast('🔄 重新載入資料...', 'info');
            loadAll();
        });
        $('search').addEventListener('input', (e) => {
            state.keyword = e.target.value || '';
            renderTable();
        });
        $('modal-close').addEventListener('click', closeDetail);
        $('detail-modal').addEventListener('click', (e) => { if (e.target && e.target.id === 'detail-modal') closeDetail(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
    }

    // ── 啟動 ───────────────────────────────────────────
    async function boot() {
        // 版本號（公開端點，不需登入）
        fetch('/api/health').then(r => r.json()).then(h => {
            if (h && h.version) $('ver-label').textContent = 'v' + h.version;
        }).catch(() => {});

        // 嘗試沿用既有 session（重新整理不會被登出）
        try {
            const me = await api('/api/me');
            if (me && me.user) showApp(me.user);
        } catch (e) {
            showLogin();
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        bind();
        boot();
    });
})();



