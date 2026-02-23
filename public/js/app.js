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

  /* ── Debug / Network diagnostics ────────────────────── */
  const _netLog = [];          // circular buffer of recent requests
  const NET_LOG_MAX = 100;
  let _activeRequests = 0;
  let _totalRequests = 0;
  let _totalErrors = 0;

  function _ts() { return new Date().toLocaleTimeString('fr-FR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }); }

  function _logNet(entry) {
    if (_netLog.length >= NET_LOG_MAX) _netLog.shift();
    _netLog.push(entry);
    _updateDebugPanel();
  }

  /** Dump diagnostics to console — callable from DevTools: _encodiumDebug() */
  window._encodiumDebug = function () {
    console.group('%c[Encodium Network Diagnostics]', 'color:#0af;font-weight:bold');
    console.log('Active requests:', _activeRequests);
    console.log('Total requests:', _totalRequests, '| Total errors:', _totalErrors);
    console.log('SSE state:', sse ? ['CONNECTING','OPEN','CLOSED'][sse.readyState] : 'null', '| retries:', sseRetries);
    console.table(_netLog.slice(-30).map(e => ({
      time: e.time, method: e.method, path: e.path, status: e.status,
      ms: e.duration, error: e.error || '', retry: e.retry || 0
    })));
    console.groupEnd();
    return { active: _activeRequests, total: _totalRequests, errors: _totalErrors, log: _netLog.slice() };
  };

  /* ── Debug overlay panel (toggle with Ctrl+Shift+D) ──── */
  let _debugPanel = null;
  let _debugVisible = false;

  function _initDebugPanel() {
    const panel = document.createElement('div');
    panel.id = 'enc-debug-panel';
    panel.innerHTML = `
      <div id="enc-debug-header">
        <span>🔍 Encodium Net Debug</span>
        <span id="enc-debug-stats"></span>
        <button id="enc-debug-close" title="Fermer (Ctrl+Shift+D)">✕</button>
      </div>
      <div id="enc-debug-body"></div>`;
    document.body.appendChild(panel);
    _debugPanel = panel;
    panel.style.display = 'none';

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #enc-debug-panel { position:fixed; bottom:0; right:0; width:520px; max-height:340px;
        background:#1a1a2e; color:#e0e0e0; font-family:monospace; font-size:11px;
        border-top:2px solid #0af; border-left:2px solid #0af; border-radius:8px 0 0 0;
        z-index:99999; display:flex; flex-direction:column; box-shadow:0 -2px 20px rgba(0,0,0,.5); }
      #enc-debug-header { display:flex; align-items:center; justify-content:space-between;
        padding:4px 10px; background:#0d0d1a; border-bottom:1px solid #333; gap:10px; flex-shrink:0; }
      #enc-debug-header span:first-child { font-weight:bold; color:#0af; }
      #enc-debug-stats { color:#aaa; flex:1; text-align:center; }
      #enc-debug-close { background:none; border:none; color:#f55; cursor:pointer; font-size:14px; padding:2px 6px; }
      #enc-debug-body { overflow-y:auto; padding:4px 8px; flex:1; }
      .enc-dl { display:flex; gap:6px; padding:1px 0; border-bottom:1px solid #222; align-items:baseline; }
      .enc-dl.enc-err { color:#f55; }
      .enc-dl.enc-slow { color:#f80; }
      .enc-dl .dl-time { color:#666; width:85px; flex-shrink:0; }
      .enc-dl .dl-method { width:36px; flex-shrink:0; color:#0af; }
      .enc-dl .dl-path { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .enc-dl .dl-status { width:55px; flex-shrink:0; text-align:right; }
      .enc-dl .dl-ms { width:50px; flex-shrink:0; text-align:right; color:#888; }
      .enc-dl .dl-err { color:#f55; margin-left:4px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    `;
    document.head.appendChild(style);

    document.getElementById('enc-debug-close').addEventListener('click', () => _toggleDebugPanel());
  }

  function _toggleDebugPanel() {
    if (!_debugPanel) _initDebugPanel();
    _debugVisible = !_debugVisible;
    _debugPanel.style.display = _debugVisible ? 'flex' : 'none';
    if (_debugVisible) _updateDebugPanel();
  }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') { e.preventDefault(); _toggleDebugPanel(); }
  });

  function _updateDebugPanel() {
    if (!_debugVisible || !_debugPanel) return;
    const statsEl = document.getElementById('enc-debug-stats');
    const bodyEl = document.getElementById('enc-debug-body');
    if (!statsEl || !bodyEl) return;

    const sseState = sse ? ['CONNECTING','OPEN','CLOSED'][sse.readyState] : 'null';
    statsEl.textContent = `Active: ${_activeRequests} | Errors: ${_totalErrors} | SSE: ${sseState} (r${sseRetries})`;

    const last30 = _netLog.slice(-40);
    bodyEl.innerHTML = last30.map(e => {
      const cls = e.error ? 'enc-err' : (e.duration > 3000 ? 'enc-slow' : '');
      const statusColor = e.status === 200 ? '#4c4' : (typeof e.status === 'number' && e.status >= 400 ? '#f55' : '#f80');
      return `<div class="enc-dl ${cls}">
        <span class="dl-time">${e.time}</span>
        <span class="dl-method">${e.method}</span>
        <span class="dl-path" title="${e.path}">${e.path}</span>
        <span class="dl-status" style="color:${statusColor}">${e.status}</span>
        <span class="dl-ms">${e.duration}ms</span>
        ${e.error ? `<span class="dl-err" title="${e.error}">${e.error}</span>` : ''}
      </div>`;
    }).join('');

    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  /* ── Proxy / CORS session detection ───────────────────── */
  let _proxyReloadPending = false;

  function _handleProxyAuthExpired(reqId, path, ms) {
    if (_proxyReloadPending) return; // already handling it
    _proxyReloadPending = true;
    _logNet({ time: _ts(), method: 'PROXY', path, status: 'AUTH_EXPIRED', duration: ms, error: 'Coder session expired → reloading' });
    console.error(`[NET #${reqId}] ✖ Proxy auth expired (CORS redirect detected) — reloading page in 3s…`);
    toast('⚠️ Session proxy expirée — rechargement automatique…', 'error');
    setTimeout(() => { window.location.reload(); }, 3000);
  }

  function api(path, opts = {}, _retry = 0) {
    const method = (opts.method || 'GET').toUpperCase();
    const t0 = performance.now();
    const reqId = ++_totalRequests;
    _activeRequests++;
    if (_retry === 0) {
      console.debug(`%c[NET #${reqId}] → ${method} /api${path}`, 'color:#888');
    } else {
      console.warn(`%c[NET #${reqId}] ↻ RETRY ${_retry} ${method} /api${path}`, 'color:#f80');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`/api${path}`, { ...opts, headers })
      .then(async r => {
        const ms = Math.round(performance.now() - t0);
        _activeRequests--;

        // Detect proxy redirect: if the response URL is on a different origin,
        // the reverse proxy (Coder) redirected us to its auth page.
        if (r.url && new URL(r.url).origin !== window.location.origin) {
          _handleProxyAuthExpired(reqId, path, ms);
          throw new Error('Proxy auth redirect');
        }
        // Also detect opaque redirect (type === 'opaqueredirect')
        if (r.type === 'opaqueredirect') {
          _handleProxyAuthExpired(reqId, path, ms);
          throw new Error('Proxy auth redirect');
        }

        if (r.status === 401) {
          _logNet({ time: _ts(), method, path, status: 401, duration: ms, error: 'session expired' });
          console.warn(`[NET #${reqId}] ← 401 (${ms}ms) ${path}`);
          logout(); throw new Error(t('error.session_expired'));
        }
        let j;
        try { j = await r.json(); } catch {
          _totalErrors++;
          _logNet({ time: _ts(), method, path, status: r.status, duration: ms, error: 'invalid JSON' });
          console.error(`[NET #${reqId}] ← ${r.status} INVALID JSON (${ms}ms) ${path}`);
          throw new Error(t('error.invalid_response', {status: r.status}));
        }
        if (!r.ok) {
          _totalErrors++;
          const errMsg = j.error || `HTTP ${r.status}`;
          _logNet({ time: _ts(), method, path, status: r.status, duration: ms, error: errMsg });
          console.error(`[NET #${reqId}] ← ${r.status} (${ms}ms) ${path}: ${errMsg}`);
          throw new Error(errMsg);
        }
        _logNet({ time: _ts(), method, path, status: r.status, duration: ms });
        if (ms > 3000) {
          console.warn(`[NET #${reqId}] ← ${r.status} SLOW (${ms}ms) ${path}`);
        } else {
          console.debug(`%c[NET #${reqId}] ← ${r.status} (${ms}ms) ${path}`, 'color:#888');
        }
        return j;
      })
      .catch(err => {
        const ms = Math.round(performance.now() - t0);
        if (err.message === t('error.session_expired') || err.message === 'Proxy auth redirect') throw err;
        // Only TypeError means the fetch itself failed (network level).
        // HTTP errors (4xx/5xx) already decremented _activeRequests in .then().
        if (err.name !== 'TypeError') throw err;

        // Detect Coder proxy CORS redirect: multiple consecutive TypeErrors
        // strongly suggest the reverse proxy session expired and is redirecting
        // to an external auth page, causing CORS blocks.
        if (!window._corsErrorCount) window._corsErrorCount = 0;
        window._corsErrorCount++;
        // If 3+ network errors within a short window → almost certainly proxy auth
        if (window._corsErrorCount >= 3) {
          _activeRequests--;
          _handleProxyAuthExpired(reqId, path, ms);
          throw new Error('Proxy auth redirect');
        }
        // Reset counter after 10s of no errors
        clearTimeout(window._corsErrorResetTimer);
        window._corsErrorResetTimer = setTimeout(() => { window._corsErrorCount = 0; }, 10000);

        // Retry once on network errors (server restart, brief outage)
        if (_retry < 1) {
          _logNet({ time: _ts(), method, path, status: 'NET_ERR', duration: ms, error: err.message, retry: 1 });
          console.warn(`[NET #${reqId}] ✖ NETWORK ERROR (${ms}ms) ${path}: ${err.message} — retrying in 2s…`);
          return new Promise(r => setTimeout(r, 2000)).then(() => api(path, opts, _retry + 1));
        }
        _activeRequests--;
        _totalErrors++;
        _logNet({ time: _ts(), method, path, status: 'NET_ERR', duration: ms, error: err.message, retry: _retry });
        console.error(`[NET #${reqId}] ✖ NETWORK FAILURE after ${_retry + 1} attempts (${ms}ms) ${path}: ${err.message}`);
        throw new Error(t('error.server_unreachable') + ` [${path}]`);
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
    // Restore last active tab, default to dashboard
    const savedTab = localStorage.getItem('enc_activeTab') || 'dashboard';
    // loadDashboard + loadFolders are already triggered by switchTab for relevant tabs
    // Only load dashboard explicitly if switching to a tab that doesn't call it
    if (savedTab !== 'library') loadDashboard();
    loadFolders();
    switchTab(savedTab);
    // Pre-load encode queue (for SSE progress) — but switchTab('library') already does it
    if (savedTab !== 'library') loadEncodeQueue();
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
    console.info(`[SSE] Connecting… (attempt ${sseRetries + 1})`);
    sse = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    sse.addEventListener('connected', () => {
      console.info(`[SSE] ✓ Connected (after ${sseRetries} retries)`);
      _logNet({ time: _ts(), method: 'SSE', path: '/events', status: 'OPEN', duration: 0 });
      // If reconnecting after a drop, refresh only current tab data
      if (sseRetries > 0) {
        const activeTab = localStorage.getItem('enc_activeTab') || 'dashboard';
        if (activeTab === 'dashboard') loadDashboard();
        else if (activeTab === 'library') loadLibrary();
        loadEncodeQueue();
      }
      sseRetries = 0;
    });
    sse.addEventListener('job_update', e => {
      try { handleJobUpdate(JSON.parse(e.data)); } catch {}
    });
    sse.addEventListener('job_progress', e => {
      try { handleJobProgress(JSON.parse(e.data)); } catch {}
    });
    sse.addEventListener('encoder_state', e => {
      try {
        const d = JSON.parse(e.data);
        if (typeof d.paused === 'boolean') { _queuePaused = d.paused; updatePauseButton(); }
        scheduleLoadEncodeQueue(300);
      } catch {}
    });
    sse.addEventListener('log', e => {
      try { addLogEntry(JSON.parse(e.data)); } catch {}
    });
    sse.addEventListener('pipeline_status', e => {
      try { handlePipelineStatus(JSON.parse(e.data)); } catch {}
    });
    sse.onerror = (ev) => {
      const state = ['CONNECTING','OPEN','CLOSED'][sse.readyState] || sse.readyState;
      console.warn(`[SSE] ✖ Error — readyState=${state}`);
      _logNet({ time: _ts(), method: 'SSE', path: '/events', status: 'ERROR', duration: 0, error: `readyState=${state}, retry=${sseRetries + 1}` });
      sse.close(); sse = null;
      sseRetries++;

      // If SSE fails quickly AND we have CORS network errors → proxy auth expired
      if (sseRetries >= 2 && window._corsErrorCount >= 2) {
        _handleProxyAuthExpired(0, '/events (SSE)', 0);
        return;
      }

      if (token && sseRetries < 10) {
        const delay = Math.min(sseRetries * 3000, 30000);
        console.info(`[SSE] Reconnecting in ${delay / 1000}s (retry ${sseRetries}/10)…`);
        setTimeout(() => connectSSE(), delay);
      } else if (sseRetries >= 10) {
        console.error('[SSE] ✖ Gave up after 10 retries — likely proxy auth expired');
        _logNet({ time: _ts(), method: 'SSE', path: '/events', status: 'DEAD', duration: 0, error: 'gave up after 10 retries' });
        // Last resort: if 10 SSE retries failed, reload the page
        _handleProxyAuthExpired(0, '/events (SSE final)', 0);
      }
    };
  }

  /* ── Pipeline SSE — auto-refresh on background scan/enrich/thumbs ── */
  let _pipelineRefreshTimer = null;

  function handlePipelineStatus(data) {
    const { step, status } = data;
    // When a step finishes, schedule a debounced refresh so we don't flood
    if (status === 'done') {
      debouncedPipelineRefresh();
    }
  }

  function debouncedPipelineRefresh() {
    if (_pipelineRefreshTimer) clearTimeout(_pipelineRefreshTimer);
    _pipelineRefreshTimer = setTimeout(() => {
      _pipelineRefreshTimer = null;
      loadDashboard();
      loadFolders();
      // Only reload library if we're on the library tab to avoid unnecessary calls
      const activeTab = localStorage.getItem('enc_activeTab') || 'dashboard';
      if (activeTab === 'library') {
        loadLibrary();
      }
    }, 1500);
  }

  /* ── Tab switching ────────────────────────────────────── */
  $$('.sidenav-item').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  function switchTab(tab) {
    $$('.sidenav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.admin-tab').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
    localStorage.setItem('enc_activeTab', tab);
    if (tab === 'dashboard') loadDashboard();
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
      const fail = $('#lib-fail').value;
      const sort = $('#lib-sort').value;

      const params = new URLSearchParams({
        page: libPage, limit: libLimit, sort, order: libOrder,
      });
      if (q) params.set('q', q);
      if (folder) params.set('folder', folder);
      if (codec) params.set('codec', codec);
      if (skip) params.set('skip', skip);
      if (fail) params.set('fail', fail);

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
          <div class="mb-card-thumb" id="thumb-wrap-${v.id}">
            <div class="mb-thumb-spinner"></div>
            <img data-thumb-id="${v.id}"
                 src="/api/thumb/${v.id}?token=${encodeURIComponent(token)}"
                 loading="lazy">
            <button class="mb-play-btn" data-vid="${v.id}" data-fname="${escHtml(v.filename)}" title="Lire">▶</button>
          </div>
          <span class="mb-card-size">${fmtSize(v.size)}</span>
          ${v.encode_skip ? '<span class="mb-card-skip" title="Encodage ignoré (résultat plus gros)">⚠ skip</span>' : ''}
          ${v.encode_failed ? `<span class="mb-card-fail" title="${escHtml(t('lib.fail_tag'))}">❌ fail</span>` : ''}
          <div class="mb-card-info">
            <div class="mb-card-name" title="${escHtml(v.filename)}">${escHtml(v.filename)}</div>
            <div class="mb-card-meta">${v.codec || '?'} · ${v.width ? v.width + '×' + v.height : '?'} · ${fmtDur(v.duration)}</div>
          </div>
        </div>`;
    }).join('');

    // Thumbnail load/error handler — retry with backoff, then fallback
    $$('img[data-thumb-id]', grid).forEach(img => {
      let retries = 0;
      const vid = img.dataset.thumbId;
      const wrap = img.closest('.mb-card-thumb');

      img.addEventListener('load', () => {
        // 202 JSON responses won't trigger 'load' on img (they trigger 'error')
        img.classList.add('thumb-loaded');
        wrap.classList.add('thumb-ready');
      });

      img.addEventListener('error', () => {
        if (retries < 2) {
          retries++;
          setTimeout(() => {
            img.src = `/api/thumb/${vid}?token=${encodeURIComponent(token)}&t=${Date.now()}`;
          }, 4000 * retries);
        } else {
          img.src = '/img/no-thumb.svg';
          img.classList.add('thumb-failed');
          wrap.classList.add('thumb-ready');
        }
      });
    });

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
  ['lib-folder', 'lib-codec', 'lib-skip', 'lib-fail', 'lib-sort'].forEach(id => {
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
      const fail = $('#lib-fail').value;
      if (q) params.set('q', q);
      if (folder) params.set('folder', folder);
      if (codec) params.set('codec', codec);
      if (skip) params.set('skip', skip);
      if (fail) params.set('fail', fail);
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
      // Sync pause state from server
      if (typeof status.paused === 'boolean') { _queuePaused = status.paused; updatePauseButton(); }
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
    _eqPollTimer = setInterval(() => loadEncodeQueue(), 30000);
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
        ${status.paused ? `<span class="enc-qs" style="color:var(--a-warn);font-weight:bold">⏸ ${t('queue.paused')}</span>` : ''}
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
            ${j.status === 'encoding' ? `<button class="btn btn-xs btn-danger" onclick="encAction('cancel',${j.id})" title="${t('queue.cancel_job')}">✕</button><button class="btn btn-xs btn-ghost" onclick="encAction('force-kill',${j.id})" title="${t('queue.force_kill')}">💀</button>` : ''}
            ${j.status === 'error' || j.status === 'cancelled' ? `<button class="btn btn-xs btn-primary" onclick="encAction('retry',${j.id})">↻</button>` : ''}
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
      else if (act === 'force-kill') {
        if (!confirm(t('queue.force_kill_confirm'))) return;
        await api(`/encode/force-kill/${id}`, { method: 'POST' });
      }
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

  // Pause / Resume queue
  let _queuePaused = false;
  function updatePauseButton() {
    const btn = $('#btn-pause-queue');
    if (_queuePaused) {
      btn.textContent = t('queue.resume');
      btn.classList.remove('btn-ghost');
      btn.classList.add('btn-primary');
    } else {
      btn.textContent = t('queue.pause');
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-ghost');
    }
  }
  $('#btn-pause-queue').addEventListener('click', async () => {
    try {
      const endpoint = _queuePaused ? '/encode/resume' : '/encode/pause';
      const r = await api(endpoint, { method: 'POST' });
      _queuePaused = r.paused;
      updatePauseButton();
      toast(_queuePaused ? t('toast.queue_paused') : t('toast.queue_resumed'), 'info');
      loadEncodeQueue();
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#btn-cancel-all').addEventListener('click', async () => {
    try {
      if (!confirm(t('queue.cancel_all_confirm'))) return;
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
    // Auto-scan interval
    try {
      const as = await api('/settings/autoscan');
      $('#autoscan-interval').value = String(as.interval);
    } catch {}
    // Media sources
    loadSources();
    // Custom presets
    loadCustomPresets();
  }

  $('#schedule-enabled').addEventListener('change', () => {
    $('#schedule-fields').style.display = $('#schedule-enabled').checked ? 'flex' : 'none';
  });

  $('#btn-save-autoscan').addEventListener('click', async () => {
    try {
      await api('/settings/autoscan', {
        method: 'POST',
        body: JSON.stringify({ interval: parseInt($('#autoscan-interval').value, 10) }),
      });
      toast(t('toast.autoscan_saved'), 'success');
    } catch (e) { toast(e.message, 'error'); }
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
      } catch (e) {
        const msg = (e.message || '').includes('already') ? t('toast.source_duplicate') : e.message;
        toast(msg, 'error');
      }
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
