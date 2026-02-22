const state = { snapshot: null, markers: new Map() };

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
  if (pubForm) pubForm.style.display = role === 'companion' ? 'grid' : 'none';
  if (syncBtn) syncBtn.style.display = 'inline-block';

  renderStatus(snapshot);
  renderContacts(snapshot);
  renderEvents(snapshot);
  renderMap(snapshot);
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
