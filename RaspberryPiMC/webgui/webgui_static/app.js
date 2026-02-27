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
  contactSort: 'last_seen_desc',
  activeChannel: null,       // currently selected channel index (number|null)
  unreadChannelCounts: {},   // channel_idx -> unread message count
  lastMsgCount: 0,           // track when new messages arrive
  lastPingTs: 0,             // ts of last event processed for map pings
  chMsgCounts: {},           // channel_idx -> last rendered message count
  chScrollPos: {},           // channel_idx -> last saved scrollTop when visible
  chEverViewed: {},          // channel_idx -> bool: has user ever opened this channel
  // DM (Messages tab)
  activeDmContact: null,     // full pubkey hex of selected contact
  unreadDms: new Set(),      // pubkey_prefixes (12 hex chars) with unread messages
  dmMsgCounts: {},           // pubkey_prefix -> last rendered DM count
  dmScrollPos: {},           // pubkey_prefix -> last saved scrollTop
  dmEverViewed: {},          // pubkey_prefix -> bool
  rxlogLiveScroll: false,    // whether RxLog live scroll is enabled
  latestRxLogText: '',       // cached raw packet log text
  latestRxLogLines: [],      // cached packet log lines for incremental updates
  headerStats: null,         // cached backend packet header stats
  headerStatsLastFetch: 0,   // unix ms of last fetch
  headerStatsFetching: false,
  lastStateRenderAt: 0,      // unix ms of last renderAll() update
  lastRxLogFetchAt: 0,       // unix ms of last refreshCombinedLog() fetch
  ws: null,
  wsConnected: false,
  wsRetryTimer: null,
  wsRxCount: 0,
  wsTxCount: 0,
  wsLastMsgAt: 0,
  wsLatencyTs: [],
  wsLatencyMs: [],
  autoSyncTimePending: null,
  // Accumulated history — grows client-side so heartbeats only need to send
  // the latest 2 points instead of the full 720-point series each time.
  history: {},
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
const markerByPubkey = {};  // pubkey hex -> Leaflet marker (for map pings)

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

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx += 1;
  }
  return `${v.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function contactKindStr(kind, role) {
  // ADV_TYPE_NONE=0, ADV_TYPE_CHAT=1 (client), ADV_TYPE_REPEATER=2, ADV_TYPE_ROOM=3, ADV_TYPE_SENSOR=4
  const types = ['Unknown', 'Client', 'Repeater', 'Room Server', 'Sensor'];
  if (role === 'repeater' && (!Number.isFinite(Number(kind)) || Number(kind) === 0)) return 'Neighbor';
  return types[kind] ?? `Type ${kind}`;
}

// ─── API ─────────────────────────────────────────────
async function sendCommand(name, args = {}) {
  app.wsTxCount += 1;
  updateWsStatusPanel();
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

function _recordWsLatencyFromEvent(msg) {
  const ts = Number(msg?.ts);
  if (!Number.isFinite(ts) || ts <= 0) return;
  const nowMs = Date.now();
  const latencyMs = Math.max(0, nowMs - (ts * 1000));
  const nowSec = Math.floor(nowMs / 1000);
  app.wsLatencyTs.push(nowSec);
  app.wsLatencyMs.push(Math.round(latencyMs));
  const maxPoints = 180;
  if (app.wsLatencyTs.length > maxPoints) {
    app.wsLatencyTs = app.wsLatencyTs.slice(app.wsLatencyTs.length - maxPoints);
    app.wsLatencyMs = app.wsLatencyMs.slice(app.wsLatencyMs.length - maxPoints);
  }
}

function updateWsStatusPanel() {
  const stateEl = document.getElementById('ws-state');
  const rxEl = document.getElementById('ws-rx');
  const txEl = document.getElementById('ws-tx');
  const latEl = document.getElementById('ws-latency-now');
  const lastEl = document.getElementById('ws-last-msg');
  if (!stateEl || !rxEl || !txEl || !latEl || !lastEl) return;

  const now = Date.now();
  const wsFresh = app.wsLastMsgAt > 0 ? (now - app.wsLastMsgAt) < 25000 : app.wsConnected;
  const backendConnected = Boolean(app.snap?.connected);
  const wsHealthy = app.wsConnected && wsFresh && backendConnected;

  stateEl.textContent = wsHealthy ? 'connected' : 'offline';
  stateEl.className = `badge ${wsHealthy ? 'ok' : 'err'}`;

  rxEl.textContent = `RX events: ${app.wsRxCount}`;
  txEl.textContent = `TX commands: ${app.wsTxCount}`;

  const latestLatency = app.wsLatencyMs.length ? app.wsLatencyMs[app.wsLatencyMs.length - 1] : null;
  latEl.textContent = latestLatency == null ? 'Latency: –' : `Latency: ${latestLatency} ms`;

  if (app.wsLastMsgAt > 0) {
    const ageMs = Math.max(0, now - app.wsLastMsgAt);
    const ageSec = Math.floor(ageMs / 1000);
    lastEl.textContent = `Last message: ${ageSec}s ago`;
  } else {
    lastEl.textContent = 'Last message: –';
  }

  const connBadge = document.getElementById('conn-badge');
  if (connBadge && !wsFresh) {
    connBadge.textContent = 'offline';
    connBadge.className = 'badge err';
  }

  drawChart(document.getElementById('ws-latency-chart'), app.wsLatencyTs, [
    { label: 'WS Latency (ms)', data: app.wsLatencyMs, color: '#58a6ff', fill: true },
  ]);
  renderFooter(app.snap);
}

// ─── Footer ──────────────────────────────────────────
function drawFooterSparkline(canvasId, values, strokeColor, fillColor) {
  const canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth  || canvas.width  || 90;
  const h = canvas.clientHeight || canvas.height || 24;
  canvas.width  = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pts = (values || []).filter(v => Number.isFinite(v));
  if (pts.length < 2) return;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const pad = 1;
  const xy = pts.map((v, i) => [
    (i / (pts.length - 1)) * (w - 2 * pad) + pad,
    h - pad - ((v - min) / range) * (h - 2 * pad),
  ]);
  ctx.beginPath();
  ctx.moveTo(xy[0][0], xy[0][1]);
  for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i][0], xy[i][1]);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  if (fillColor) {
    ctx.lineTo(xy[xy.length - 1][0], h);
    ctx.lineTo(xy[0][0], h);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  }
}

function renderFooter(snap) {
  // WS status dot
  const wsHealthy = app.wsConnected && Boolean(snap?.connected);
  const dot = document.getElementById('ft-ws-dot');
  const lbl = document.getElementById('ft-ws-label');
  if (dot) dot.className = 'ft-ws-dot' + (wsHealthy ? ' live' : '');
  if (lbl) lbl.textContent = wsHealthy ? 'WS: live' : (app.wsConnected ? 'WS: no device' : 'WS: offline');

  if (!snap) return;

  const packets = snap.stats?.packets || {};
  const radio   = snap.stats?.radio   || {};
  const core    = snap.stats?.core    || {};
  const hist    = (app.history && app.history.ts?.length ? app.history : (snap.history || {}));

  // Packet counts
  const rx = packets.recv ?? 0;
  const tx = packets.sent ?? 0;
  const el = id => document.getElementById(id);
  if (el('ft-rx')) el('ft-rx').textContent = String(rx);
  if (el('ft-tx')) el('ft-tx').textContent = String(tx);

  // RSSI / SNR
  const rssi = radio.last_rssi;
  const snr  = radio.last_snr;
  if (el('ft-rssi')) el('ft-rssi').textContent = rssi != null ? `${rssi}` : '–';
  if (el('ft-snr'))  el('ft-snr').textContent  = snr  != null ? `${snr}` : '–';

  // Uptime
  if (el('ft-uptime')) el('ft-uptime').textContent = fmtUptime(core.uptime_secs);

  // WS latency
  if (el('ft-latency')) {
    const lat = app.wsLatencyMs.length ? app.wsLatencyMs[app.wsLatencyMs.length - 1] : null;
    el('ft-latency').textContent = lat != null ? `Lat: ${lat}ms` : 'Lat: –';
  }

  // Last update timestamp
  if (el('ft-last-update') && app.wsLastMsgAt > 0) {
    const ageSec = Math.floor((Date.now() - app.wsLastMsgAt) / 1000);
    el('ft-last-update').textContent = `${ageSec}s ago`;
  }

  // Sparklines from history (flat arrays)
  const rxHist   = (hist.rx   || []).slice(-60);
  const rssiHist = (hist.rssi || []).slice(-60);
  drawFooterSparkline('ft-traffic-chart', rxHist,   '#2ecc71', 'rgba(46,204,113,.18)');
  drawFooterSparkline('ft-rssi-chart',    rssiHist,  '#58a6ff', 'rgba(88,166,255,.18)');
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
  if (tabName === 'stats' && app.snap) {
    refreshPacketStats();
  }
  if (tabName === 'contacts' && app.snap) {
    renderContacts(app.snap, document.getElementById('contact-search')?.value || '');
  }
  if (tabName === 'logs' && app.snap) {
    renderCombinedLog();
  }
  if (tabName === 'messages' && app.snap) {
    app.unreadDms.clear();
    updateDmBadge();
    renderMessages(app.snap);
  }
  if (tabName === 'channels' && app.snap) {
    renderChannels(app.snap);
    updateChannelBadge();
  }
  if (tabName === 'config' && app.snap?.role === 'repeater' && !app.configLoaded) {
    loadRepeaterConfig();
    refreshRegions();
  }

  // Companion only: request a fresh stats snapshot from the device immediately on
  // tab switch so all tabs show current data without waiting for the next 2.5 s
  // heartbeat cycle.  Repeater's refresh() is a heavy synchronous CLI call that
  // would block on every click; the repeater's 2.5 s loop already delivers fresh
  // data so no extra nudge is needed there.
  if (app.snap?.role === 'companion') {
    sendCommand('refresh').catch(() => {});
  }
}

async function refreshCombinedLog() {
  const out = document.getElementById('combined-log-output');
  if (!out) return;
  renderCombinedLog();
  if (app.rxlogLiveScroll) out.scrollTop = out.scrollHeight;
}

function _isNearBottom(el, pad = 12) {
  if (!el) return false;
  return (el.scrollTop + el.clientHeight) >= (el.scrollHeight - pad);
}

function adjustLogBoxSize(opts = {}) {
  const out = document.getElementById('combined-log-output');
  if (!out) return;
  const keepBottom = !!opts.keepBottom;
  const wasNearBottom = _isNearBottom(out, 24);

  const rect = out.getBoundingClientRect();
  const viewport = window.innerHeight || document.documentElement.clientHeight || 0;
  const bottomGap = 24;
  const minHeight = 120;
  const maxHeight = Math.max(minHeight, Math.floor(viewport - rect.top - bottomGap));
  out.style.maxHeight = `${maxHeight}px`;

  if (app.rxlogLiveScroll && (keepBottom || wasNearBottom)) {
    out.scrollTop = out.scrollHeight;
  }
}

function _normalizeLogLines(lines) {
  return (lines || []).map(v => String(v ?? '').replace(/\r/g, '')).filter(Boolean);
}

function _setRxLogFromText(text) {
  const lines = String(text ?? '').split('\n').map(v => v.replace(/\r/g, '')).filter(Boolean);
  const maxLines = 5000;
  app.latestRxLogLines = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  app.latestRxLogText = app.latestRxLogLines.join('\n');
  app.lastRxLogFetchAt = Date.now();
}

function _appendRxLogLines(lines) {
  const incoming = _normalizeLogLines(lines);
  if (!incoming.length) return;
  app.latestRxLogLines.push(...incoming);
  const maxLines = 5000;
  if (app.latestRxLogLines.length > maxLines) {
    app.latestRxLogLines = app.latestRxLogLines.slice(app.latestRxLogLines.length - maxLines);
  }
  app.latestRxLogText = app.latestRxLogLines.join('\n');
  app.lastRxLogFetchAt = Date.now();
}

function _packetTypeKeyFromCode(code) {
  const n = Number(code);
  if (n === 0x00) return 'req';
  if (n === 0x01) return 'resp';
  if (n === 0x02) return 'txt';
  if (n === 0x03) return 'ack';
  if (n === 0x04) return 'advert';
  if (n === 0x08) return 'path';
  return null;
}

function _routeKeyFromCodeOrChar(routeCode, routeChar, payloadKey) {
  const rc = Number(routeCode);
  if (Number.isFinite(rc) && rc >= 0 && rc <= 3) {
    if (rc === 0) return 'transport_flood';
    if (rc === 1) return 'flood';
    if (rc === 2) return 'direct';
    if (rc === 3) return 'transport_direct';
  }
  const transport = payloadKey === 'req' || payloadKey === 'resp' || payloadKey === 'path';
  const c = String(routeChar || '').toUpperCase();
  if (c === 'D') return transport ? 'transport_direct' : 'direct';
  if (c === 'F') return transport ? 'transport_flood' : 'flood';
  return null;
}

function _routeLabel(routeKey) {
  return {
    transport_flood: '0x00 Transport Flood',
    flood: '0x01 Flood',
    direct: '0x02 Direct',
    transport_direct: '0x03 Transport Direct',
  }[routeKey] || '–';
}

function _payloadLabel(payloadKey) {
  return {
    req: '0x00 REQ',
    resp: '0x01 RESP',
    txt: '0x02 TXT',
    ack: '0x03 ACK',
    advert: '0x04 ADVERT',
    path: '0x08 PATH',
  }[payloadKey] || '–';
}

function _parsePacketLogLines(text) {
  const entries = [];
  const rxRe = /RX,.*\(type=(\d+),\s*route=([A-Za-z])(?:,\s*route_code=(\d+))?/;
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    if (!line) continue;
    const m = line.match(rxRe);
    const payloadKey = m ? _packetTypeKeyFromCode(m[1]) : null;
    const routeKey = m ? _routeKeyFromCodeOrChar(m[3], m[2], payloadKey) : null;
    const cls = line.includes('TX FAIL') || /ERR|FAIL|DROP|CRC/i.test(line)
      ? 'err'
      : (line.includes(': TX') ? 'tx' : (line.includes(': RX') ? 'rx' : ''));
    entries.push({
      kind: 'packet',
      text: line,
      payloadKey,
      routeKey,
      cls,
    });
  }
  return entries;
}

function _eventLine(e) {
  const p = e?.payload || {};
  if (e.type === 'connected') return `Connected to ${p.host || '?'}:${p.port || '?'}`;
  if (e.type === 'error') return `Error: ${p.message || ''}`;
  if (e.type === 'config_set') return `Config ${p.key}=${p.value}`;
  if (e.type === 'reboot') return `Reboot ${p.reply || ''}`;
  if (e.type === 'chan_msg') return `[${p.channel || 'ch'}] ${p.text || ''}`;
  if (e.type === 'contact_msg') return `${p.sender || p.pubkey_prefix || '?'}: ${p.text || ''}`;
  return JSON.stringify(p);
}

function _eventClass(type) {
  if (type === 'error') return 'err';
  if (type === 'connected' || type === 'self_info') return 'cfg';
  if (type === 'pkt_tx') return 'tx';
  if (type === 'pkt_rx' || type === 'rx_advert') return 'rx';
  return 'evt';
}

function renderCombinedLog() {
  const out = document.getElementById('combined-log-output');
  if (!out) return;

  const search = (document.getElementById('log-filter')?.value || '').trim().toLowerCase();
  const routeFilter = document.getElementById('log-route-filter')?.value || 'all';
  const payloadFilter = document.getElementById('log-payload-filter')?.value || 'all';

  let entries = _parsePacketLogLines(app.latestRxLogText);
  entries = entries.filter(en => {
    if (routeFilter !== 'all' && en.routeKey !== routeFilter) return false;
    if (payloadFilter !== 'all' && en.payloadKey !== payloadFilter) return false;
    if (search && !en.text.toLowerCase().includes(search)) return false;
    return true;
  });

  const maxVisible = 1200;
  if (entries.length > maxVisible) entries = entries.slice(entries.length - maxVisible);

  if (!entries.length) {
    out.innerHTML = '<div class="rxlog-line">No matching log entries.</div>';
    return;
  }

  out.innerHTML = entries.map(en => {
    const tagRoute = en.routeKey ? `<span class="combined-tag">${_esc(_routeLabel(en.routeKey))}</span>` : '';
    const tagPayload = en.payloadKey ? `<span class="combined-tag">${_esc(_payloadLabel(en.payloadKey))}</span>` : '';
    const cls = en.cls ? `rxlog-line ${en.cls}` : 'rxlog-line';
    return `<div class="${cls}">${tagRoute}${tagPayload}${_esc(en.text)}</div>`;
  }).join('');

  adjustLogBoxSize();
}

function rxlogLineType(line) {
  const lower = String(line || '').toLowerCase();
  if (!lower) return '';
  if (
    lower.includes('err') ||
    lower.includes('fail') ||
    lower.includes('drop') ||
    lower.includes('crc')
  ) {
    return 'err';
  }
  if (lower.includes('warn')) return 'warn';
  if (lower.startsWith('rx') || lower.includes(' rx ') || lower.includes('rx:') || lower.includes('<-')) {
    return 'rx';
  }
  if (lower.startsWith('tx') || lower.includes(' tx ') || lower.includes('tx:') || lower.includes('->')) {
    return 'tx';
  }
  return '';
}

function renderRxLogText(text) {
  const out = document.getElementById('combined-log-output');
  if (!out) return;
  const lines = String(text ?? '').split('\n');
  out.innerHTML = lines.map(line => {
    const t = rxlogLineType(line);
    const cls = t ? `rxlog-line ${t}` : 'rxlog-line';
    const content = line.length ? _esc(line) : '&nbsp;';
    return `<div class="${cls}">${content}</div>`;
  }).join('');
}

function _renderFixedBars(container, labels, counts, classes) {
  if (!container) return;
  const keys = Object.keys(labels).sort((a, b) => {
    const av = counts[a] || 0;
    const bv = counts[b] || 0;
    return bv - av;
  });
  const values = keys.map(k => counts[k] || 0);
  const max = Math.max(1, ...values);
  container.innerHTML = keys.map((key) => {
    const n = counts[key] || 0;
    const width = n > 0 ? Math.max(4, Math.round((n / max) * 100)) : 0;
    const cls = classes[key] || 'c5';
    return `<div class="pktstats-row">` +
      `<div class="pktstats-top">` +
      `<span class="pktstats-label">${labels[key]}</span>` +
      `<span class="pktstats-count">${n}</span>` +
      `</div>` +
      `<div class="pktstats-track"><div class="pktstats-fill ${cls}" style="width:${width}%"></div></div>` +
      `</div>`;
  }).join('');
}

async function refreshPacketStats() {
  if (app.headerStatsFetching) return;
  app.headerStatsFetching = true;
  try {
    const d = await sendCommand('header_stats');
    if (d?.ok && d.payload) {
      app.headerStats = d.payload;
      app.headerStatsLastFetch = Date.now();
    }
  } finally {
    app.headerStatsFetching = false;
    renderPacketStats(app.headerStats);
  }
}

function renderPacketStats(stats) {
  const routingEl = document.getElementById('pktstats-routing-bars');
  const payloadEl = document.getElementById('pktstats-payload-bars');
  const totalEl = document.getElementById('pktstats-total');
  if (!routingEl || !payloadEl || !totalEl) return;

  const routingCounts = stats?.routing || {
    transport_flood: 0,
    flood: 0,
    direct: 0,
    transport_direct: 0,
  };
  const payloadCounts = stats?.payload || {
    req: 0,
    resp: 0,
    txt: 0,
    ack: 0,
    advert: 0,
    path: 0,
  };
  totalEl.textContent = `${Number(stats?.total_rx || 0)} RX packets`;

  _renderFixedBars(
    routingEl,
    {
      transport_flood: '0x00 Transport Flood',
      flood: '0x01 Flood',
      direct: '0x02 Direct',
      transport_direct: '0x03 Transport Direct',
    },
    routingCounts,
    {
      transport_flood: 'c1',
      flood: 'c2',
      direct: 'c3',
      transport_direct: 'c4',
    },
  );

  _renderFixedBars(
    payloadEl,
    {
      req: '0x00 REQ',
      resp: '0x01 RESP',
      txt: '0x02 TXT',
      ack: '0x03 ACK',
      advert: '0x04 ADVERT',
      path: '0x08 PATH',
    },
    payloadCounts,
    {
      req: 'c1',
      resp: 'c2',
      txt: 'c3',
      ack: 'c4',
      advert: 'c5',
      path: 'c6',
    },
  );
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
function pingMarker(pubkeyOrPrefix) {
  const prefix = (pubkeyOrPrefix || '').slice(0, 12);
  const key = Object.keys(markerByPubkey).find(k => k.startsWith(prefix));
  if (!key) return;
  const icon = markerByPubkey[key]._icon;
  if (!icon) return;
  icon.classList.remove('mc-ping'); // restart if already animating
  void icon.offsetWidth;            // force reflow
  icon.classList.add('mc-ping');
  setTimeout(() => icon.classList.remove('mc-ping'), 1400);
}

function updateMap(snap) {
  let popupKeyToRestore = null;
  markerLayer.eachLayer(layer => {
    if (typeof layer.isPopupOpen === 'function' && layer.isPopupOpen() && layer._mcPopupKey) {
      popupKeyToRestore = layer._mcPopupKey;
    }
  });

  markerLayer.clearLayers();
  lineLayer.clearLayers();
  Object.keys(markerByPubkey).forEach(k => delete markerByPubkey[k]);
  const bounds = [];

  // Self node — lower threshold so even ~10m GPS drift shows
  const si = snap.self_info || {};
  const selfLat = si.adv_lat, selfLon = si.adv_lon;
  const selfOnMap = Number.isFinite(selfLat) && Number.isFinite(selfLon) &&
                    (Math.abs(selfLat) > 0.0001 || Math.abs(selfLon) > 0.0001);
  if (selfOnMap) {
    const m = L.marker([selfLat, selfLon], { icon: markerIconForKind(null, true), zIndexOffset: 100 });
    m._mcPopupKey = '__self__';
    m.bindPopup(
      `<div style="min-width:160px"><b>${si.name || 'This Node'}</b><br>` +
      `<span style="color:#58a6ff">Self (${snap.role || 'unknown'})</span><br>` +
      `${selfLat.toFixed(5)}, ${selfLon.toFixed(5)}</div>`,
      { autoClose: false, closeOnClick: false }
    );
    m.addTo(markerLayer);
    if (popupKeyToRestore === '__self__') {
      m.openPopup();
    }
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
    m._mcPopupKey = c.pubkey;
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
    markerByPubkey[c.pubkey] = m;
    if (popupKeyToRestore && popupKeyToRestore === c.pubkey) {
      m.openPopup();
    }
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

  const isMini = H <= 100;
  const pad = isMini
    ? { l: 34, r: 10, t: 18, b: 16 }
    : { l: 46, r: 14, t: 22, b: 26 };
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
  const nGrid = isMini ? 3 : 4;
  ctx.lineWidth = 1;
  for (let i = 0; i <= nGrid; i++) {
    const y = pad.t + ph * (1 - i / nGrid);
    ctx.strokeStyle = '#1e2e52';
    ctx.setLineDash([2, 5]);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
    ctx.setLineDash([]);
    const val = yMin + yRange * (i / nGrid);
    ctx.fillStyle = '#7a8fc7';
    ctx.font = isMini ? '9px system-ui' : '10px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(
      Math.abs(val) >= 1000 ? (val / 1000).toFixed(1) + 'k' : Math.round(val),
      pad.l - 3, y + (isMini ? 3 : 3.5)
    );
  }

  // X-axis labels
  const tsMin = ts[0], tsMax = ts[ts.length - 1];
  const nXL = Math.min(isMini ? 3 : 6, ts.length);
  ctx.fillStyle = '#7a8fc7';
  ctx.font = isMini ? '9px system-ui' : '10px system-ui';
  ctx.textAlign = 'center';
  for (let i = 0; i <= nXL; i++) {
    const t = tsMin + (tsMax - tsMin) * (i / nXL);
    const x = pad.l + pw * (i / nXL);
    const d = new Date(t * 1000);
    ctx.fillText(
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      x, H - (isMini ? 4 : 7)
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
    ctx.fillRect(lx, pad.t - (isMini ? 8 : 9), isMini ? 14 : 18, 4);
    ctx.fillStyle = '#e4eeff';
    ctx.font = isMini ? '9px system-ui' : '10px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + (isMini ? 18 : 22), pad.t - 5);
    lx += Math.max(isMini ? 56 : 70, s.label.length * (isMini ? 6 : 7) + (isMini ? 22 : 28));
  }
}

// Convert a cumulative series to per-interval deltas (for traffic rate charts)
function toDelta(arr) {
  if (!arr || arr.length < 2) return arr || [];
  const out = [0];
  for (let i = 1; i < arr.length; i++) out.push(Math.max(0, (arr[i] ?? 0) - (arr[i-1] ?? 0)));
  return out;
}

function updateChartsLiveAge(ts) {
  const el = document.getElementById('charts-live-age');
  if (!el) return;
  if (!Array.isArray(ts) || !ts.length) {
    el.textContent = 'Last sample: waiting for data…';
    return;
  }
  const last = Number(ts[ts.length - 1] || 0);
  if (!Number.isFinite(last) || last <= 0) {
    el.textContent = 'Last sample: –';
    return;
  }
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(last));
  el.textContent = `Last sample: ${ageSec}s ago`;
}

function renderCharts(snap) {
  const h = app.history && app.history.ts?.length ? app.history : (snap?.history || {});
  const ts = h.ts || [];
  updateChartsLiveAge(ts);

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
  const allContacts = snap.contacts || [];
  const q = (filter || '').toLowerCase().trim();

  const visible = allContacts.filter(c => {
    if (!q) return true;
    return (c.name || '').toLowerCase().includes(q) || (c.pubkey || '').toLowerCase().includes(q);
  });

  const sortMode = app.contactSort || 'last_seen_desc';
  const sorted = [...visible].sort((a, b) => {
    const nameA = (a.name || '').toLowerCase();
    const nameB = (b.name || '').toLowerCase();
    const snrA = Number.isFinite(a.snr) ? a.snr : -9999;
    const snrB = Number.isFinite(b.snr) ? b.snr : -9999;
    const hopsA = (a.out_path_len == null || a.out_path_len >= 255) ? 999 : a.out_path_len;
    const hopsB = (b.out_path_len == null || b.out_path_len >= 255) ? 999 : b.out_path_len;
    const seenA = Number(a.last_advert_timestamp || 0);
    const seenB = Number(b.last_advert_timestamp || 0);

    if (sortMode === 'name_asc') return nameA.localeCompare(nameB) || (a.pubkey || '').localeCompare(b.pubkey || '');
    if (sortMode === 'snr_desc') return (snrB - snrA) || (seenB - seenA);
    if (sortMode === 'hops_asc') return (hopsA - hopsB) || (seenB - seenA);
    return (seenB - seenA) || nameA.localeCompare(nameB);
  });

  const byKind = {
    2: [], // Repeaters
    1: [], // Clients
    3: [], // Servers
    4: [], // Sensors
  };
  for (const c of sorted) {
    const kind = Number(c.kind || 1);
    if (byKind[kind]) byKind[kind].push(c);
  }

  const renderRows = contacts => {
    if (!contacts.length) {
      return `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:14px">No contacts</td></tr>`;
    }
    return contacts.slice(0, 250).map(c => {
      const loc = hasLoc(c) ? `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}` : '–';
      const hops = c.out_path_len;
      const hopStr = (hops === 0) ? 'Direct'
                   : (hops > 0 && hops < 255) ? `${hops} hop${hops !== 1 ? 's' : ''}` : '–';
      const snrStr = c.snr != null ? `${c.snr} dB` : '–';
      const locateBtn = hasLoc(c)
        ? `<button class="btn-sm" onclick="locateContact(${c.lat.toFixed(6)},${c.lon.toFixed(6)})">MAP</button>`
        : '';
      const removeBtn = `<button class="btn-sm btn-err" onclick="removeContact('${c.pubkey}')">Delete</button>`;
      return `<tr>
        <td>${c.name || '–'}</td>
        <td title="${c.pubkey}" style="font-family:monospace;font-size:11px">${c.pubkey.slice(0, 16)}…</td>
        <td>${loc}</td>
        <td>${snrStr}</td>
        <td>${hopStr}</td>
        <td>${fmtTime(c.last_advert_timestamp)}</td>
        <td style="white-space:nowrap">${locateBtn}${removeBtn ? ' ' + removeBtn : ''}</td>
      </tr>`;
    }).join('');
  };

  [2, 1, 3, 4].forEach(kind => {
    const tbody = document.getElementById(`contacts-body-${kind}`);
    const count = document.getElementById(`contacts-count-${kind}`);
    if (count) count.textContent = String((byKind[kind] || []).length);
    if (tbody) tbody.innerHTML = renderRows(byKind[kind] || []);
  });
}

async function removeContact(pubkey) {
  const key = String(pubkey || '').trim().toLowerCase();
  if (!key) return;
  const shortKey = key.slice(0, 16);
  if (!confirm(`Delete contact ${shortKey}?`)) return;
  const d = await sendCommand('contact_remove', { pubkey: key });
  if (!d?.ok) {
    alert(d?.error || 'Delete failed');
    return;
  }
  alert(d?.payload?.reply || `Deleted ${shortKey}`);
}

function locateContact(lat, lon) {
  switchTab('dashboard');
  setTimeout(() => mcMap.setView([lat, lon], 14), 100);
}

// ─── System Charts (dashboard) ───────────────────────
function renderSystemCharts(snap) {
  const h  = app.history && app.history.ts?.length ? app.history : (snap?.history || {});
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
  const contacts = app.snap?.contacts || [];
  const resolveName = pk => contacts.find(cx => pk && cx.pubkey.startsWith((pk||'').slice(0, 8)))?.name || null;
  const kindLabel = {1:'Client',2:'Repeater',3:'Server',4:'Sensor'};
  const evSummary = e => {
    const p = e.payload || {};
    switch (e.type) {
      case 'rx_advert': {
        const name = p.name || resolveName(p.pubkey) || (p.pubkey||'').slice(0,12)+'\u2026';
        const k = p.kind != null ? ` (${kindLabel[p.kind]||'Node'})` : '';
        const h = p.hops === 0 ? ' Direct' : p.hops > 0 ? ` ${p.hops}hop` : '';
        return name + k + h;
      }
      case 'neighbor_new': {
        const name = p.name || resolveName(p.pubkey) || (p.pubkey||'').slice(0,12)+'\u2026';
        return name + (p.snr != null ? ` SNR\u00a0${p.snr}\u00a0dB` : '');
      }
      case 'pkt_rx':
        return `+${p.count??'?'} pkt \u03a3${p.total??'?'}` +
          (p.rssi!=null ? ` RSSI\u00a0${p.rssi}` : '') +
          (p.snr !=null ? ` SNR\u00a0${p.snr}` : '');
      case 'pkt_tx':
        return `+${p.count??'?'} sent \u03a3${p.total??'?'}`;
      case 'chan_msg':
        return `[${p.channel||'?'}] ${(p.text||'').slice(0,40)}`;
      case 'contact_msg':
        return `\uD83D\uDCE8 ${p.sender||p.pubkey_prefix||'?'}: ${(p.text||'').slice(0,40)}`;
      case 'connected':   return `\u2192 ${p.host||'?'}:${p.port||'?'}`;
      case 'self_info':   return p.name || '(unnamed)';
      case 'error':       return p.message || JSON.stringify(p).slice(0,60);
      case 'config_set':  return `${p.key}=${p.value}`;
      default:
        return Object.entries(p)
          .filter(([k]) => k !== 'pubkey' && k !== 'reply')
          .map(([k,v]) => `${k}:${v}`).join(' ').slice(0, 60);
    }
  };
  list.innerHTML = recent.map(e =>
    `<li>
      <span class="ev-type">${e.type}</span>
      <span class="ev-detail" style="color:var(--muted);font-size:11px">${evSummary(e)}</span>
      <span class="ev-ts">${fmtTime(e.ts)}</span>
    </li>`
  ).join('');
}

// ─── Log Table ───────────────────────────────────────
function renderLog(events, filter = '') {
  void events;
  void filter;
  renderCombinedLog();
    requestAnimationFrame(() => adjustLogBoxSize({ keepBottom: true }));
}

// legacy function body intentionally removed
function _renderLogLegacyNoop() {
  const tbody = document.getElementById('log-body');
  if (!tbody) return;

  const catFilter = 'all';
  const categoryMatches = type => {
    if (catFilter === 'all')    return true;
    if (catFilter === 'pkt')    return type === 'pkt_rx' || type === 'pkt_tx';
    if (catFilter === 'advert') return type === 'rx_advert' || type === 'neighbor_new';
    if (catFilter === 'msgs')   return type === 'chan_msg' || type === 'contact_msg' || type === 'chan_msg_sent' || type === 'dm_sent';
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
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted)">No events</td></tr>`;
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

  // Resolve a pubkey prefix to a known contact name
  const contacts = app.snap?.contacts || [];
  const findName = pk => {
    const c = contacts.find(cx => pk && cx.pubkey.startsWith(pk.slice(0, 8)));
    return c?.name || null;
  };

  // Node / Key column: name + pubkey for events that carry an identity
  const nodeStr = e => {
    const p = e.payload || {};
    switch (e.type) {
      case 'rx_advert':
      case 'neighbor_new': {
        const name = p.name || findName(p.pubkey);
        const key  = (p.pubkey || '').slice(0, 16);
        if (name) return `<span class="log-node-name" title="${_esc(p.pubkey||'')}">${_esc(name)}</span>` +
          `<span class="log-node-key">${key}…</span>`;
        return `<span class="log-node-key" title="${_esc(p.pubkey||'')}">${key}…</span>`;
      }
      case 'contact_msg': {
        const name = p.sender || findName(p.pubkey_prefix);
        const key  = (p.pubkey_prefix || '').slice(0, 12);
        if (name) return `<span class="log-node-name">${_esc(name)}</span>` +
          `<span class="log-node-key">${key}…</span>`;
        return `<span class="log-node-key">${key}…</span>`;
      }
      case 'chan_msg':
      case 'chan_msg_sent': {
        const ch = p.channel || (p.channel_idx != null ? `ch${p.channel_idx}` : null);
        return ch ? `<span class="log-node-ch">[${_esc(ch)}]</span>` : '';
      }
      case 'dm_sent':
        return p.recipient ? `<span class="log-node-name">${_esc(p.recipient)}</span>` : '';
      default: return '';
    }
  };

  // Prefer a domain timestamp carried in payload (e.g. message timestamp)
  const eventTs = e => (e?.payload && e.payload.ts != null) ? e.payload.ts : e.ts;

  const asHex2 = n => {
    if (n == null || Number.isNaN(Number(n))) return '0x??';
    const v = Number(n) & 0xFF;
    return '0x' + v.toString(16).padStart(2, '0');
  };

  const id2 = hex => {
    const s = String(hex || '').replace(/[^0-9a-f]/ig, '').toLowerCase();
    return (s.length >= 4) ? s.slice(0, 4).toUpperCase() : '????';
  };

  const routeDF = hopsOrPathLen => {
    const n = Number(hopsOrPathLen);
    if (!Number.isFinite(n) || n < 0) return '–';
    return (n === 0) ? 'D' : 'F';
  };

  const fmtSig = p => {
    const parts = [];
    if (p?.snr != null)  parts.push(`SNR ${p.snr} dB`);
    if (p?.rssi != null) parts.push(`RSSI ${p.rssi} dBm`);
    return parts.length ? parts.join(' / ') : '–';
  };

  const findContact = pkOrPrefix => {
    const key = String(pkOrPrefix || '').toLowerCase();
    if (!key) return null;
    return contacts.find(c => (c?.pubkey || '').toLowerCase().startsWith(key.slice(0, 8))) || null;
  };

  const evHash32 = e => {
    // FNV-1a 32-bit over a short stable string (not protocol packet hash)
    const p = e?.payload || {};
    const s = `${e?.type || ''}|${p.ts ?? e?.ts ?? ''}|${p.pubkey || p.pubkey_prefix || ''}|${p.channel_idx ?? p.channel ?? ''}|${p.text || ''}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };

  const detailStr = e => {
    const p = e.payload || {};
    switch (e.type) {
      case 'pkt_rx': {
        const parts = [`+${p.count ?? '?'} pkt${(p.count ?? 1) !== 1 ? 's' : ''}`, `\u03a3 ${p.total ?? '?'}`,
          p.rssi  != null ? `RSSI\u00a0${p.rssi}\u00a0dBm` : null,
          p.snr   != null ? `SNR\u00a0${p.snr}\u00a0dB`  : null,
        ].filter(Boolean);
        return parts.join(' \u00b7 ');
      }
      case 'pkt_tx': {
        const parts = [`+${p.count ?? '?'} pkt${(p.count ?? 1) !== 1 ? 's' : ''}`, `\u03a3 ${p.total ?? '?'}`].filter(Boolean);
        return parts.join(' \u00b7 ');
      }
      case 'rx_advert': {
        const kindMap = {1:'Client',2:'Repeater',3:'Server',4:'Sensor'};
        const kindStr = p.kind != null ? `${kindMap[p.kind] || 'Node'}` : 'Node';
        const locStr  = p.lat  != null ? ` \u00b7 \uD83D\uDCCD ${p.lat.toFixed(4)}, ${p.lon?.toFixed(4)}` : '';
        const hopStr  = p.hops === 0   ? ' \u00b7 Direct' : p.hops > 0 ? ` \u00b7 ${p.hops}\u00a0hop${p.hops !== 1 ? 's' : ''}` : '';
        const snrStr  = p.snr  != null ? ` \u00b7 SNR\u00a0${p.snr}\u00a0dB` : '';
        const rssiStr = p.rssi != null ? ` \u00b7 RSSI\u00a0${p.rssi}\u00a0dBm` : '';
        const ids = `id ${id2(p.pubkey)}→ME`;
        const route = routeDF(p.hops);
        const pos = (p.lat != null && p.lon != null) ? `${p.lat.toFixed(4)},${p.lon.toFixed(4)}` : '–';
        const sig = fmtSig(p);
        return `${route} · ADV ${kindStr} · ${ids} · pos ${pos} · sig ${sig} · eh ${evHash32(e)}`;
      }
      case 'chan_msg': {
        const route = routeDF(p.path_len);
        const ch = p.channel || `ch${p.channel_idx}`;
        const size = (p.text || '').length;
        const sig = fmtSig(p);
        return `${route} · TXT ${asHex2(p.txt_type)} · ????→[${ch}] · len ${size} · path ${p.path_len ?? '–'} · sig ${sig} · ${(p.text||'').slice(0,80)} · eh ${evHash32(e)}`;
      }
      case 'chan_msg_sent': {
        const route = 'D';
        const ch = p.channel || `ch${p.channel_idx}`;
        const size = (p.text || '').length;
        return `${route} · TXT ${asHex2(0)} · ME→[${ch}] · len ${size} · ${(p.text||'').slice(0,60)} · eh ${evHash32(e)}`;
      }
      case 'dm_sent': {
        const route = 'D';
        const size = (p.text || '').length;
        const toName = p.recipient || '?';
        const toId = p.pubkey_prefix ? id2(p.pubkey_prefix) : '????';
        return `${route} · TXT ${asHex2(0)} · ME→${toName}(${toId}) · len ${size} · ${(p.text||'').slice(0,60)} · eh ${evHash32(e)}`;
      }
      case 'contact_msg': {
        const route = routeDF(p.path_len);
        const from = p.sender || p.pubkey_prefix || '?';
        const fromId = id2(p.pubkey_prefix);
        const size = (p.text || '').length;
        const sig = fmtSig(p);
        const c = findContact(p.pubkey_prefix);
        const pos = (c && hasLoc(c)) ? `${c.lat.toFixed(4)},${c.lon.toFixed(4)}` : '–';
        return `${route} · TXT ${asHex2(p.txt_type)} · ${from}(${fromId})→ME · len ${size} · path ${p.path_len ?? '–'} · pos ${pos} · sig ${sig} · ${(p.text||'').slice(0,80)} · eh ${evHash32(e)}`;
      }
      case 'neighbor_new': {
        const route = 'D';
        const name = p.name || findName(p.pubkey) || 'Neighbor';
        const pos = (p.lat != null && p.lon != null) ? `${Number(p.lat).toFixed(4)},${Number(p.lon).toFixed(4)}` : '–';
        const sig = fmtSig(p);
        return `${route} · NBR · ${name}(${id2(p.pubkey)})→ME · pos ${pos} · sig ${sig} · eh ${evHash32(e)}`;
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
      <td style="font-size:11px;color:var(--muted);white-space:nowrap">${fmtTime(eventTs(e))}</td>
      <td><span class="log-type-badge ${badgeClass(e.type)}">${e.type}</span></td>
      <td class="log-node-cell">${nodeStr(e)}</td>
      <td style="font-size:11px;font-family:monospace">${detailStr(e)}</td>
    </tr>`
  ).join('');
}

// ─── Channels ────────────────────────────────────────
function updateDmBadge() {
  const badge = document.getElementById('dm-tab-badge');
  if (!badge) return;
  const count = app.unreadDms.size;
  badge.style.display = count ? '' : 'none';
  badge.textContent   = count;
}

function updateChannelBadge() {
  const badge = document.getElementById('ch-tab-badge');
  if (!badge) return;
  const count = Object.values(app.unreadChannelCounts || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
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

// ─── Messages (DM) Tab ───────────────────────────────
function renderMessages(snap) {
  const contacts = snap.contacts || [];
  const messages = snap.messages || [];
  const listEl    = document.getElementById('dm-contact-list');
  const msgArea   = document.getElementById('dm-messages');
  const titleEl   = document.getElementById('dm-title');
  const subtitleEl = document.getElementById('dm-subtitle');
  if (!listEl || !msgArea) return;

  const query = (document.getElementById('dm-search')?.value || '').toLowerCase().trim();

  // All direct messages (inbound from contacts + outbound we sent)
  const dmMessages = messages.filter(m => m.msg_type === 'contact');

  // Most-recent DM timestamp per pubkey_prefix (12-hex = 6 bytes)
  const lastTs = {};
  dmMessages.forEach(m => {
    if (!lastTs[m.pubkey_prefix] || m.ts > lastTs[m.pubkey_prefix]) lastTs[m.pubkey_prefix] = m.ts;
  });

  // Filter + sort contacts — only users (kind=1/chat), exclude repeaters/sensors/rooms
  let filtered = contacts.filter(c => {
    if (c.kind !== 1) return false;  // skip repeaters (2), rooms (3), sensors (4)
    if (!query) return true;
    return c.name.toLowerCase().includes(query) || c.pubkey.includes(query);
  });
  filtered.sort((a, b) => {
    const ta = lastTs[a.pubkey.slice(0, 12)] || a.lastmod || 0;
    const tb = lastTs[b.pubkey.slice(0, 12)] || b.lastmod || 0;
    return tb - ta;
  });

  // Render sidebar
  listEl.innerHTML = filtered.length === 0
    ? '<li style="padding:16px;text-align:center;color:var(--muted);font-size:12px">No contacts found</li>'
    : filtered.map(c => {
        const prefix   = c.pubkey.slice(0, 12);
        const isActive = c.pubkey === app.activeDmContact;
        const unread   = app.unreadDms.has(prefix);
        const cMsgs    = dmMessages.filter(m => m.pubkey_prefix === prefix);
        const last     = cMsgs[cMsgs.length - 1];
        const lastText = last ? last.text.slice(0, 30) + (last.text.length > 30 ? '\u2026' : '') : 'No messages yet';
        const initial  = (c.name || '?')[0].toUpperCase();
        return `<li class="ch-list-item${isActive ? ' active' : ''}" data-pubkey="${_esc(c.pubkey)}" data-prefix="${_esc(prefix)}">
          <div class="ch-item-icon" style="font-size:14px;font-weight:700">${initial}</div>
          <div class="ch-item-info">
            <div class="ch-item-name">${_esc(c.name)}</div>
            <div class="ch-item-sub">${_esc(lastText)}</div>
          </div>
          ${unread ? `<div class="ch-item-badge">\u25cf</div>` : ''}
        </li>`;
      }).join('');

  // No contact selected
  if (!app.activeDmContact) {
    if (titleEl)    titleEl.textContent = 'Select a contact';
    if (subtitleEl) subtitleEl.textContent = '';
    msgArea.innerHTML = `<div class="ch-empty"><div class="ch-empty-icon">&#128172;</div>Select a contact on the left<br><small>to start a direct message conversation.</small></div>`;
    return;
  }

  const activeContact = contacts.find(c => c.pubkey === app.activeDmContact);
  const contactName   = activeContact?.name || app.activeDmContact.slice(0, 12);
  const prefix        = app.activeDmContact.slice(0, 12);
  if (titleEl)    titleEl.textContent = contactName;
  if (subtitleEl) subtitleEl.textContent = activeContact ? contactKindStr(activeContact.kind, snap.role) : '';

  const convoMsgs = dmMessages.filter(m => m.pubkey_prefix === prefix);

  if (!convoMsgs.length) {
    msgArea.innerHTML = `<div class="ch-empty"><div class="ch-empty-icon">&#128172;</div>No messages yet with ${_esc(contactName)}.<br><small>Send the first message below.</small></div>`;
    app.dmMsgCounts[prefix] = 0;
    return;
  }

  const prevCount  = app.dmMsgCounts[prefix] ?? -1;
  const gotNewMsgs = convoMsgs.length > prevCount;
  const isVisible  = msgArea.offsetHeight > 0;

  let wasAtBottom = false;
  if (isVisible) {
    const scrollable = Math.max(msgArea.scrollHeight - msgArea.clientHeight, 0);
    wasAtBottom = msgArea.scrollTop >= scrollable - 20;
    app.dmScrollPos[prefix] = msgArea.scrollTop;
  }

  msgArea.innerHTML = convoMsgs.map(m => {
    const dir       = m.outbound ? 'outbound' : 'inbound';
    const snrStr    = m.snr  != null ? `SNR ${m.snr} dB` : '';
    const hopStr    = m.path_len === 0 ? 'Direct' : m.path_len > 0 ? `${m.path_len} hop${m.path_len !== 1 ? 's' : ''}` : '';
    const metaParts = [m.outbound ? 'You' : '', fmtMsgTime(m.ts)].filter(Boolean);
    const footerParts = [hopStr, snrStr].filter(Boolean);
    let statusHtml = '';
    if (m.outbound) {
      if      (m.status === 'pending') statusHtml = '<span class="ch-status pending">&#9201; Sending\u2026</span>';
      else if (m.status === 'sent')    statusHtml = '<span class="ch-status sent">&#10003; Delivered</span>';
      else if (m.status === 'failed')  statusHtml = '<span class="ch-status failed">&#9888; Failed</span>';
    }
    return `<div class="ch-bubble ${dir}">
      <div class="ch-bubble-meta">
        ${!m.outbound ? `<span class="ch-bubble-sender">${_esc(contactName)}</span>` : ''}
        <span>${metaParts.join(' \u00b7 ')}</span>
      </div>
      <div class="ch-bubble-text">${_esc(m.text)}</div>
      ${(footerParts.length || statusHtml) ? `<div class="ch-bubble-footer">${footerParts.join(' \u00b7 ')}${statusHtml}</div>` : ''}
    </div>`;
  }).join('');

  app.dmMsgCounts[prefix] = convoMsgs.length;

  if (isVisible) {
    const firstView = !app.dmEverViewed[prefix];
    app.dmEverViewed[prefix] = true;
    if (firstView || (gotNewMsgs && wasAtBottom)) {
      msgArea.scrollTop = msgArea.scrollHeight;
    } else {
      msgArea.scrollTop = app.dmScrollPos[prefix] ?? 0;
    }
  }
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
    const unreadCount = app.unreadChannelCounts[ch.index] || 0;
    const unread = unreadCount > 0;
    const chMsgs    = messages.filter(m => m.msg_type === 'channel' && m.channel_idx === ch.index);
    const last      = chMsgs[chMsgs.length - 1];
    const lastText  = last ? last.text.slice(0, 28) + (last.text.length > 28 ? '…' : '') : 'No messages yet';
    const icon      = ch.index === 0 ? '#' : String(ch.index);
    return `<li class="ch-list-item${isActive ? ' active' : ''}${unread ? ' unread' : ''}" data-ch-idx="${ch.index}">
      <div class="ch-item-icon">${icon}</div>
      <div class="ch-item-info">
        <div class="ch-item-name${unread ? ' unread' : ''}">${_esc(ch.name)}</div>
        <div class="ch-item-sub">${_esc(lastText)}</div>
      </div>
      ${unread ? `<div class="ch-item-badge">${unreadCount}</div>` : ''}
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
  radio_bw: { label: 'Radio Bandwidth', unit: 'kHz', group: 'Radio', desc: 'From radio tuple (bw,sf,cr). Saved back into radio key.' },
  radio_sf: { label: 'Radio SF',        unit: '',    group: 'Radio', desc: 'From radio tuple (bw,sf,cr). Saved back into radio key.' },
  radio_cr: { label: 'Radio CR',        unit: '',    group: 'Radio', desc: 'From radio tuple (bw,sf,cr). Saved back into radio key.' },
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

const RADIO_SPLIT_KEYS = ['radio_bw', 'radio_sf', 'radio_cr'];

function _parseRadioTuple(raw) {
  const txt = String(raw ?? '').trim();
  if (!txt) return [];
  return txt.split(',').map(v => String(v).trim());
}

function _getRadioSplitValue(splitKey) {
  const parts = _parseRadioTuple(app.configValues?.radio);
  const hasFreq = parts.length >= 4;
  const idx = hasFreq
    ? ({ radio_bw: 1, radio_sf: 2, radio_cr: 3 }[splitKey])
    : ({ radio_bw: 0, radio_sf: 1, radio_cr: 2 }[splitKey]);
  if (idx == null) return '';
  return parts[idx] ?? '';
}

function _composeRadioTupleWithSplitValue(splitKey, value) {
  const nextVal = String(value ?? '').trim();
  const parts = _parseRadioTuple(app.configValues?.radio);
  const hasFreq = parts.length >= 4;

  if (hasFreq) {
    while (parts.length < 4) parts.push('');
    const freq = String(app.configValues?.freq ?? '').trim();
    if (freq) parts[0] = freq;
    const idx = { radio_bw: 1, radio_sf: 2, radio_cr: 3 }[splitKey];
    if (idx != null) parts[idx] = nextVal;
    return parts.join(',');
  }

  while (parts.length < 3) parts.push('');
  const idx = { radio_bw: 0, radio_sf: 1, radio_cr: 2 }[splitKey];
  if (idx != null) parts[idx] = nextVal;
  return parts.join(',');
}

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
  const renderKeys = [];
  for (const key of app.configKeys) {
    if (key === 'radio') {
      renderKeys.push(...RADIO_SPLIT_KEYS);
      continue;
    }
    renderKeys.push(key);
  }

  for (const key of renderKeys) {
    const g = CONFIG_META[key]?.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(key);
  }
  const sorted = [...GROUP_ORDER.filter(g => groups[g]), ...Object.keys(groups).filter(g => !GROUP_ORDER.includes(g))];

  container.innerHTML = sorted.map(group => {
    const rows = (groups[group] || []).map(key => {
      const meta = CONFIG_META[key];
      const raw  = RADIO_SPLIT_KEYS.includes(key)
        ? _getRadioSplitValue(key)
        : (app.configValues[key] ?? '');
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
  if (RADIO_SPLIT_KEYS.includes(key)) {
    const composed = _composeRadioTupleWithSplitValue(key, value);
    const d = await sendCommand('config_set', { key: 'radio', value: composed });
    if (d?.ok) {
      app.configValues.radio = composed;
      const parts = _parseRadioTuple(composed);
      if (parts.length >= 4 && parts[0]) {
        const freqSync = await sendCommand('config_set', { key: 'freq', value: parts[0] });
        if (freqSync?.ok) {
          app.configValues.freq = parts[0];
        }
      }
      renderConfigRows();
      setOutput('config-output', `set radio = ${composed}\n${d.payload?.reply || ''}`);
    } else {
      setOutput('config-output', `Error: ${d?.error || 'unknown'}`);
    }
    return;
  }

  const d = await sendCommand('config_set', { key, value });
  if (d?.ok) {
    app.configValues[key] = value;
    renderConfigRows();
    setOutput('config-output', `set ${key} = ${value}\n${d.payload?.reply || ''}`);
  } else {
    setOutput('config-output', `Error: ${d?.error || 'unknown'}`);
  }
}

// ─── Region Manager ──────────────────────────────────
async function refreshRegions() {
  setRegionStatus('Fetching regions…');
  const d = await sendCommand('region_refresh_full');
  if (!d?.ok) {
    setRegionStatus('Error: ' + (d?.error || '?'));
    return;
  }
  const { regions } = d.payload;
  renderRegionList(regions);
  setRegionStatus(`${regions.length} region${regions.length !== 1 ? 's' : ''} loaded`);
}

function setRegionStatus(msg) {
  const el = document.getElementById('region-status');
  if (el) el.textContent = msg;
}

function renderRegionList(regions) {
  const container = document.getElementById('region-list');
  if (!container) return;
  if (!regions || !regions.length) {
    container.innerHTML = '<div class="region-list-empty">No regions configured</div>';
    return;
  }
  // Sort: * first, then alphabetically
  const sorted = [...regions].sort((a, b) => {
    if (a.name === '*') return -1;
    if (b.name === '*') return  1;
    return a.name.localeCompare(b.name);
  });
  container.innerHTML = sorted.map(r => {
    const isWild    = r.name === '*';
    const nameDisp  = isWild ? '&#9733; * — Forward All' : _esc(r.name);
    const nameClass = 'region-row-name' + (isWild ? ' region-node-wildcard' : '');
    const allowCls  = r.flood  ? ' rfl-active' : '';
    const denyCls   = !r.flood ? ' rfl-active' : '';
    const removeBtn = isWild ? '' :
      `<button class="rfl-btn rfl-remove" data-action="remove" title="Remove region">\uD83D\uDDD1</button>`;
    return `<div class="region-row" data-region="${_esc(r.name)}">` +
      `<span class="${nameClass}">${nameDisp}</span>` +
      `<div class="region-row-actions">` +
      `<button class="rfl-btn rfl-flood-allow${allowCls}" data-action="allowf" title="Allow flood">\u2713 Flood</button>` +
      `<button class="rfl-btn rfl-flood-deny${denyCls}" data-action="denyf" title="Deny flood">\u00d7 Flood</button>` +
      `${removeBtn}` +
      `</div></div>`;
  }).join('');
}

// ─── History merge ──────────────────────────────────
// Merge incremental history points from a snapshot delta into app.history.
// If snap.history is empty or absent the accumulated history is unchanged.
function _mergeHistory(snap) {
  const h = snap?.history;
  if (!h || !h.ts || !h.ts.length) return;
  if (!app.history.ts || !app.history.ts.length) {
    // First delivery or reset — replace wholesale
    app.history = {};
    for (const k of Object.keys(h)) app.history[k] = [...(h[k] || [])];
    return;
  }
  const lastKnown = app.history.ts[app.history.ts.length - 1];
  const newIdxs = h.ts.reduce((acc, t, i) => { if (t > lastKnown) acc.push(i); return acc; }, []);
  if (!newIdxs.length) return;
  for (const k of Object.keys(h)) {
    if (!app.history[k]) app.history[k] = [];
    for (const i of newIdxs) app.history[k].push(h[k][i]);
    if (app.history[k].length > 720) app.history[k] = app.history[k].slice(-720);
  }
}

// ─── Full Render ─────────────────────────────────────
function renderAll(snap) {
  // Merge any new history points into the client-side accumulator before rendering
  _mergeHistory(snap);
  app.lastStateRenderAt = Date.now();
  const prevSnap = app.snap;
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

  // ── Map pings ──────────────────────────────────────────────────────
  // Ping markers for contacts whose advert timestamp just advanced
  if (prevSnap) {
    const prevTs = {};
    (prevSnap.contacts || []).forEach(c => { prevTs[c.pubkey] = c.last_advert_timestamp; });
    (snap.contacts || []).forEach(c => {
      if (c.last_advert_timestamp > (prevTs[c.pubkey] || 0)) pingMarker(c.pubkey);
    });
  }
  // Ping markers for fresh contact messages / outbound DMs
  const nowSec = Math.floor(Date.now() / 1000);
  (snap.events || []).forEach(ev => {
    if (ev.ts <= app.lastPingTs || ev.ts < nowSec - 10) return;
    if (ev.type === 'contact_msg' && ev.payload?.pubkey_prefix) pingMarker(ev.payload.pubkey_prefix);
    if (ev.type === 'dm_sent'    && ev.payload?.pubkey_prefix) pingMarker(ev.payload.pubkey_prefix);
  });
  app.lastPingTs = (snap.events || []).reduce((max, e) => e.ts > max ? e.ts : max, app.lastPingTs);
  // ───────────────────────────────────────────────────────────────────

  // System charts (dashboard side panel — CPU/RAM over time)
  renderSystemCharts(snap);
  updateWsStatusPanel();

  // Device info panels (companion + repeater config)
  const infoEls = [
    document.getElementById('companion-device-info'),
    document.getElementById('repeater-device-info'),
  ].filter(Boolean);
  if (infoEls.length) {
    const si = snap.self_info  || {};
    const di = snap.device_info || {};
    const settings = snap.settings || {};
    const selfPubkey = si.pubkey || si.public_key || di.pubkey || di.public_key || '–';
    const lastSyncEpoch = Number(settings.last_time_sync_epoch || 0);
    const lastSyncSource = settings.last_time_sync_source || '–';
    const lastSyncStr = lastSyncEpoch > 0
      ? `${new Date(lastSyncEpoch * 1000).toLocaleString()} (${lastSyncSource})`
      : '–';
    const infoText = [
      `Name     : ${si.name    || '–'}`,
      `Pubkey   : ${selfPubkey}`,
      `Model    : ${di.model   || '–'}`,
      `Firmware : ${di.version || '–'}`,
      `Freq     : ${si.radio_freq_khz  ? (si.radio_freq_khz / 1000).toFixed(3) + ' MHz' : '–'}`,
      `TX Power : ${si.tx_power_db != null ? si.tx_power_db + ' dB' : '–'}`,
      `Last Sync: ${lastSyncStr}`,
    ].join('\n');
    infoEls.forEach((el) => { el.textContent = infoText; });
  }

  const autoSyncToggle = document.getElementById('auto-sync-time-toggle');
  if (autoSyncToggle) {
    const enabled = app.autoSyncTimePending === null
      ? !!snap?.settings?.auto_sync_time
      : !!app.autoSyncTimePending;
    autoSyncToggle.checked = enabled;
  }

  const msgDbStatsEl = document.getElementById('msg-db-stats');
  if (msgDbStatsEl) {
    const settings = snap.settings || {};
    const maxMsgs = Number(settings.message_store_max || 0);
    const countMsgs = Number(settings.message_store_count || 0);
    const payloadBytes = Number(settings.message_store_payload_bytes || 0);
    const diskBytes = Number(settings.message_store_disk_bytes || 0);
    msgDbStatsEl.textContent = [
      `Stored    : ${countMsgs}${maxMsgs > 0 ? ` / ${maxMsgs}` : ''}`,
      `Payload   : ${fmtBytes(payloadBytes)}`,
      `DB on disk: ${fmtBytes(diskBytes)}`,
    ].join('\n');
    const input = document.querySelector('#msg-db-form input[name="max_messages"]');
    if (input && document.activeElement !== input && maxMsgs > 0) {
      input.value = String(maxMsgs);
    }
  }

  const radioFreqInput = document.querySelector('#cfg-radio-form input[name="freq_mhz"]');
  const radioBwInput = document.querySelector('#cfg-radio-form input[name="bw_khz"]');
  const radioSfInput = document.querySelector('#cfg-radio-form-2 input[name="sf"]');
  const radioCrInput = document.querySelector('#cfg-radio-form-2 input[name="cr"]');
  if (radioFreqInput && document.activeElement !== radioFreqInput) {
    const freqKhz = Number(si.radio_freq_khz || 0);
    if (freqKhz > 0) radioFreqInput.value = (freqKhz / 1000).toFixed(3);
  }
  if (radioBwInput && document.activeElement !== radioBwInput) {
    const bwKhz = Number(si.radio_bw_khz || 0);
    if (bwKhz > 0) radioBwInput.value = String(bwKhz / 1000);
  }
  if (radioSfInput && document.activeElement !== radioSfInput) {
    const sf = Number(si.radio_sf || 0);
    if (sf > 0) radioSfInput.value = String(sf);
  }
  if (radioCrInput && document.activeElement !== radioCrInput) {
    const cr = Number(si.radio_cr || 0);
    if (cr > 0) radioCrInput.value = String(cr);
  }

  // Events sidebar
  renderEvents(snap.events || []);

  // Tab-specific renders
  if (app.activeTab === 'charts')   renderCharts(snap);
  if (app.activeTab === 'stats') {
    if ((Date.now() - app.headerStatsLastFetch) > 2500 && !app.headerStatsFetching) {
      refreshPacketStats();
    }
    renderPacketStats(app.headerStats);
  }
  if (app.activeTab === 'contacts') renderContacts(snap, document.getElementById('contact-search')?.value || '');
  if (app.activeTab === 'logs')     renderCombinedLog();
  if (app.activeTab === 'channels') renderChannels(snap);
  if (app.activeTab === 'messages') renderMessages(snap);

  // Region list: sync from pushed state when on config tab
  if (app.activeTab === 'config' && snap.regions?.length) {
    renderRegionList(snap.regions);
  }

  // Track new messages and update the tab badge (even off-tab)
  const msgs = snap.messages || [];
  if (msgs.length > app.lastMsgCount) {
    const newMsgs = msgs.slice(app.lastMsgCount);
    newMsgs.forEach(m => {
      if (m.msg_type === 'channel' && !m.outbound) {
        const isCurrentlyViewed = app.activeTab === 'channels' && app.activeChannel === m.channel_idx;
        if (!isCurrentlyViewed) {
          app.unreadChannelCounts[m.channel_idx] = (app.unreadChannelCounts[m.channel_idx] || 0) + 1;
        }
      }
      if (m.msg_type === 'contact' && !m.outbound && app.activeTab !== 'messages') {
        app.unreadDms.add(m.pubkey_prefix);
      }
    });
    app.lastMsgCount = msgs.length;
    updateChannelBadge();
    updateDmBadge();
  }

  renderFooter(snap);
}

// ─── Wire UI ─────────────────────────────────────────
function wireUi() {
  initPaneResizers();

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

  // Contacts search + sorting
  document.getElementById('contact-search')?.addEventListener('input', e => {
    if (app.snap) renderContacts(app.snap, e.target.value);
  });
  document.getElementById('contact-sort')?.addEventListener('change', e => {
    app.contactSort = String(e.target?.value || 'last_seen_desc');
    if (app.snap) renderContacts(app.snap, document.getElementById('contact-search')?.value || '');
  });

  // Log filter + log type filter buttons
  document.getElementById('log-filter')?.addEventListener('input', () => renderCombinedLog());
  document.getElementById('log-route-filter')?.addEventListener('change', () => renderCombinedLog());
  document.getElementById('log-payload-filter')?.addEventListener('change', () => renderCombinedLog());

  document.getElementById('btn-rxlog-clear')?.addEventListener('click', () => {
    app.latestRxLogText = '';
    app.latestRxLogLines = [];
    renderCombinedLog();
    adjustLogBoxSize({ keepBottom: true });
  });

  document.getElementById('rxlog-live-scroll')?.addEventListener('change', e => {
    app.rxlogLiveScroll = e.target.checked;
    if (app.rxlogLiveScroll) {
      adjustLogBoxSize({ keepBottom: true });
    }
  });

  document.getElementById('auto-sync-time-toggle')?.addEventListener('change', async e => {
    const enabled = !!e.target.checked;
    app.autoSyncTimePending = enabled;
    const d = await sendCommand('set_auto_sync_time', { enabled });
    if (d?.ok) {
      app.autoSyncTimePending = null;
      setOutput('auto-sync-time-output', enabled
        ? '✓ Auto-Sync Time enabled. Device time will sync from Raspberry Pi on connect/boot.'
        : 'Auto-Sync Time disabled.');
      return;
    }
    app.autoSyncTimePending = null;
    setOutput('auto-sync-time-output', `Error: ${d?.error || 'unknown'}`);
    e.target.checked = !enabled;
  });

  document.getElementById('msg-db-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const raw = new FormData(e.target).get('max_messages');
    const maxMessages = parseInt(raw, 10);
    if (!Number.isFinite(maxMessages) || maxMessages < 50 || maxMessages > 50000) {
      setOutput('msg-db-stats', 'Invalid value. Use 50..50000 messages.');
      return;
    }
    const d = await sendCommand('set_message_store_max', { max_messages: maxMessages });
    if (!d?.ok) {
      setOutput('msg-db-stats', `Error: ${d?.error || 'unknown'}`);
      return;
    }
    const p = d.payload || {};
    setOutput('msg-db-stats', [
      `Stored    : ${p.message_store_count || 0} / ${p.message_store_max || maxMessages}`,
      `DB on disk: ${fmtBytes(p.message_store_disk_bytes || 0)}`,
    ].join('\n'));
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => adjustLogBoxSize(), 40);
  });

  // Helper: lock all identity buttons during an async operation
  function _identityBusy(flag) {
    ['btn-identity-load', 'btn-identity-renew-public', 'btn-identity-regenerate'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = flag;
    });
    const submit = document.querySelector('#identity-key-form button[type="submit"]');
    if (submit) submit.disabled = flag;
  }

  document.getElementById('identity-key-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const key = new FormData(e.target).get('private_key')?.trim().toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(key || '')) {
      setOutput('identity-key-output', 'Invalid key format. Expected 128 hex chars.');
      return;
    }
    _identityBusy(true);
    setOutput('identity-key-output', 'Applying key to device…');
    const d = await sendCommand('identity_set_key', { private_key: key });
    _identityBusy(false);
    const payload = d?.payload || {};
    setOutput('identity-key-output', d?.ok
      ? (payload.message || payload.reply || 'Private key update queued.')
      : `Error: ${d?.error || 'unknown'}`);
    if (d?.ok) e.target.reset();
  });

  document.getElementById('btn-identity-load')?.addEventListener('click', async () => {
    _identityBusy(true);
    setOutput('identity-key-output', 'Reading key from device…');
    const d = await sendCommand('identity_load_key');
    _identityBusy(false);
    const payload = d?.payload || {};
    if (!d?.ok) {
      setOutput('identity-key-output', `Error: ${d?.error || 'unknown'}`);
      return;
    }
    const key = String(payload.private_key || '').toLowerCase();
    const input = document.querySelector('#identity-key-form input[name="private_key"]');
    if (input && /^[0-9a-f]{128}$/.test(key)) {
      input.value = key;
    }
    const pub = payload.pubkey ? ` Public: ${payload.pubkey.slice(0, 16)}…` : '';
    setOutput('identity-key-output', `${payload.message || 'Loaded current private key.'}${pub}`);
  });

  document.getElementById('btn-identity-renew-public')?.addEventListener('click', async () => {
    if (!confirm('Generate and apply a new keypair to renew the public key?')) return;
    _identityBusy(true);
    setOutput('identity-key-output', 'Generating keypair and applying to device… (this may take a few seconds)');
    const d = await sendCommand('identity_renew_public_key');
    _identityBusy(false);
    const payload = d?.payload || {};
    const pub = payload.new_pubkey ? ` New public key: ${payload.new_pubkey.slice(0, 16)}…` : '';
    setOutput('identity-key-output', d?.ok
      ? `${payload.message || 'Public key renewal queued.'}${pub}`
      : `Error: ${d?.error || 'unknown'}`);
  });

  document.getElementById('btn-identity-regenerate')?.addEventListener('click', async () => {
    if (!confirm('Generate and apply a new identity key now?')) return;
    _identityBusy(true);
    setOutput('identity-key-output', 'Generating new identity key and applying to device… (this may take a few seconds)');
    const d = await sendCommand('identity_regenerate');
    _identityBusy(false);
    const payload = d?.payload || {};
    const pub = payload.new_pubkey ? ` New public key: ${payload.new_pubkey.slice(0, 16)}…` : '';
    setOutput('identity-key-output', d?.ok
      ? `${payload.message || payload.reply || 'New key generated and queued.'}${pub}`
      : `Error: ${d?.error || 'unknown'}`);
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

  // ── Region panel ──────────────────────────────────────
  document.getElementById('refresh-regions-btn')?.addEventListener('click', refreshRegions);
  document.getElementById('save-regions-btn')?.addEventListener('click', async () => {
    const d = await sendCommand('region_save');
    setRegionStatus(d?.payload?.reply || 'Saved.');
  });

  // Region add form toggle
  document.getElementById('btn-region-add-open')?.addEventListener('click', () => {
    const f = document.getElementById('region-add-form');
    if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('btn-region-add-cancel')?.addEventListener('click', () => {
    const f = document.getElementById('region-add-form');
    if (f) f.style.display = 'none';
  });

  // Add region form submit
  document.getElementById('region-put-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd   = new FormData(e.target);
    const name = fd.get('name')?.trim();
    const flood = fd.get('flood') === 'on';
    if (!name) return;
    setRegionStatus(`Creating ${name}…`);
    const d = await sendCommand('region_put', { name });
    if (d?.ok) {
      await sendCommand(flood ? 'region_allowf' : 'region_denyf', { name });
    }
    setRegionStatus(d?.payload?.reply || (d?.error ? `Error: ${d.error}` : `Region ${name} created`));
    e.target.reset();
    document.getElementById('region-add-form').style.display = 'none';
    await refreshRegions();
  });

  // Inline region row actions (delegated)
  document.getElementById('region-list')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = btn.closest('[data-region]');
    if (!row) return;
    const regionName = row.dataset.region;
    const action = btn.dataset.action;
    if (action === 'allowf') {
      const d = await sendCommand('region_allowf', { name: regionName });
      setRegionStatus(d?.payload?.reply || `Flood allowed: ${regionName}`);
      await refreshRegions();
    } else if (action === 'denyf') {
      const d = await sendCommand('region_denyf', { name: regionName });
      setRegionStatus(d?.payload?.reply || `Flood denied: ${regionName}`);
      await refreshRegions();
    } else if (action === 'remove') {
      if (!confirm(`Remove region "${regionName}"?`)) return;
      const d = await sendCommand('region_remove', { name: regionName });
      setRegionStatus(d?.payload?.reply || `Removed: ${regionName}`);
      await refreshRegions();
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

  const submitCompanionRadio = async () => {
    const freqInput = document.querySelector('#cfg-radio-form input[name="freq_mhz"]');
    const bwInput = document.querySelector('#cfg-radio-form input[name="bw_khz"]');
    const sfInput = document.querySelector('#cfg-radio-form-2 input[name="sf"]');
    const crInput = document.querySelector('#cfg-radio-form-2 input[name="cr"]');

    const freqMhz = parseFloat(freqInput?.value || '');
    const bwKhz = parseFloat(bwInput?.value || '');
    const sf = parseInt(sfInput?.value || '', 10);
    const cr = parseInt(crInput?.value || '', 10);

    if (!isFinite(freqMhz) || !isFinite(bwKhz) || !Number.isFinite(sf) || !Number.isFinite(cr)) {
      setOutput('companion-cfg-output', 'Invalid radio params. Use freq MHz, bw kHz, sf 5..12, cr 5..8.');
      return;
    }

    const d = await sendCommand('set_radio_params', { freq_mhz: freqMhz, bw_khz: bwKhz, sf, cr });
    setOutput('companion-cfg-output', d?.ok
      ? `✓ Radio set: ${freqMhz.toFixed(3)} MHz, ${bwKhz} kHz, SF${sf}, CR${cr}`
      : `Error: ${d?.error || 'unknown'}`);
  };

  document.getElementById('cfg-radio-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    await submitCompanionRadio();
  });

  document.getElementById('cfg-radio-form-2')?.addEventListener('submit', async e => {
    e.preventDefault();
    await submitCompanionRadio();
  });

  document.getElementById('btn-advert-cfg')?.addEventListener('click', async () => {
    const d = await sendCommand('advert');
    setOutput('companion-cfg-output', d?.ok ? '✓ Advert sent' : `Error: ${d?.error}`);
  });

  document.getElementById('btn-sync-time-cfg')?.addEventListener('click', async () => {
    const d = await sendCommand('sync_time');
    setOutput('companion-cfg-output', d?.ok ? `✓ Time synced: ${new Date().toLocaleString()}` : `Error: ${d?.error}`);
  });

  document.querySelectorAll('[data-copy-pubkey]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const snap = app.snap || {};
      const si = snap.self_info || {};
      const di = snap.device_info || {};
      const pubkey = String(si.pubkey || si.public_key || di.pubkey || di.public_key || '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
        setOutput('companion-cfg-output', 'No valid public key available yet. Try Refresh.');
        return;
      }
      try {
        await navigator.clipboard.writeText(pubkey.toLowerCase());
        setOutput('companion-cfg-output', '✓ Public key copied to clipboard');
      } catch (err) {
        setOutput('companion-cfg-output', `Clipboard error: ${err?.message || err}`);
      }
    });
  });

  // ── Messages (DM) tab ─────────────────────────────────
  // Contact list click (delegated)
  document.getElementById('dm-contact-list')?.addEventListener('click', e => {
    const item = e.target.closest('[data-pubkey]');
    if (!item) return;
    app.activeDmContact = item.dataset.pubkey;
    app.unreadDms.delete(item.dataset.prefix);
    updateDmBadge();
    if (app.snap) renderMessages(app.snap);
  });

  // Contact search
  document.getElementById('dm-search')?.addEventListener('input', () => {
    if (app.snap) renderMessages(app.snap);
  });

  // DM send form
  document.getElementById('dm-send-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!app.activeDmContact) return;
    const input = document.getElementById('dm-input');
    const text  = input?.value.trim();
    if (!text) return;
    input.value    = '';
    input.disabled = true;
    await sendCommand('send_direct_msg', { pubkey: app.activeDmContact, text });
    input.disabled = false;
    input.focus();
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
    delete app.unreadChannelCounts[idx];
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

// Debounce rapid-fire WS state bursts (e.g. stat responses arriving in quick
// succession) into a single renderAll() per animation frame.  At most one render
// per ~16 ms regardless of how many WS messages arrive simultaneously.
let _pendingSnap = null;
let _renderPending = false;
function _scheduleRenderAll(snap) {
  _pendingSnap = snap;
  if (!_renderPending) {
    _renderPending = true;
    requestAnimationFrame(() => {
      _renderPending = false;
      if (_pendingSnap) renderAll(_pendingSnap);
    });
  }
}

function _handleRealtimeEvent(msg) {
  if (!msg || typeof msg !== 'object') return;
  _recordWsLatencyFromEvent(msg);
  if (msg.type === 'state' && msg.payload) {
    _scheduleRenderAll(msg.payload);
    return;
  }
  if (msg.type === 'rxlog_lines') {
    _appendRxLogLines(msg.payload?.lines || []);
    if (app.activeTab === 'logs') {
      renderCombinedLog();
      if (app.rxlogLiveScroll) {
        const out = document.getElementById('combined-log-output');
        if (out) out.scrollTop = out.scrollHeight;
      }
      adjustLogBoxSize();
    }
  }
}

function initPaneResizers() {
  const resizers = document.querySelectorAll('.pane-resizer');
  if (!resizers.length) return;

  const initialized = new Set();
  resizers.forEach(resizer => {
    const cssVar = resizer.dataset.resizeVar;
    const key = resizer.dataset.resizeKey;
    const min = Number(resizer.dataset.resizeMin || '180');
    const max = Number(resizer.dataset.resizeMax || '900');
    if (!cssVar || !key || initialized.has(key)) return;
    const saved = Number(window.localStorage.getItem(key));
    if (Number.isFinite(saved)) {
      const width = Math.max(min, Math.min(max, saved));
      document.documentElement.style.setProperty(cssVar, `${width}px`);
    }
    initialized.add(key);
  });

  resizers.forEach(resizer => {
    resizer.addEventListener('pointerdown', ev => {
      if (window.matchMedia('(max-width: 900px)').matches) return;
      const cssVar = resizer.dataset.resizeVar;
      const key = resizer.dataset.resizeKey;
      const anchor = (resizer.dataset.resizeAnchor || 'left').toLowerCase();
      const min = Number(resizer.dataset.resizeMin || '180');
      const max = Number(resizer.dataset.resizeMax || '900');
      if (!cssVar || !key) return;

      ev.preventDefault();
      resizer.classList.add('is-dragging');
      const layout = resizer.parentElement;
      if (!layout) return;
      const layoutRect = layout.getBoundingClientRect();

      const onMove = moveEv => {
        const raw = anchor === 'right'
          ? (layoutRect.right - moveEv.clientX - 11)
          : (moveEv.clientX - layoutRect.left - 11);
        const width = Math.max(min, Math.min(max, Math.round(raw)));
        document.documentElement.style.setProperty(cssVar, `${width}px`);
        window.localStorage.setItem(key, String(width));
      };

      const onUp = () => {
        resizer.classList.remove('is-dragging');
        const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
        const px = Number(String(value).replace('px', '').trim());
        if (Number.isFinite(px)) {
          window.localStorage.setItem(key, String(px));
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  });
}

function connectWebSocket() {
  if (app.ws && (app.ws.readyState === WebSocket.OPEN || app.ws.readyState === WebSocket.CONNECTING)) return;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${window.location.host}/ws`;
  const ws = new WebSocket(url);
  app.ws = ws;

  ws.onopen = () => {
    app.wsConnected = true;
    clearTimeout(app.wsRetryTimer);
    updateWsStatusPanel();
  };

  ws.onmessage = evt => {
    app.wsRxCount += 1;
    app.wsLastMsgAt = Date.now();
    try {
      const msg = JSON.parse(evt.data);
      _handleRealtimeEvent(msg);
    } catch (_) {}
    updateWsStatusPanel();
  };

  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };

  ws.onclose = () => {
    app.wsConnected = false;
    if (app.ws === ws) app.ws = null;
    clearTimeout(app.wsRetryTimer);
    app.wsRetryTimer = setTimeout(connectWebSocket, 2000);
    updateWsStatusPanel();
  };
}

// ─── Boot ────────────────────────────────────────────
(async function init() {
  wireUi();
  adjustLogBoxSize();
  updateWsStatusPanel();

  // Initial state via REST fallback
  try {
    const snap = await fetch('/api/state').then(r => r.json());
    renderAll(snap);
    // Load initial HW stats
    sendCommand('get_hardware_stats').then(d => { if (d?.ok && d.payload) updateHwStats(d.payload); });
  } catch (e) {
    console.log('Initial state fetch failed, waiting for WebSocket');
  }

  // Periodic HW stats refresh (every 30s)
  setInterval(() => {
    sendCommand('get_hardware_stats').then(d => { if (d?.ok && d.payload) updateHwStats(d.payload); });
  }, 30000);

  setInterval(updateWsStatusPanel, 1000);

  connectWebSocket();
})();
