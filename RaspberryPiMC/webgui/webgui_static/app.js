/* ═══════════════════════════════════════════════════
   MeshCore Web GUI  –  app.js
   ═══════════════════════════════════════════════════ */

// ─── App state ───────────────────────────────────────
const app = {
  snap: null,
  configKeys: [],
  configValues: {},
  configLoaded: false,
  mapFitted: false,
  activeTab: 'dashboard',
};

// ─── Leaflet map (init early – dashboard is default tab so div is visible) ──
const mcMap = L.map('map', { zoomControl: true }).setView([20, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(mcMap);
const markerLayer = L.layerGroup().addTo(mcMap);

function makeMarkerIcon(cls) {
  return L.divIcon({ className: cls, iconSize: [14, 14], iconAnchor: [7, 7] });
}

// ─── Helpers ─────────────────────────────────────────
function fmtTime(epoch) {
  if (!epoch) return '–';
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  return new Date(ms).toLocaleString();
}

function fmtUptime(secs) {
  if (!secs) return '–';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function hasLoc(c) {
  return (
    Number.isFinite(c.lat) && Number.isFinite(c.lon) &&
    (Math.abs(c.lat) > 0.0001 || Math.abs(c.lon) > 0.0001)
  );
}

function rssiClass(rssi) {
  if (rssi == null) return '';
  if (rssi > -70)  return 'good';
  if (rssi > -90)  return '';
  if (rssi > -105) return 'warn';
  return 'error';
}

function setOutput(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = (text == null) ? '' : (typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

function contactKindStr(kind, role) {
  if (role === 'repeater') return 'Neighbor';
  // ADV_TYPE_NONE=0, ADV_TYPE_CHAT=1 (client), ADV_TYPE_REPEATER=2, ADV_TYPE_ROOM=3, ADV_TYPE_SENSOR=4
  const types = ['Unknown', 'Client', 'Repeater', 'Room Server', 'Sensor'];
  return types[kind] ?? `Type ${kind}`;
}

// ─── API ─────────────────────────────────────────────
async function sendCommand(name, args = {}) {
  try {
    const resp = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    return await resp.json();
  } catch (e) {
    console.error('sendCommand error:', name, e);
    return { ok: false, error: String(e) };
  }
}

// ─── Tab Switching ───────────────────────────────────
function switchTab(tabName) {
  app.activeTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === `tab-${tabName}`));

  if (tabName === 'dashboard') {
    setTimeout(() => mcMap.invalidateSize(), 60);
  }
  if (tabName === 'charts' && app.snap) {
    setTimeout(() => renderCharts(app.snap), 150);
  }
  if (tabName === 'contacts' && app.snap) {
    renderContacts(app.snap, document.getElementById('contact-search')?.value || '');
  }
  if (tabName === 'logs' && app.snap) {
    renderLog(app.snap.events || [], document.getElementById('log-filter')?.value || '');
  }
  if (tabName === 'config' && app.snap?.role === 'repeater' && !app.configLoaded) {
    loadRepeaterConfig();
    refreshRegions();
  }
}

// ─── Stat Cards ──────────────────────────────────────
function renderStatCards(snap) {
  const role   = snap.role || 'companion';
  const core    = snap.stats?.core    || {};
  const radio   = snap.stats?.radio   || {};
  const packets = snap.stats?.packets || {};
  const si     = snap.self_info  || {};
  const di     = snap.device_info || {};
  const batt   = snap.battery    || {};
  const battMv = batt.battery_mv || core.battery_mv || 0;
  const freqMhz = si.radio_freq_khz ? `${(si.radio_freq_khz / 1000).toFixed(3)} MHz` : '–';

  const cards = role === 'repeater'
    ? [
      { label: 'Status',     value: snap.connected ? 'Connected' : 'Offline',
        cls: snap.connected ? 'good' : 'error' },
      { label: 'Node Name',  value: si.name || '–' },
      { label: 'Mode',       value: core.queue_len != null ? 'Forwarding' : '–',
        sub: di.model || '' },
      { label: 'RX Packets', value: (packets.recv ?? 0).toLocaleString(), cls: 'good' },
      { label: 'TX Packets', value: (packets.sent ?? 0).toLocaleString() },
      { label: 'Dropped',    value: (packets.drop ?? packets.recv_errors ?? 0).toLocaleString(),
        cls: (packets.drop || packets.recv_errors || 0) > 0 ? 'warn' : '' },
      { label: 'RSSI',       value: radio.last_rssi != null ? `${radio.last_rssi} dBm` : '–',
        cls: rssiClass(radio.last_rssi) },
      { label: 'SNR',        value: radio.last_snr  != null ? `${radio.last_snr} dB` : '–' },
      { label: 'Noise Floor',value: radio.noise_floor != null ? `${radio.noise_floor} dBm` : '–' },
      { label: 'Queue',      value: core.queue_len ?? '–',
        cls: (core.queue_len || 0) > 10 ? 'warn' : '' },
      { label: 'Uptime',     value: fmtUptime(core.uptime_secs) },
      { label: 'Frequency',  value: freqMhz },
    ]
    : [
      { label: 'Status',     value: snap.connected ? 'Connected' : 'Offline',
        cls: snap.connected ? 'good' : 'error' },
      { label: 'Node Name',  value: si.name || '–' },
      { label: 'Model',      value: di.model || '–' },
      { label: 'Firmware',   value: di.version || '–' },
      { label: 'RX Packets', value: (packets.recv ?? 0).toLocaleString(), cls: 'good' },
      { label: 'TX Packets', value: (packets.sent ?? 0).toLocaleString() },
      { label: 'RSSI',       value: radio.last_rssi != null ? `${radio.last_rssi} dBm` : '–',
        cls: rssiClass(radio.last_rssi) },
      { label: 'SNR',        value: radio.last_snr  != null ? `${radio.last_snr} dB` : '–' },
      { label: 'Noise Floor',value: radio.noise_floor != null ? `${radio.noise_floor} dBm` : '–' },
      { label: 'Battery',    value: battMv ? `${battMv} mV` : '–' },
      { label: 'Uptime',     value: fmtUptime(core.uptime_secs) },
      { label: 'Frequency',  value: freqMhz },
    ];

  document.getElementById('stat-grid').innerHTML = cards
    .map(c => `<div class="stat-card${c.cls ? ' ' + c.cls : ''}">
      <div class="sc-label">${c.label}</div>
      <div class="sc-value">${c.value}</div>
      ${c.sub ? `<div class="sc-sub">${c.sub}</div>` : ''}
    </div>`)
    .join('');
}

// ─── Map Update ──────────────────────────────────────
function updateMap(snap) {
  markerLayer.clearLayers();
  const bounds = [];

  // Self node
  const si = snap.self_info || {};
  const selfLat = si.adv_lat, selfLon = si.adv_lon;
  if (Number.isFinite(selfLat) && Number.isFinite(selfLon) &&
      (Math.abs(selfLat) > 0.001 || Math.abs(selfLon) > 0.001)) {
    const m = L.marker([selfLat, selfLon], { icon: makeMarkerIcon('mc-self-icon'), zIndexOffset: 100 });
    m.bindPopup(
      `<div style="min-width:160px"><b>${si.name || 'This Node'}</b><br>` +
      `<span style="color:#58a6ff">Self</span><br>` +
      `${selfLat.toFixed(5)}, ${selfLon.toFixed(5)}</div>`
    );
    m.addTo(markerLayer);
    bounds.push([selfLat, selfLon]);
  }

  // Contacts / neighbors with location
  let onMap = 0;
  for (const c of (snap.contacts || [])) {
    if (!hasLoc(c)) continue;
    onMap++;
    const m = L.marker([c.lat, c.lon], { icon: makeMarkerIcon('mc-node-icon') });
    m.bindPopup(
      `<div style="min-width:160px"><b>${c.name || c.pubkey.slice(0, 12)}</b><br>` +
      `<span style="color:#2ecc71">${contactKindStr(c.kind, snap.role)}</span><br>` +
      `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}<br>` +
      `Last: ${fmtTime(c.last_advert_timestamp)}<br>` +
      `<small style="color:#7a8fc7">${c.pubkey.slice(0,16)}…</small></div>`
    );
    m.addTo(markerLayer);
    bounds.push([c.lat, c.lon]);
  }

  const total = (snap.contacts || []).length;
  const countEl = document.getElementById('map-count');
  if (countEl) countEl.textContent = `${total} node${total !== 1 ? 's' : ''}, ${onMap} on map`;

  if (!app.mapFitted && bounds.length >= 2) {
    mcMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    app.mapFitted = true;
  } else if (!app.mapFitted && bounds.length === 1) {
    mcMap.setView(bounds[0], 12);
    app.mapFitted = true;
  }
}

// ─── Charts ──────────────────────────────────────────
/**
 * Generic Canvas 2D time-series line chart.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} ts - Unix timestamps (seconds)
 * @param {{label:string, data:number[], color:string, fill?:boolean, dash?:number[]}} series
 */
function drawChart(canvas, ts, series) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const W = rect.width  > 4 ? rect.width  : (canvas.parentElement?.clientWidth  || 600);
  const H = rect.height > 4 ? rect.height : 180;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#080e1e';
  ctx.fillRect(0, 0, W, H);

  if (!ts || ts.length < 2) {
    ctx.fillStyle = '#7a8fc7';
    ctx.font = '12px system-ui';
    ctx.fillText('Collecting data…', 16, 24);
    return;
  }

  const pad = { l: 46, r: 14, t: 22, b: 26 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;

  // Y range
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    for (const v of (s.data || [])) {
      if (Number.isFinite(v)) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
    }
  }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 10; }
  if (yMin === yMax) { const d = Math.abs(yMin) * 0.1 || 1; yMin -= d; yMax += d; }
  const yRange = yMax - yMin;

  // Grid
  const nGrid = 4;
  ctx.lineWidth = 1;
  for (let i = 0; i <= nGrid; i++) {
    const y = pad.t + ph * (1 - i / nGrid);
    ctx.strokeStyle = '#1e2e52';
    ctx.setLineDash([2, 5]);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    ctx.setLineDash([]);
    const val = yMin + yRange * (i / nGrid);
    ctx.fillStyle = '#7a8fc7';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(
      Math.abs(val) >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val),
      pad.l - 4, y + 3.5
    );
  }

  // X-axis labels
  const tsMin = ts[0], tsMax = ts[ts.length - 1];
  const nXL = Math.min(6, ts.length);
  ctx.fillStyle = '#7a8fc7';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'center';
  for (let i = 0; i <= nXL; i++) {
    const t = tsMin + (tsMax - tsMin) * (i / nXL);
    const x = pad.l + pw * (i / nXL);
    const d = new Date(t * 1000);
    ctx.fillText(
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      x, H - 7
    );
  }

  // Series
  const xAt = i => pad.l + pw * (ts[i] - tsMin) / Math.max(1, tsMax - tsMin);
  const yAt = v => pad.t + ph * (1 - (v - yMin) / yRange);

  for (const s of series) {
    if (!s.data?.length) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.8;
    ctx.setLineDash(s.dash || []);

    ctx.beginPath();
    let first = true;
    for (let i = 0; i < Math.min(ts.length, s.data.length); i++) {
      const v = s.data[i];
      if (!Number.isFinite(v)) { first = true; continue; }
      const x = xAt(i), y = yAt(v);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (s.fill) {
      ctx.beginPath();
      let started = false, lastX = pad.l;
      for (let i = 0; i < Math.min(ts.length, s.data.length); i++) {
        const v = s.data[i];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = xAt(i), y = yAt(v);
        if (!started) { ctx.moveTo(x, pad.t + ph); ctx.lineTo(x, y); started = true; }
        else ctx.lineTo(x, y);
        lastX = x;
      }
      if (started) { ctx.lineTo(lastX, pad.t + ph); ctx.closePath(); }
      ctx.fillStyle = s.color + '22';
      ctx.fill();
    }
  }

  // Legend
  let lx = pad.l;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, pad.t - 9, 18, 4);
    ctx.fillStyle = '#e4eeff';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + 22, pad.t - 5);
    lx += Math.max(70, s.label.length * 7 + 28);
  }
}

function renderCharts(snap) {
  const h = snap?.history || {};
  const ts = h.ts || [];

  // 1. Packet traffic: RX, TX, Drop
  drawChart(document.getElementById('chart-traffic'), ts, [
    { label: 'RX Packets', data: h.rx,   color: '#58a6ff', fill: true },
    { label: 'TX Packets', data: h.tx,   color: '#2ecc71' },
    { label: 'Dropped',    data: h.drop, color: '#ff6b6b', dash: [4, 3] },
  ]);

  // 2. Signal quality: RSSI & Noise Floor (both dBm — same axis is meaningful)
  drawChart(document.getElementById('chart-radio'), ts, [
    { label: 'RSSI (dBm)',        data: h.rssi,        color: '#f4c430' },
    { label: 'Noise Floor (dBm)', data: h.noise_floor, color: '#a78bfa', dash: [4, 4] },
  ]);

  // 3. SNR & Queue
  drawChart(document.getElementById('chart-noise'), ts, [
    { label: 'SNR (dB)', data: h.snr,   color: '#38bdf8', fill: true },
    { label: 'Queue',    data: h.queue, color: '#ff6b6b' },
  ]);
}

// ─── Contacts Table ──────────────────────────────────
function renderContacts(snap, filter = '') {
  const role = snap.role || 'companion';
  const contacts = (snap.contacts || []).filter(c => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (c.name || '').toLowerCase().includes(q) || c.pubkey.toLowerCase().includes(q);
  });
  const tbody = document.getElementById('contacts-body');
  if (!tbody) return;
  if (!contacts.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">No contacts found</td></tr>`;
    return;
  }
  tbody.innerHTML = contacts.slice(0, 250).map(c => {
    const loc     = hasLoc(c) ? `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}` : '–';
    const hops    = c.out_path_len;
    const snrPath = role === 'companion'
      ? (hops === 0 ? 'direct' : (hops > 0 && hops < 255) ? `${hops} hop${hops !== 1 ? 's' : ''}` : '–')
      : '–';
    const kind = contactKindStr(c.kind, role);
    const locateBtn = hasLoc(c)
      ? `<button class="btn-sm" onclick="locateContact(${c.lat.toFixed(6)},${c.lon.toFixed(6)})">Locate</button>`
      : '';
    const removeBtn = role === 'repeater'
      ? `<button class="btn-sm btn-err" onclick="removeNeighbor('${c.pubkey.slice(0, 16)}')">Remove</button>`
      : '';
    return `<tr>
      <td>${c.name || '–'}</td>
      <td>${kind}</td>
      <td title="${c.pubkey}" style="font-family:monospace;font-size:11px">${c.pubkey.slice(0, 16)}…</td>
      <td>${loc}</td>
      <td>${snrPath}</td>
      <td>${fmtTime(c.last_advert_timestamp)}</td>
      <td style="white-space:nowrap">${locateBtn}${removeBtn ? ' ' + removeBtn : ''}</td>
    </tr>`;
  }).join('');
}

async function removeNeighbor(prefix) {
  if (!confirm(`Remove neighbor ${prefix}?`)) return;
  const d = await sendCommand('neighbor_remove', { pubkey_prefix: prefix });
  alert(d?.payload?.reply || JSON.stringify(d?.payload) || 'Done');
}

function locateContact(lat, lon) {
  switchTab('dashboard');
  setTimeout(() => mcMap.setView([lat, lon], 14), 100);
}

// ─── System Charts (dashboard) ───────────────────────
function renderSystemCharts(snap) {
  const h  = snap?.history || {};
  const ts = h.ts || [];
  drawChart(document.getElementById('sys-chart-cpu'), ts, [
    { label: 'CPU %', data: h.cpu, color: '#38bdf8', fill: true },
  ]);
  drawChart(document.getElementById('sys-chart-mem'), ts, [
    { label: 'RAM %', data: h.mem, color: '#a78bfa', fill: true },
  ]);
}

// ─── Events List ─────────────────────────────────────
function renderEvents(events) {
  const list = document.getElementById('events-list');
  if (!list) return;
  const recent = [...events].reverse().slice(0, 50);
  if (!recent.length) {
    list.innerHTML = '<li style="color:var(--muted);padding:8px 0">No events yet…</li>';
    return;
  }
  list.innerHTML = recent.map(e => {
    const detail = e.payload
      ? Object.entries(e.payload).filter(([k]) => k !== 'pubkey').map(([k, v]) => `${k}:${v}`).join(' ')
      : '';
    return `<li>
      <span class="ev-type">${e.type}</span>
      <span class="ev-detail" style="color:var(--muted);font-size:11px">${detail.slice(0, 60)}</span>
      <span class="ev-ts">${fmtTime(e.ts)}</span>
    </li>`;
  }).join('');
}

// ─── Log Table ───────────────────────────────────────
function renderLog(events, filter = '') {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;
  const filtered = [...events].reverse().filter(e => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return e.type.toLowerCase().includes(q) ||
      JSON.stringify(e.payload || {}).toLowerCase().includes(q);
  });
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--muted)">No events</td></tr>`;
    return;
  }
  const typeClass = t => {
    if (/error|fail/i.test(t)) return 'err';
    if (/config|save|set/i.test(t)) return 'cfg';
    if (/warn|mode/i.test(t)) return 'warn';
    return '';
  };
  tbody.innerHTML = filtered.slice(0, 400).map(e =>
    `<tr>
      <td style="font-size:11px;color:var(--muted)">${fmtTime(e.ts)}</td>
      <td><span class="log-type-badge ${typeClass(e.type)}">${e.type}</span></td>
      <td style="font-size:11px;font-family:monospace">${JSON.stringify(e.payload || {}).slice(0, 200)}</td>
    </tr>`
  ).join('');
}

// ─── HW Stats ────────────────────────────────────────
function updateHwStats(stats) {
  const cpu  = document.getElementById('hw-cpu');
  const mem  = document.getElementById('hw-mem');
  const disk = document.getElementById('hw-disk');
  const temp = document.getElementById('hw-temp');
  if (cpu)  cpu.textContent  = stats.cpu_percent  != null ? `${stats.cpu_percent.toFixed(1)}%`  : '–';
  if (mem)  mem.textContent  = stats.mem_percent  != null ? `${stats.mem_percent.toFixed(1)}%`  : '–';
  if (disk) disk.textContent = stats.disk_used_gb != null ? `${stats.disk_used_gb}/${stats.disk_total_gb} GB` : '–';
  if (temp) temp.textContent = stats.cpu_temp     != null ? `${stats.cpu_temp}°C` : '–';
}

// ─── Config Management ───────────────────────────────
function renderConfigRows() {
  const tbody = document.getElementById('config-rows');
  if (!tbody) return;
  if (!app.configKeys.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No config loaded. Click ↓ Load.</td></tr>';
    return;
  }
  tbody.innerHTML = app.configKeys.map(key => {
    const v = String(app.configValues[key] ?? '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return `<tr>
      <td style="font-family:monospace;font-size:11px">${key}</td>
      <td style="font-family:monospace;font-size:11px">${v}</td>
      <td><input data-config-input="${key}" value="${v}" /></td>
      <td><button class="btn-sm" data-config-set="${key}">Set</button></td>
    </tr>`;
  }).join('');
}

async function loadRepeaterConfig() {
  setOutput('config-output', 'Loading…');
  const schema = await sendCommand('config_schema');
  const values = await sendCommand('config_get_all');
  app.configKeys   = schema?.payload?.all_keys || [];
  app.configValues = values?.payload?.values   || {};
  app.configLoaded = true;
  renderConfigRows();
  setOutput('config-output', `✓ Loaded ${app.configKeys.length} keys.`);
}

async function setConfigKey(key, value) {
  const d = await sendCommand('config_set', { key, value });
  if (d?.ok) {
    app.configValues[key] = value;
    renderConfigRows();
    setOutput('config-output', `set ${key} = ${value}\n${d.payload?.reply || ''}`);
  } else {
    setOutput('config-output', `Error: ${d?.error || 'unknown'}`);
  }
}

async function refreshRegions() {
  setOutput('region-output', 'Refreshing regions…');
  const [dump, allowed, denied, home] = await Promise.all([
    sendCommand('region_dump'),
    sendCommand('regions_allowed'),
    sendCommand('regions_denied'),
    sendCommand('region_home_get'),
  ]);
  setOutput('region-output', [
    '=== HOME ===',     home?.payload?.reply    || '–',
    '', '=== TREE ===',    dump?.payload?.reply    || '–',
    '', '=== ALLOWED ===', allowed?.payload?.reply || '–',
    '', '=== DENIED ===',  denied?.payload?.reply  || '–',
  ].join('\n'));
}

// ─── Full Render ─────────────────────────────────────
function renderAll(snap) {
  app.snap = snap;
  const role = snap.role || 'companion';

  // Apply role to body for CSS show/hide
  document.body.dataset.role = role;
  document.getElementById('role-subtitle').textContent =
    role === 'repeater' ? 'Repeater Bridge' : 'Companion Link';

  // Connection badge
  const badge = document.getElementById('conn-badge');
  badge.textContent = snap.connected ? 'connected' : 'offline';
  badge.className = 'badge ' + (snap.connected ? 'ok' : 'err');

  // Stat cards
  renderStatCards(snap);

  // Map (always update, even when on another tab — markers are fast)
  updateMap(snap);

  // System charts (dashboard side panel — CPU/RAM over time)
  renderSystemCharts(snap);

  // Companion device info panel (config tab)
  const infoEl = document.getElementById('companion-device-info');
  if (infoEl) {
    const si = snap.self_info  || {};
    const di = snap.device_info || {};
    infoEl.textContent = [
      `Name     : ${si.name    || '–'}`,
      `Pubkey   : ${si.pubkey  ? si.pubkey.slice(0, 24) + '…' : '–'}`,
      `Model    : ${di.model   || '–'}`,
      `Firmware : ${di.version || '–'}`,
      `Freq     : ${si.radio_freq_khz  ? (si.radio_freq_khz / 1000).toFixed(3) + ' MHz' : '–'}`,
      `TX Power : ${si.tx_power_db != null ? si.tx_power_db + ' dB' : '–'}`,
    ].join('\n');
  }

  // Events sidebar
  renderEvents(snap.events || []);

  // Tab-specific renders
  if (app.activeTab === 'charts')   renderCharts(snap);
  if (app.activeTab === 'contacts') renderContacts(snap, document.getElementById('contact-search')?.value || '');
  if (app.activeTab === 'logs')     renderLog(snap.events || [], document.getElementById('log-filter')?.value || '');
}

// ─── Wire UI ─────────────────────────────────────────
function wireUi() {
  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  // Topbar buttons
  document.getElementById('btn-advert')?.addEventListener('click', () => sendCommand('advert'));
  document.getElementById('btn-refresh')?.addEventListener('click', () => sendCommand('refresh'));
  document.getElementById('btn-sync-time')?.addEventListener('click', () => sendCommand('sync_time'));

  // Fit map button
  document.getElementById('btn-fit-map')?.addEventListener('click', () => {
    const pts = [];
    markerLayer.eachLayer(m => pts.push([m.getLatLng().lat, m.getLatLng().lng]));
    if (pts.length >= 2)  mcMap.fitBounds(pts, { padding: [40, 40] });
    else if (pts.length)  mcMap.setView(pts[0], 12);
  });

  // Quick actions
  document.getElementById('btn-clear-stats')?.addEventListener('click', () => sendCommand('clear_stats'));
  document.getElementById('btn-mode-fwd')?.addEventListener('click', () =>
    sendCommand('set_mode', { mode: 'forward' }).then(d =>
      alert(d?.payload ? `Mode → Forward (repeat=1)\n${d.payload.reply || ''}` : d?.error)
    )
  );
  document.getElementById('btn-mode-mon')?.addEventListener('click', () =>
    sendCommand('set_mode', { mode: 'monitor' }).then(d =>
      alert(d?.payload ? `Mode → Monitor (repeat=0)\n${d.payload.reply || ''}` : d?.error)
    )
  );
  document.getElementById('btn-clear-events')?.addEventListener('click', () => {
    if (app.snap) app.snap.events = [];
    renderEvents([]);
  });

  // HW stats refresh
  document.getElementById('btn-hw-stats')?.addEventListener('click', async () => {
    const d = await sendCommand('get_hardware_stats');
    if (d?.ok && d.payload) updateHwStats(d.payload);
  });

  // Name form
  document.getElementById('name-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = new FormData(e.target).get('name')?.trim();
    if (name) { await sendCommand('set_name', { name }); e.target.reset(); }
  });

  // Location form
  document.getElementById('loc-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lat = parseFloat(fd.get('lat')), lon = parseFloat(fd.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return alert('Invalid coordinates');
    await sendCommand('set_location', { lat, lon });
    e.target.reset();
  });

  // Public message form (companion)
  document.getElementById('pub-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const text = new FormData(e.target).get('msg')?.trim();
    if (text) { await sendCommand('public_msg', { text, channel: 0 }); e.target.reset(); }
  });

  // Contacts search
  document.getElementById('contact-search')?.addEventListener('input', e => {
    if (app.snap) renderContacts(app.snap, e.target.value);
  });

  // Log filter
  document.getElementById('log-filter')?.addEventListener('input', e => {
    renderLog(app.snap?.events || [], e.target.value);
  });
  document.getElementById('btn-clear-log')?.addEventListener('click', () => {
    if (app.snap) app.snap.events = [];
    renderLog([], '');
  });

  // Config table delegated set-button
  document.getElementById('config-rows')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-config-set]');
    if (!btn) return;
    const key = btn.dataset.configSet;
    const inp = document.querySelector(`[data-config-input="${key}"]`);
    if (inp) setConfigKey(key, inp.value.trim());
  });

  // Config buttons
  document.getElementById('load-config-btn')?.addEventListener('click', loadRepeaterConfig);
  document.getElementById('save-config-btn')?.addEventListener('click', async () => {
    const d = await sendCommand('config_save');
    setOutput('config-output', d?.payload?.reply || JSON.stringify(d?.payload) || 'Saved.');
  });

  // Config set form
  document.getElementById('config-set-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const key = fd.get('key')?.trim(), value = fd.get('value')?.trim();
    if (!key || !value) return;
    await setConfigKey(key, value);
    e.target.reset();
  });

  // Region buttons
  document.getElementById('refresh-regions-btn')?.addEventListener('click', refreshRegions);
  document.getElementById('save-regions-btn')?.addEventListener('click', async () => {
    const d = await sendCommand('region_save');
    setOutput('region-output', d?.payload?.reply || 'Saved.');
  });

  // Region forms
  document.getElementById('region-home-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = new FormData(e.target).get('name')?.trim();
    if (name) {
      const d = await sendCommand('region_home_set', { name });
      setOutput('region-output', d?.payload?.reply || JSON.stringify(d?.payload));
      e.target.reset();
    }
  });
  document.getElementById('region-put-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get('name')?.trim(), parent = fd.get('parent')?.trim() || '';
    if (name) {
      const d = await sendCommand('region_put', { name, parent });
      setOutput('region-output', d?.payload?.reply || JSON.stringify(d?.payload));
      e.target.reset();
    }
  });
  document.getElementById('region-remove-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = new FormData(e.target).get('name')?.trim();
    if (name) {
      const d = await sendCommand('region_remove', { name });
      setOutput('region-output', d?.payload?.reply || JSON.stringify(d?.payload));
      e.target.reset();
    }
  });
  document.getElementById('region-flag-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const mode = fd.get('mode'), name = fd.get('name')?.trim();
    if (name) {
      const cmd = mode === 'denyf' ? 'region_denyf' : 'region_allowf';
      const d = await sendCommand(cmd, { name });
      setOutput('region-output', d?.payload?.reply || JSON.stringify(d?.payload));
      e.target.reset();
    }
  });
  document.getElementById('region-get-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = new FormData(e.target).get('name')?.trim();
    if (name) {
      const d = await sendCommand('region_get', { name });
      setOutput('region-output', d?.payload?.reply || JSON.stringify(d?.payload));
    }
  });
  document.getElementById('region-load-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get('name')?.trim(), flood = fd.get('flood') === 'on' ? 'F' : '';
    if (name) {
      const d = await sendCommand('region_load_named', { name, flood_flag: flood });
      setOutput('region-output', d?.payload?.reply || JSON.stringify(d?.payload));
      e.target.reset();
    }
  });

  // Raw CLI form
  document.getElementById('raw-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const cmd = new FormData(e.target).get('cmd')?.trim();
    if (!cmd) return;
    setOutput('raw-output', `$ ${cmd}\nRunning…`);
    const d = await sendCommand('raw', { cmd });
    setOutput('raw-output', `$ ${cmd}\n${d?.payload?.reply ?? JSON.stringify(d?.payload) ?? d?.error ?? '(no output)'}`);
    e.target.reset();
  });

  // Reboot button
  document.getElementById('btn-reboot')?.addEventListener('click', async () => {
    if (!confirm('Reboot the repeater node?')) return;
    const d = await sendCommand('reboot');
    setOutput('raw-output', d?.payload?.reply || JSON.stringify(d?.payload));
  });

  // Neighbor remove form
  document.getElementById('neighbor-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const prefix = new FormData(e.target).get('pubkey_prefix')?.trim();
    if (!prefix) return;
    const d = await sendCommand('neighbor_remove', { pubkey_prefix: prefix });
    alert(d?.payload?.reply || JSON.stringify(d?.payload));
    e.target.reset();
  });

  // ── Companion Config tab forms ──────────────────────
  document.getElementById('cfg-name-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = new FormData(e.target).get('name')?.trim();
    if (!name) return;
    const d = await sendCommand('set_name', { name });
    setOutput('companion-cfg-output', d?.ok ? `✓ Name set: ${name}` : `Error: ${d?.error}`);
    e.target.reset();
  });

  document.getElementById('cfg-loc-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const lat = parseFloat(fd.get('lat')), lon = parseFloat(fd.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) {
      setOutput('companion-cfg-output', 'Invalid coordinates'); return;
    }
    const d = await sendCommand('set_location', { lat, lon });
    setOutput('companion-cfg-output', d?.ok ? `✓ Location set: ${lat.toFixed(6)}, ${lon.toFixed(6)}` : `Error: ${d?.error}`);
    e.target.reset();
  });

  document.getElementById('btn-advert-cfg')?.addEventListener('click', async () => {
    const d = await sendCommand('advert');
    setOutput('companion-cfg-output', d?.ok ? '✓ Advert sent' : `Error: ${d?.error}`);
  });

  document.getElementById('btn-sync-time-cfg')?.addEventListener('click', async () => {
    const d = await sendCommand('sync_time');
    setOutput('companion-cfg-output', d?.ok ? `✓ Time synced: ${new Date().toLocaleString()}` : `Error: ${d?.error}`);
  });
}

// ─── SSE Connection ──────────────────────────────────
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = evt => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'state' && msg.payload) renderAll(msg.payload);
  };
  es.onerror = () => { es.close(); setTimeout(connectSSE, 2000); };
}

// ─── Boot ────────────────────────────────────────────
(async function init() {
  wireUi();

  // Initial state via REST fallback
  try {
    const snap = await fetch('/api/state').then(r => r.json());
    renderAll(snap);
    // Load initial HW stats
    sendCommand('get_hardware_stats').then(d => { if (d?.ok && d.payload) updateHwStats(d.payload); });
  } catch (e) {
    console.log('Initial state fetch failed, waiting for SSE');
  }

  // Periodic HW stats refresh (every 30s)
  setInterval(() => {
    sendCommand('get_hardware_stats').then(d => { if (d?.ok && d.payload) updateHwStats(d.payload); });
  }, 30000);

  connectSSE();
})();
