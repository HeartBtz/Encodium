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
  let libOrder = 'asc';
  let libSelected = new Set();
  let libSearchTimer = null;

  // Encode
  let presets = [];

  // Logs
  const logEntries = [];
  const MAX_LOG = 500;

  /* ── Helpers ──────────────────────────────────────────── */
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`/api${path}`, { ...opts, headers })
      .then(async r => {
        if (r.status === 401) { logout(); throw new Error('Session expirée'); }
        let j;
        try { j = await r.json(); } catch { throw new Error(`Réponse invalide (${r.status})`); }
        if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
        return j;
      })
      .catch(err => {
        if (err.message === 'Session expirée') throw err;
        if (err.name === 'TypeError') throw new Error('Connexion au serveur impossible');
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

  function showApp() {
    $('#login-screen').style.display = 'none';
    $('#app').style.display = '';
    $('#adminUser').textContent = currentUser.email;
    connectSSE();
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
      const jobTxt = jb ? `${jb.total || 0} (${jb.encoding || 0} en cours)` : '0';
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
            <div class="savings-item"><span class="savings-label">Fichiers encodés</span><span class="savings-value">${enc.count}</span></div>
            <div class="savings-item"><span class="savings-label">Taille avant</span><span class="savings-value">${fmtSize(enc.totalBefore)}</span></div>
            <div class="savings-item"><span class="savings-label">Taille après</span><span class="savings-value">${fmtSize(enc.totalAfter)}</span></div>
            <div class="savings-item"><span class="savings-label">Espace ${saved >= 0 ? 'gagné' : 'perdu'}</span><span class="savings-value ${saved >= 0 ? 'savings-positive' : 'savings-negative'}">${saved >= 0 ? '-' : '+'}${fmtSize(Math.abs(saved))} (${pct}%)</span></div>
            <div class="savings-item"><span class="savings-label">Ratio moyen</span><span class="savings-value">${ratio}%</span></div>
          </div>
          <div class="savings-bar-wrap">
            <div class="savings-bar-bg">
              <div class="savings-bar-fill" style="width:${Math.min(100, Number(ratio))}%"></div>
            </div>
            <div class="savings-bar-labels"><span>Après : ${fmtSize(enc.totalAfter)}</span><span>Avant : ${fmtSize(enc.totalBefore)}</span></div>
          </div>`;
      } else {
        $('#stat-saved').textContent = '—';
        $('#savings-card').style.display = 'none';
      }

      // Paths
      if (stats.paths) {
        $('#path-media').textContent = stats.paths.media || '—';
        $('#path-thumbs').textContent = stats.paths.thumbs || '—';
        $('#path-encode').textContent = stats.paths.encode || '—';
      }

      // Codec chart
      const grid = $('#codec-chart');
      if (codecs && codecs.length) {
        grid.innerHTML = codecs.map(c => `
          <div class="codec-card">
            <div class="cc-name">${escHtml(c.codec || 'inconnu')}</div>
            <div class="cc-count">${c.count}</div>
            <div class="cc-size">${fmtSize(c.total_size)}</div>
          </div>
        `).join('');
      } else {
        grid.innerHTML = '<p style="color:var(--a-text-muted);padding:12px">Aucune donnée codec</p>';
      }

      // Load encoding history charts
      loadStatsCharts();
    } catch (e) { toast(`Erreur dashboard: ${e.message}`, 'error'); }
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
            { label: 'Espace gagné (GB)', data: savedData, backgroundColor: 'rgba(168,85,247,0.6)', borderColor: 'rgba(168,85,247,1)', borderWidth: 1 },
            { label: 'Fichiers', data: countData, backgroundColor: 'rgba(59,130,246,0.5)', borderColor: 'rgba(59,130,246,1)', borderWidth: 1, yAxisID: 'y1' },
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
            { label: 'Avant (GB)', data: beforeData, borderColor: 'rgba(239,68,68,0.8)', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3 },
            { label: 'Après (GB)', data: afterData, borderColor: 'rgba(34,197,94,0.8)', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3 },
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
      toast('Scan lancé', 'success');
      startScanPoll();
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#btn-scan-cancel').addEventListener('click', async () => {
    try {
      await api('/scan/cancel', { method: 'POST' });
      toast('Annulation demandée', 'warn');
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
          detail.textContent = `${s.done}/${s.total} – ${s.currentFolder || '…'} (${s.skipped} ignorés, ${s.errors} erreurs)`;
        } else {
          clearInterval(scanPollTimer);
          scanPollTimer = null;
          bar.style.width = '100%';
          detail.textContent = s.cancelled ? 'Scan annulé' : `Terminé — ${s.total} fichiers, ${s.errors} erreurs`;
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
      toast('Synchronisation lancée', 'success');
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
          detail.textContent = `${s.done}/${s.total} vérifiés — ${s.removed} supprimé(s), ${s.added} ajouté(s), ${s.errors} erreurs`;
        } else {
          clearInterval(syncPollTimer);
          syncPollTimer = null;
          bar.style.width = '100%';
          detail.textContent = `Terminé — ${s.removed} supprimé(s), ${s.added} ajouté(s), ${s.errors} erreurs`;
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
      toast('Enrichissement lancé', 'success');
      startEnrichPoll();
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#btn-gen-thumbs').addEventListener('click', async () => {
    try {
      await api('/thumbs', { method: 'POST' });
      toast('Génération des miniatures lancée', 'success');
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
          detail.textContent = `${s.done}/${s.total} (${s.errors} erreurs)`;
        } else {
          clearInterval(enrichPollTimer);
          enrichPollTimer = null;
          bar.style.width = '100%';
          detail.textContent = `Terminé — ${s.total} vidéos, ${s.errors} erreurs`;
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
          detail.textContent = `${s.done}/${s.total} (${s.errors} erreurs)`;
        } else {
          clearInterval(thumbsPollTimer);
          thumbsPollTimer = null;
          bar.style.width = '100%';
          detail.textContent = `Terminé — ${s.total} miniatures, ${s.errors} erreurs`;
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
    if (!confirm('⚠️ Êtes-vous sûr de vouloir vider toute la base de données ?\nCette action est irréversible.')) return;
    try {
      await api('/clear', { method: 'POST' });
      toast('Base de données vidée', 'success');
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
      sel.innerHTML = '<option value="">Tous les dossiers</option>';
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
      const sort = $('#lib-sort').value;

      const params = new URLSearchParams({
        page: libPage, limit: libLimit, sort, order: libOrder,
      });
      if (q) params.set('q', q);
      if (folder) params.set('folder', folder);
      if (codec) params.set('codec', codec);

      const data = await api(`/videos?${params}`);
      renderLibGrid(data.videos);
      renderPagination(data.pages, data.page);
      updateSelectionBar();
    } catch (e) { toast(`Erreur bibliothèque: ${e.message}`, 'error'); }
  }

  function renderLibGrid(videos) {
    const grid = $('#lib-grid');
    if (!videos.length) {
      grid.innerHTML = '<div class="mb-empty">Aucune vidéo trouvée</div>';
      return;
    }
    grid.innerHTML = videos.map(v => {
      const sel = libSelected.has(v.id);
      return `
        <div class="mb-card ${sel ? 'mb-selected' : ''}" data-id="${v.id}">
          <input type="checkbox" class="mb-card-cb" ${sel ? 'checked' : ''}>
          <div class="mb-card-thumb">
            <img src="/api/thumb/${v.id}" onerror="this.src='/img/no-thumb.svg'" loading="lazy">
            <button class="mb-play-btn" data-vid="${v.id}" data-fname="${escHtml(v.filename)}" title="Lire">▶</button>
          </div>
          <span class="mb-card-size">${fmtSize(v.size)}</span>
          <div class="mb-card-info">
            <div class="mb-card-name" title="${escHtml(v.filename)}">${escHtml(v.filename)}</div>
            <div class="mb-card-meta">${v.codec || '?'} · ${v.width ? v.width + '×' + v.height : '?'} · ${fmtDur(v.duration)}</div>
          </div>
        </div>`;
    }).join('');

    // Click to select
    $$('.mb-card', grid).forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT' || e.target.classList.contains('mb-play-btn')) return;
        const id = parseInt(card.dataset.id, 10);
        toggleSelect(id, card);
      });
      const cb = card.querySelector('.mb-card-cb');
      cb.addEventListener('change', () => {
        const id = parseInt(card.dataset.id, 10);
        toggleSelect(id, card, cb.checked);
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
      $('#lib-sel-count').textContent = `${count} sélectionné(s)`;
    } else {
      bar.classList.add('hidden');
    }
  }

  function renderPagination(pages, current) {
    const wrap = $('#lib-pagination');
    if (pages <= 1) { wrap.innerHTML = ''; return; }
    let html = '';
    for (let p = 1; p <= pages; p++) {
      html += `<button class="page-btn ${p === current ? 'active' : ''}" data-page="${p}">${p}</button>`;
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
  ['lib-folder', 'lib-codec', 'lib-sort'].forEach(id => {
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
  $('#lib-sel-none').addEventListener('click', () => {
    libSelected.clear();
    $$('.mb-card').forEach(c => {
      c.classList.remove('mb-selected');
      c.querySelector('.mb-card-cb').checked = false;
    });
    updateSelectionBar();
  });
  // Encode selected
  $('#lib-encode-sel').addEventListener('click', () => {
    if (!libSelected.size) return;
    openEncodeModal([...libSelected]);
  });
  // Delete selected
  $('#lib-delete-sel').addEventListener('click', async () => {
    if (!libSelected.size) return;
    const n = libSelected.size;
    if (!confirm(`⚠️ Supprimer ${n} vidéo(s) définitivement ?\nLes fichiers seront effacés du disque.`)) return;
    try {
      const r = await api('/videos/delete', { method: 'POST', body: JSON.stringify({ ids: [...libSelected] }) });
      toast(`${r.deleted} vidéo(s) supprimée(s)`, 'success');
      if (r.fileErrors && r.fileErrors.length) toast(`${r.fileErrors.length} erreur(s) fichier`, 'warn');
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
    try {
      const [status, history] = await Promise.all([api('/encode/status'), api('/encode/history?limit=100')]);
      renderEncodeStatus(status, history.rows);
    } catch (e) { toast(`Erreur encodage: ${e.message}`, 'error'); }
  }

  function renderEncodeStatus(status, jobs) {
    // Header stats
    const header = $('#encode-status');
    const counts = { pending: 0, encoding: 0, done: 0, error: 0 };
    (jobs || []).forEach(j => { if (counts.hasOwnProperty(j.status)) counts[j.status]++; });

    header.innerHTML = `
      <div class="enc-queue-stats">
        <span class="enc-qs"><span class="dot dot-encoding"></span> En cours : <b>${counts.encoding}</b></span>
        <span class="enc-qs"><span class="dot dot-pending"></span> En attente : <b>${counts.pending}</b></span>
        <span class="enc-qs"><span class="dot dot-done"></span> Terminés : <b>${counts.done}</b></span>
        <span class="enc-qs"><span class="dot dot-error"></span> Erreurs : <b>${counts.error}</b></span>
      </div>
      <div style="font-size:12px;color:var(--a-text-muted)">Workers actifs : ${status.activeJobs}/${status.workerCount}</div>
    `;

    // Update badge on panel header
    const badge = $('#encode-badge');
    if (badge) {
      const activeCount = counts.encoding + counts.pending;
      if (activeCount > 0) {
        badge.textContent = activeCount;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    }

    // Jobs list
    const list = $('#encode-queue');
    if (!jobs || !jobs.length) {
      list.innerHTML = '<div class="mb-empty">Aucun job d\'encodage</div>';
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
      if (!res.ok) { toast('Log non disponible', 'warn'); return; }
      const text = await res.text();
      const modal = document.getElementById('log-modal') || createLogModal();
      modal.querySelector('.log-modal-content').textContent = text || '(vide)';
      modal.querySelector('.log-modal-title').textContent = `Log — Job #${jobId}`;
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
    // Always refresh encode queue on job status changes
    loadEncodeQueue();
    if (d.status === 'done') {
      if (d.skipped) {
        toast(`Job #${d.id} : ${d.reason || 'encodage ignoré'}`, 'info');
      } else {
        toast(`Encodage terminé : job #${d.id}`, 'success');
      }
      loadDashboard();
      // Refresh library to show updated codec/size/metadata
      loadLibrary();
    } else if (d.status === 'error') {
      toast(`Erreur encodage : job #${d.id} – ${d.error || ''}`, 'error');
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
      toast(`Workers réglés à ${count}`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#btn-cancel-all').addEventListener('click', async () => {
    try {
      const r = await api('/encode/cancel-all', { method: 'POST' });
      toast(`${r.cancelled} jobs annulés`, 'info');
      loadEncodeQueue();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#btn-clear-queue').addEventListener('click', async () => {
    try {
      const r = await api('/encode/clear-finished', { method: 'POST' });
      toast(`${r.cleared} job(s) supprimé(s) de la file`, 'success');
      loadEncodeQueue();
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ── Video Player ──────────────────────────────────────── */
  function openVideoPlayer(videoId, filename) {
    const player = $('#video-player');
    const modal = $('#player-modal');
    $('#player-title').textContent = filename || 'Lecture vidéo';
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
    $('#encode-modal-info').textContent = `${videoIds.length} vidéo(s) sélectionnée(s)`;
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

  $('#encode-modal-close').addEventListener('click', () => { $('#encode-modal').style.display = 'none'; });
  $('#encode-modal-cancel').addEventListener('click', () => { $('#encode-modal').style.display = 'none'; });
  $('#encode-modal-submit').addEventListener('click', async () => {
    const presetId = $('#encode-preset').value;
    const replaceOriginal = $('#encode-replace').checked;
    const container = $('#encode-container')?.value || 'auto';
    const downscale = $('#encode-downscale')?.value || '';
    const tonemap = $('#encode-tonemap')?.checked || false;
    if (!presetId) return toast('Sélectionnez un preset', 'warn');
    try {
      const r = await api('/encode/enqueue', {
        method: 'POST',
        body: JSON.stringify({ videoIds: encodeVideoIds, presetId, replaceOriginal, container, downscale, tonemap }),
      });
      const nJobs = (r.jobs || []).length;
      const nSkipped = (r.skipped || []).length;
      let msg = `${nJobs} job(s) ajouté(s)`;
      if (nSkipped > 0) msg += `, ${nSkipped} ignoré(s) (déjà dans le codec cible)`;
      toast(msg, nJobs > 0 ? 'success' : 'info');
      $('#encode-modal').style.display = 'none';
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
      if (caps.nvidia) chips += `<span class="hw-chip hw-chip-gpu">🟢 NVIDIA NVENC</span>`;
      if (caps.vaapi) chips += `<span class="hw-chip hw-chip-vaapi">🔵 VA-API</span>`;
      if (!caps.nvidia && !caps.vaapi) chips += `<span class="hw-chip hw-chip-cpu">⚪ CPU uniquement (libx265)</span>`;
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
    } catch (e) { toast(`Erreur matériel: ${e.message}`, 'error'); }
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
      toast('Planification enregistrée', 'success');
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
      toast('Notifications enregistrées', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ── Custom Presets ─────────────────────────────────────── */
  async function loadCustomPresets() {
    try {
      const presetsList = await api('/custom-presets');
      const list = $('#custom-presets-list');
      if (!presetsList.length) {
        list.innerHTML = '<p style="color:var(--a-text-muted);font-size:12px">Aucun preset personnalisé</p>';
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
      toast('Preset supprimé', 'success');
      loadCustomPresets();
    } catch (e) { toast(e.message, 'error'); }
  };

  $('#btn-save-custom-preset').addEventListener('click', async () => {
    const name = $('#cp-name').value.trim();
    if (!name) return toast('Nom requis', 'warn');
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
      toast('Preset créé', 'success');
      $('#cp-name').value = '';
      loadCustomPresets();
    } catch (e) { toast(e.message, 'error'); }
  });

  /* ═══════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════ */

  initAuth();

})();
