/**
 * Encodium — Frontend app
 */
(function () {
  'use strict';

  /* ─── State ────────────────────────────────────────────── */
  let token = localStorage.getItem('encodium_token') || '';
  let currentTab = 'dashboard';
  let libPage = 1, libOrder = 'asc';
  let selectedIds = new Set();
  let presets = [];
  let sse = null;
  let scanPollTimer = null;

  /* ─── API helper ───────────────────────────────────────── */
  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    if (res.status === 401) { logout(); throw new Error('Session expired'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ─── Toast ────────────────────────────────────────────── */
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i> ${esc(msg)}`;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  /* ─── Format helpers ───────────────────────────────────── */
  function fmtSize(b) {
    if (!b) return '—';
    if (b > 1e12) return (b / 1e12).toFixed(2) + ' TB';
    if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
    return (b / 1e3).toFixed(0) + ' KB';
  }
  function fmtDuration(s) {
    if (!s) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(sec).padStart(2, '0')}s`;
  }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString();
  }
  function codecBadge(c) {
    const lc = (c || '').toLowerCase();
    if (lc.includes('h264') || lc.includes('avc')) return '<span class="badge badge-h264">H.264</span>';
    if (lc.includes('hevc') || lc.includes('h265') || lc === 'hevc') return '<span class="badge badge-hevc">HEVC</span>';
    if (lc.includes('av1'))  return '<span class="badge badge-av1">AV1</span>';
    if (lc.includes('vp9'))  return '<span class="badge badge-vp9">VP9</span>';
    return `<span class="badge badge-other">${esc(c || '?')}</span>`;
  }
  function statusBadge(s) { return `<span class="status-badge status-${s}">${s}</span>`; }

  /* ═══════════════════════════════════════════════════════════
     AUTH
     ═══════════════════════════════════════════════════════════ */
  function initAuth() {
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value;
      const pass = document.getElementById('login-pass').value;
      try {
        const data = await api('POST', '/auth/login', { email, password: pass });
        token = data.token;
        localStorage.setItem('encodium_token', token);
        showApp();
      } catch (err) {
        const el = document.getElementById('login-error');
        el.textContent = err.message; el.style.display = 'block';
      }
    });
  }

  function logout() {
    token = '';
    localStorage.removeItem('encodium_token');
    if (sse) { sse.close(); sse = null; }
    document.getElementById('app').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }

  async function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    connectSSE();
    switchTab('dashboard');
  }

  /* ═══════════════════════════════════════════════════════════
     SSE
     ═══════════════════════════════════════════════════════════ */
  function connectSSE() {
    if (sse) sse.close();
    sse = new EventSource(`/api/events?token=${token}`);
    sse.addEventListener('job_update', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.status === 'done') toast(`Job #${d.id} done`, 'success');
        else if (d.status === 'failed') toast(`Job #${d.id} failed: ${d.error || ''}`, 'error');
        if (currentTab === 'encode') loadEncodeTab();
        if (currentTab === 'history') loadHistory();
        if (currentTab === 'dashboard') loadStats();
      } catch {}
    });
    sse.addEventListener('job_progress', (e) => {
      try {
        const d = JSON.parse(e.data);
        const bar = document.getElementById(`job-bar-${d.id}`);
        const pct = document.getElementById(`job-pct-${d.id}`);
        if (bar) bar.style.width = d.percent + '%';
        if (pct) pct.textContent = d.percent + '%';
      } catch {}
    });
    sse.onerror = () => { setTimeout(connectSSE, 5000); };
  }

  /* ═══════════════════════════════════════════════════════════
     NAVIGATION
     ═══════════════════════════════════════════════════════════ */
  function initNav() {
    document.querySelectorAll('.sidebar-nav li').forEach(li => {
      li.addEventListener('click', () => switchTab(li.dataset.tab));
    });
    document.getElementById('btn-logout').addEventListener('click', logout);
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.sidebar-nav li').forEach(li => li.classList.toggle('active', li.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab === 'dashboard') loadDashboard();
    else if (tab === 'library') loadLibrary();
    else if (tab === 'encode') loadEncodeTab();
    else if (tab === 'history') loadHistory();
    else if (tab === 'hardware') loadHardware();
  }

  /* ═══════════════════════════════════════════════════════════
     DASHBOARD
     ═══════════════════════════════════════════════════════════ */
  async function loadDashboard() {
    loadStats();
    loadCodecChart();
    pollScanProgress();
  }

  async function loadStats() {
    try {
      const d = await api('GET', '/stats');
      document.getElementById('stat-videos').textContent = d.videos.count.toLocaleString();
      document.getElementById('stat-size').textContent = fmtSize(d.videos.total_size);
      document.getElementById('stat-duration').textContent = fmtDuration(d.videos.total_duration);
      document.getElementById('stat-jobs').textContent = `${d.jobs.encoding || 0}/${d.jobs.pending || 0}`;
    } catch {}
  }

  async function loadCodecChart() {
    try {
      const rows = await api('GET', '/codec-stats');
      const max = Math.max(1, ...rows.map(r => r.count));
      const colors = { h264: '#3498db', hevc: '#00cec9', av1: '#feca57', vp9: '#a29bfe' };
      document.getElementById('codec-chart').innerHTML = rows.map(r => {
        const pct = Math.round((r.count / max) * 100);
        const color = colors[r.codec] || '#8a8f9d';
        return `<div class="codec-row">
          <span class="codec-label">${esc(r.codec)}</span>
          <div class="codec-bar-wrap"><div class="codec-bar" style="width:${pct}%;background:${color}">${r.count}</div></div>
          <span class="codec-count">${fmtSize(r.total_size)}</span>
        </div>`;
      }).join('');
    } catch {}
  }

  function pollScanProgress() {
    if (scanPollTimer) clearInterval(scanPollTimer);
    scanPollTimer = setInterval(async () => {
      try {
        const s = await api('GET', '/scan/progress');
        const el = document.getElementById('scan-progress');
        if (s.scanning) {
          el.style.display = 'block';
          document.getElementById('scan-label').textContent = s.phase || 'Scanning…';
          document.getElementById('scan-bar').style.width = (s.progress || 0) + '%';
          document.getElementById('scan-detail').textContent = s.found != null ? `Found: ${s.found} files` : '';
        } else {
          el.style.display = 'none';
        }
      } catch {}
    }, 1500);
  }

  function initDashboard() {
    document.getElementById('btn-scan').addEventListener('click', async () => {
      try { await api('POST', '/scan'); toast('Scan started', 'success'); pollScanProgress(); }
      catch (e) { toast(e.message, 'error'); }
    });
    document.getElementById('btn-scan-cancel').addEventListener('click', async () => {
      try { await api('POST', '/scan/cancel'); toast('Scan cancelled', 'info'); }
      catch (e) { toast(e.message, 'error'); }
    });
    document.getElementById('btn-enrich').addEventListener('click', async () => {
      try { await api('POST', '/enrich'); toast('Enrichment started', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    });
    document.getElementById('btn-gen-thumbs').addEventListener('click', async () => {
      try { await api('POST', '/thumbs'); toast('Thumbnail generation started', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     LIBRARY
     ═══════════════════════════════════════════════════════════ */
  let libSearchTimeout = null;

  function initLibrary() {
    const searchInput = document.getElementById('lib-search');
    searchInput.addEventListener('input', () => {
      clearTimeout(libSearchTimeout);
      libSearchTimeout = setTimeout(() => { libPage = 1; loadLibrary(); }, 300);
    });
    document.getElementById('lib-folder').addEventListener('change', () => { libPage = 1; loadLibrary(); });
    document.getElementById('lib-codec').addEventListener('change', () => { libPage = 1; loadLibrary(); });
    document.getElementById('lib-sort').addEventListener('change', () => loadLibrary());
    document.getElementById('lib-order-btn').addEventListener('click', () => {
      libOrder = libOrder === 'asc' ? 'desc' : 'asc';
      document.querySelector('#lib-order-btn i').className = `fas fa-sort-amount-${libOrder === 'asc' ? 'up' : 'down'}`;
      loadLibrary();
    });
    document.getElementById('lib-encode-sel').addEventListener('click', openEncodeModal);
    document.getElementById('lib-sel-all').addEventListener('click', () => {
      document.querySelectorAll('.video-card').forEach(c => { selectedIds.add(Number(c.dataset.id)); c.classList.add('selected'); });
      updateSelectionBar();
    });
    document.getElementById('lib-sel-none').addEventListener('click', () => {
      selectedIds.clear();
      document.querySelectorAll('.video-card').forEach(c => c.classList.remove('selected'));
      updateSelectionBar();
    });
  }

  async function loadLibrary() {
    try {
      // Load folders for filter
      const folders = await api('GET', '/folders');
      const folderSel = document.getElementById('lib-folder');
      const curVal = folderSel.value;
      folderSel.innerHTML = '<option value="">All Folders</option>' +
        folders.map(f => `<option value="${esc(f.folder)}">${esc(f.folder)} (${f.count})</option>`).join('');
      folderSel.value = curVal;

      const q = document.getElementById('lib-search').value;
      const folder = folderSel.value;
      const codec = document.getElementById('lib-codec').value;
      const sort = document.getElementById('lib-sort').value;
      const params = new URLSearchParams({ q, folder, codec, sort, order: libOrder, page: libPage, limit: 48 });

      const data = await api('GET', `/videos?${params}`);
      renderVideoGrid(data.videos);
      renderPagination(data.page, data.pages);
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderVideoGrid(videos) {
    document.getElementById('lib-grid').innerHTML = videos.map(v => {
      const sel = selectedIds.has(v.id) ? 'selected' : '';
      return `<div class="video-card ${sel}" data-id="${v.id}">
        <div class="check-overlay"><i class="fas fa-check"></i></div>
        <img class="video-thumb" src="/api/thumb/${v.id}" onerror="this.src='/img/no-thumb.svg'" alt="">
        <div class="video-info">
          <div class="video-name" title="${esc(v.filename)}">${esc(v.filename)}</div>
          <div class="video-meta">
            ${codecBadge(v.video_codec)}
            <span><i class="fas fa-hdd"></i> ${fmtSize(v.size)}</span>
            <span><i class="fas fa-clock"></i> ${fmtDuration(v.duration)}</span>
            ${v.width ? `<span>${v.width}x${v.height}</span>` : ''}
          </div>
          <div class="video-meta" style="margin-top:4px">
            <span><i class="fas fa-folder"></i> ${esc(v.folder || '/')}</span>
          </div>
        </div>
      </div>`;
    }).join('');

    document.querySelectorAll('.video-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const id = Number(card.dataset.id);
        if (selectedIds.has(id)) { selectedIds.delete(id); card.classList.remove('selected'); }
        else { selectedIds.add(id); card.classList.add('selected'); }
        updateSelectionBar();
      });
    });
  }

  function updateSelectionBar() {
    const bar = document.getElementById('lib-selection-bar');
    if (selectedIds.size > 0) {
      bar.style.display = 'flex';
      document.getElementById('lib-sel-count').textContent = `${selectedIds.size} selected`;
    } else {
      bar.style.display = 'none';
    }
  }

  function renderPagination(page, pages) {
    if (pages <= 1) { document.getElementById('lib-pagination').innerHTML = ''; return; }
    let html = `<button ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}"><i class="fas fa-chevron-left"></i></button>`;
    const range = 3;
    for (let i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || (i >= page - range && i <= page + range)) {
        html += `<button class="${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
      } else if (i === page - range - 1 || i === page + range + 1) {
        html += '<button disabled>…</button>';
      }
    }
    html += `<button ${page >= pages ? 'disabled' : ''} data-page="${page + 1}"><i class="fas fa-chevron-right"></i></button>`;
    const el = document.getElementById('lib-pagination');
    el.innerHTML = html;
    el.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        libPage = parseInt(btn.dataset.page, 10);
        loadLibrary();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     ENCODE MODAL
     ═══════════════════════════════════════════════════════════ */
  function initEncodeModal() {
    document.getElementById('encode-modal-close').addEventListener('click', closeEncodeModal);
    document.getElementById('encode-modal-cancel').addEventListener('click', closeEncodeModal);
    document.getElementById('encode-modal-submit').addEventListener('click', submitEncode);
  }

  async function openEncodeModal() {
    if (selectedIds.size === 0) return toast('Select at least one video', 'error');
    try {
      const caps = await api('GET', '/encode/capabilities');
      presets = caps.presets || [];
      const sel = document.getElementById('encode-preset');
      sel.innerHTML = presets.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
      document.getElementById('encode-modal-info').textContent = `${selectedIds.size} video(s) selected for encoding`;
      document.getElementById('encode-modal').style.display = 'flex';
    } catch (e) { toast(e.message, 'error'); }
  }

  function closeEncodeModal() { document.getElementById('encode-modal').style.display = 'none'; }

  async function submitEncode() {
    const presetId = document.getElementById('encode-preset').value;
    const replaceOriginal = document.getElementById('encode-replace').checked;
    if (!presetId) return toast('Select a preset', 'error');
    try {
      const data = await api('POST', '/encode/enqueue', { videoIds: [...selectedIds], presetId, replaceOriginal });
      toast(`${data.jobs.length} job(s) enqueued`, 'success');
      closeEncodeModal();
      selectedIds.clear();
      updateSelectionBar();
      document.querySelectorAll('.video-card.selected').forEach(c => c.classList.remove('selected'));
      switchTab('encode');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ═══════════════════════════════════════════════════════════
     ENCODE TAB
     ═══════════════════════════════════════════════════════════ */
  function initEncodeTab() {
    document.getElementById('btn-cancel-all').addEventListener('click', async () => {
      try {
        const d = await api('POST', '/encode/cancel-all');
        toast(`${d.cancelled} pending jobs cancelled`, 'info');
        loadEncodeTab();
      } catch (e) { toast(e.message, 'error'); }
    });
    document.getElementById('btn-set-workers').addEventListener('click', async () => {
      const count = parseInt(document.getElementById('worker-count').value, 10);
      try {
        const d = await api('POST', '/encode/workers', { count });
        toast(`Workers set to ${d.workers}`, 'success');
        loadEncodeTab();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  async function loadEncodeTab() {
    try {
      const [status, hist] = await Promise.all([
        api('GET', '/encode/status'),
        api('GET', '/encode/history?limit=50'),
      ]);

      document.getElementById('worker-count').value = status.workerCount;
      document.getElementById('encode-status').innerHTML =
        `<span class="badge-running">${status.activeJobs} active</span>` +
        `<span>Workers: ${status.workerCount}</span>` +
        `<span>${status.running ? '● Running' : '○ Stopped'}</span>`;

      // Show active + pending + recent from history
      const jobs = (hist.rows || []).filter(j => ['pending', 'encoding'].includes(j.status));
      const doneJobs = (hist.rows || []).filter(j => !['pending', 'encoding'].includes(j.status)).slice(0, 10);

      document.getElementById('encode-queue').innerHTML =
        (jobs.length === 0 && doneJobs.length === 0 ? '<p class="text-muted text-center">No encoding jobs</p>' : '') +
        jobs.map(renderEncodeItem).join('') +
        (doneJobs.length ? '<h4 style="margin:16px 0 8px;color:var(--text-muted)">Recent</h4>' : '') +
        doneJobs.map(renderEncodeItem).join('');

      // Wire up action buttons
      document.querySelectorAll('.job-cancel-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api('POST', `/encode/cancel/${btn.dataset.id}`); loadEncodeTab(); }
          catch (e) { toast(e.message, 'error'); }
        });
      });
      document.querySelectorAll('.job-retry-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api('POST', `/encode/retry/${btn.dataset.id}`); toast('Job retried', 'success'); loadEncodeTab(); }
          catch (e) { toast(e.message, 'error'); }
        });
      });
      document.querySelectorAll('.job-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api('DELETE', `/encode/job/${btn.dataset.id}`); loadEncodeTab(); }
          catch (e) { toast(e.message, 'error'); }
        });
      });
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderEncodeItem(j) {
    let preset = j.preset_id || '?';
    try { const p = JSON.parse(j.preset_json); preset = p.label || preset; } catch {}
    const isActive = j.status === 'encoding';
    const canCancel = j.status === 'pending' || j.status === 'encoding';
    const canRetry = j.status === 'failed' || j.status === 'cancelled';
    return `<div class="encode-item">
      <span class="job-id">#${j.id}</span>
      <div class="job-info">
        <div class="job-name">${esc(j.filename || 'Unknown')}</div>
        <div class="job-preset">${esc(preset)}</div>
      </div>
      ${isActive ? `<div class="job-progress"><div class="progress-bar"><div class="progress-fill" id="job-bar-${j.id}" style="width:0%"></div></div></div><span class="job-pct" id="job-pct-${j.id}">0%</span>` : ''}
      <div>${statusBadge(j.status)}</div>
      <div class="job-actions">
        ${canCancel ? `<button class="btn btn-sm btn-danger job-cancel-btn" data-id="${j.id}" title="Cancel"><i class="fas fa-stop"></i></button>` : ''}
        ${canRetry  ? `<button class="btn btn-sm btn-secondary job-retry-btn" data-id="${j.id}" title="Retry"><i class="fas fa-redo"></i></button>` : ''}
        ${!canCancel ? `<button class="btn btn-sm btn-ghost job-delete-btn" data-id="${j.id}" title="Delete"><i class="fas fa-trash"></i></button>` : ''}
      </div>
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     HISTORY
     ═══════════════════════════════════════════════════════════ */
  function initHistory() {
    document.getElementById('btn-refresh-history').addEventListener('click', loadHistory);
  }

  async function loadHistory() {
    try {
      const data = await api('GET', '/encode/history?limit=100');
      if (!data.rows || data.rows.length === 0) {
        document.getElementById('history-list').innerHTML = '<p class="text-muted text-center">No encoding history yet</p>';
        return;
      }
      document.getElementById('history-list').innerHTML = `
        <table class="history-table">
          <thead><tr>
            <th>#</th><th>File</th><th>Preset</th><th>Status</th><th>Output Size</th><th>Started</th><th>Ended</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${data.rows.map(j => {
              let preset = j.preset_id;
              try { const p = JSON.parse(j.preset_json); preset = p.label || preset; } catch {}
              return `<tr>
                <td>${j.id}</td>
                <td title="${esc(j.file_path || '')}">${esc(j.filename || '?')}</td>
                <td>${esc(preset)}</td>
                <td>${statusBadge(j.status)}</td>
                <td>${j.output_size ? fmtSize(j.output_size) : '—'}</td>
                <td>${fmtDate(j.started_at)}</td>
                <td>${fmtDate(j.ended_at)}</td>
                <td>
                  ${['failed','cancelled'].includes(j.status) ? `<button class="btn btn-sm btn-ghost job-retry-btn" data-id="${j.id}"><i class="fas fa-redo"></i></button>` : ''}
                  <button class="btn btn-sm btn-ghost job-delete-btn" data-id="${j.id}"><i class="fas fa-trash"></i></button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      document.querySelectorAll('.job-retry-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api('POST', `/encode/retry/${btn.dataset.id}`); toast('Job retried', 'success'); loadHistory(); }
          catch (e) { toast(e.message, 'error'); }
        });
      });
      document.querySelectorAll('.job-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          try { await api('DELETE', `/encode/job/${btn.dataset.id}`); loadHistory(); }
          catch (e) { toast(e.message, 'error'); }
        });
      });
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ═══════════════════════════════════════════════════════════
     HARDWARE
     ═══════════════════════════════════════════════════════════ */
  function initHardware() {
    document.getElementById('btn-hw-refresh').addEventListener('click', () => loadHardware(true));
  }

  async function loadHardware(refresh = false) {
    try {
      const caps = await api('GET', `/encode/capabilities${refresh ? '?refresh=1' : ''}`);
      presets = caps.presets || [];

      let hwHtml = '';
      if (caps.nvidia && caps.nvidia.length) {
        hwHtml += caps.nvidia.map(g => `
          <div class="hw-card">
            <h4><i class="fas fa-desktop" style="color:#76b900"></i> NVIDIA GPU ${g.index}</h4>
            <p class="hw-detail"><strong>Name:</strong> ${esc(g.name)}</p>
            <p class="hw-detail"><strong>VRAM:</strong> ${esc(g.vram)}</p>
            <p class="hw-detail"><strong>Driver:</strong> ${esc(g.driver)}</p>
          </div>`).join('');
      }
      if (caps.vaapi && caps.vaapi.length) {
        hwHtml += caps.vaapi.map(d => `
          <div class="hw-card">
            <h4><i class="fas fa-microchip" style="color:#0071c5"></i> VA-API ${esc(d.vendor)}</h4>
            <p class="hw-detail"><strong>Device:</strong> ${esc(d.device)}</p>
            <p class="hw-detail"><strong>Driver:</strong> ${esc(d.driver)}</p>
          </div>`).join('');
      }
      if (!caps.nvidia?.length && !caps.vaapi?.length) {
        hwHtml = '<div class="hw-card"><h4><i class="fas fa-cpu"></i> CPU Only</h4><p class="hw-detail">No hardware encoders detected. CPU encoding available.</p></div>';
      }
      document.getElementById('hw-info').innerHTML = hwHtml;

      document.getElementById('hw-presets').innerHTML = caps.presets.map(p => {
        const typeClass = p.type.includes('nvidia') ? 'type-nvidia' : p.type.includes('vaapi') ? 'type-vaapi' : p.type === 'qsv' ? 'type-qsv' : 'type-cpu';
        return `<div class="preset-item">
          <span class="preset-type ${typeClass}">${p.type.toUpperCase()}</span>
          <span>${esc(p.label)}</span>
          <span class="preset-id">${p.id}</span>
        </div>`;
      }).join('') || '<p class="text-muted">No presets available</p>';

      if (refresh) toast('Hardware info refreshed', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ═══════════════════════════════════════════════════════════
     BOOT
     ═══════════════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    initNav();
    initDashboard();
    initLibrary();
    initEncodeModal();
    initEncodeTab();
    initHistory();
    initHardware();

    // Check for existing session
    if (token) {
      api('GET', '/auth/me').then(() => showApp()).catch(() => logout());
    }
  });
})();
