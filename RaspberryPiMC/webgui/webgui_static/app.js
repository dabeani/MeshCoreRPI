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
  contactTypeFilter: 'all',
  logTypeFilter: 'all',
  activeChannel: null,       // currently selected channel index (number|null)
  unreadChannels: new Set(), // channel indices with unread messages
  lastMsgCount: 0,           // track when new messages arrive
  chMsgCounts: {},           // channel_idx -> last rendered message count
  chScrollPos: {},           // channel_idx -> last saved scrollTop when visible
  chEverViewed: {},          // channel_idx -> bool: has user ever opened this channel
};

// ─── Leaflet map (init early – dashboard is default tab so div is visible) ──
const mcMap = L.map('map', { zoomControl: true, closePopupOnClick: false }).setView([20, 0], 2);
// Dark CartoDB tiles to match pyMC style
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(mcMap);
const lineLayer   = L.layerGroup().addTo(mcMap);  // paths drawn below markers
const markerLayer = L.layerGroup().addTo(mcMap);

function markerIconForKind(kind, isSelf) {
  if (isSelf) return L.divIcon({ className: 'mc-icon mc-icon-self',     iconSize: [20, 20], iconAnchor: [10, 10] });
  switch (kind) {
    case 2:  return L.divIcon({ className: 'mc-icon mc-icon-repeater', iconSize: [16, 16], iconAnchor: [8,  8]  });
    case 3:  return L.divIcon({ className: 'mc-icon mc-icon-server',   iconSize: [14, 14], iconAnchor: [7,  7]  });
    case 4:  return L.divIcon({ className: 'mc-icon mc-icon-sensor',   iconSize: [12, 12], iconAnchor: [6,  6]  });
    default: return L.divIcon({ className: 'mc-icon mc-icon-client',   iconSize: [12, 12], iconAnchor: [6,  6]  });
  }
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
  if (tabName === 'channels' && app.snap) {
    app.unreadChannels.clear();
    updateChannelBadge();
    renderChannels(app.snap);
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
  lineLayer.clearLayers();
  const bounds = [];

  // Self node — lower threshold so even ~10m GPS drift shows
  const si = snap.self_info || {};
  const selfLat = si.adv_lat, selfLon = si.adv_lon;
  const selfOnMap = Number.isFinite(selfLat) && Number.isFinite(selfLon) &&
                    (Math.abs(selfLat) > 0.0001 || Math.abs(selfLon) > 0.0001);
  if (selfOnMap) {
    const m = L.marker([selfLat, selfLon], { icon: markerIconForKind(null, true), zIndexOffset: 100 });
    m.bindPopup(
      `<div style="min-width:160px"><b>${si.name || 'This Node'}</b><br>` +
      `<span style="color:#58a6ff">Self (${snap.role || 'unknown'})</span><br>` +
      `${selfLat.toFixed(5)}, ${selfLon.toFixed(5)}</div>`,
      { autoClose: false, closeOnClick: false }
    );
    m.addTo(markerLayer);
    bounds.push([selfLat, selfLon]);
  }

  // Contacts / neighbors with location
  let onMap = 0;
  const kindCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const c of (snap.contacts || [])) {
    const k = c.kind || 1;
    kindCounts[k] = (kindCounts[k] || 0) + 1;

    if (!hasLoc(c)) continue;
    onMap++;
    const m = L.marker([c.lat, c.lon], { icon: markerIconForKind(k, false) });
    const hops = c.out_path_len;
    const hopStr = (hops === 0 || hops === null || hops === undefined)
      ? 'Direct' : (hops < 255 ? `${hops} hop${hops !== 1 ? 's' : ''}` : '–');
    const snrStr = c.snr != null ? ` · SNR ${c.snr} dB` : '';
    m.bindPopup(
      `<div style="min-width:160px"><b>${c.name || c.pubkey.slice(0, 12)}</b><br>` +
      `<span style="color:#2ecc71">${contactKindStr(c.kind, snap.role)}</span> · ${hopStr}${snrStr}<br>` +
      `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}<br>` +
      `Last: ${fmtTime(c.last_advert_timestamp)}<br>` +
      `<small style="color:#7a8fc7">${c.pubkey.slice(0,16)}…</small></div>`,
      { autoClose: false, closeOnClick: false }
    );
    m.addTo(markerLayer);
    bounds.push([c.lat, c.lon]);

    // Draw path polyline from self to contact (only when we know self pos)
    if (selfOnMap) {
      const hopsN = (hops === null || hops === undefined) ? 255 : hops;
      let lineOpts;
      if (hopsN === 0)      lineOpts = { color: '#00ff88', weight: 2.5, opacity: 0.8 };
      else if (hopsN <= 2)  lineOpts = { color: '#58a6ff', weight: 2.0, opacity: 0.7, dashArray: '6,4' };
      else if (hopsN < 255) lineOpts = { color: '#f4c430', weight: 1.5, opacity: 0.6, dashArray: '4,6' };
      if (lineOpts) {
        L.polyline([[selfLat, selfLon], [c.lat, c.lon]], lineOpts).addTo(lineLayer);
      }
    }
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

// Convert a cumulative series to per-interval deltas (for traffic rate charts)
function toDelta(arr) {
  if (!arr || arr.length < 2) return arr || [];
  const out = [0];
  for (let i = 1; i < arr.length; i++) out.push(Math.max(0, (arr[i] ?? 0) - (arr[i-1] ?? 0)));
  return out;
}

function renderCharts(snap) {
  const h = snap?.history || {};
  const ts = h.ts || [];

  // 1. Packet traffic: show per-interval deltas so chart stays "live"
  drawChart(document.getElementById('chart-traffic'), ts, [
    { label: 'RX/interval',   data: toDelta(h.rx),   color: '#58a6ff', fill: true },
    { label: 'TX/interval',   data: toDelta(h.tx),   color: '#2ecc71' },
    { label: 'Drop/interval', data: toDelta(h.drop), color: '#ff6b6b', dash: [4, 3] },
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
  const kindFilter = app.contactTypeFilter;

  // Update button counts
  const allContacts = snap.contacts || [];
  const kindMap = { '1': 0, '2': 0, '3': 0, '4': 0 };
  for (const c of allContacts) kindMap[String(c.kind || 1)]++;
  document.querySelectorAll('.type-btn[data-kind]').forEach(btn => {
    const k = btn.dataset.kind;
    if (k === 'all') btn.textContent = `All (${allContacts.length})`;
    else btn.textContent = {
      '1': `Clients (${kindMap['1']})`,
      '2': `Repeaters (${kindMap['2']})`,
      '3': `Servers (${kindMap['3']})`,
      '4': `Sensors (${kindMap['4']})`,
    }[k] || k;
  });

  const contacts = allContacts.filter(c => {
    if (kindFilter !== 'all' && String(c.kind || 1) !== kindFilter) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (c.name || '').toLowerCase().includes(q) || c.pubkey.toLowerCase().includes(q);
  });

  const tbody = document.getElementById('contacts-body');
  if (!tbody) return;
  if (!contacts.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px">No contacts found</td></tr>`;
    return;
  }
  tbody.innerHTML = contacts.slice(0, 250).map(c => {
    const loc    = hasLoc(c) ? `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}` : '–';
    const hops   = c.out_path_len;
    const hopStr = (hops === 0) ? 'Direct'
                 : (hops > 0 && hops < 255) ? `${hops} hop${hops !== 1 ? 's' : ''}` : '–';
    const snrStr = c.snr != null ? `${c.snr} dB` : '–';
    const kind   = contactKindStr(c.kind, role);
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
      <td>${snrStr}</td>
      <td>${hopStr}</td>
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

  const catFilter = app.logTypeFilter;
  const categoryMatches = type => {
    if (catFilter === 'all')    return true;
    if (catFilter === 'pkt')    return type === 'pkt_rx' || type === 'pkt_tx';
    if (catFilter === 'advert') return type === 'rx_advert' || type === 'neighbor_new';
    if (catFilter === 'msgs')   return type === 'chan_msg' || type === 'contact_msg' || type === 'chan_msg_sent';
    if (catFilter === 'system') return /^(connected|error|reboot|config_set|config_save|self_info|command|region_home|region_put|region_remove|region_allowf|region_denyf|region_load|region_get)$/.test(type);
    return true;
  };

  const filtered = [...events].reverse().filter(e => {
    if (!categoryMatches(e.type)) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return e.type.toLowerCase().includes(q) ||
      JSON.stringify(e.payload || {}).toLowerCase().includes(q);
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted)">No events</td></tr>`;
    return;
  }

  const badgeClass = type => {
    if (type === 'pkt_rx' || type === 'rx_advert') return 'rx';
    if (type === 'pkt_tx')                          return 'tx';
    if (type === 'neighbor_new')                    return 'adv';
    if (type === 'connected' || type === 'self_info') return 'cfg';
    if (/error|fail/i.test(type))                   return 'err';
    if (/config|save|set|reboot/i.test(type))       return 'cfg';
    if (/region/i.test(type))                       return 'warn';
    return '';
  };

  const dirCell = type => {
    if (type === 'pkt_rx' || type === 'rx_advert') return `<td class="log-dir rx">↓</td>`;
    if (type === 'pkt_tx')                          return `<td class="log-dir tx">↑</td>`;
    return `<td></td>`;
  };

  const detailStr = e => {
    const p = e.payload || {};
    // Try to resolve a pubkey prefix to a known contact name
    const contacts = app.snap?.contacts || [];
    const findName = pk => {
      const c = contacts.find(cx => pk && cx.pubkey.startsWith(pk.slice(0, 8)));
      return c?.name || null;
    };
    switch (e.type) {
      case 'pkt_rx': {
        const parts = [];
        if (p.rssi  != null) parts.push(`RSSI ${p.rssi} dBm`);
        if (p.snr   != null) parts.push(`SNR ${p.snr} dB`);
        if (p.count != null) parts.push(`+${p.count} pkt${p.count !== 1 ? 's' : ''}`);
        if (p.total != null) parts.push(`(\u03a3 ${p.total})`);
        return parts.join(' \u00b7 ');
      }
      case 'pkt_tx': {
        const parts = [];
        if (p.count != null) parts.push(`+${p.count} pkt${p.count !== 1 ? 's' : ''}`);
        if (p.total != null) parts.push(`(\u03a3 ${p.total})`);
        return parts.join(' \u00b7 ');
      }
      case 'rx_advert': {
        const name = p.name || findName(p.pubkey);
        const who  = name ? `${name} (${(p.pubkey||'').slice(0,12)}\u2026)` : `${(p.pubkey||'').slice(0,16)}\u2026`;
        const kindMap = {1:'Client',2:'Repeater',3:'Server',4:'Sensor'};
        const kindStr = p.kind != null ? ` · ${kindMap[p.kind] || 'Node'}` : '';
        const locStr  = p.lat  != null ? ` · \uD83D\uDCCD ${p.lat.toFixed(4)}, ${p.lon?.toFixed(4)}` : '';
        const hopStr  = p.hops === 0   ? ' · Direct' : p.hops > 0 ? ` · ${p.hops} hop${p.hops !== 1 ? 's' : ''}` : '';
        return `Advert from ${who}${kindStr}${locStr}${hopStr}`;
      }
      case 'chan_msg': {
        const snrStr = p.snr != null ? ` · SNR ${p.snr} dB` : '';
        const hopStr = p.path_len === 0 ? ' · Direct' : p.path_len > 0 ? ` · ${p.path_len} hop${p.path_len !== 1 ? 's' : ''}` : '';
        return `[${p.channel || `ch${p.channel_idx}`}] ${(p.text||'').slice(0,80)}${hopStr}${snrStr}`;
      }
      case 'chan_msg_sent': {
        return `\u2191 Sent to [${p.channel || '?'}]: ${(p.text||'').slice(0,60)}`;
      }
      case 'contact_msg': {
        const snrStr = p.snr != null ? ` · SNR ${p.snr} dB` : '';
        const hopStr = p.path_len === 0 ? ' · Direct' : p.path_len > 0 ? ` · ${p.path_len} hop${p.path_len !== 1 ? 's' : ''}` : '';
        return `\uD83D\uDCE8 From ${p.sender || p.pubkey_prefix || '?'}: ${(p.text||'').slice(0,80)}${hopStr}${snrStr}`;
      }
      case 'neighbor_new': {
        const name = findName(p.pubkey);
        const who  = name ? `${name} (${(p.pubkey||'').slice(0,12)}\u2026)` : `${(p.pubkey||'').slice(0,16)}\u2026`;
        const snr  = p.snr != null ? ` \u00b7 SNR ${p.snr} dB` : '';
        return `New neighbor: ${who}${snr}`;
      }
      case 'connected':     return `Connected \u2192 ${p.host || '?'}:${p.port || '?'}`;
      case 'self_info':     return `Node: ${p.name || '(unnamed)'}`;
      case 'error':         return `\u26a0 ${p.message || JSON.stringify(p)}`;
      case 'config_set':    return `${p.key} = ${p.value}`;
      case 'config_save':   return 'Config saved to device flash';
      case 'reboot':        return `Node reboot${p.reply ? ': ' + p.reply : ''}`;
      case 'command':       return `cmd: ${p.name}${p.reply ? ' \u2192 ' + String(p.reply).slice(0,80) : ''}`;
      case 'region_home':   return `Home region set: ${p.name}`;
      case 'region_put':    return `Region created: ${p.name}${p.parent ? ' under ' + p.parent : ''}`;
      case 'region_remove': return `Region removed: ${p.name}`;
      case 'region_allowf': return `Flood ALLOWED for: ${p.name}`;
      case 'region_denyf':  return `Flood DENIED for: ${p.name}`;
      case 'region_load':   return `Region preset loaded: ${p.name}${p.flood_flag ? ' (flood)' : ''}`;
      default:              return Object.entries(p).map(([k,v]) => `${k}: ${v}`).join(' \u00b7 ').slice(0,200) || '\u2013';
    }
  };

  tbody.innerHTML = filtered.slice(0, 500).map(e =>
    `<tr>
      ${dirCell(e.type)}
      <td style="font-size:11px;color:var(--muted);white-space:nowrap">${fmtTime(e.ts)}</td>
      <td><span class="log-type-badge ${badgeClass(e.type)}">${e.type}</span></td>
      <td style="font-size:11px;font-family:monospace">${detailStr(e)}</td>
    </tr>`
  ).join('');
}

// ─── Channels ────────────────────────────────────────
function updateChannelBadge() {
  const badge = document.getElementById('ch-tab-badge');
  if (!badge) return;
  const count = app.unreadChannels.size;
  badge.textContent = count;
  badge.style.display = count ? '' : 'none';
}

function fmtMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const h = d.getHours().toString().padStart(2,'0');
  const m = d.getMinutes().toString().padStart(2,'0');
  return `${h}:${m}`;
}

function renderChannels(snap) {
  const channels  = snap.channels  || [];
  const messages  = snap.messages  || [];
  const listEl    = document.getElementById('ch-list');
  const msgArea   = document.getElementById('ch-messages');
  const titleEl   = document.getElementById('ch-title');
  const subtitleEl = document.getElementById('ch-subtitle');
  if (!listEl || !msgArea) return;

  // If no active channel, default to first available
  if (app.activeChannel === null && channels.length) {
    app.activeChannel = channels[0].index;
  }

  // Render sidebar list
  listEl.innerHTML = channels.map(ch => {
    const isActive  = ch.index === app.activeChannel;
    const unread    = app.unreadChannels.has(ch.index);
    const chMsgs    = messages.filter(m => m.msg_type === 'channel' && m.channel_idx === ch.index);
    const last      = chMsgs[chMsgs.length - 1];
    const lastText  = last ? last.text.slice(0, 28) + (last.text.length > 28 ? '…' : '') : 'No messages yet';
    const icon      = ch.index === 0 ? '#' : String(ch.index);
    return `<li class="ch-list-item${isActive ? ' active' : ''}" data-ch-idx="${ch.index}">
      <div class="ch-item-icon">${icon}</div>
      <div class="ch-item-info">
        <div class="ch-item-name">${_esc(ch.name)}</div>
        <div class="ch-item-sub">${_esc(lastText)}</div>
      </div>
      ${unread ? `<div class="ch-item-badge">${unread}</div>` : ''}
    </li>`;
  }).join('');

  // Render chat area
  if (app.activeChannel === null) {
    titleEl && (titleEl.textContent = 'Select a channel');
    subtitleEl && (subtitleEl.textContent = '');
    msgArea.innerHTML = `<div class="ch-empty"><div class="ch-empty-icon">&#128172;</div>No channels configured yet.<br><small>Channels are fetched from the device on connect.</small></div>`;
    return;
  }

  const activeCh = channels.find(c => c.index === app.activeChannel);
  const chName = activeCh?.name || `Channel ${app.activeChannel}`;
  if (titleEl)    titleEl.textContent = chName;
  if (subtitleEl) subtitleEl.textContent = `Slot ${app.activeChannel}`;

  // Filter messages for active channel
  const chMsgs = messages.filter(m =>
    m.msg_type === 'channel' && m.channel_idx === app.activeChannel
  );

  if (!chMsgs.length) {
    msgArea.innerHTML = `<div class="ch-empty"><div class="ch-empty-icon">&#128172;</div>No messages yet.<br><small>Messages will appear here as they arrive.</small></div>`;
    app.chMsgCounts[app.activeChannel] = 0;
    return;
  }

  const prevCount = app.chMsgCounts[app.activeChannel] ?? -1;
  const gotNewMsgs = chMsgs.length > prevCount;
  // offsetHeight > 0 means the element is actually rendered and visible
  const isVisible = msgArea.offsetHeight > 0;

  // While visible: snapshot scroll state before replacing DOM
  let wasAtBottom = false;
  if (isVisible) {
    const scrollable = Math.max(msgArea.scrollHeight - msgArea.clientHeight, 0);
    wasAtBottom = msgArea.scrollTop >= scrollable - 20;
    app.chScrollPos[app.activeChannel] = msgArea.scrollTop;
  }

  msgArea.innerHTML = chMsgs.map(m => {
    const dir = m.outbound ? 'outbound' : 'inbound';
    const snrStr  = m.snr  != null ? `SNR ${m.snr} dB` : '';
    const hopStr  = m.path_len === 0 ? 'Direct' : m.path_len > 0 ? `${m.path_len} hop${m.path_len !== 1 ? 's' : ''}` : '';
    const metaParts = [m.outbound ? 'You' : '', fmtMsgTime(m.ts)].filter(Boolean);
    const footerParts = [hopStr, snrStr].filter(Boolean);
    // Delivery status for outbound messages
    let statusHtml = '';
    if (m.outbound) {
      if      (m.status === 'pending') statusHtml = '<span class="ch-status pending">&#9201; Sending\u2026</span>';
      else if (m.status === 'sent')    statusHtml = '<span class="ch-status sent">&#10003; Delivered</span>';
      else if (m.status === 'failed')  statusHtml = '<span class="ch-status failed">&#9888; Failed</span>';
    }
    return `<div class="ch-bubble ${dir}">
      <div class="ch-bubble-meta">
        ${m.outbound ? '' : `<span class="ch-bubble-sender">${_esc(chName)}</span>`}
        <span>${metaParts.join(' · ')}</span>
      </div>
      <div class="ch-bubble-text">${_esc(m.text)}</div>
      ${(footerParts.length || statusHtml) ? `<div class="ch-bubble-footer">${footerParts.join(' · ')}${statusHtml}</div>` : ''}
    </div>`;
  }).join('');

  app.chMsgCounts[app.activeChannel] = chMsgs.length;

  if (isVisible) {
    const firstView = !app.chEverViewed[app.activeChannel];
    app.chEverViewed[app.activeChannel] = true;
    if (firstView || (gotNewMsgs && wasAtBottom)) {
      // First time opening this channel, or new message arrived while user was at bottom
      msgArea.scrollTop = msgArea.scrollHeight;
    } else {
      // Restore position the user was at before the DOM was replaced
      msgArea.scrollTop = app.chScrollPos[app.activeChannel] ?? 0;
    }
  }
  // When not visible (background update): don't touch scroll at all
}

// Helper: escape HTML special characters
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

// ─── Config Management ───────────────────────────────────────────
// Human-readable metadata for known MeshCore config keys
const CONFIG_META = {
  // Radio
  freq:    { label: 'Frequency',        unit: 'MHz',  group: 'Radio',    desc: 'LoRa carrier frequency (e.g. 869.525 for EU)' },
  bw:      { label: 'Bandwidth',        unit: 'kHz',  group: 'Radio',    desc: 'Channel bandwidth — 125 / 250 / 500 kHz' },
  sf:      { label: 'Spreading Factor', unit: '',     group: 'Radio',    desc: 'SF7–SF12 · Higher = longer range & slower airtime' },
  cr:      { label: 'Coding Rate',      unit: '',     group: 'Radio',    desc: 'Error correction ratio — 5 (4/5) … 8 (4/8)' },
  txpow:   { label: 'TX Power',         unit: 'dBm',  group: 'Radio',    desc: 'Transmit power in dBm' },
  txdelay: { label: 'TX Delay',         unit: 'ms',   group: 'Radio',    desc: 'Random delay added before transmitting to reduce collisions' },
  // Identity
  name:    { label: 'Node Name',        unit: '',     group: 'Identity', desc: 'Displayed name on the mesh network (max 31 chars)' },
  // Location
  lat:     { label: 'Latitude',         unit: '°',    group: 'Location', desc: 'GPS latitude in decimal degrees (eg: 48.8566)' },
  lon:     { label: 'Longitude',        unit: '°',    group: 'Location', desc: 'GPS longitude in decimal degrees (eg: 2.3522)' },
  // Routing / Operation
  repeat:  { label: 'Repeat Mode',      unit: '',     group: 'Routing',  desc: '0 = monitor only · 1 = forward / repeat packets' },
  airtime: { label: 'Airtime Limit',    unit: '%',    group: 'Routing',  desc: 'Max airtime fraction reserved for forwarding (0–100)' },
  maxhops: { label: 'Max Hops',         unit: '',     group: 'Routing',  desc: 'Maximum hop count before a packet is discarded' },
};

function renderConfigRows() {
  const container = document.getElementById('config-groups');
  if (!container) return;

  if (!app.configKeys.length) {
    container.innerHTML = '<p class="cfg-no-params">No config loaded. Click ↓ Load from Device to fetch parameters.</p>';
    return;
  }

  // Group all keys
  const groups = {};
  const GROUP_ORDER = ['Radio', 'Identity', 'Location', 'Routing', 'Other'];
  for (const key of app.configKeys) {
    const g = CONFIG_META[key]?.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(key);
  }
  const sorted = [...GROUP_ORDER.filter(g => groups[g]), ...Object.keys(groups).filter(g => !GROUP_ORDER.includes(g))];

  container.innerHTML = sorted.map(group => {
    const rows = (groups[group] || []).map(key => {
      const meta = CONFIG_META[key];
      const raw  = app.configValues[key] ?? '';
      const v    = String(raw).replace(/</g, '&lt;').replace(/"/g, '&quot;');
      const label   = meta?.label || key;
      const unitHtml = meta?.unit  ? `<span style="color:var(--muted);font-size:10px"> ${meta.unit}</span>` : '';
      const descHtml = meta?.desc  ? `<small style="display:block;color:var(--muted);font-size:10px;margin-top:1px">${meta.desc}</small>` : '';
      return `<div class="cfg-param-row">
        <div class="cfg-param-label">
          <span>${label}${unitHtml}</span>
          <code>${key}</code>
          ${descHtml}
        </div>
        <div class="cfg-param-value"><span class="cfg-current-val" title="${v}">${v || '–'}</span></div>
        <div class="cfg-param-edit"><input data-config-input="${key}" value="${v}" /></div>
        <div class="cfg-param-action"><button class="btn-sm" data-config-set="${key}">Set</button></div>
      </div>`;
    }).join('');
    return `<div class="cfg-group"><div class="cfg-group-header">${group}</div>${rows}</div>`;
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
  if (app.activeTab === 'channels') renderChannels(snap);

  // Track new messages and update the tab badge (even off-tab)
  const msgs = snap.messages || [];
  if (msgs.length > app.lastMsgCount) {
    const newMsgs = msgs.slice(app.lastMsgCount);
    newMsgs.forEach(m => {
      if (m.msg_type === 'channel' && !m.outbound && app.activeTab !== 'channels') {
        app.unreadChannels.add(m.channel_idx);
      }
    });
    app.lastMsgCount = msgs.length;
    updateChannelBadge();
  }
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

  // Contacts search + type filter buttons
  document.getElementById('contact-search')?.addEventListener('input', e => {
    if (app.snap) renderContacts(app.snap, e.target.value);
  });
  document.querySelectorAll('.type-btn[data-kind]').forEach(btn =>
    btn.addEventListener('click', () => {
      app.contactTypeFilter = btn.dataset.kind;
      document.querySelectorAll('.type-btn[data-kind]').forEach(b => b.classList.toggle('active', b === btn));
      if (app.snap) renderContacts(app.snap, document.getElementById('contact-search')?.value || '');
    })
  );

  // Log filter + log type filter buttons
  document.getElementById('log-filter')?.addEventListener('input', e => {
    renderLog(app.snap?.events || [], e.target.value);
  });
  document.querySelectorAll('.type-btn[data-log-filter]').forEach(btn =>
    btn.addEventListener('click', () => {
      app.logTypeFilter = btn.dataset.logFilter;
      document.querySelectorAll('.type-btn[data-log-filter]').forEach(b => b.classList.toggle('active', b === btn));
      renderLog(app.snap?.events || [], document.getElementById('log-filter')?.value || '');
    })
  );
  document.getElementById('btn-clear-log')?.addEventListener('click', () => {
    if (app.snap) app.snap.events = [];
    renderLog([], '');
  });

  // Config: delegated set-button click from grouped param display
  document.getElementById('config-groups')?.addEventListener('click', e => {
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

  // ── Channels tab ────────────────────────────────────
  document.getElementById('btn-refresh-channels')?.addEventListener('click', async () => {
    await sendCommand('get_channels');
  });

  // Channel list item click (delegated)
  document.getElementById('ch-list')?.addEventListener('click', e => {
    const item = e.target.closest('[data-ch-idx]');
    if (!item) return;
    const idx = parseInt(item.dataset.chIdx, 10);
    app.activeChannel = idx;
    app.unreadChannels.delete(idx);
    updateChannelBadge();
    if (app.snap) renderChannels(app.snap);
  });

  // Channel message send form
  document.getElementById('ch-send-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const text = new FormData(e.target).get('text')?.trim();
    if (!text || app.activeChannel === null) return;
    const input = document.getElementById('ch-input');
    if (input) input.disabled = true;
    await sendCommand('public_msg', { text, channel: app.activeChannel });
    e.target.reset();
    if (input) input.disabled = false;
    input?.focus();
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
