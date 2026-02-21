#!/usr/bin/env python3

import argparse
import dbus
import dbus.exceptions
import dbus.mainloop.glib
import dbus.service
import errno
import os
import socket
import struct
from gi.repository import GLib


BLUEZ_SERVICE_NAME = "org.bluez"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"
GATT_MANAGER_IFACE = "org.bluez.GattManager1"
LE_ADVERTISING_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"
LE_ADVERTISEMENT_IFACE = "org.bluez.LEAdvertisement1"

NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"


class InvalidArgsException(dbus.exceptions.DBusException):
    _dbus_error_name = "org.freedesktop.DBus.Error.InvalidArgs"


class NotSupportedException(dbus.exceptions.DBusException):
    _dbus_error_name = "org.bluez.Error.NotSupported"


class Application(dbus.service.Object):
    def __init__(self, bus):
        self.path = "/"
        self.services = []
        super().__init__(bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_service(self, service):
        self.services.append(service)

    @dbus.service.method(DBUS_OM_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        response = {}
        for service in self.services:
            response[service.get_path()] = service.get_properties()
            for chrc in service.characteristics:
                response[chrc.get_path()] = chrc.get_properties()
        return response


class Service(dbus.service.Object):
    def __init__(self, bus, index, uuid, primary=True):
        self.path = f"/org/meshcore/service{index}"
        self.bus = bus
        self.uuid = uuid
        self.primary = primary
        self.characteristics = []
        super().__init__(bus, self.path)

    def get_properties(self):
        return {
            GATT_SERVICE_IFACE: {
                "UUID": self.uuid,
                "Primary": self.primary,
                "Characteristics": dbus.Array(
                    [chrc.get_path() for chrc in self.characteristics],
                    signature="o",
                ),
            }
        }

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_characteristic(self, characteristic):
        self.characteristics.append(characteristic)

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_SERVICE_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_SERVICE_IFACE]


class Characteristic(dbus.service.Object):
    def __init__(self, bus, index, uuid, flags, service):
        self.path = service.path + f"/char{index}"
        self.bus = bus
        self.uuid = uuid
        self.service = service
        self.flags = flags
        super().__init__(bus, self.path)

    def get_properties(self):
        return {
            GATT_CHRC_IFACE: {
                "Service": self.service.get_path(),
                "UUID": self.uuid,
                "Flags": dbus.Array(self.flags, signature="s"),
            }
        }

    def get_path(self):
        return dbus.ObjectPath(self.path)

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_CHRC_IFACE]

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, _options):
        raise NotSupportedException()

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, _value, _options):
        raise NotSupportedException()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        raise NotSupportedException()

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        raise NotSupportedException()


class NUSRxCharacteristic(Characteristic):
    def __init__(self, bus, index, service, bridge):
        self.bridge = bridge
        super().__init__(
            bus,
            index,
            NUS_RX_UUID,
            ["write", "write-without-response", "encrypt-write"],
            service,
        )

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, _options):
        payload = bytes(value)
        self.bridge.send_to_companion(payload)


class NUSTxCharacteristic(Characteristic):
    def __init__(self, bus, index, service):
        self.notifying = False
        self.last_value = b""
        super().__init__(
            bus,
            index,
            NUS_TX_UUID,
            ["notify", "read", "encrypt-read"],
            service,
        )

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, _options):
        return dbus.ByteArray(self.last_value)

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.notifying = True

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False

    def send_notify(self, payload):
        if not self.notifying:
            return
        self.last_value = payload
        self.PropertiesChanged(
            GATT_CHRC_IFACE,
            {"Value": dbus.ByteArray(payload)},
            [],
        )

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass


class NUSService(Service):
    def __init__(self, bus, index, bridge):
        super().__init__(bus, index, NUS_SERVICE_UUID, True)
        self.tx = NUSTxCharacteristic(bus, 0, self)
        self.rx = NUSRxCharacteristic(bus, 1, self, bridge)
        self.add_characteristic(self.tx)
        self.add_characteristic(self.rx)


class Advertisement(dbus.service.Object):
    def __init__(self, bus, index, local_name):
        self.path = f"/org/meshcore/advertisement{index}"
        self.bus = bus
        self.local_name = local_name
        self.service_uuids = [NUS_SERVICE_UUID]
        super().__init__(bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            LE_ADVERTISEMENT_IFACE: {
                "Type": "peripheral",
                "ServiceUUIDs": dbus.Array(self.service_uuids, signature="s"),
                "LocalName": dbus.String(self.local_name),
                "Includes": dbus.Array(["tx-power"], signature="s"),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != LE_ADVERTISEMENT_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[LE_ADVERTISEMENT_IFACE]

    @dbus.service.method(LE_ADVERTISEMENT_IFACE, in_signature="", out_signature="")
    def Release(self):
        pass


class CompanionBridge:
    def __init__(self, host, port, tx_char):
        self.host = host
        self.port = port
        self.tx_char = tx_char
        self.sock = None
        self.recv_buffer = bytearray()

    def ensure_connected(self):
        if self.sock is not None:
            return
        try:
            sock = socket.create_connection((self.host, self.port), timeout=0.5)
            sock.setblocking(False)
            self.sock = sock
            self.recv_buffer.clear()
            print(f"[ble-bridge] connected to companion tcp {self.host}:{self.port}")
        except OSError:
            self.sock = None

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def send_to_companion(self, payload):
        if not payload:
            return
        if len(payload) > 255:
            payload = payload[:255]
        frame = b"<" + struct.pack("<H", len(payload)) + payload
        self.ensure_connected()
        if self.sock is None:
            return
        try:
            self.sock.sendall(frame)
        except OSError:
            self.close()

    def poll_companion(self):
        self.ensure_connected()
        if self.sock is None:
            return
        while True:
            try:
                chunk = self.sock.recv(2048)
                if not chunk:
                    self.close()
                    return
                self.recv_buffer.extend(chunk)
            except OSError as ex:
                if ex.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    break
                self.close()
                return

        while len(self.recv_buffer) >= 3:
            frame_type = self.recv_buffer[0]
            frame_len = self.recv_buffer[1] | (self.recv_buffer[2] << 8)
            total = 3 + frame_len
            if len(self.recv_buffer) < total:
                break
            payload = bytes(self.recv_buffer[3:total])
            del self.recv_buffer[:total]
            if frame_type == ord(">") and payload:
                self.tx_char.send_notify(payload)


def find_adapter(bus, adapter_name):
    manager = dbus.Interface(bus.get_object(BLUEZ_SERVICE_NAME, "/"), DBUS_OM_IFACE)
    objects = manager.GetManagedObjects()
    wanted = f"/org/bluez/{adapter_name}"
    for path, ifaces in objects.items():
        if path == wanted and GATT_MANAGER_IFACE in ifaces and LE_ADVERTISING_MANAGER_IFACE in ifaces:
            return path
    return None


def main():
    parser = argparse.ArgumentParser(description="MeshCore NUS BLE bridge for RaspberryPi companion")
    parser.add_argument("--adapter", default=os.getenv("RPI_COMPANION_BLE_ADAPTER", "hci0"))
    parser.add_argument("--name", default=os.getenv("RPI_COMPANION_BLE_NAME", "MeshCore"))
    parser.add_argument("--tcp-host", default=os.getenv("RPI_COMPANION_TCP_HOST", "127.0.0.1"))
    parser.add_argument("--tcp-port", type=int, default=int(os.getenv("RPI_COMPANION_TCP_PORT", "5000")))
    parser.add_argument("--poll-ms", type=int, default=20)
    args = parser.parse_args()

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    adapter_path = find_adapter(bus, args.adapter)
    if adapter_path is None:
        raise RuntimeError(f"BLE adapter {args.adapter} with GATT+ADV manager not found")

    adapter_obj = bus.get_object(BLUEZ_SERVICE_NAME, adapter_path)
    gatt_manager = dbus.Interface(adapter_obj, GATT_MANAGER_IFACE)
    adv_manager = dbus.Interface(adapter_obj, LE_ADVERTISING_MANAGER_IFACE)

    bridge_placeholder = type("BridgePlaceholder", (), {})()
    app = Application(bus)
    service = NUSService(bus, 0, bridge_placeholder)
    app.add_service(service)

    bridge = CompanionBridge(args.tcp_host, args.tcp_port, service.tx)
    service.rx.bridge = bridge

    adv = Advertisement(bus, 0, args.name)

    mainloop = GLib.MainLoop()

    def register_ok():
        print("[ble-bridge] GATT app registered")

    def register_err(err):
        print(f"[ble-bridge] failed to register GATT app: {err}")
        mainloop.quit()

    def adv_ok():
        print("[ble-bridge] advertising started")

    def adv_err(err):
        print(f"[ble-bridge] failed to start advertising: {err}")
        mainloop.quit()

    gatt_manager.RegisterApplication(app.get_path(), {}, reply_handler=register_ok, error_handler=register_err)
    adv_manager.RegisterAdvertisement(adv.get_path(), {}, reply_handler=adv_ok, error_handler=adv_err)

    def on_tick():
        bridge.poll_companion()
        return True

    GLib.timeout_add(max(5, args.poll_ms), on_tick)

    try:
        mainloop.run()
    finally:
        try:
            adv_manager.UnregisterAdvertisement(adv.get_path())
        except Exception:
            pass
        bridge.close()


if __name__ == "__main__":
    main()
