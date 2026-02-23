#!/usr/bin/env python3

from __future__ import annotations

import argparse
import errno
import json
import os
import queue
import re
import socket
import struct
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

CMD_APP_START = 1
CMD_SEND_TXT_MSG = 2
CMD_SEND_CHANNEL_TXT_MSG = 3
CMD_GET_CONTACTS = 4
CMD_SET_DEVICE_TIME = 6
CMD_SEND_SELF_ADVERT = 7
CMD_SET_ADVERT_NAME = 8
CMD_SYNC_NEXT_MESSAGE = 10
CMD_SET_ADVERT_LATLON = 14
CMD_GET_BATT_AND_STORAGE = 20
CMD_DEVICE_QUERY = 22
CMD_GET_STATS = 56
CMD_GET_CHANNEL = 0x1F
CMD_SET_CHANNEL = 0x20

STATS_TYPE_CORE = 0
STATS_TYPE_RADIO = 1
STATS_TYPE_PACKETS = 2

RESP_CODE_OK = 0x00
RESP_CODE_CONTACT = 3
RESP_CODE_SELF_INFO = 5
RESP_CODE_MSG_SENT = 0x06
RESP_CODE_CONTACT_MSG = 0x07
RESP_CODE_CHANNEL_MSG = 0x08
RESP_CODE_NO_MORE_MSGS = 0x0A
RESP_CODE_BATT_AND_STORAGE = 12
RESP_CODE_DEVICE_INFO = 13
RESP_CODE_CONTACT_MSG_V3 = 0x10
RESP_CODE_CHANNEL_MSG_V3 = 0x11
RESP_CODE_CHANNEL_INFO = 0x12
RESP_CODE_STATS = 24

PUSH_CODE_ADVERT = 0x80
PUSH_CODE_MSG_WAITING = 0x83
PUSH_CODE_LOG_RX_DATA = 0x88
PUSH_CODE_NEW_ADVERT = 0x8A

APP_NAME = b"mc-webgui"
_FLOAT_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")
_CONFIG_KEY_RE = re.compile(r"^[a-zA-Z0-9._-]+$")
_REGION_NAME_RE = re.compile(r"^[#*a-zA-Z0-9._-]+$")
_RX_HEADER_RE = re.compile(r"RX,.*\(type=(\d+),\s*route=([A-Za-z])(?:,\s*route_code=(\d+))?")

REPEATER_CONFIG_KEYS: dict[str, list[str]] = {
    "radio": [
        "radio",
        "freq",
        "tx",
    ],
    "system": [
        "name",
        "lat",
        "lon",
        "password",
        "guest.password",
        "owner.info",
        "adc.multiplier",
    ],
    "routing": [
        "repeat",
        "txdelay",
        "direct.txdelay",
        "rxdelay",
        "af",
        "int.thresh",
        "agc.reset.interval",
        "multi.acks",
        "flood.advert.interval",
        "advert.interval",
        "flood.max",
    ],
    "acl": [
        "allow.read.only",
    ],
}


def _decode_cstr(raw: bytes) -> str:
    return raw.split(b"\x00", 1)[0].decode("utf-8", errors="ignore").strip()


def _parse_json_text(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    if isinstance(parsed, dict):
        return parsed
    return {}


def _extract_float(value: str) -> float | None:
    match = _FLOAT_RE.search(value)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _require_safe_config_key(value: str) -> str:
    key = value.strip()
    if not key or not _CONFIG_KEY_RE.fullmatch(key):
        raise ValueError("invalid config key")
    return key


def _require_safe_region_name(value: str) -> str:
    name = value.strip()
    if not name or not _REGION_NAME_RE.fullmatch(name):
        raise ValueError("invalid region name")
    return name


def _require_cli_value(value: Any) -> str:
    text = str(value).strip()
    if not text:
        raise ValueError("value is required")
    if "\n" in text or "\r" in text:
        raise ValueError("value must be a single line")
    return text


def _packet_log_candidate_paths() -> list[Path]:
    roots: list[Path] = []
    env_root = os.getenv("MESHCORE_DATA_DIR", "").strip()
    if env_root:
        roots.append(Path(env_root))
    roots.append(Path("/var/lib/raspberrypimc/userdata"))
    roots.append(Path.cwd() / "RaspberryPiMC" / "userdata")
    roots.append(Path(__file__).resolve().parent.parent / "userdata")
    paths: list[Path] = []
    for root in roots:
        paths.append(root / "packet_log")
    return paths


def _read_packet_log_tail(lines: int, max_bytes: int = 64 * 1024) -> str:
    lines = max(10, min(5000, int(lines)))
    for p in _packet_log_candidate_paths():
        try:
            if not p.exists() or not p.is_file():
                continue
            size = p.stat().st_size
            if size <= 0:
                return "-empty-"
            start = max(0, size - max_bytes)
            with p.open("rb") as f:
                if start > 0:
                    f.seek(start)
                data = f.read()
            if start > 0:
                nl = data.find(b"\n")
                if nl >= 0:
                    data = data[nl + 1 :]
            try:
                text = data.decode("utf-8", errors="replace")
            except Exception:
                text = data.decode("latin-1", errors="replace")
            if lines <= 0:
                return text
            parts = text.splitlines()
            return "\n".join(parts[-lines:])
        except OSError:
            continue
    return "-none-"


def _append_packet_log_line(line: str) -> None:
    text = str(line).strip()
    if not text:
        return
    for p in _packet_log_candidate_paths():
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            with p.open("a", encoding="utf-8", errors="replace") as f:
                f.write(text)
                f.write("\n")
            return
        except OSError:
            continue


def _compute_packet_header_breakdown_from_text(text: str, source: str = "") -> dict[str, Any]:
    transport_payload_types = {0x00, 0x01, 0x08}  # REQ, RESP, PATH
    routing = {
        "transport_flood": 0,
        "flood": 0,
        "direct": 0,
        "transport_direct": 0,
    }
    payload = {
        "req": 0,
        "resp": 0,
        "txt": 0,
        "ack": 0,
        "advert": 0,
        "path": 0,
    }
    code_to_payload = {
        0x00: "req",
        0x01: "resp",
        0x02: "txt",
        0x03: "ack",
        0x04: "advert",
        0x08: "path",
    }
    total_rx = 0

    for line in str(text or "").splitlines():
        m = _RX_HEADER_RE.search(line)
        if not m:
            continue
        try:
            ptype = int(m.group(1))
        except ValueError:
            continue
        route_ch = m.group(2).upper()
        route_code_raw = m.group(3)
        route_code: int | None = None
        if route_code_raw is not None:
            try:
                route_code = int(route_code_raw)
            except ValueError:
                route_code = None

        total_rx += 1

        payload_key = code_to_payload.get(ptype)
        if payload_key:
            payload[payload_key] += 1

        if route_code is not None and 0 <= route_code <= 3:
            if route_code == 0:
                routing["transport_flood"] += 1
            elif route_code == 1:
                routing["flood"] += 1
            elif route_code == 2:
                routing["direct"] += 1
            elif route_code == 3:
                routing["transport_direct"] += 1
        else:
            is_transport = ptype in transport_payload_types
            if route_ch == "F":
                routing["transport_flood" if is_transport else "flood"] += 1
            elif route_ch == "D":
                routing["transport_direct" if is_transport else "direct"] += 1

    return {
        "routing": routing,
        "payload": payload,
        "total_rx": total_rx,
        "source": source,
    }


def _compute_packet_header_breakdown(max_bytes: int = 4 * 1024 * 1024) -> dict[str, Any]:
    empty = _compute_packet_header_breakdown_from_text("", source="")

    for p in _packet_log_candidate_paths():
        try:
            if not p.exists() or not p.is_file():
                continue
            size = p.stat().st_size
            if size <= 0:
                empty["source"] = str(p)
                return empty

            start = max(0, size - max_bytes)
            with p.open("rb") as f:
                if start > 0:
                    f.seek(start)
                data = f.read()

            if start > 0:
                nl = data.find(b"\n")
                if nl >= 0:
                    data = data[nl + 1 :]

            text = data.decode("utf-8", errors="replace")
            return _compute_packet_header_breakdown_from_text(text, source=str(p))
        except OSError:
            continue

    return {
        "routing": empty["routing"],
        "payload": empty["payload"],
        "total_rx": empty["total_rx"],
        "source": "",
    }


@dataclass
class Contact:
    pubkey: str
    kind: int
    flags: int
    out_path_len: int
    name: str
    last_advert_timestamp: int
    lat: float | None
    lon: float | None
    lastmod: int
    snr: float | None = None   # SNR in dB (populated for repeater neighbors)


class MeshState:
    def __init__(self, role: str) -> None:
        self._lock = threading.Lock()
        self.role = role
        self.started_at = int(time.time())
        self.last_frame_at = 0.0
        self.connected = False
        self.self_info: dict[str, Any] = {}
        self.device_info: dict[str, Any] = {}
        self.battery: dict[str, Any] = {}
        self.stats: dict[str, Any] = {"core": {}, "radio": {}, "packets": {}}
        self.contacts: dict[str, Contact] = {}
        self.channels: list[dict[str, Any]] = []  # index 0-7, each: {index, name, active}
        self.messages: list[dict[str, Any]] = []  # received channel+contact messages
        self.regions: list[dict[str, Any]] = []   # parsed [{name, parent, flood, home}]
        self.events: list[dict[str, Any]] = []
        self.history: dict[str, list[float | int]] = {
            "ts": [],
            "rx": [],
            "tx": [],
            "drop": [],
            "queue": [],
            "rssi": [],
            "snr": [],
            "noise_floor": [],
            "cpu": [],
            "mem": [],
        }

    def set_connected(self, connected: bool) -> None:
        with self._lock:
            self.connected = connected

    def update_last_frame(self) -> None:
        with self._lock:
            self.last_frame_at = time.time()

    def add_event(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        with self._lock:
            item = {
                "ts": int(time.time()),
                "type": event_type,
                "payload": payload or {},
            }
            self.events.append(item)
            if len(self.events) > 200:
                self.events = self.events[-200:]

    def upsert_contact(self, contact: Contact) -> None:
        with self._lock:
            self.contacts[contact.pubkey] = contact

    def replace_contacts(self, contacts: list[Contact]) -> None:
        with self._lock:
            self.contacts = {c.pubkey: c for c in contacts}

    def touch_contact_advert(self, pubkey: str) -> None:
        with self._lock:
            if pubkey in self.contacts:
                self.contacts[pubkey].last_advert_timestamp = int(time.time())

    def add_history_sample(self, sample: dict[str, float | int]) -> None:
        with self._lock:
            for key in self.history.keys():
                if key in sample:
                    self.history[key].append(sample[key])

            max_points = 720
            for key in self.history.keys():
                if len(self.history[key]) > max_points:
                    self.history[key] = self.history[key][-max_points:]

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            contacts = [
                {
                    "pubkey": c.pubkey,
                    "kind": c.kind,
                    "flags": c.flags,
                    "out_path_len": c.out_path_len,
                    "name": c.name,
                    "last_advert_timestamp": c.last_advert_timestamp,
                    "lat": c.lat,
                    "lon": c.lon,
                    "lastmod": c.lastmod,
                    "snr": c.snr,
                }
                for c in self.contacts.values()
            ]
            contacts.sort(key=lambda c: c["lastmod"], reverse=True)
            return {
                "role": self.role,
                "started_at": self.started_at,
                "connected": self.connected,
                "last_frame_at": self.last_frame_at,
                "self_info": self.self_info,
                "device_info": self.device_info,
                "battery": self.battery,
                "stats": self.stats,
                "contacts": contacts,
                "channels": list(self.channels),
                "messages": list(self.messages[-300:]),
                "regions": list(self.regions),
                "events": list(self.events[-100:]),
                "history": {k: list(v) for k, v in self.history.items()},
            }


class EventBus:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: set[queue.Queue[dict[str, Any]]] = set()

    def subscribe(self) -> queue.Queue[dict[str, Any]]:
        q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=256)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: queue.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass


class CompanionClient:
    def __init__(self, host: str, port: int, state: MeshState, bus: EventBus) -> None:
        self.host = host
        self.port = port
        self.state = state
        self.bus = bus
        self.sock: socket.socket | None = None
        self.recv_buf = bytearray()
        self.send_lock = threading.Lock()
        self.stop_event = threading.Event()
        self._pending_ack_ids: list[str] = []  # msg_ids awaiting RESP_CODE_MSG_SENT

    def _frame_out(self, payload: bytes) -> bytes:
        return b"<" + struct.pack("<H", len(payload)) + payload

    def send_cmd(self, payload: bytes) -> None:
        if not payload or len(payload) > 255:
            return
        frame = self._frame_out(payload)
        with self.send_lock:
            if self.sock is None:
                return
            try:
                self.sock.sendall(frame)
            except OSError:
                self._close()

    def _close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        self.recv_buf.clear()
        self.state.set_connected(False)

    def _connect(self) -> bool:
        if self.sock is not None:
            return True
        try:
            sock = socket.create_connection((self.host, self.port), timeout=1.0)
            sock.setblocking(False)
            self.sock = sock
            self.state.set_connected(True)
            self._bootstrap()
            self.state.add_event("connected", {"host": self.host, "port": self.port})
            self.bus.publish({"type": "connected", "ts": int(time.time())})
            return True
        except OSError:
            self.sock = None
            self.state.set_connected(False)
            return False

    def _bootstrap(self) -> None:
        # CMD_APP_START expects 7 reserved bytes, then app name starting at offset 8.
        app_name = APP_NAME.ljust(16, b"\x00")
        self.send_cmd(bytes([CMD_APP_START]) + (b"\x00" * 7) + app_name)
        self.send_cmd(bytes([CMD_DEVICE_QUERY, 0x03]))
        self.send_cmd(bytes([CMD_GET_BATT_AND_STORAGE]))
        self.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_CORE]))
        self.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_RADIO]))
        self.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_PACKETS]))
        self.send_cmd(bytes([CMD_GET_CONTACTS]))
        # Fetch all channel slots (0-7)
        for idx in range(8):
            self.send_cmd(bytes([CMD_GET_CHANNEL, idx]))
        # Pull any queued messages
        self.send_cmd(bytes([CMD_SYNC_NEXT_MESSAGE]))

    def _parse_channel_info(self, payload: bytes) -> None:
        if len(payload) < 2:
            return
        idx = payload[1]
        name = _decode_cstr(payload[2:34]) if len(payload) > 2 else ""
        # Check if it's the public channel (all-zeros secret region => index 0 with no name is public)
        if idx == 0 and not name:
            name = "#public"
        with self.state._lock:
            # Replace or insert channel entry
            channels = [c for c in self.state.channels if c["index"] != idx]
            if name:  # non-empty = active channel slot
                channels.append({"index": idx, "name": name, "active": True})
                channels.sort(key=lambda c: c["index"])
            self.state.channels = channels

    def _parse_channel_msg(self, payload: bytes) -> None:
        """Parse RESP_CODE_CHANNEL_MSG (0x08) and RESP_CODE_CHANNEL_MSG_V3 (0x11)."""
        if len(payload) < 8:
            return
        ptype = payload[0]
        snr: float | None = None
        off = 1
        if ptype == RESP_CODE_CHANNEL_MSG_V3:  # V3: 1 byte SNR + 2 reserved
            snr_raw = payload[off]
            snr = (snr_raw if snr_raw < 128 else snr_raw - 256) / 4.0
            off += 3
        channel_idx = payload[off]
        path_len = payload[off + 1]
        txt_type = payload[off + 2]
        ts = struct.unpack_from("<I", payload, off + 3)[0]
        text_bytes = payload[off + 7:]
        text = text_bytes.decode("utf-8", errors="replace")
        hop_str = "Direct" if path_len == 0 else (f"{path_len} hop{'s' if path_len != 1 else ''}" if path_len < 255 else "–")
        msg = {
            "msg_type": "channel",
            "channel_idx": channel_idx,
            "path_len": path_len,
            "hop_str": hop_str,
            "txt_type": txt_type,
            "ts": ts,
            "text": text,
            "snr": snr,
        }
        with self.state._lock:
            self.state.messages.append(msg)
            if len(self.state.messages) > 500:
                self.state.messages = self.state.messages[-500:]
        # Resolve channel name for event
        ch_name = next((c["name"] for c in self.state.channels if c["index"] == channel_idx), f"ch{channel_idx}")
        self.state.add_event(
            "chan_msg",
            {
                "channel_idx": channel_idx,
                "channel": ch_name,
                "text": text[:80],
                "path_len": path_len,
                "txt_type": txt_type,
                "snr": snr,
                "ts": ts,
            },
        )

    def _parse_contact_msg(self, payload: bytes) -> None:
        """Parse RESP_CODE_CONTACT_MSG (0x07) and RESP_CODE_CONTACT_MSG_V3 (0x10)."""
        if len(payload) < 15:
            return
        ptype = payload[0]
        snr: float | None = None
        off = 1
        if ptype == RESP_CODE_CONTACT_MSG_V3:
            snr_raw = payload[off]
            snr = (snr_raw if snr_raw < 128 else snr_raw - 256) / 4.0
            off += 3
        pubkey_prefix = payload[off:off + 6].hex()
        path_len = payload[off + 6]
        txt_type = payload[off + 7]
        ts = struct.unpack_from("<I", payload, off + 8)[0]
        text_off = off + 12
        if txt_type == 2:
            text_off += 4  # skip 4-byte signature
        text = payload[text_off:].decode("utf-8", errors="replace")
        # Resolve sender name
        contact = self.state.contacts.get(pubkey_prefix) or next(
            (c for k, c in self.state.contacts.items() if k.startswith(pubkey_prefix)), None
        )
        sender = contact.name if contact else pubkey_prefix
        hop_str = "Direct" if path_len == 0 else (f"{path_len} hop{'s' if path_len != 1 else ''}" if path_len < 255 else "–")
        msg = {
            "msg_type": "contact",
            "sender": sender,
            "pubkey_prefix": pubkey_prefix,
            "path_len": path_len,
            "hop_str": hop_str,
            "txt_type": txt_type,
            "ts": ts,
            "text": text,
            "snr": snr,
        }
        with self.state._lock:
            self.state.messages.append(msg)
            if len(self.state.messages) > 500:
                self.state.messages = self.state.messages[-500:]
        self.state.add_event(
            "contact_msg",
            {
                "sender": sender,
                "pubkey_prefix": pubkey_prefix,
                "text": text[:80],
                "path_len": path_len,
                "txt_type": txt_type,
                "snr": snr,
                "ts": ts,
            },
        )

    def _parse_contact(self, payload: bytes) -> None:
        if len(payload) < 148:
            return
        pubkey_raw = payload[1:33]
        pubkey = pubkey_raw.hex()
        kind = payload[33]
        flags = payload[34]
        out_path_len = payload[35]
        name = _decode_cstr(payload[100:132])
        last_advert_ts = struct.unpack_from("<I", payload, 132)[0]
        lat_i = struct.unpack_from("<i", payload, 136)[0]
        lon_i = struct.unpack_from("<i", payload, 140)[0]
        lastmod = struct.unpack_from("<I", payload, 144)[0]
        contact = Contact(
            pubkey=pubkey,
            kind=kind,
            flags=flags,
            out_path_len=out_path_len,
            name=name or pubkey[:12],
            last_advert_timestamp=last_advert_ts,
            lat=lat_i / 1_000_000.0,
            lon=lon_i / 1_000_000.0,
            lastmod=lastmod,
        )
        self.state.upsert_contact(contact)

    def _parse_self_info(self, payload: bytes) -> None:
        if len(payload) < 58:
            return
        info = {
            "adv_type": payload[1],
            "tx_power": payload[2],
            "max_tx_power": payload[3],
            "public_key": payload[4:36].hex(),
            "adv_lat": struct.unpack_from("<i", payload, 36)[0] / 1_000_000.0,
            "adv_lon": struct.unpack_from("<i", payload, 40)[0] / 1_000_000.0,
            "multi_acks": payload[44],
            "adv_loc_policy": payload[45],
            "telemetry_mode": payload[46],
            "manual_add_contacts": payload[47],
            "radio_freq_khz": struct.unpack_from("<I", payload, 48)[0],
            "radio_bw_khz": struct.unpack_from("<I", payload, 52)[0],
            "radio_sf": payload[56],
            "radio_cr": payload[57],
            "name": _decode_cstr(payload[58:]) if len(payload) > 58 else "",
        }
        self.state.self_info = info
        self.state.add_event("self_info", {"name": info.get("name", "")})

    def _parse_device_info(self, payload: bytes) -> None:
        if len(payload) < 2:
            return
        fw_ver = payload[1]
        info: dict[str, Any] = {"fw_ver": fw_ver}
        if fw_ver >= 3 and len(payload) >= 80:
            info.update(
                {
                    "max_contacts": payload[2] * 2,
                    "max_channels": payload[3],
                    "ble_pin": struct.unpack_from("<I", payload, 4)[0],
                    "fw_build": _decode_cstr(payload[8:20]),
                    "model": _decode_cstr(payload[20:60]),
                    "version": _decode_cstr(payload[60:80]),
                }
            )
        self.state.device_info = info

    def _parse_battery(self, payload: bytes) -> None:
        if len(payload) < 3:
            return
        batt_mv = struct.unpack_from("<H", payload, 1)[0]
        data: dict[str, Any] = {"battery_mv": batt_mv}
        if len(payload) >= 11:
            data["used_kb"] = struct.unpack_from("<I", payload, 3)[0]
            data["total_kb"] = struct.unpack_from("<I", payload, 7)[0]
        self.state.battery = data

    def _parse_stats(self, payload: bytes) -> None:
        if len(payload) < 2:
            return
        subtype = payload[1]
        if subtype == STATS_TYPE_CORE and len(payload) >= 11:
            self.state.stats["core"] = {
                "battery_mv": struct.unpack_from("<H", payload, 2)[0],
                "uptime_secs": struct.unpack_from("<I", payload, 4)[0],
                "errors": struct.unpack_from("<H", payload, 8)[0],
                "queue_len": payload[10],
            }
        elif subtype == STATS_TYPE_RADIO and len(payload) >= 14:
            self.state.stats["radio"] = {
                "noise_floor": struct.unpack_from("<h", payload, 2)[0],
                "last_rssi": struct.unpack_from("<b", payload, 4)[0],
                "last_snr": struct.unpack_from("<b", payload, 5)[0] / 4.0,
                "tx_air_secs": struct.unpack_from("<I", payload, 6)[0],
                "rx_air_secs": struct.unpack_from("<I", payload, 10)[0],
            }
        elif subtype == STATS_TYPE_PACKETS and len(payload) >= 30:
            self.state.stats["packets"] = {
                "recv": struct.unpack_from("<I", payload, 2)[0],
                "sent": struct.unpack_from("<I", payload, 6)[0],
                "flood_tx": struct.unpack_from("<I", payload, 10)[0],
                "direct_tx": struct.unpack_from("<I", payload, 14)[0],
                "flood_rx": struct.unpack_from("<I", payload, 18)[0],
                "direct_rx": struct.unpack_from("<I", payload, 22)[0],
                "recv_errors": struct.unpack_from("<I", payload, 26)[0],
            }

    def _handle_payload(self, payload: bytes) -> None:
        if not payload:
            return
        payload_type = payload[0]
        self.state.update_last_frame()
        if payload_type == RESP_CODE_CONTACT:
            self._parse_contact(payload)
        elif payload_type == PUSH_CODE_NEW_ADVERT:
            self._parse_contact(payload)
            if len(payload) >= 33:
                pubkey = payload[1:33].hex()
                # Include rich data in event so log shows name + location
                contact = self.state.contacts.get(pubkey)
                event_data: dict[str, Any] = {"pubkey": pubkey}
                if contact:
                    event_data["name"] = contact.name
                    if contact.lat is not None and (abs(contact.lat) > 0.0001 or abs(contact.lon or 0) > 0.0001):
                        event_data["lat"] = round(contact.lat, 6)
                        event_data["lon"] = round(contact.lon or 0, 6)
                    event_data["kind"] = contact.kind
                    event_data["hops"] = contact.out_path_len
                # Best-effort signal (last radio stats sample; may not be per-advert)
                radio = self.state.stats.get("radio", {})
                try:
                    if "last_rssi" in radio:
                        event_data["rssi"] = int(radio.get("last_rssi"))
                    if "last_snr" in radio:
                        event_data["snr"] = float(radio.get("last_snr"))
                except Exception:
                    pass
                self.state.add_event("rx_advert", event_data)
        elif payload_type == RESP_CODE_SELF_INFO:
            self._parse_self_info(payload)
        elif payload_type == RESP_CODE_DEVICE_INFO:
            self._parse_device_info(payload)
        elif payload_type == RESP_CODE_BATT_AND_STORAGE:
            self._parse_battery(payload)
        elif payload_type == RESP_CODE_STATS:
            self._parse_stats(payload)
        elif payload_type == RESP_CODE_CHANNEL_INFO:
            self._parse_channel_info(payload)
        elif payload_type in (RESP_CODE_CHANNEL_MSG, RESP_CODE_CHANNEL_MSG_V3):
            self._parse_channel_msg(payload)
        elif payload_type in (RESP_CODE_CONTACT_MSG, RESP_CODE_CONTACT_MSG_V3):
            self._parse_contact_msg(payload)
            # Fetch the next queued message automatically
            self.send_cmd(bytes([CMD_SYNC_NEXT_MESSAGE]))
        elif payload_type == RESP_CODE_MSG_SENT:
            # Acknowledge oldest pending outbound message
            if self._pending_ack_ids:
                ack_id = self._pending_ack_ids.pop(0)
                with self.state._lock:
                    for m in reversed(self.state.messages):
                        if m.get("msg_id") == ack_id:
                            m["status"] = "sent"
                            break
        elif payload_type == RESP_CODE_NO_MORE_MSGS:
            pass  # No more queued messages — nothing to do
        elif payload_type == PUSH_CODE_ADVERT and len(payload) >= 33:
            self.state.touch_contact_advert(payload[1:33].hex())
        elif payload_type == PUSH_CODE_LOG_RX_DATA and len(payload) >= 4:
            snr = (payload[1] if payload[1] < 128 else payload[1] - 256) / 4.0
            rssi = payload[2] if payload[2] < 128 else payload[2] - 256
            raw = payload[3:]
            if raw:
                header = raw[0]
                route_code = header & 0x03
                payload_type_code = (header >> 2) & 0x0F
                route_char = "D" if route_code in (2, 3) else "F"
                _append_packet_log_line(
                    f"{time.strftime('%H:%M:%S')}: RX, len={len(raw)} "
                    f"(type={payload_type_code}, route={route_char}, route_code={route_code}, payload_len=0) "
                    f"SNR={snr:.2f} RSSI={rssi}"
                )
        elif payload_type == PUSH_CODE_MSG_WAITING:
            self.send_cmd(bytes([CMD_SYNC_NEXT_MESSAGE]))
        self.bus.publish({"type": "state", "payload": self.state.snapshot(), "ts": int(time.time())})

    def _recv(self) -> None:
        assert self.sock is not None
        while True:
            try:
                chunk = self.sock.recv(4096)
                if not chunk:
                    self._close()
                    return
                self.recv_buf.extend(chunk)
            except OSError as ex:
                if ex.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    break
                self._close()
                return

        while len(self.recv_buf) >= 3:
            frame_type = self.recv_buf[0]
            frame_len = self.recv_buf[1] | (self.recv_buf[2] << 8)
            total = 3 + frame_len
            if len(self.recv_buf) < total:
                return
            payload = bytes(self.recv_buf[3:total])
            del self.recv_buf[:total]
            if frame_type == ord(">"):
                self._handle_payload(payload)

    def run(self) -> None:
        poll_counter = 0
        while not self.stop_event.is_set():
            if self._connect():
                self._recv()
                poll_counter += 1
                if poll_counter % 40 == 0:
                    # Expire outbound messages that never received an ACK (>15 s)
                    now_ts = int(time.time())
                    expired_any = False
                    with self.state._lock:
                        for m in self.state.messages:
                            if m.get("outbound") and m.get("status") == "pending" and now_ts - m.get("ts", now_ts) > 15:
                                m["status"] = "failed"
                                expired_any = True
                    if expired_any:
                        self.bus.publish({"type": "state", "payload": self.state.snapshot(), "ts": now_ts})
                    self.send_cmd(bytes([CMD_GET_BATT_AND_STORAGE]))
                    self.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_CORE]))
                    self.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_RADIO]))
                    self.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_PACKETS]))
                    # Add periodic history sample for companion mode
                    radio = self.state.stats.get("radio", {})
                    packets = self.state.stats.get("packets", {})
                    core = self.state.stats.get("core", {})
                    if radio or packets or core:
                        self.state.add_history_sample({
                            "ts": int(time.time()),
                            "rx": int(packets.get("recv", 0)),
                            "tx": int(packets.get("sent", 0)),
                            "drop": int(packets.get("recv_errors", 0)),
                            "queue": int(core.get("queue_len", 0)),
                            "rssi": float(radio.get("last_rssi", 0.0)),
                            "snr": float(radio.get("last_snr", 0.0)),
                            "noise_floor": float(radio.get("noise_floor", 0.0)),
                            "cpu": 0.0,
                            "mem": 0.0,
                        })
                if poll_counter % 200 == 0:
                    self.send_cmd(bytes([CMD_GET_CONTACTS]))
            time.sleep(0.25)

    def stop(self) -> None:
        self.stop_event.set()
        self._close()


class RepeaterClient:
    def __init__(self, host: str, port: int, state: MeshState, bus: EventBus) -> None:
        self.host = host
        self.port = port
        self.state = state
        self.bus = bus
        self.sock: socket.socket | None = None
        self.recv_buf = bytearray()
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self._prev_rx: int = 0
        self._prev_tx: int = 0
        self._logging_started = False

    def _close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        self.recv_buf.clear()
        self.state.set_connected(False)

    def _connect(self) -> bool:
        if self.sock is not None:
            return True
        try:
            sock = socket.create_connection((self.host, self.port), timeout=1.0)
            sock.settimeout(2.0)
            self.sock = sock
            self.state.set_connected(True)
            self.state.add_event("connected", {"host": self.host, "port": self.port})
            self.bus.publish({"type": "connected", "ts": int(time.time())})
            self._logging_started = False
            return True
        except OSError:
            self._close()
            return False

    def _recv_line(self) -> str:
        assert self.sock is not None
        while True:
            idx = self.recv_buf.find(b"\n")
            if idx >= 0:
                raw = bytes(self.recv_buf[:idx])
                del self.recv_buf[: idx + 1]
                return raw.decode("utf-8", errors="ignore").strip()
            chunk = self.sock.recv(1024)
            if not chunk:
                raise ConnectionError("repeater bridge disconnected")
            self.recv_buf.extend(chunk)

    def send_cli_command(self, command: str) -> str:
        command = command.strip()
        if not command:
            return ""
        with self.lock:
            if not self._connect():
                raise ConnectionError("unable to connect repeater bridge")
            assert self.sock is not None
            try:
                self.sock.sendall(command.encode("utf-8") + b"\n")
                line = self._recv_line()
                payload = _parse_json_text(line)
                if payload:
                    self.state.update_last_frame()
                    reply_str = str(payload.get("reply", ""))
                    # Strip CLI prompt artifact, e.g. "> 869.525" → "869.525"
                    if reply_str.startswith("> "):
                        reply_str = reply_str[2:]
                    return reply_str.strip()
                return line.strip()
            except (OSError, ConnectionError, socket.timeout) as ex:
                self._close()
                raise ConnectionError(str(ex)) from ex

    def _ensure_logging_started(self) -> None:
        if self._logging_started:
            return
        try:
            self.send_cli_command("log start")
            self._logging_started = True
        except Exception:
            pass

    def _update_core(self, raw: str) -> None:
        data = _parse_json_text(raw)
        if data:
            self.state.stats["core"] = data
            battery_mv = data.get("battery_mv")
            if isinstance(battery_mv, int):
                self.state.battery = {"battery_mv": battery_mv}

    def _update_radio(self, raw: str) -> None:
        data = _parse_json_text(raw)
        if data:
            self.state.stats["radio"] = data

    def _update_packets(self, raw: str) -> None:
        data = _parse_json_text(raw)
        if data:
            self.state.stats["packets"] = data

    def _update_neighbors(self, raw: str) -> None:
        rows = [line.strip() for line in raw.splitlines() if line.strip() and line.strip() != "-none-"]
        contacts: list[Contact] = []
        now = int(time.time())
        with self.state._lock:
            existing_contacts = dict(self.state.contacts)
        current_keys = set(existing_contacts.keys())
        for row in rows:
            parts = row.split(":")
            if len(parts) < 3:
                continue
            key = parts[0].lower()
            try:
                seen_ago = int(parts[1])
            except ValueError:
                seen_ago = 0
            try:
                snr_q = int(parts[2])
            except ValueError:
                snr_q = 0
            snr_db = round(snr_q / 4.0, 2)

            prev = existing_contacts.get(key)

            kind = prev.kind if prev else 0
            if len(parts) >= 4:
                try:
                    parsed_kind = int(parts[3])
                    if 0 <= parsed_kind <= 4:
                        kind = parsed_kind
                except ValueError:
                    pass

            name = (prev.name if prev else f"Neighbor {key[:8]}")
            if len(parts) >= 5:
                parsed_name = parts[4].strip()
                if parsed_name:
                    name = parsed_name

            lat = prev.lat if prev else None
            lon = prev.lon if prev else None
            if len(parts) >= 7:
                try:
                    lat = float(parts[5])
                    lon = float(parts[6])
                except ValueError:
                    pass

            flags = prev.flags if prev else 0
            out_path_len = prev.out_path_len if prev else 0

            contact = Contact(
                pubkey=key,
                kind=kind,
                flags=flags,
                out_path_len=out_path_len,
                name=name,
                last_advert_timestamp=max(0, now - max(0, seen_ago)),
                lat=lat,
                lon=lon,
                lastmod=now,
                snr=snr_db,
            )
            contacts.append(contact)
            if key not in current_keys:
                self.state.add_event("neighbor_new", {"pubkey": key, "name": contact.name, "snr": snr_db})
        self.state.replace_contacts(contacts)

    def _update_identity(self) -> None:
        name_raw = self.send_cli_command("get name")
        lat_raw  = self.send_cli_command("get lat")
        lon_raw  = self.send_cli_command("get lon")
        freq_raw = self.send_cli_command("get freq")  # returns MHz

        current = dict(self.state.self_info)
        current["name"] = name_raw.strip() or current.get("name", "")
        lat_v  = _extract_float(lat_raw)
        lon_v  = _extract_float(lon_raw)
        freq_v = _extract_float(freq_raw)
        if lat_v is not None:
            current["adv_lat"] = lat_v
        if lon_v is not None:
            current["adv_lon"] = lon_v
        if freq_v is not None and freq_v > 0:
            current["radio_freq_khz"] = int(freq_v * 1000)  # MHz → kHz
        self.state.self_info = current

    def refresh(self, full: bool = False) -> None:
        self._ensure_logging_started()
        self._update_core(self.send_cli_command("stats-core"))
        self._update_radio(self.send_cli_command("stats-radio"))
        self._update_packets(self.send_cli_command("stats-packets"))
        self._update_neighbors(self.send_cli_command("neighbors"))

        core = self.state.stats.get("core", {})
        radio = self.state.stats.get("radio", {})
        packets = self.state.stats.get("packets", {})
        recv_count = int(packets.get("recv", 0))
        sent_count = int(packets.get("sent", 0))
        flood_rx = int(packets.get("flood_rx", 0))
        direct_rx = int(packets.get("direct_rx", 0))
        dropped = max(0, recv_count - (flood_rx + direct_rx)) if (flood_rx or direct_rx) else 0
        self.state.add_history_sample(
            {
                "ts": int(time.time()),
                "rx": recv_count,
                "tx": sent_count,
                "drop": dropped,
                "queue": int(core.get("queue_len", 0)),
                "rssi": float(radio.get("last_rssi", 0.0)),
                "snr": float(radio.get("last_snr", 0.0)),
                "noise_floor": float(radio.get("noise_floor", 0.0)),
                "cpu": float(core.get("cpu_usage_pct", 0.0)),
                "mem": float(core.get("mem_usage_pct", 0.0)),
            }
        )

        # Emit live packet events for the log (only when counts actually increase)
        if self._prev_rx > 0 or self._prev_tx > 0:
            delta_rx = max(0, recv_count - self._prev_rx)
            delta_tx = max(0, sent_count - self._prev_tx)
            if delta_rx > 0:
                self.state.add_event("pkt_rx", {
                    "count": delta_rx, "total": recv_count,
                    "rssi": int(radio.get("last_rssi", 0)),
                    "snr": float(radio.get("last_snr", 0)),
                })
            if delta_tx > 0:
                self.state.add_event("pkt_tx", {
                    "count": delta_tx, "total": sent_count,
                })
        self._prev_rx = recv_count
        self._prev_tx = sent_count

        if full:
            self._update_identity()
            radio_diag = self.send_cli_command("radio-diag")
            diag_json = _parse_json_text(radio_diag)
            if diag_json:
                self.state.device_info = {
                    "model": diag_json.get("driver", "repeater"),
                    "version": "native-repeater",
                    "radio": diag_json,
                }
            ver = self.send_cli_command("ver")
            if ver:
                self.state.device_info.setdefault("version", ver.strip())

    def run(self) -> None:
        cycle = 0
        while not self.stop_event.is_set():
            try:
                if self._connect():
                    cycle += 1
                    self.refresh(full=(cycle % 12 == 1))
                    self.bus.publish({"type": "state", "payload": self.state.snapshot(), "ts": int(time.time())})
            except Exception as ex:
                self.state.add_event("error", {"message": str(ex)})
                self._close()
            time.sleep(2.5)

    def stop(self) -> None:
        self.stop_event.set()
        self._close()


class WebRequestHandler(BaseHTTPRequestHandler):
    server_version = "MeshCoreWebGUI/1.1"

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json_body(self) -> dict[str, Any]:
        content_len = int(self.headers.get("Content-Length", "0"))
        if content_len <= 0:
            return {}
        body = self.rfile.read(content_len)
        return json.loads(body.decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self._send_json(self.server.state.snapshot())
            return

        if parsed.path == "/api/events":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            q = self.server.bus.subscribe()
            try:
                init = {"type": "state", "payload": self.server.state.snapshot(), "ts": int(time.time())}
                self.wfile.write(f"data: {json.dumps(init)}\n\n".encode("utf-8"))
                self.wfile.flush()
                while True:
                    try:
                        event = q.get(timeout=15.0)
                    except queue.Empty:
                        event = {"type": "ping", "ts": int(time.time())}
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self.server.bus.unsubscribe(q)
            return

        if parsed.path == "/":
            return self._serve_static("index.html", "text/html; charset=utf-8")
        if parsed.path == "/app.js":
            return self._serve_static("app.js", "application/javascript; charset=utf-8")
        if parsed.path == "/styles.css":
            return self._serve_static("styles.css", "text/css; charset=utf-8")

        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def _serve_static(self, filename: str, content_type: str) -> None:
        p = self.server.static_dir / filename
        if not p.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        raw = p.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/api/command":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        try:
            req = self._read_json_body()
            name = str(req.get("name", "")).strip()
            args = req.get("args") or {}
            payload = self.server.command_handler(name, args)
            self._send_json({"ok": True, "name": name, "payload": payload})
        except Exception as ex:
            self._send_json({"ok": False, "error": str(ex)}, status=400)

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.getenv("RPI_COMPANION_WEB_VERBOSE", "0") == "1":
            super().log_message(fmt, *args)


class MeshWebServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], state: MeshState, bus: EventBus, static_dir: Path, command_handler):
        super().__init__(address, WebRequestHandler)
        self.state = state
        self.bus = bus
        self.static_dir = static_dir
        self.command_handler = command_handler


class App:
    def __init__(
        self,
        role: str,
        companion_host: str,
        companion_port: int,
        repeater_host: str,
        repeater_port: int,
        bind_host: str,
        bind_port: int,
        static_dir: Path,
    ) -> None:
        self.role = role
        self.state = MeshState(role)
        self.bus = EventBus()
        if role == "companion":
            self.client: CompanionClient | RepeaterClient = CompanionClient(companion_host, companion_port, self.state, self.bus)
        elif role == "repeater":
            self.client = RepeaterClient(repeater_host, repeater_port, self.state, self.bus)
        else:
            raise ValueError(f"unsupported role: {role}")

        self.bind_host = bind_host
        self.bind_port = bind_port
        self.static_dir = static_dir

    def _companion_command(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        assert isinstance(self.client, CompanionClient)
        if name == "refresh":
            self.client.send_cmd(bytes([CMD_DEVICE_QUERY, 0x03]))
            self.client.send_cmd(bytes([CMD_GET_BATT_AND_STORAGE]))
            self.client.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_CORE]))
            self.client.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_RADIO]))
            self.client.send_cmd(bytes([CMD_GET_STATS, STATS_TYPE_PACKETS]))
            self.client.send_cmd(bytes([CMD_GET_CONTACTS]))
            return {"queued": True}

        if name == "advert":
            self.client.send_cmd(bytes([CMD_SEND_SELF_ADVERT]))
            return {"queued": True}

        if name == "sync_time":
            now = int(time.time())
            self.client.send_cmd(bytes([CMD_SET_DEVICE_TIME]) + struct.pack("<I", now))
            return {"epoch": now}

        if name == "set_name":
            raw = str(args.get("name", "")).encode("utf-8")[:31]
            self.client.send_cmd(bytes([CMD_SET_ADVERT_NAME]) + raw)
            return {"name": raw.decode("utf-8", errors="ignore")}

        if name == "set_location":
            lat = float(args.get("lat"))
            lon = float(args.get("lon"))
            lat_i = int(lat * 1_000_000)
            lon_i = int(lon * 1_000_000)
            self.client.send_cmd(bytes([CMD_SET_ADVERT_LATLON]) + struct.pack("<ii", lat_i, lon_i))
            return {"lat": lat, "lon": lon}

        if name == "rxlog":
            try:
                lines = int(args.get("lines", 200))
            except (TypeError, ValueError):
                lines = 200
            lines = max(10, min(5000, lines))
            return {"lines": lines, "text": _read_packet_log_tail(lines)}

        if name == "clear_rxlog":
            for p in _packet_log_candidate_paths():
                try:
                    if p.exists():
                        p.unlink()
                        break
                except OSError:
                    pass
            return {"cleared": True}

        if name == "header_stats":
            text = self.client.send_cli_command("rxlog 5000")
            return _compute_packet_header_breakdown_from_text(text, source="repeater:rxlog")

        if name == "public_msg":
            text = str(args.get("text", "")).encode("utf-8")[:180]
            channel = int(args.get("channel", 0)) & 0xFF
            ts = int(time.time())
            msg_id = f"{ts}_{channel}_{len(self.client._pending_ack_ids)}"
            payload = bytes([CMD_SEND_CHANNEL_TXT_MSG, 0, channel]) + struct.pack("<I", ts) + text
            self.client.send_cmd(payload)
            # Store the outbound message with pending status
            ch_name = next((c["name"] for c in self.state.channels if c["index"] == channel), f"ch{channel}")
            out_msg = {
                "msg_type": "channel",
                "channel_idx": channel,
                "path_len": -1,
                "hop_str": "Sent",
                "txt_type": 0,
                "ts": ts,
                "text": text.decode("utf-8", errors="replace"),
                "snr": None,
                "outbound": True,
                "status": "pending",
                "msg_id": msg_id,
            }
            with self.state._lock:
                self.state.messages.append(out_msg)
                self.client._pending_ack_ids.append(msg_id)
            self.state.add_event(
                "chan_msg_sent",
                {
                    "channel": ch_name,
                    "channel_idx": channel,
                    "ts": ts,
                    "text": text.decode("utf-8", errors="replace")[:60],
                },
            )
            self.bus.publish({"type": "state", "payload": self.state.snapshot(), "ts": int(time.time())})
            return {"channel": channel, "bytes": len(text)}

        if name == "send_direct_msg":
            pubkey_hex = str(args.get("pubkey", "")).strip().lower()
            text_raw = str(args.get("text", "")).encode("utf-8")[:180]
            if len(pubkey_hex) < 12:
                raise ValueError("pubkey too short")
            pubkey_bytes = bytes.fromhex(pubkey_hex[:12])  # first 6 bytes
            ts = int(time.time())
            msg_id = f"dm_{ts}_{pubkey_hex[:12]}_{len(self.client._pending_ack_ids)}"
            cmd_payload = bytes([CMD_SEND_TXT_MSG, 0, 0]) + struct.pack("<I", ts) + pubkey_bytes + text_raw
            self.client.send_cmd(cmd_payload)
            contact = self.state.contacts.get(pubkey_hex) or next(
                (c for k, c in self.state.contacts.items() if k.startswith(pubkey_hex[:12])), None
            )
            contact_name = contact.name if contact else pubkey_hex[:12]
            out_msg = {
                "msg_type": "contact",
                "sender": "You",
                "pubkey_prefix": pubkey_hex[:12],
                "path_len": -1,
                "hop_str": "Sent",
                "txt_type": 0,
                "ts": ts,
                "text": text_raw.decode("utf-8", errors="replace"),
                "snr": None,
                "outbound": True,
                "status": "pending",
                "msg_id": msg_id,
            }
            with self.state._lock:
                self.state.messages.append(out_msg)
                self.client._pending_ack_ids.append(msg_id)
            self.state.add_event(
                "dm_sent",
                {
                    "recipient": contact_name,
                    "pubkey_prefix": pubkey_hex[:12],
                    "ts": ts,
                    "text": text_raw.decode("utf-8", errors="replace")[:60],
                },
            )
            self.bus.publish({"type": "state", "payload": self.state.snapshot(), "ts": int(time.time())})
            return {"pubkey_prefix": pubkey_hex[:12], "bytes": len(text_raw)}

        if name == "get_channels":
            for idx in range(8):
                self.client.send_cmd(bytes([CMD_GET_CHANNEL, idx]))
            return {"queued": True}

        if name == "get_next_message":
            self.client.send_cmd(bytes([CMD_SYNC_NEXT_MESSAGE]))
            return {"queued": True}

        if name == "get_hardware_stats":
            stats: dict[str, Any] = {}
            try:
                import psutil
                stats["cpu_percent"] = psutil.cpu_percent(interval=0.2)
                vm = psutil.virtual_memory()
                stats["mem_percent"] = vm.percent
                stats["mem_used_mb"] = vm.used // (1024 * 1024)
                stats["mem_total_mb"] = vm.total // (1024 * 1024)
                try:
                    d = psutil.disk_usage("/")
                    stats["disk_percent"] = d.percent
                    stats["disk_used_gb"] = round(d.used / (1024 ** 3), 1)
                    stats["disk_total_gb"] = round(d.total / (1024 ** 3), 1)
                except Exception:
                    pass
                try:
                    for t_key in ("cpu_thermal", "coretemp", "k10temp", "cpu-thermal"):
                        temps = psutil.sensors_temperatures() or {}
                        if t_key in temps and temps[t_key]:
                            stats["cpu_temp"] = round(temps[t_key][0].current, 1)
                            break
                except Exception:
                    pass
            except ImportError:
                core = self.state.stats.get("core", {})
                stats["cpu_percent"] = float(core.get("cpu_usage_pct", 0.0))
                stats["mem_percent"] = float(core.get("mem_usage_pct", 0.0))
            return stats

        raise ValueError(f"unknown command: {name}")

    def _repeater_command(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        assert isinstance(self.client, RepeaterClient)

        if name == "refresh":
            self.client.refresh(full=True)
            self.bus.publish({"type": "state", "payload": self.state.snapshot(), "ts": int(time.time())})
            return {"queued": True}

        if name == "advert":
            reply = self.client.send_cli_command("advert")
            self.state.add_event("command", {"name": "advert", "reply": reply})
            return {"reply": reply}

        if name == "sync_time":
            now = int(time.time())
            reply = self.client.send_cli_command(f"time {now}")
            self.state.add_event("command", {"name": "time", "reply": reply})
            return {"epoch": now, "reply": reply}

        if name == "set_name":
            raw_name = str(args.get("name", "")).strip()
            if not raw_name:
                raise ValueError("name is required")
            reply = self.client.send_cli_command(f"set name {raw_name}")
            self.client.refresh(full=True)
            return {"name": raw_name, "reply": reply}

        if name == "set_location":
            lat = float(args.get("lat"))
            lon = float(args.get("lon"))
            reply_lat = self.client.send_cli_command(f"set lat {lat:.6f}")
            reply_lon = self.client.send_cli_command(f"set lon {lon:.6f}")
            self.client.refresh(full=True)
            return {"lat": lat, "lon": lon, "reply": [reply_lat, reply_lon]}

        if name == "clear_stats":
            reply = self.client.send_cli_command("clear stats")
            self.client.refresh(full=False)
            return {"reply": reply}

        if name == "reboot":
            reply = self.client.send_cli_command("reboot")
            self.state.add_event("reboot", {"reply": reply})
            return {"reply": reply}

        if name == "neighbor_remove":
            pubkey_prefix = str(args.get("pubkey_prefix", "")).strip().lower()
            if not pubkey_prefix:
                raise ValueError("pubkey_prefix is required")
            reply = self.client.send_cli_command(f"neighbor.remove {pubkey_prefix}")
            self.client.refresh(full=False)
            return {"pubkey_prefix": pubkey_prefix, "reply": reply}

        if name == "get_radio":
            reply = self.client.send_cli_command("get radio")
            return {"reply": reply}

        if name == "rxlog":
            try:
                lines = int(args.get("lines", 200))
            except (TypeError, ValueError):
                lines = 200
            lines = max(10, min(5000, lines))
            text = self.client.send_cli_command(f"rxlog {lines}")
            return {"lines": lines, "text": text}

        if name == "clear_rxlog":
            reply = self.client.send_cli_command("clear_rxlog")
            return {"reply": reply}

        if name == "header_stats":
            return _compute_packet_header_breakdown()

        if name == "config_schema":
            return {
                "groups": REPEATER_CONFIG_KEYS,
                "all_keys": [k for group in REPEATER_CONFIG_KEYS.values() for k in group],
            }

        if name == "config_get":
            key = _require_safe_config_key(str(args.get("key", "")))
            reply = self.client.send_cli_command(f"get {key}")
            return {"key": key, "reply": reply}

        if name == "config_get_all":
            values: dict[str, str] = {}
            for key in [k for group in REPEATER_CONFIG_KEYS.values() for k in group]:
                values[key] = self.client.send_cli_command(f"get {key}")
            return {"values": values}

        if name == "config_set":
            key = _require_safe_config_key(str(args.get("key", "")))
            value = _require_cli_value(args.get("value", ""))
            reply = self.client.send_cli_command(f"set {key} {value}")
            self.state.add_event("config_set", {"key": key, "value": value, "reply": reply})
            self.client.refresh(full=False)
            return {"key": key, "value": value, "reply": reply}

        if name == "config_save":
            reply = self.client.send_cli_command("save")
            self.state.add_event("config_save", {"reply": reply})
            return {"reply": reply}

        if name == "region_dump":
            reply = self.client.send_cli_command("region")
            home = self.client.send_cli_command("region home")
            return {"reply": reply, "home": home}

        if name == "region_home_set":
            region_name = _require_safe_region_name(str(args.get("name", "")))
            reply = self.client.send_cli_command(f"region home {region_name}")
            self.state.add_event("region_home", {"name": region_name, "reply": reply})
            return {"name": region_name, "reply": reply}

        if name == "region_home_get":
            reply = self.client.send_cli_command("region home")
            return {"reply": reply}

        if name == "region_put":
            region_name = _require_safe_region_name(str(args.get("name", "")))
            parent_name = str(args.get("parent", "")).strip()
            if parent_name:
                parent_name = _require_safe_region_name(parent_name)
                reply = self.client.send_cli_command(f"region put {region_name} {parent_name}")
            else:
                reply = self.client.send_cli_command(f"region put {region_name}")
            self.state.add_event("region_put", {"name": region_name, "parent": parent_name, "reply": reply})
            return {"name": region_name, "parent": parent_name, "reply": reply}

        if name == "region_remove":
            region_name = _require_safe_region_name(str(args.get("name", "")))
            reply = self.client.send_cli_command(f"region remove {region_name}")
            self.state.add_event("region_remove", {"name": region_name, "reply": reply})
            return {"name": region_name, "reply": reply}

        if name == "region_get":
            region_name = _require_safe_region_name(str(args.get("name", "")))
            reply = self.client.send_cli_command(f"region get {region_name}")
            return {"name": region_name, "reply": reply}

        if name == "region_allowf":
            region_name = _require_safe_region_name(str(args.get("name", "")))
            reply = self.client.send_cli_command(f"region allowf {region_name}")
            self.state.add_event("region_allowf", {"name": region_name, "reply": reply})
            return {"name": region_name, "reply": reply}

        if name == "region_denyf":
            region_name = _require_safe_region_name(str(args.get("name", "")))
            reply = self.client.send_cli_command(f"region denyf {region_name}")
            self.state.add_event("region_denyf", {"name": region_name, "reply": reply})
            return {"name": region_name, "reply": reply}

        if name == "region_load_named":
            region_name = _require_safe_region_name(str(args.get("name", "")))
            flood_flag = str(args.get("flood_flag", "")).strip().upper()
            if flood_flag == "F":
                reply = self.client.send_cli_command(f"region load {region_name} F")
            else:
                reply = self.client.send_cli_command(f"region load {region_name}")
            self.state.add_event("region_load", {"name": region_name, "flood_flag": flood_flag, "reply": reply})
            return {"name": region_name, "flood_flag": flood_flag, "reply": reply}

        if name == "region_save":
            reply = self.client.send_cli_command("region save")
            self.state.add_event("region_save", {"reply": reply})
            return {"reply": reply}

        if name == "regions_allowed":
            reply = self.client.send_cli_command("region list allowed")
            return {"reply": reply}

        if name == "regions_denied":
            reply = self.client.send_cli_command("region list denied")
            return {"reply": reply}

        if name == "region_refresh_full":
            home_reply = self.client.send_cli_command("region home")
            home = re.sub(r'home\s+is\s*', '', home_reply, flags=re.IGNORECASE).strip()

            allowed_str = self.client.send_cli_command("region list allowed")
            denied_str  = self.client.send_cli_command("region list denied")

            _bad = {"", "-none-", "err", "error"}
            # CLI may return comma-separated or whitespace-separated names (e.g. "*,at,at-ost")
            allowed_names = [n.strip() for n in re.split(r'[,\s]+', allowed_str) if n.strip().lower() not in _bad]
            denied_names  = [n.strip() for n in re.split(r'[,\s]+', denied_str)  if n.strip().lower() not in _bad]
            flood_set = set(allowed_names)
            seen: dict[str, None] = {}
            for n in allowed_names + denied_names:
                seen[n] = None
            all_names = list(seen.keys())

            regions: list[dict[str, Any]] = []
            for rname in all_names:
                info = self.client.send_cli_command(f"region get {rname}")
                parent: str | None = None
                m = re.search(r'\(([^)]+)\)', info)
                if m:
                    parent = m.group(1).strip()
                regions.append({
                    "name": rname,
                    "parent": parent,
                    "flood": rname in flood_set,
                    "home": rname == home,
                })

            with self.state._lock:
                self.state.regions = regions
            self.bus.publish({"type": "state", "payload": self.state.snapshot(), "ts": int(time.time())})
            return {"home": home, "regions": regions}

        if name == "set_mode":
            mode = str(args.get("mode", "forward")).strip().lower()
            if mode not in ("forward", "monitor"):
                raise ValueError("mode must be 'forward' or 'monitor'")
            value = "1" if mode == "forward" else "0"
            reply = self.client.send_cli_command(f"set repeat {value}")
            save_reply = self.client.send_cli_command("save")
            self.state.add_event("mode_change", {"mode": mode, "reply": reply})
            return {"mode": mode, "repeat": value, "reply": reply, "saved": save_reply}

        if name == "get_hardware_stats":
            stats: dict[str, Any] = {}
            try:
                import psutil
                stats["cpu_percent"] = psutil.cpu_percent(interval=0.2)
                vm = psutil.virtual_memory()
                stats["mem_percent"] = vm.percent
                stats["mem_used_mb"] = vm.used // (1024 * 1024)
                stats["mem_total_mb"] = vm.total // (1024 * 1024)
                try:
                    d = psutil.disk_usage("/")
                    stats["disk_percent"] = d.percent
                    stats["disk_used_gb"] = round(d.used / (1024 ** 3), 1)
                    stats["disk_total_gb"] = round(d.total / (1024 ** 3), 1)
                except Exception:
                    pass
                try:
                    for t_key in ("cpu_thermal", "coretemp", "k10temp", "cpu-thermal"):
                        temps = psutil.sensors_temperatures() or {}
                        if t_key in temps and temps[t_key]:
                            stats["cpu_temp"] = round(temps[t_key][0].current, 1)
                            break
                except Exception:
                    pass
            except ImportError:
                # Fallback: use what the repeater already reports
                core = self.state.stats.get("core", {})
                stats["cpu_percent"] = float(core.get("cpu_usage_pct", 0.0))
                stats["mem_percent"] = float(core.get("mem_usage_pct", 0.0))
            return stats

        if name == "get_logs":
            snapshot = self.state.snapshot()
            return {"logs": snapshot.get("events", [])[-100:]}

        if name == "raw":
            raw_cmd = str(args.get("cmd", "")).strip()
            if not raw_cmd:
                raise ValueError("cmd is required")
            reply = self.client.send_cli_command(raw_cmd)
            self.state.add_event("raw", {"cmd": raw_cmd, "reply": reply})
            return {"cmd": raw_cmd, "reply": reply}

        if name == "public_msg":
            raise ValueError("public message is companion-only")

        raise ValueError(f"unknown command: {name}")

    def command_handler(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if self.role == "companion":
            return self._companion_command(name, args)
        return self._repeater_command(name, args)

    def run(self) -> None:
        t = threading.Thread(target=self.client.run, daemon=True)
        t.start()

        server = MeshWebServer((self.bind_host, self.bind_port), self.state, self.bus, self.static_dir, self.command_handler)
        print(f"[webgui] role={self.role} listening on http://{self.bind_host}:{self.bind_port}")
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            self.client.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="MeshCore Role-aware Web GUI bridge")
    parser.add_argument("--role", choices=["companion", "repeater"], default=os.getenv("RPI_WEB_ROLE", "companion"))
    parser.add_argument("--companion-host", default=os.getenv("RPI_COMPANION_TCP_HOST", "127.0.0.1"))
    parser.add_argument("--companion-port", type=int, default=int(os.getenv("RPI_COMPANION_TCP_PORT", "5000")))
    parser.add_argument("--repeater-host", default=os.getenv("RPI_REPEATER_TCP_HOST", "127.0.0.1"))
    parser.add_argument("--repeater-port", type=int, default=int(os.getenv("RPI_REPEATER_TCP_PORT", "5001")))
    parser.add_argument("--bind-host", default=None)
    parser.add_argument("--bind-port", type=int, default=None)
    parser.add_argument("--static-dir", default=str(Path(__file__).with_name("webgui_static")))
    args = parser.parse_args()

    if args.bind_host is None:
        if args.role == "repeater":
            args.bind_host = os.getenv("RPI_REPEATER_WEB_HOST", "0.0.0.0")
        else:
            args.bind_host = os.getenv("RPI_COMPANION_WEB_HOST", "0.0.0.0")

    if args.bind_port is None:
        if args.role == "repeater":
            args.bind_port = int(os.getenv("RPI_REPEATER_WEB_PORT", "8081"))
        else:
            args.bind_port = int(os.getenv("RPI_COMPANION_WEB_PORT", "8080"))

    app = App(
        role=args.role,
        companion_host=args.companion_host,
        companion_port=args.companion_port,
        repeater_host=args.repeater_host,
        repeater_port=args.repeater_port,
        bind_host=args.bind_host,
        bind_port=args.bind_port,
        static_dir=Path(args.static_dir),
    )
    app.run()


if __name__ == "__main__":
    main()
