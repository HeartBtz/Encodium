/* ═══════════════════════════════════════════════════════════
   Encodium — Front-end application
   ═══════════════════════════════════════════════════════════ */

;(function () {
  'use strict';

  /* ── State ────────────────────────────────────────────── */
  let token = localStorage.getItem('enc_token') || '';
  let currentUser = null;
  let sse = null;

  // Library
  let libPage = 1;
  const libLimit = 50;
  let libTotal = 0;
  let lastClickedCardIdx = -1;
  let libOrder = 'desc';
  let libSelected = new Set();
  let libSearchTimer = null;

  // Encode
  let presets = [];

  // Logs
  const logEntries = [];
  const MAX_LOG = 500;
  const t = (k, p) => i18n.t(k, p);

  /* ── Helpers ──────────────────────────────────────────── */
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`/api${path}`, { ...opts, headers })
      .then(async r => {
        if (r.status === 401) { logout(); throw new Error(t('error.session_expired')); }
        let j;
        try { j = await r.json(); } catch { throw new Error(t('error.invalid_response', {status: r.status})); }
        if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
        return j;
      })
      .catch(err => {
        if (err.message === 'Session expirée') throw err;
        if (err.name === 'TypeError') throw new Error(t('error.server_unreachable'));
        throw err;
      });
  }

  function fmtSize(b) {
    if (!b || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1);
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtDur(s) {
    if (!s || s <= 0) return '0s';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    return `${m}m ${Math.floor(s % 60)}s`;
  }
  function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function truncPath(p) { return p ? p.split('/').pop() : ''; }

  /* ── Live progress cache (survives queue re-renders) ─── */
  const liveProgress = new Map();   // jobId → { percent, speed, fps, text }

  /* ── Encode queue reload guard (prevents flickering & stale overwrites) ─── */
  let _eqGen = 0;            // generation counter — stale API responses are discarded
  let _eqDebounceTimer = null;

  function toast(msg, type = 'info') {
    const c = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
  }

  /* ── Auth ──────────────────────────────────────────────── */
  function initAuth() {
    if (token) {
      api('/auth/me')
        .then(u => { currentUser = u; showApp(); })
        .catch(() => { token = ''; localStorage.removeItem('enc_token'); showLogin(); });
    } else {
      showLogin();
    }
  }

  function showLogin() {
    $('#login-screen').style.display = '';
    $('#app').style.display = 'none';
    if (sse) { sse.close(); sse = null; }
  }

  /* ── Language selector ────────────────────────────────── */
  (function initLangSelector() {
    const sel = $('#lang-select');
    if (!sel) return;
    const langs = i18n.getLanguages();
    sel.innerHTML = langs.map(l => `<option value="${l.code}">${l.flag} ${l.name}</option>`).join('');
    sel.value = i18n.getLang();
    sel.addEventListener('change', () => {
      i18n.setLang(sel.value);
      // Re-render dynamic content that uses t()
      if (currentUser) {
        loadDashboard();
        loadLibrary();
        loadEncodeQueue();
        if ($('#tab-hardware').classList.contains('active')) loadHardware();
        if ($('#tab-settings').classList.contains('active')) loadSettings();
      }
    });
  })();

  function showApp() {
    $('#login-screen').style.display = 'none';
    $('#app').style.display = '';
    $('#adminUser').textContent = currentUser.email;
    connectSSE();
    startQueuePoll();
    loadInitialLogs();
    loadDashboard();
    loadFolders();
    checkScanOnLoad();
    checkSyncOnLoad();
    checkEnrichOnLoad();
    checkThumbsOnLoad();
    // Restore last active tab, default to dashboard
    const savedTab = localStorage.getItem('enc_activeTab') || 'dashboard';
    switchTab(savedTab);
    // Always pre-load encode queue so SSE progress updates work after refresh
    loadEncodeQueue();
  }

  function logout() {
    token = '';
    currentUser = null;
    localStorage.removeItem('enc_token');
    if (sse) { sse.close(); sse = null; }
    stopQueuePoll();
    showLogin();
  }

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = $('#login-error');
    errEl.style.display = 'none';
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: $('#login-email').value,
          password: $('#login-pass').value,
        }),
      });
      token = data.token;
      localStorage.setItem('enc_token', token);
      currentUser = data.user;
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = '';
    }
  });

  $('#btn-logout').addEventListener('click', logout);

  /* ── SSE ──────────────────────────────────────────────── */
  let sseRetries = 0;
  function connectSSE() {
    if (sse) sse.close();
    if (!token) return;
    sse = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    sse.addEventListener('connected', () => { sseRetries = 0; });
    sse.addEventListener('job_update', e => {
      try { handleJobUpdate(JSON.parse(e.data)); } catch {}
    });
    sse.addEventListener('job_progress', e => {
      try { handleJobProgress(JSON.parse(e.data)); } catch {}
    });
    sse.addEventListener('log', e => {
      try { addLogEntry(JSON.parse(e.data)); } catch {}
    });
    sse.onerror = () => {
      sse.close(); sse = null;
      sseRetries++;
      if (token && sseRetries < 10) {
        setTimeout(() => connectSSE(), Math.min(sseRetries * 3000, 30000));
      }
    };
  }

  /* ── Tab switching ────────────────────────────────────── */
  $$('.sidenav-item').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  function switchTab(tab) {
    $$('.sidenav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.admin-tab').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
    localStorage.setItem('enc_activeTab', tab);
    if (tab === 'library') { loadLibrary(); loadEncodeQueue(); }
    if (tab === 'hardware') loadHardware();
    if (tab === 'logs') renderLogs();
    if (tab === 'settings') loadSettings();
  }

  /* ═══════════════════════════════════════════════════════
     DASHBOARD
     ═══════════════════════════════════════════════════════ */

  async function loadDashboard() {
    try {
      const [stats, codecs] = await Promise.all([api('/stats'), api('/codec-stats')]);
      $('#stat-videos').textContent = (stats.videos.count || 0).toLocaleString();
      $('#stat-size').textContent = fmtSize(stats.videos.total_size);
      $('#stat-duration').textContent = fmtDur(stats.videos.total_duration);

      const jb = stats.jobs;
      const jobTxt = jb ? t('dash.jobs_in_progress', {total: jb.total || 0, encoding: jb.encoding || 0}) : '0';
      $('#stat-jobs').textContent = jobTxt;

      // Encoding savings
      const enc = stats.encoding;
      if (enc && enc.count > 0) {
        const saved = enc.saved;
        const pct = enc.totalBefore > 0 ? Math.round((saved / enc.totalBefore) * 100) : 0;
        $('#stat-saved').textContent = (saved > 0 ? '-' : '') + fmtSize(Math.abs(saved));
        const card = $('#savings-card');
        card.style.display = '';
        const ratio = enc.totalBefore > 0 ? (enc.totalAfter / enc.totalBefore * 100).toFixed(1) : '—';
        $('#savings-detail').innerHTML = `
          <div class="savings-grid">
            <div class="savings-item"><span class="savings-label">${t('dash.files_encoded')}</span><span class="savings-value">${enc.count}</span></div>
            <div class="savings-item"><span class="savings-label">${t('dash.size_before')}</span><span class="savings-value">${fmtSize(enc.totalBefore)}</span></div>
            <div class="savings-item"><span class="savings-label">${t('dash.size_after')}</span><span class="savings-value">${fmtSize(enc.totalAfter)}</span></div>
            <div class="savings-item"><span class="savings-label">${saved >= 0 ? t('dash.space_won') : t('dash.space_lost')}</span><span class="savings-value ${saved >= 0 ? 'savings-positive' : 'savings-negative'}">${saved >= 0 ? '-' : '+'}${fmtSize(Math.abs(saved))} (${pct}%)</span></div>
            <div class="savings-item"><span class="savings-label">${t('dash.avg_ratio')}</span><span class="savings-value">${ratio}%</span></div>
          </div>
          <div class="savings-bar-wrap">
            <div class="savings-bar-bg">
              <div class="savings-bar-fill" style="width:${Math.min(100, Number(ratio))}%"></div>
            </div>
            <div class="savings-bar-labels"><span>${t('dash.after_label', {size: fmtSize(enc.totalAfter)})}</span><span>${t('dash.before_label', {size: fmtSize(enc.totalBefore)})}</span></div>
          </div>`;
      } else {
        $('#stat-saved').textContent = '—';
        $('#savings-card').style.display = 'none';
      }

      // Paths — media is now an array of source paths
      if (stats.paths) {
        const mediaPaths = stats.paths.media;
        const mediaEl = $('#path-media');
        if (Array.isArray(mediaPaths) && mediaPaths.length) {
          mediaEl.innerHTML = mediaPaths.map(p => `<code>${escHtml(p)}</code>`).join('');
        } else {
          mediaEl.innerHTML = `<code>${escHtml(mediaPaths || '—')}</code>`;
        }
        $('#path-thumbs').textContent = stats.paths.thumbs || '—';
        $('#path-encode').textContent = stats.paths.encode || '—';
      }

      // Codec chart
      const grid = $('#codec-chart');
      if (codecs && codecs.length) {
        grid.innerHTML = codecs.map(c => `
          <div class="codec-card">
            <div class="cc-name">${escHtml(c.codec || t('lib.unknown'))}</div>
            <div class="cc-count">${c.count}</div>
            <div class="cc-size">${fmtSize(c.total_size)}</div>
          </div>
        `).join('');
      } else {
        grid.innerHTML = `<p style="color:var(--a-text-muted);padding:12px">${t('dash.no_codec_data')}</p>`;
      }

      // Load encoding history charts
      loadStatsCharts();
    } catch (e) { toast(t('error.dashboard', {msg: e.message}), 'error'); }
  }

  /* ── Stats Charts ─────────────────────────────────────── */
  let savingsChart = null, speedChart = null;

  async function loadStatsCharts() {
    if (typeof Chart === 'undefined') return;
    try {
      const history = await api('/stats/history');
      if (!history || !history.length) {
        $('#stats-charts-card').style.display = 'none';
        return;
      }
      $('#stats-charts-card').style.display = '';

      const labels = history.map(h => h.day);
      const savedData = history.map(h => ((h.saved || 0) / 1e9).toFixed(2)); // GB
      const countData = history.map(h => h.count);

      const chartOpts = {
        responsive: true,
        plugins: { legend: { labels: { color: '#aaa' } } },
        scales: {
          x: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#888' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        },
      };

      // Savings chart
      if (savingsChart) savingsChart.destroy();
      savingsChart = new Chart($('#chart-savings'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: t('chart.space_saved_gb'), data: savedData, backgroundColor: 'rgba(168,85,247,0.6)', borderColor: 'rgba(168,85,247,1)', borderWidth: 1 },
            { label: t('chart.files'), data: countData, backgroundColor: 'rgba(59,130,246,0.5)', borderColor: 'rgba(59,130,246,1)', borderWidth: 1, yAxisID: 'y1' },
          ],
        },
        options: { ...chartOpts, scales: { ...chartOpts.scales, y1: { position: 'right', ticks: { color: '#888' }, grid: { drawOnChartArea: false } } } },
      });

      // Speed chart — before vs after size
      const beforeData = history.map(h => ((h.total_before || 0) / 1e9).toFixed(2));
      const afterData = history.map(h => ((h.total_after || 0) / 1e9).toFixed(2));
      if (speedChart) speedChart.destroy();
      speedChart = new Chart($('#chart-speed'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: t('chart.before_gb'), data: beforeData, borderColor: 'rgba(239,68,68,0.8)', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3 },
            { label: t('chart.after_gb'), data: afterData, borderColor: 'rgba(34,197,94,0.8)', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3 },
          ],
        },
        options: chartOpts,
      });
    } catch {}
  }

  /* ── Scan progress ────────────────────────────────────── */
  let scanPollTimer = null;

  $('#btn-scan').addEventListener('click', async () => {
    try {
      await api('/scan', { method: 'POST' });
      toast(t('toast.scan_started'), 'success');
      startScanPoll();
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#btn-scan-cancel').addEventListener('click', async () => {
    try {
      await api('/scan/cancel', { method: 'POST' });
      toast(t('toast.cancel_requested'), 'warn');
    } catch (e) { toast(e.message, 'error'); }
  });

  function startScanPoll() {
    if (scanPollTimer) return;
    const wrap = $('#scan-progress');
    const bar = $('#scan-bar');
    const detail = $('#scan-detail');
    const btnScan = $('#btn-scan');
    const btnCancel = $('#btn-scan-cancel');

    wrap.classList.remove('hidden');
    btnCancel.classList.remove('hidden');
    btnScan.disabled = true;

    scanPollTimer = setInterval(async () => {
      try {
        const s = await api('/scan/progress');
        if (s.running) {
          const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
          bar.style.width = pct + '%';
          detail.textContent = t('scan.progress', {done:s.done, total:s.total, folder:s.currentFolder||'…', skipped:s.skipped, errors:s.errors});
        } else {
          clearInterval(scanPollTimer);
          scanPollTimer = null;
          bar.style.width = '100%';
          detail.textContent = s.cancelled ? t('scan.cancelled') : t('scan.done', {total:s.total, errors:s.errors});
          btnCancel.classList.add('hidden');
          btnScan.disabled = false;
          setTimeout(() => { wrap.classList.add('hidden'); bar.style.width = '0'; }, 4000);
          loadDashboard();
        }
      } catch { clearInterval(scanPollTimer); scanPollTimer = null; btnScan.disabled = false; }
    }, 1000);
  }

  // Check scan on load (called from showApp)
  function checkScanOnLoad() {
    api('/scan/progress').then(s => { if (s.running) startScanPoll(); }).catch(() => {});
  }

  /* ── Sync DB ───────────────────────────────────────────── */
  let syncPollTimer = null;

  $('#btn-sync').addEventListener('click', async () => {
    try {
      await api('/sync', { method: 'POST' });
      toast(t('toast.sync_started'), 'success');
      startSyncPoll();
    } catch (e) { toast(e.message, 'error'); }
  });

  function startSyncPoll() {
    if (syncPollTimer) return;
    const wrap = $('#sync-progress');
    const bar = $('#sync-bar');
    const detail = $('#sync-detail');
    const btn = $('#btn-sync');

    wrap.classList.remove('hidden');
    btn.disabled = true;

    syncPollTimer = setInterval(async () => {
      try {
        const s = await api('/sync/progress');
        if (s.running) {
          const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
          bar.style.width = pct + '%';
          detail.textContent = t('sync.progress', {done:s.done, total:s.total, removed:s.removed, added:s.added, errors:s.errors});
        } else {
          clearInterval(syncPollTimer);
          syncPollTimer = null;
          bar.style.width = '100%';
          detail.textContent = t('sync.done', {removed:s.removed, added:s.added, errors:s.errors});
          btn.disabled = false;
          setTimeout(() => { wrap.classList.add('hidden'); bar.style.width = '0'; }, 5000);
          loadDashboard();
          loadFolders();
        }
      } catch { clearInterval(syncPollTimer); syncPollTimer = null; btn.disabled = false; }
    }, 1000);
  }

  function checkSyncOnLoad() {
    api('/sync/progress').then(s => { if (s.running) startSyncPoll(); }).catch(() => {});
  }

  /* ── Enrich / Thumbs ──────────────────────────────────── */
  let enrichPollTimer = null;
  let thumbsPollTimer = null;

  $('#btn-enrich').addEventListener('click', async () => {
    try {
      await api('/enrich', { method: 'POST' });
      toast(t('toast.enrich_started'), 'success');
      startEnrichPoll();
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#btn-gen-thumbs').addEventListener('click', async () => {
    try {
      await api('/thumbs', { method: 'POST' });
      toast(t('toast.thumbs_started'), 'success');
      startThumbsPoll();
    } catch (e) { toast(e.message, 'error'); }
  });

  function startEnrichPoll() {
    if (enrichPollTimer) return;
    const wrap = $('#enrich-progress');
    const bar = $('#enrich-bar');
    const detail = $('#enrich-detail');
    const btn = $('#btn-enrich');

    wrap.classList.remove('hidden');
    btn.disabled = true;

    enrichPollTimer = setInterval(async () => {
      try {
        const s = await api('/enrich/progress');
        if (s.running) {
          const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
          bar.style.width = pct + '%';
          detail.textContent = t('enrich.progress', {done:s.done, total:s.total, errors:s.errors});
        } else {
          clearInterval(enrichPollTimer);
          enrichPollTimer = null;
          bar.style.width = '100%';
          detail.textContent = t('enrich.done', {total:s.total, errors:s.errors});
          btn.disabled = false;
          setTimeout(() => { wrap.classList.add('hidden'); bar.style.width = '0'; }, 4000);
          loadDashboard();
        }
      } catch { clearInterval(enrichPollTimer); enrichPollTimer = null; btn.disabled = false; }
    }, 1000);
  }

  function startThumbsPoll() {
    if (thumbsPollTimer) return;
    const wrap = $('#thumbs-progress');
    const bar = $('#thumbs-bar');
    const detail = $('#thumbs-detail');
    const btn = $('#btn-gen-thumbs');

    wrap.classList.remove('hidden');
    btn.disabled = true;

    thumbsPollTimer = setInterval(async () => {
      try {
        const s = await api('/thumbs/progress');
        if (s.running) {
          const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
          bar.style.width = pct + '%';
          detail.textContent = t('thumbs.progress', {done:s.done, total:s.total, errors:s.errors});
        } else {
          clearInterval(thumbsPollTimer);
          thumbsPollTimer = null;
          bar.style.width = '100%';
          detail.textContent = t('thumbs.done', {total:s.total, errors:s.errors});
          btn.disabled = false;
          setTimeout(() => { wrap.classList.add('hidden'); bar.style.width = '0'; }, 4000);
          loadDashboard();
        }
      } catch { clearInterval(thumbsPollTimer); thumbsPollTimer = null; btn.disabled = false; }
    }, 1000);
  }

  // Check enrich/thumbs on load (resume progress bars if running)
  function checkEnrichOnLoad() {
    api('/enrich/progress').then(s => { if (s.running) startEnrichPoll(); }).catch(() => {});
  }
  function checkThumbsOnLoad() {
    api('/thumbs/progress').then(s => { if (s.running) startThumbsPoll(); }).catch(() => {});
  }

  /* ── Clear DB ──────────────────────────────────────────── */
  $('#btn-clear-db').addEventListener('click', async () => {
    if (!confirm(t('confirm.clear_db'))) return;
    try {
      await api('/clear', { method: 'POST' });
      toast(t('toast.db_cleared'), 'success');
      libSelected.clear();
      loadDashboard();
      loadFolders();
      loadLibrary();
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ═══════════════════════════════════════════════════════
     LIBRARY
     ═══════════════════════════════════════════════════════ */

  async function loadFolders() {
    try {
      const folders = await api('/folders');
      const sel = $('#lib-folder');
      sel.innerHTML = `<option value="">${t('lib.all_folders')}</option>`;
      folders.forEach(f => {
        const o = document.createElement('option');
        o.value = f.folder;
        o.textContent = `${f.folder} (${f.count})`;
        sel.appendChild(o);
      });
    } catch {}
  }

  async function loadLibrary() {
    try {
      const q = $('#lib-search').value;
      const folder = $('#lib-folder').value;
      const codec = $('#lib-codec').value;
      const skip = $('#lib-skip').value;
      const sort = $('#lib-sort').value;

      const params = new URLSearchParams({
        page: libPage, limit: libLimit, sort, order: libOrder,
      });
      if (q) params.set('q', q);
      if (folder) params.set('folder', folder);
      if (codec) params.set('codec', codec);
      if (skip) params.set('skip', skip);

      const data = await api(`/videos?${params}`);
      libTotal = data.total || 0;
      renderLibGrid(data.videos);
      renderPagination(data.pages, data.page);
      updateSelectionBar();
    } catch (e) { toast(t('error.library', {msg: e.message}), 'error'); }
  }

  function renderLibGrid(videos) {
    const grid = $('#lib-grid');
    if (!videos.length) {
      grid.innerHTML = `<div class="mb-empty">${t('lib.no_video')}</div>`;
      return;
    }
    grid.innerHTML = videos.map(v => {
      const sel = libSelected.has(v.id);
      return `
        <div class="mb-card ${sel ? 'mb-selected' : ''}" data-id="${v.id}">
          <input type="checkbox" class="mb-card-cb" ${sel ? 'checked' : ''}>
          <div class="mb-card-thumb">
            <img src="/api/thumb/${v.id}?token=${encodeURIComponent(token)}" onerror="this.src='/img/no-thumb.svg'" loading="lazy">
            <button class="mb-play-btn" data-vid="${v.id}" data-fname="${escHtml(v.filename)}" title="Lire">▶</button>
          </div>
          <span class="mb-card-size">${fmtSize(v.size)}</span>
          ${v.encode_skip ? '<span class="mb-card-skip" title="Encodage ignoré (résultat plus gros)">⚠ skip</span>' : ''}
          <div class="mb-card-info">
            <div class="mb-card-name" title="${escHtml(v.filename)}">${escHtml(v.filename)}</div>
            <div class="mb-card-meta">${v.codec || '?'} · ${v.width ? v.width + '×' + v.height : '?'} · ${fmtDur(v.duration)}</div>
          </div>
        </div>`;
    }).join('');

    // Click to select
    const cards = $$('.mb-card', grid);
    cards.forEach((card, idx) => {
      card.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT' || e.target.classList.contains('mb-play-btn')) return;
        const id = parseInt(card.dataset.id, 10);
        if (e.shiftKey && lastClickedCardIdx >= 0) {
          const from = Math.min(lastClickedCardIdx, idx);
          const to = Math.max(lastClickedCardIdx, idx);
          for (let i = from; i <= to; i++) {
            const c = cards[i];
            const cid = parseInt(c.dataset.id, 10);
            libSelected.add(cid);
            c.classList.add('mb-selected');
            c.querySelector('.mb-card-cb').checked = true;
          }
          updateSelectionBar();
        } else {
          toggleSelect(id, card);
        }
        lastClickedCardIdx = idx;
      });
      const cb = card.querySelector('.mb-card-cb');
      cb.addEventListener('change', () => {
        const id = parseInt(card.dataset.id, 10);
        toggleSelect(id, card, cb.checked);
        lastClickedCardIdx = idx;
      });
    });

    // Play buttons
    $$('.mb-play-btn', grid).forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const vid = btn.dataset.vid;
        const fname = btn.dataset.fname;
        openVideoPlayer(vid, fname);
      });
    });
  }

  function toggleSelect(id, card, force) {
    const sel = force !== undefined ? force : !libSelected.has(id);
    if (sel) libSelected.add(id); else libSelected.delete(id);
    card.classList.toggle('mb-selected', sel);
    card.querySelector('.mb-card-cb').checked = sel;
    updateSelectionBar();
  }

  function updateSelectionBar() {
    const bar = $('#lib-selection-bar');
    const count = libSelected.size;
    if (count > 0) {
      bar.classList.remove('hidden');
      $('#lib-sel-count').textContent = count > libLimit && libTotal > libLimit ? t('lib.n_selected_total', {count, total: libTotal}) : t('lib.n_selected', {count});
    } else {
      bar.classList.add('hidden');
    }
  }

  function renderPagination(pages, current) {
    const wrap = $('#lib-pagination');
    if (pages <= 1) { wrap.innerHTML = ''; return; }
    let html = '';
    const MAX_VISIBLE = 7;
    if (pages <= MAX_VISIBLE + 2) {
      for (let p = 1; p <= pages; p++) {
        html += `<button class="page-btn ${p === current ? 'active' : ''}" data-page="${p}">${p}</button>`;
      }
    } else {
      // Truncated pagination: 1 ... 4 5 6 ... 50
      const range = [];
      range.push(1);
      let lo = Math.max(2, current - 2);
      let hi = Math.min(pages - 1, current + 2);
      if (lo > 2) range.push(-1); // ellipsis
      for (let p = lo; p <= hi; p++) range.push(p);
      if (hi < pages - 1) range.push(-1); // ellipsis
      range.push(pages);
      for (const p of range) {
        if (p === -1) { html += '<span class="page-ellipsis">…</span>'; }
        else { html += `<button class="page-btn ${p === current ? 'active' : ''}" data-page="${p}">${p}</button>`; }
      }
    }
    wrap.innerHTML = html;
    $$('.page-btn', wrap).forEach(btn => {
      btn.addEventListener('click', () => { libPage = parseInt(btn.dataset.page, 10); loadLibrary(); });
    });
  }

  // Library controls
  $('#lib-search').addEventListener('input', () => {
    clearTimeout(libSearchTimer);
    libSearchTimer = setTimeout(() => { libPage = 1; loadLibrary(); }, 350);
  });
  ['lib-folder', 'lib-codec', 'lib-skip', 'lib-sort'].forEach(id => {
    $(`#${id}`).addEventListener('change', () => { libPage = 1; loadLibrary(); });
  });
  $('#lib-order-btn').addEventListener('click', () => {
    libOrder = libOrder === 'asc' ? 'desc' : 'asc';
    $('#lib-order-btn').textContent = libOrder === 'asc' ? '↑' : '↓';
    loadLibrary();
  });
  $('#lib-sel-all').addEventListener('click', () => {
    $$('.mb-card').forEach(c => {
      const id = parseInt(c.dataset.id, 10);
      libSelected.add(id);
      c.classList.add('mb-selected');
      c.querySelector('.mb-card-cb').checked = true;
    });
    updateSelectionBar();
  });
  // Select ALL videos matching the current filter (across all pages)
  $('#lib-sel-all-filtered').addEventListener('click', async () => {
    try {
      const params = new URLSearchParams();
      const q = $('#lib-search').value;
      const folder = $('#lib-folder').value;
      const codec = $('#lib-codec').value;
      const skip = $('#lib-skip').value;
      if (q) params.set('q', q);
      if (folder) params.set('folder', folder);
      if (codec) params.set('codec', codec);
      if (skip) params.set('skip', skip);
      const data = await api(`/videos/ids?${params}`);
      if (!data.ids || !data.ids.length) { toast(t('toast.no_matching'), 'info'); return; }
      data.ids.forEach(id => libSelected.add(id));
      // Update checkboxes on current page
      $$('.mb-card').forEach(c => {
        const id = parseInt(c.dataset.id, 10);
        if (libSelected.has(id)) {
          c.classList.add('mb-selected');
          c.querySelector('.mb-card-cb').checked = true;
        }
      });
      updateSelectionBar();
      toast(t('toast.n_selected', {n: data.ids.length}), 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#lib-sel-none').addEventListener('click', () => {
    libSelected.clear();
    $$('.mb-card').forEach(c => {
      c.classList.remove('mb-selected');
      c.querySelector('.mb-card-cb').checked = false;
    });
    updateSelectionBar();
  });
  // Encode selected
  let forceEncodeFlag = false;
  $('#lib-encode-sel').addEventListener('click', () => {
    if (!libSelected.size) return;
    forceEncodeFlag = false;
    openEncodeModal([...libSelected]);
  });
  // Force encode (skip-flagged videos)
  $('#lib-force-encode-sel').addEventListener('click', () => {
    if (!libSelected.size) return;
    forceEncodeFlag = true;
    openEncodeModal([...libSelected]);
  });
  // Delete selected
  $('#lib-delete-sel').addEventListener('click', async () => {
    if (!libSelected.size) return;
    const n = libSelected.size;
    if (!confirm(t('confirm.delete_videos', {n}))) return;
    try {
      const r = await api('/videos/delete', { method: 'POST', body: JSON.stringify({ ids: [...libSelected] }) });
      toast(t('toast.n_deleted', {n: r.deleted}), 'success');
      if (r.fileErrors && r.fileErrors.length) toast(t('toast.file_errors', {n: r.fileErrors.length}), 'warn');
      libSelected.clear();
      updateSelectionBar();
      loadLibrary();
      loadDashboard();
      loadFolders();
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ═══════════════════════════════════════════════════════
     ENCODE
     ═══════════════════════════════════════════════════════ */

  async function loadEncodeQueue() {
    const gen = ++_eqGen;
    try {
      const [status, history] = await Promise.all([api('/encode/status'), api('/encode/history?limit=200')]);
      if (gen !== _eqGen) return; // a newer request was made — discard stale result
      renderEncodeStatus(status, history.rows, history.counts);
    } catch (e) {
      if (gen === _eqGen) toast(t('error.encoding', {msg: e.message}), 'error');
    }
  }

  /** Debounced version — used by SSE handlers to avoid rapid re-renders */
  function scheduleLoadEncodeQueue(delay) {
    if (typeof delay !== 'number') delay = 400;
    if (_eqDebounceTimer) clearTimeout(_eqDebounceTimer);
    _eqDebounceTimer = setTimeout(() => {
      _eqDebounceTimer = null;
      loadEncodeQueue();
    }, delay);
  }

  // Periodic fallback refresh in case SSE events are missed (every 15s)
  let _eqPollTimer = null;
  function startQueuePoll() {
    if (_eqPollTimer) return;
    _eqPollTimer = setInterval(() => loadEncodeQueue(), 15000);
  }
  function stopQueuePoll() {
    if (_eqPollTimer) { clearInterval(_eqPollTimer); _eqPollTimer = null; }
  }

  function renderEncodeStatus(status, jobs, serverCounts) {
    // Header stats — use server-side counts (accurate even with pagination)
    const header = $('#encode-status');
    const counts = serverCounts
      ? { pending: serverCounts.pending || 0, encoding: serverCounts.encoding || 0, done: serverCounts.done || 0, error: serverCounts.error || 0 }
      : (() => { const c = { pending: 0, encoding: 0, done: 0, error: 0 }; (jobs || []).forEach(j => { if (c.hasOwnProperty(j.status)) c[j.status]++; }); return c; })();

    header.innerHTML = `
      <div class="enc-queue-stats">
        <span class="enc-qs"><span class="dot dot-encoding"></span> ${t('queue.encoding')} : <b>${counts.encoding}</b></span>
        <span class="enc-qs"><span class="dot dot-pending"></span> ${t('queue.pending')} : <b>${counts.pending}</b></span>
        <span class="enc-qs"><span class="dot dot-done"></span> ${t('queue.done')} : <b>${counts.done}</b></span>
        <span class="enc-qs"><span class="dot dot-error"></span> ${t('queue.errors')} : <b>${counts.error}</b></span>
      </div>
      <div style="font-size:12px;color:var(--a-text-muted)">${t('queue.active_workers', {active: status.activeJobs, total: status.workerCount})}</div>
    `;

    // Update badge on panel header
    const badge = $('#encode-badge');
    if (badge) {
      const activeCount = counts.encoding + counts.pending;
      if (activeCount > 0) {
        badge.textContent = activeCount > 999 ? Math.floor(activeCount / 1000) + 'k' : activeCount;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }

    // Jobs list
    const list = $('#encode-queue');
    if (!jobs || !jobs.length) {
      list.innerHTML = `<div class="mb-empty">${t('queue.no_jobs')}</div>`;
      return;
    }
    list.innerHTML = jobs.map(j => {
      const dotClass = j.status === 'encoding' ? 'dot-encoding' : j.status === 'pending' ? 'dot-pending' : j.status === 'done' ? 'dot-done' : 'dot-error';
      const fname = j.filename || truncPath(j.file_path) || `#${j.video_id}`;
      const meta = [j.preset_name || j.preset_id, j.status].filter(Boolean).join(' · ');
      const showProgress = j.status === 'encoding';
      const showActions = j.status === 'pending' || j.status === 'error';
      return `
        <div class="enc-job" data-jid="${j.id}">
          <span class="enc-job-status ${dotClass}"></span>
          <div class="enc-job-info">
            <div class="enc-job-name" title="${escHtml(fname)}">${escHtml(fname)}</div>
            <div class="enc-job-meta">${escHtml(meta)}</div>
          </div>
          ${showProgress ? (() => {
            const cached = liveProgress.get(j.id);
            const pct = cached ? cached.percent : (j.progress || 0);
            // Seed liveProgress from DB so subsequent in-place updates have a baseline
            if (!cached && pct > 0) liveProgress.set(j.id, { percent: pct, speed: '', fps: '' });
            const label = cached && cached.text ? cached.text : pct + '%';
            return `
            <div class="enc-job-progress">
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
              <div class="enc-job-pct">${label}</div>
            </div>`;
          })() : ''}
          <div class="enc-job-actions">
            ${j.status === 'pending' ? `<button class="btn btn-xs btn-ghost" onclick="encAction('up',${j.id})" title="Priorité +">⬆</button><button class="btn btn-xs btn-ghost" onclick="encAction('down',${j.id})" title="Priorité −">⬇</button><button class="btn btn-xs btn-danger" onclick="encAction('cancel',${j.id})">✕</button>` : ''}
            ${j.status === 'error' ? `<button class="btn btn-xs btn-primary" onclick="encAction('retry',${j.id})">↻</button>` : ''}
            ${j.status === 'done' || j.status === 'error' || j.status === 'cancelled' ? `<button class="btn btn-xs btn-ghost" onclick="encAction('log',${j.id})" title="Voir le log">📋</button>` : ''}
            ${j.status === 'encoding' ? `<button class="btn btn-xs btn-ghost" onclick="encAction('log',${j.id})" title="Voir le log">📋</button>` : ''}
            ${j.status === 'done' || j.status === 'error' || j.status === 'cancelled' ? `<button class="btn btn-xs btn-ghost" onclick="encAction('delete',${j.id})">🗑</button>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  // Expose for onclick
  window.encAction = async function (act, id) {
    try {
      if (act === 'cancel') await api(`/encode/cancel/${id}`, { method: 'POST' });
      else if (act === 'retry') await api(`/encode/retry/${id}`, { method: 'POST' });
      else if (act === 'delete') await api(`/encode/job/${id}`, { method: 'DELETE' });
      else if (act === 'up') await api(`/encode/job/${id}/move`, { method: 'POST', body: JSON.stringify({ direction: 'up' }) });
      else if (act === 'down') await api(`/encode/job/${id}/move`, { method: 'POST', body: JSON.stringify({ direction: 'down' }) });
      else if (act === 'log') { showJobLog(id); return; }
      loadEncodeQueue();
    } catch (e) { toast(e.message, 'error'); }
  };

  async function showJobLog(jobId) {
    try {
      const headers = { 'Authorization': `Bearer ${token}` };
      const res = await fetch(`/api/encode/job/${jobId}/log`, { headers });
      if (!res.ok) { toast(t('toast.log_unavailable'), 'warn'); return; }
      const text = await res.text();
      const modal = document.getElementById('log-modal') || createLogModal();
      modal.querySelector('.log-modal-content').textContent = text || t('log.empty');
      modal.querySelector('.log-modal-title').textContent = t('log.modal_title', {id: jobId});
      modal.style.display = '';
    } catch (e) { toast(`Erreur: ${e.message}`, 'error'); }
  }

  function createLogModal() {
    const modal = document.createElement('div');
    modal.id = 'log-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="max-width:900px;width:90vw">
        <div class="modal-header"><h3 class="log-modal-title">Log</h3><button class="modal-close" onclick="document.getElementById('log-modal').style.display='none'">✕</button></div>
        <div class="modal-body"><pre class="log-modal-content" style="max-height:60vh;overflow:auto;font-size:11px;background:var(--a-surface2);padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all;color:var(--a-text-muted)"></pre></div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  // SSE handlers
  function handleJobUpdate(d) {
    // Clean up progress cache for finished jobs
    if (d.status === 'done' || d.status === 'error' || d.status === 'cancelled') {
      liveProgress.delete(d.id);
    }

    // Status 'encoding' is just a confirmation — progress SSE handles the bar.
    // Only re-render for actual list changes (new job, finished, cancelled, pending).
    if (d.status === 'encoding') {
      // Update the existing DOM element in-place if it exists (just flip the dot color)
      const el = $(`.enc-job[data-jid="${d.id}"]`);
      if (el) {
        const dot = el.querySelector('.enc-job-status');
        if (dot) { dot.className = 'enc-job-status dot-encoding'; }
      } else {
        // New job not yet in DOM — need full re-render
        scheduleLoadEncodeQueue(300);
      }
      return;
    }

    // Debounced refresh — avoids rapid re-renders when many SSE events fire at once
    scheduleLoadEncodeQueue(300);
    if (d.status === 'done') {
      if (d.skipped) {
        toast(t('toast.job_skipped', {id: d.id, reason: d.reason || ''}), 'info');
      } else {
        toast(t('toast.encoding_done', {id: d.id}), 'success');
      }
      loadDashboard();
      // Refresh library to show updated codec/size/metadata
      loadLibrary();
    } else if (d.status === 'error') {
      toast(t('toast.encoding_error', {id: d.id, error: d.error || ''}), 'error');
    }
  }

  function handleJobProgress(d) {
    liveProgress.set(d.id, { percent: d.percent, speed: d.speed, fps: d.fps });
    const job = $(`.enc-job[data-jid="${d.id}"]`);
    if (!job) return;
    const fill = job.querySelector('.progress-fill');
    const pctEl = job.querySelector('.enc-job-pct');
    if (fill) fill.style.width = d.percent + '%';
    if (pctEl) pctEl.textContent = d.percent + '%';
  }

  // Workers
  $('#btn-set-workers').addEventListener('click', async () => {
    const count = parseInt($('#worker-count').value, 10);
    if (!count || count < 1 || count > 8) return;
    try {
      await api('/encode/workers', { method: 'POST', body: JSON.stringify({ count }) });
      toast(t('toast.workers_set', {count}), 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#btn-cancel-all').addEventListener('click', async () => {
    try {
      const r = await api('/encode/cancel-all', { method: 'POST' });
      toast(t('toast.jobs_cancelled', {n: r.cancelled}), 'info');
      loadEncodeQueue();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#btn-clear-queue').addEventListener('click', async () => {
    try {
      const r = await api('/encode/clear-finished', { method: 'POST' });
      toast(t('toast.jobs_cleared', {n: r.cleared}), 'success');
      loadEncodeQueue();
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ── Video Player ──────────────────────────────────────── */
  function openVideoPlayer(videoId, filename) {
    const player = $('#video-player');
    const modal = $('#player-modal');
    $('#player-title').textContent = filename || t('player.title');
    player.src = `/api/stream/${videoId}?token=${encodeURIComponent(token)}`;
    modal.style.display = '';
    player.play().catch(() => {});
  }

  function closeVideoPlayer() {
    const player = $('#video-player');
    player.pause();
    player.removeAttribute('src');
    player.load();
    $('#player-modal').style.display = 'none';
  }

  $('#player-modal-close').addEventListener('click', closeVideoPlayer);
  $('#player-modal').addEventListener('click', e => {
    if (e.target === $('#player-modal')) closeVideoPlayer();
  });

  /* ── Encode Modal ─────────────────────────────────────── */
  let encodeVideoIds = [];

  function openEncodeModal(videoIds) {
    encodeVideoIds = videoIds;
    $('#encode-modal-info').textContent = t('modal.n_selected', {n: videoIds.length});
    loadPresetsForModal();
    $('#encode-modal').style.display = '';
  }

  async function loadPresetsForModal() {
    try {
      const [caps, customPresets] = await Promise.all([
        api('/encode/capabilities'),
        api('/custom-presets').catch(() => []),
      ]);
      presets = caps.presets || [];

      // Add custom presets with a special prefix
      const customEntries = (customPresets || []).map(cp => ({
        id: `custom_${cp.id}`,
        label: `⭐ ${cp.name}`,
        _custom: cp,
      }));

      const sel = $('#encode-preset');
      sel.innerHTML = [
        ...customEntries.map(p => `<option value="${p.id}">${escHtml(p.label)}</option>`),
        ...presets.map(p => `<option value="${p.id}">${escHtml(p.label)}</option>`),
      ].join('');
    } catch (e) { toast(e.message, 'error'); }
  }

  $('#encode-modal-close').addEventListener('click', () => { forceEncodeFlag = false; $('#encode-modal').style.display = 'none'; });
  $('#encode-modal-cancel').addEventListener('click', () => { forceEncodeFlag = false; $('#encode-modal').style.display = 'none'; });
  $('#encode-modal-submit').addEventListener('click', async () => {
    const presetId = $('#encode-preset').value;
    const replaceOriginal = $('#encode-replace').checked;
    const container = $('#encode-container')?.value || 'auto';
    const downscale = $('#encode-downscale')?.value || '';
    const tonemap = $('#encode-tonemap')?.checked || false;
    if (!presetId) return toast(t('toast.select_preset'), 'warn');
    try {
      const r = await api('/encode/enqueue', {
        method: 'POST',
        body: JSON.stringify({ videoIds: encodeVideoIds, presetId, replaceOriginal, container, downscale, tonemap, force: forceEncodeFlag }),
      });
      const nJobs = (r.jobs || []).length;
      const nSkipped = (r.skipped || []).length;
      const msg = nSkipped > 0 ? t('toast.jobs_added_skipped', {nJobs, nSkipped}) : t('toast.jobs_added', {nJobs});
      toast(msg, nJobs > 0 ? 'success' : 'info');
      $('#encode-modal').style.display = 'none';
      forceEncodeFlag = false;
      libSelected.clear();
      updateSelectionBar();
      loadEncodeQueue();
      // Ensure encode panel is visible
      const body = $('#encode-panel-body');
      if (body) body.style.display = '';
    } catch (e) { toast(e.message, 'error'); }
  });

  // Encode panel toggle
  const encPanelToggle = $('#encode-panel-toggle');
  if (encPanelToggle) {
    encPanelToggle.addEventListener('click', () => {
      const body = $('#encode-panel-body');
      body.style.display = body.style.display === 'none' ? '' : 'none';
    });
  }

  /* ═══════════════════════════════════════════════════════
     HARDWARE
     ═══════════════════════════════════════════════════════ */

  async function loadHardware(refresh) {
    try {
      const caps = await api(`/encode/capabilities${refresh ? '?refresh=1' : ''}`);
      presets = caps.presets || [];

      // Info chips
      const info = $('#hw-info');
      let chips = '';
      if (caps.nvidia) chips += `<span class="hw-chip hw-chip-gpu">${t('hw.nvidia')}</span>`;
      if (caps.vaapi) chips += `<span class="hw-chip hw-chip-vaapi">${t('hw.vaapi')}</span>`;
      if (!caps.nvidia && !caps.vaapi) chips += `<span class="hw-chip hw-chip-cpu">${t('hw.cpu_only')}</span>`;
      info.innerHTML = chips;

      // Presets list
      const list = $('#hw-presets');
      list.innerHTML = presets.map(p => `
        <div class="enc-job">
          <span class="enc-job-status" style="background:var(--a-accent)"></span>
          <div class="enc-job-info">
            <div class="enc-job-name">${escHtml(p.label)}</div>
            <div class="enc-job-meta">${escHtml(p.id)} — ${p.encoder || '?'}</div>
          </div>
        </div>`).join('');
    } catch (e) { toast(t('error.hardware', {msg: e.message}), 'error'); }
  }

  $('#btn-hw-refresh').addEventListener('click', () => loadHardware(true));

  /* ═══════════════════════════════════════════════════════
     LOGS
     ═══════════════════════════════════════════════════════ */

  function addLogEntry(entry) {
    logEntries.push(entry);
    if (logEntries.length > MAX_LOG) logEntries.shift();
    // Live render if tab open
    if ($('#tab-logs').classList.contains('active')) appendLogLine(entry);
  }

  function renderLogs() {
    const box = $('#log-container');
    box.innerHTML = '';
    const lvl = $('#log-level-filter').value;
    const src = $('#log-source-filter').value;
    const filtered = logEntries.filter(e =>
      (!lvl || e.level === lvl) && (!src || e.source === src)
    );
    filtered.forEach(e => appendLogLine(e, false));
    if ($('#log-autoscroll').checked) box.scrollTop = box.scrollHeight;
  }

  function appendLogLine(entry, scroll = true) {
    const lvl = $('#log-level-filter').value;
    const src = $('#log-source-filter').value;
    if (lvl && entry.level !== lvl) return;
    if (src && entry.source !== src) return;

    const box = $('#log-container');
    const line = document.createElement('div');
    line.className = `log-line log-${entry.level}`;
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : '';
    line.innerHTML = `<span class="log-ts">${ts}</span><span class="log-src">[${escHtml(entry.source)}]</span>${escHtml(entry.message)}`;
    box.appendChild(line);
    if (box.children.length > MAX_LOG) box.removeChild(box.firstChild);
    if (scroll && $('#log-autoscroll').checked) box.scrollTop = box.scrollHeight;
  }

  // Load initial logs
  async function loadInitialLogs() {
    try {
      const entries = await api('/logs?limit=200');
      if (Array.isArray(entries)) entries.forEach(e => { logEntries.push(e); });
    } catch {}
  }

  $('#log-level-filter').addEventListener('change', renderLogs);
  $('#log-source-filter').addEventListener('change', renderLogs);
  $('#btn-clear-logs').addEventListener('click', () => {
    logEntries.length = 0;
    $('#log-container').innerHTML = '';
  });

  /* ═══════════════════════════════════════════════════════
     SETTINGS
     ═══════════════════════════════════════════════════════ */

  async function loadSettings() {
    // Schedule
    try {
      const sched = await api('/settings/schedule');
      $('#schedule-enabled').checked = sched.enabled;
      $('#schedule-start').value = sched.start;
      $('#schedule-end').value = sched.end;
      $('#schedule-fields').style.display = sched.enabled ? 'flex' : 'none';
    } catch {}
    // Webhook
    try {
      const notif = await api('/settings/notifications');
      $('#webhook-enabled').checked = notif.enabled;
      $('#webhook-url').value = notif.url || '';
    } catch {}
    // Media sources
    loadSources();
    // Custom presets
    loadCustomPresets();
  }

  $('#schedule-enabled').addEventListener('change', () => {
    $('#schedule-fields').style.display = $('#schedule-enabled').checked ? 'flex' : 'none';
  });

  $('#btn-save-schedule').addEventListener('click', async () => {
    try {
      await api('/settings/schedule', {
        method: 'POST',
        body: JSON.stringify({
          enabled: $('#schedule-enabled').checked,
          start: parseInt($('#schedule-start').value, 10),
          end: parseInt($('#schedule-end').value, 10),
        }),
      });
      toast(t('toast.schedule_saved'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#btn-save-webhook').addEventListener('click', async () => {
    try {
      await api('/settings/notifications', {
        method: 'POST',
        body: JSON.stringify({
          enabled: $('#webhook-enabled').checked,
          url: $('#webhook-url').value,
        }),
      });
      toast(t('toast.webhook_saved'), 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ── Media Sources ────────────────────────────────────────── */
  async function loadSources() {
    try {
      const sources = await api('/settings/sources');
      const list = $('#sources-list');
      if (!sources.length) {
        list.innerHTML = `<div class="source-empty">${t('settings.sources_empty')}</div>`;
        return;
      }
      list.innerHTML = sources.map(s => `
        <div class="source-card">
          <div class="source-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </div>
          <div class="source-info">
            <div class="source-path">${escHtml(s.path)}</div>
            ${s.label ? `<div class="source-label">${escHtml(s.label)}</div>` : ''}
          </div>
          <button class="btn btn-xs btn-danger" onclick="removeSource(${s.id})" title="${t('settings.sources_remove')}">🗑</button>
        </div>`).join('');
    } catch (e) { toast(t('error.generic', { msg: e.message }), 'error'); }
  }

  window.removeSource = async function(id) {
    if (!confirm(t('settings.sources_confirm_remove'))) return;
    try {
      await api(`/settings/sources/${id}`, { method: 'DELETE' });
      toast(t('toast.source_removed'), 'success');
      loadSources();
      loadDashboard();
    } catch (e) { toast(e.message, 'error'); }
  };

  /* ── File Browser Modal ─────────────────────────────────── */
  let browsePath = '/';
  let browseCallback = null;

  function openBrowser(startPath, callback) {
    browsePath = startPath || '/';
    browseCallback = callback;
    $('#browse-modal').style.display = '';
    $('#browse-label').value = '';
    loadBrowse(browsePath);
  }

  function closeBrowser() {
    $('#browse-modal').style.display = 'none';
    browseCallback = null;
  }

  async function loadBrowse(dirPath) {
    browsePath = dirPath;
    $('#browse-path').textContent = dirPath;
    const list = $('#browse-dirs');
    list.innerHTML = `<div class="browse-empty">…</div>`;
    try {
      const data = await api(`/browse?path=${encodeURIComponent(dirPath)}`);
      browsePath = data.current;
      $('#browse-path').textContent = data.current;
      $('#browse-up').disabled = !data.parent;
      if (!data.dirs.length) {
        list.innerHTML = `<div class="browse-empty">${t('browse.empty')}</div>`;
        return;
      }
      list.innerHTML = data.dirs.map(d => `
        <div class="browse-item${d.readable ? '' : ' disabled'}" data-path="${escHtml(d.path)}">
          <span class="browse-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </span>
          <span class="browse-item-name">${escHtml(d.name)}</span>
          ${d.videoCount ? `<span class="browse-item-badge">${d.videoCount} vid</span>` : ''}
        </div>`).join('');
    } catch (e) {
      list.innerHTML = `<div class="browse-empty" style="color:var(--a-red)">${escHtml(e.message)}</div>`;
    }
  }

  // Navigate into a directory on click
  document.addEventListener('click', e => {
    const item = e.target.closest('.browse-item');
    if (!item || item.classList.contains('disabled')) return;
    loadBrowse(item.dataset.path);
  });

  $('#browse-up').addEventListener('click', async () => {
    try {
      const data = await api(`/browse?path=${encodeURIComponent(browsePath)}`);
      if (data.parent) loadBrowse(data.parent);
    } catch {}
  });

  $('#browse-select').addEventListener('click', () => {
    const label = $('#browse-label').value.trim();
    if (browseCallback) browseCallback(browsePath, label);
    closeBrowser();
  });

  $('#browse-cancel').addEventListener('click', closeBrowser);
  $('#browse-modal-close').addEventListener('click', closeBrowser);
  $('#browse-modal').addEventListener('click', e => {
    if (e.target === $('#browse-modal')) closeBrowser();
  });

  // "Add source" button opens the file browser
  $('#btn-add-source').addEventListener('click', () => {
    openBrowser('/', async (selectedPath, label) => {
      try {
        await api('/settings/sources', {
          method: 'POST',
          body: JSON.stringify({ path: selectedPath, label: label || '' }),
        });
        toast(t('toast.source_added'), 'success');
        loadSources();
        loadDashboard();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  /* ── Custom Presets ─────────────────────────────────────── */
  async function loadCustomPresets() {
    try {
      const presetsList = await api('/custom-presets');
      const list = $('#custom-presets-list');
      if (!presetsList.length) {
        list.innerHTML = `<p style="color:var(--a-text-muted);font-size:12px">${t('settings.no_presets')}</p>`;
        return;
      }
      list.innerHTML = presetsList.map(p => `
        <div class="enc-job">
          <span class="enc-job-status" style="background:var(--a-green)"></span>
          <div class="enc-job-info">
            <div class="enc-job-name">${escHtml(p.name)}</div>
            <div class="enc-job-meta">${p.codec.toUpperCase()} · CQ ${p.cq} · ${p.container || 'auto'} ${p.downscale ? '· ' + p.downscale + 'p' : ''} ${p.tonemap ? '· HDR→SDR' : ''}</div>
          </div>
          <div class="enc-job-actions">
            <button class="btn btn-xs btn-danger" onclick="deleteCustomPreset(${p.id})">🗑</button>
          </div>
        </div>`).join('');
    } catch {}
  }

  window.deleteCustomPreset = async function(id) {
    try {
      await api(`/custom-presets/${id}`, { method: 'DELETE' });
      toast(t('toast.preset_deleted'), 'success');
      loadCustomPresets();
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#btn-save-custom-preset').addEventListener('click', async () => {
    const name = $('#cp-name').value.trim();
    if (!name) return toast(t('toast.name_required'), 'warn');
    try {
      await api('/custom-presets', {
        method: 'POST',
        body: JSON.stringify({
          name,
          codec: $('#cp-codec').value,
          cq: parseInt($('#cp-cq').value, 10),
          container: $('#cp-container').value,
          downscale: $('#cp-downscale').value,
          tonemap: $('#cp-tonemap').checked,
        }),
      });
      toast(t('toast.preset_created'), 'success');
      $('#cp-name').value = '';
      loadCustomPresets();
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ═══════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════ */

  initAuth();

})();
