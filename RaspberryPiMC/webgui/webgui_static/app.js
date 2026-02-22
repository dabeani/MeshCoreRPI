const state = {
  snapshot: null,
  markers: new Map(),
  configKeys: [],
  configValues: {},
  configLoaded: false,
  configLoading: false,
};

const map = L.map('map', { zoomControl: true }).setView([47.4, 8.5], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

async function sendCommand(name, args = {}) {
  const resp = await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  const data = await resp.json();
  if (!data.ok) {
    alert(data.error || `Command failed: ${name}`);
  }
  return data;
}

function fmtTime(epochOrSec) {
  if (!epochOrSec) return '-';
  const v = epochOrSec > 1e12 ? epochOrSec : epochOrSec * 1000;
  return new Date(v).toLocaleString();
}

function hasLoc(c) {
  return Number.isFinite(c.lat) && Number.isFinite(c.lon) && (Math.abs(c.lat) > 0.00001 || Math.abs(c.lon) > 0.00001);
}

function renderStatus(s) {
  const role = s.role || 'companion';
  const connected = s.connected ? '<span class="badge ok">connected</span>' : '<span class="badge err">disconnected</span>';
  const core = s.stats.core || {};
  const radio = s.stats.radio || {};
  const packets = s.stats.packets || {};
  const selfInfo = s.self_info || {};
  const batteryMv = s.battery?.battery_mv || core.battery_mv || 0;
  const roleLabel = role === 'repeater' ? 'Repeater Bridge' : 'Companion Link';

  const cards = role === 'repeater'
    ? [
      [roleLabel, connected],
      ['Node Name', selfInfo.name || '-'],
      ['Driver', s.device_info?.model || '-'],
      ['Version', s.device_info?.version || '-'],
      ['Battery (mV)', batteryMv || '-'],
      ['Uptime (s)', core.uptime_secs || 0],
      ['CPU / RAM %', `${core.cpu_usage_pct ?? '-'} / ${core.mem_usage_pct ?? '-'}`],
      ['RSSI / SNR', `${radio.last_rssi ?? '-'} / ${radio.last_snr ?? '-'}`],
      ['TX / RX Packets', `${packets.sent ?? 0} / ${packets.recv ?? 0}`],
      ['Queue Len', core.queue_len ?? '-'],
    ]
    : [
      [roleLabel, connected],
      ['Node Name', selfInfo.name || '-'],
      ['Model', s.device_info?.model || '-'],
      ['Firmware', s.device_info?.version || '-'],
      ['Battery (mV)', batteryMv || '-'],
      ['Uptime (s)', core.uptime_secs || 0],
      ['RSSI / SNR', `${radio.last_rssi ?? '-'} / ${radio.last_snr ?? '-'}`],
      ['TX / RX Packets', `${packets.sent ?? 0} / ${packets.recv ?? 0}`],
      ['Queue Len', core.queue_len ?? '-'],
      ['Noise Floor', radio.noise_floor ?? '-'],
    ];

  document.getElementById('status-grid').innerHTML = cards
    .map(([k, v]) => `<div class="stat"><div class="label">${k}</div><div class="value">${v}</div></div>`)
    .join('');
}

function renderContacts(s) {
  const role = s.role || 'companion';
  const contacts = s.contacts || [];
  const tbody = document.getElementById('contacts-body');
  if (role === 'repeater') {
    tbody.innerHTML = contacts
      .slice(0, 120)
      .map((c) => `<tr>
        <td>${c.name || '-'}</td>
        <td>Neighbor</td>
        <td>${c.pubkey}</td>
        <td>-</td>
        <td>${fmtTime(c.last_advert_timestamp)}</td>
      </tr>`)
      .join('');
    return;
  }

  tbody.innerHTML = contacts
    .slice(0, 120)
    .map((c) => `<tr>
      <td>${c.name || '-'}</td>
      <td>${c.kind}</td>
      <td>${c.pubkey.slice(0, 14)}…</td>
      <td>${hasLoc(c) ? `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}` : '-'}</td>
      <td>${fmtTime(c.last_advert_timestamp)}</td>
    </tr>`)
    .join('');
}

function renderEvents(s) {
  const events = (s.events || []).slice(-40).reverse();
  document.getElementById('events-list').innerHTML = events
    .map((e) => `<li><strong>${e.type}</strong> · ${fmtTime(e.ts)}</li>`)
    .join('');
}

function payloadToText(payload) {
  if (payload == null) return '(empty)';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function setOutput(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

function renderConfigRows() {
  const tbody = document.getElementById('config-rows');
  if (!tbody) return;
  if (!state.configKeys.length) {
    tbody.innerHTML = '<tr><td colspan="4">No config keys loaded.</td></tr>';
    return;
  }
  tbody.innerHTML = state.configKeys
    .map((key) => {
      const value = state.configValues[key] ?? '';
      return `<tr>
        <td>${key}</td>
        <td>${String(value).replace(/</g, '&lt;')}</td>
        <td><input data-config-input="${key}" value="${String(value).replace(/"/g, '&quot;')}" /></td>
        <td><button type="button" data-config-set="${key}">Set</button></td>
      </tr>`;
    })
    .join('');
}

async function loadRepeaterConfig() {
  if (state.configLoading) return;
  state.configLoading = true;
  try {
    const schema = await sendCommand('config_schema');
    const values = await sendCommand('config_get_all');
    state.configKeys = schema?.payload?.all_keys || [];
    state.configValues = values?.payload?.values || {};
    state.configLoaded = true;
    renderConfigRows();
    setOutput('config-output', 'Loaded MeshCore config keys and values.');
  } finally {
    state.configLoading = false;
  }
}

async function refreshRegions() {
  const dump = await sendCommand('region_dump');
  const allowed = await sendCommand('regions_allowed');
  const denied = await sendCommand('regions_denied');
  const home = await sendCommand('region_home_get');
  const text = [
    '=== HOME ===',
    home?.payload?.reply || '-',
    '',
    '=== TREE ===',
    dump?.payload?.reply || '-',
    '',
    '=== ALLOWED ===',
    allowed?.payload?.reply || '-',
    '',
    '=== DENIED ===',
    denied?.payload?.reply || '-',
  ].join('\n');
  setOutput('region-output', text);
}

async function setConfigKey(key, value) {
  const data = await sendCommand('config_set', { key, value });
  if (data?.ok) {
    state.configValues[key] = value;
    renderConfigRows();
    setOutput('config-output', `set ${key} => ${value}\n${payloadToText(data.payload)}`);
  }
}

function drawMetricsChart(snapshot) {
  const canvas = document.getElementById('metrics-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 800;
  const height = canvas.clientHeight || 160;
  if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const role = snapshot.role || 'companion';
  const history = snapshot.history || {};
  const x = history.ts || [];
  const theme = getComputedStyle(document.documentElement);
  const cAccent = (theme.getPropertyValue('--accent') || '#58a6ff').trim();
  const cOk = (theme.getPropertyValue('--ok') || '#2ecc71').trim();
  const cWarn = (theme.getPropertyValue('--warn') || '#f4c430').trim();
  const cErr = (theme.getPropertyValue('--err') || '#ff6b6b').trim();
  const cMuted = (theme.getPropertyValue('--muted') || '#90a2cc').trim();
  if (x.length < 2) {
    ctx.fillStyle = cMuted;
    ctx.font = '12px system-ui';
    ctx.fillText('Collecting metrics…', 12, 24);
    return;
  }

  const pad = { left: 28, right: 12, top: 10, bottom: 18 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const tsMin = x[0];
  const tsMax = x[x.length - 1];
  const tsSpan = Math.max(1, tsMax - tsMin);

  const series = role === 'repeater'
    ? [
      { key: 'rx', color: cAccent, label: 'RX' },
      { key: 'tx', color: cOk, label: 'TX' },
      { key: 'queue', color: cWarn, label: 'Queue' },
      { key: 'cpu', color: cErr, label: 'CPU%' },
    ]
    : [
      { key: 'rx', color: cAccent, label: 'RX' },
      { key: 'tx', color: cOk, label: 'TX' },
      { key: 'rssi', color: cWarn, label: 'RSSI' },
      { key: 'snr', color: cErr, label: 'SNR' },
    ];

  let yMax = 1;
  for (const s of series) {
    const arr = history[s.key] || [];
    for (const v of arr) {
      if (Number.isFinite(v)) yMax = Math.max(yMax, Math.abs(v));
    }
  }

  ctx.strokeStyle = cMuted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + plotH);
  ctx.lineTo(pad.left + plotW, pad.top + plotH);
  ctx.stroke();

  for (const s of series) {
    const arr = history[s.key] || [];
    if (arr.length !== x.length || arr.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < x.length; i += 1) {
      const xv = pad.left + ((x[i] - tsMin) / tsSpan) * plotW;
      const norm = Math.max(-1, Math.min(1, (arr[i] || 0) / yMax));
      const yv = pad.top + plotH - ((norm + 1) / 2) * plotH;
      if (i === 0) ctx.moveTo(xv, yv);
      else ctx.lineTo(xv, yv);
    }
    ctx.stroke();
  }

  ctx.fillStyle = cMuted;
  ctx.font = '11px system-ui';
  const legends = series.map((s) => s.label).join(' · ');
  ctx.fillText(legends, pad.left + 4, pad.top + 12);
}

function renderMap(s) {
  const alive = new Set();

  const selfInfo = s.self_info || {};
  const selfHasLoc = Number.isFinite(selfInfo.adv_lat) && Number.isFinite(selfInfo.adv_lon)
    && (Math.abs(selfInfo.adv_lat) > 0.00001 || Math.abs(selfInfo.adv_lon) > 0.00001);

  if (selfHasLoc) {
    const id = 'self';
    alive.add(id);
    let m = state.markers.get(id);
    if (!m) {
      m = L.marker([selfInfo.adv_lat, selfInfo.adv_lon], { title: 'This Node' }).addTo(map);
      state.markers.set(id, m);
    } else {
      m.setLatLng([selfInfo.adv_lat, selfInfo.adv_lon]);
    }
    m.bindPopup(`<b>This node</b><br>${selfInfo.name || 'MeshCore'}`);
  }

  const role = s.role || 'companion';
  for (const c of (s.contacts || [])) {
    if (role === 'repeater') continue;
    if (!hasLoc(c)) continue;
    const id = c.pubkey;
    alive.add(id);
    let m = state.markers.get(id);
    if (!m) {
      m = L.circleMarker([c.lat, c.lon], { radius: 7, weight: 2 }).addTo(map);
      state.markers.set(id, m);
    } else {
      m.setLatLng([c.lat, c.lon]);
    }
    m.bindPopup(`<b>${c.name || c.pubkey.slice(0, 8)}</b><br>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}<br>Type: ${c.kind}`);
  }

  for (const [id, marker] of state.markers.entries()) {
    if (!alive.has(id)) {
      marker.remove();
      state.markers.delete(id);
    }
  }

  if (state.markers.size > 0) {
    const group = L.featureGroup([...state.markers.values()]);
    map.fitBounds(group.getBounds().pad(0.25), { maxZoom: 12 });
  }
}

function render(snapshot) {
  state.snapshot = snapshot;
  const role = snapshot.role || 'companion';
  const roleTitle = role === 'repeater' ? 'MeshCore Repeater Web GUI' : 'MeshCore Companion Web GUI';
  document.title = roleTitle;
  document.getElementById('role-subtitle').textContent = role === 'repeater'
    ? 'Repeater live dashboard'
    : 'Companion live dashboard';

  const pubForm = document.getElementById('pub-form');
  const syncBtn = document.querySelector('[data-cmd="sync_time"]');
  const repeaterTools = document.getElementById('repeater-tools');
  if (pubForm) pubForm.style.display = role === 'companion' ? 'grid' : 'none';
  if (syncBtn) syncBtn.style.display = 'inline-block';
  if (repeaterTools) repeaterTools.style.display = role === 'repeater' ? 'block' : 'none';

  if (role === 'repeater' && !state.configLoaded) {
    loadRepeaterConfig().catch((err) => setOutput('config-output', String(err)));
    refreshRegions().catch((err) => setOutput('region-output', String(err)));
  }

  renderStatus(snapshot);
  renderContacts(snapshot);
  renderEvents(snapshot);
  renderMap(snapshot);
  drawMetricsChart(snapshot);
}

function wireUi() {
  document.querySelectorAll('[data-cmd]').forEach((b) => {
    b.addEventListener('click', () => sendCommand(b.dataset.cmd));
  });

  document.getElementById('name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    if (name) await sendCommand('set_name', { name });
  });

  document.getElementById('loc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const lat = parseFloat(e.target.elements.lat.value);
    const lon = parseFloat(e.target.elements.lon.value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      await sendCommand('set_location', { lat, lon });
    }
  });

  document.getElementById('pub-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = e.target.elements.msg.value.trim();
    if (text) {
      await sendCommand('public_msg', { text, channel: 0 });
      e.target.reset();
    }
  });

  const neighborForm = document.getElementById('neighbor-form');
  if (neighborForm) {
    neighborForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pubkeyPrefix = e.target.elements.pubkey_prefix.value.trim();
      if (pubkeyPrefix) {
        await sendCommand('neighbor_remove', { pubkey_prefix: pubkeyPrefix });
        e.target.reset();
      }
    });
  }

  const configRows = document.getElementById('config-rows');
  if (configRows) {
    configRows.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-config-set]');
      if (!btn) return;
      const key = btn.dataset.configSet;
      const input = configRows.querySelector(`input[data-config-input="${CSS.escape(key)}"]`);
      if (!input) return;
      const value = input.value.trim();
      if (!value) return;
      await setConfigKey(key, value);
    });
  }

  const loadConfigBtn = document.getElementById('load-config-btn');
  if (loadConfigBtn) {
    loadConfigBtn.addEventListener('click', async () => {
      await loadRepeaterConfig();
    });
  }

  const saveConfigBtn = document.getElementById('save-config-btn');
  if (saveConfigBtn) {
    saveConfigBtn.addEventListener('click', async () => {
      const data = await sendCommand('config_save');
      setOutput('config-output', payloadToText(data?.payload));
    });
  }

  const configSetForm = document.getElementById('config-set-form');
  if (configSetForm) {
    configSetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = e.target.elements.key.value.trim();
      const value = e.target.elements.value.value.trim();
      if (!key || !value) return;
      await setConfigKey(key, value);
      e.target.reset();
    });
  }

  const refreshRegionsBtn = document.getElementById('refresh-regions-btn');
  if (refreshRegionsBtn) {
    refreshRegionsBtn.addEventListener('click', async () => {
      await refreshRegions();
    });
  }

  const saveRegionsBtn = document.getElementById('save-regions-btn');
  if (saveRegionsBtn) {
    saveRegionsBtn.addEventListener('click', async () => {
      const data = await sendCommand('region_save');
      setOutput('region-output', payloadToText(data?.payload));
      await refreshRegions();
    });
  }

  const regionHomeForm = document.getElementById('region-home-form');
  if (regionHomeForm) {
    regionHomeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      if (!name) return;
      const data = await sendCommand('region_home_set', { name });
      setOutput('region-output', payloadToText(data?.payload));
      await refreshRegions();
      e.target.reset();
    });
  }

  const regionPutForm = document.getElementById('region-put-form');
  if (regionPutForm) {
    regionPutForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      const parent = e.target.elements.parent.value.trim();
      if (!name) return;
      const data = await sendCommand('region_put', { name, parent });
      setOutput('region-output', payloadToText(data?.payload));
      await refreshRegions();
      e.target.reset();
    });
  }

  const regionRemoveForm = document.getElementById('region-remove-form');
  if (regionRemoveForm) {
    regionRemoveForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      if (!name) return;
      const data = await sendCommand('region_remove', { name });
      setOutput('region-output', payloadToText(data?.payload));
      await refreshRegions();
      e.target.reset();
    });
  }

  const regionFlagForm = document.getElementById('region-flag-form');
  if (regionFlagForm) {
    regionFlagForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = e.target.elements.mode.value;
      const name = e.target.elements.name.value.trim();
      if (!name) return;
      const cmd = mode === 'denyf' ? 'region_denyf' : 'region_allowf';
      const data = await sendCommand(cmd, { name });
      setOutput('region-output', payloadToText(data?.payload));
      await refreshRegions();
      e.target.reset();
    });
  }

  const regionGetForm = document.getElementById('region-get-form');
  if (regionGetForm) {
    regionGetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      if (!name) return;
      const data = await sendCommand('region_get', { name });
      setOutput('region-output', payloadToText(data?.payload));
    });
  }

  const regionLoadForm = document.getElementById('region-load-form');
  if (regionLoadForm) {
    regionLoadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      const flood = e.target.elements.flood.checked;
      if (!name) return;
      const data = await sendCommand('region_load_named', { name, flood_flag: flood ? 'F' : '' });
      setOutput('region-output', payloadToText(data?.payload));
      await refreshRegions();
      e.target.reset();
    });
  }

  const rawForm = document.getElementById('raw-form');
  if (rawForm) {
    rawForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cmd = e.target.elements.cmd.value.trim();
      if (!cmd) return;
      const data = await sendCommand('raw', { cmd });
      const output = document.getElementById('raw-output');
      if (output) {
        const reply = data?.payload?.reply || '(no output)';
        output.textContent = `$ ${cmd}\n${reply}`;
      }
    });
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'state' && msg.payload) {
      render(msg.payload);
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 1500);
  };
}

(async function init() {
  wireUi();
  const snapshot = await fetch('/api/state').then((r) => r.json());
  render(snapshot);
  connectEvents();
})();
