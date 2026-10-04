"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { UsbSerialTransport, PREFIX } = require("../serial-bridge");

class FakeSerialPort extends EventEmitter {
  static devices = [];

  static async list() {
    return FakeSerialPort.devices;
  }

  constructor(options) {
    super();
    this.path = options.path;
    this.isOpen = false;
    this.received = "";
    this.activeRequest = null;
    this.receivedChunks = 0;
  }

  open(callback) {
    this.isOpen = true;
    callback();
  }

  close(callback) {
    this.isOpen = false;
    this.emit("close");
    callback();
  }

  write(text, callback) {
    this.received += text;
    const newline = this.received.indexOf("\n");
    if (newline >= 0) {
      const line = this.received.slice(0, newline);
      this.received = this.received.slice(newline + 1);
      const envelope = JSON.parse(line.slice(PREFIX.length));
      if (envelope.op === "hello") {
        this.emitEnvelope({ op: "hello", id: envelope.id, protocol: "opdex-usb-v1", version: "test" });
      } else if (envelope.op === "request") {
        if (envelope.stream) {
          this.activeRequest = envelope;
          this.receivedChunks = 0;
          this.emitEnvelope({ op: "ready", id: envelope.id });
        } else {
          this.emitEnvelope({
            op: "response",
            id: envelope.id,
            status: 200,
            contentType: "application/json",
            body: envelope.body,
          });
        }
      } else if (envelope.op === "chunk") {
        this.receivedChunks += 1;
        this.emitEnvelope({ op: "ack", id: envelope.id, sequence: envelope.sequence });
        const totalChunks = Math.ceil(this.activeRequest.bodyLength / 3072);
        if (this.receivedChunks === totalChunks) {
          this.emitEnvelope({
            op: "response",
            id: envelope.id,
            status: 200,
            contentType: "text/plain",
            body: "OK",
          });
        }
      }
    }
    callback();
  }

  emitEnvelope(envelope) {
    const frame = Buffer.from(`${PREFIX}${JSON.stringify(envelope)}\n`);
    const split = frame.findIndex((value) => value >= 0x80);
    if (split >= 0) {
      setImmediate(() => this.emit("data", frame.subarray(0, split + 1)));
      setImmediate(() => this.emit("data", frame.subarray(split + 1)));
    } else {
      setImmediate(() => this.emit("data", frame));
    }
  }
}

test("connect verifies the firmware protocol before reporting the port connected", async () => {
  const transport = new UsbSerialTransport(FakeSerialPort);
  const status = await transport.connect("COM4");
  assert.equal(status.connected, true);
  assert.equal(status.port, "COM4");
  assert.equal(status.version, "test");
  await transport.disconnect();
});

test("inline HTTP requests preserve the request body and response status", async () => {
  const transport = new UsbSerialTransport(FakeSerialPort);
  await transport.connect("COM4");
  const result = await transport.request(
    "POST",
    "/api/settings",
    Buffer.from('{"driver":"München"}'),
    "application/json",
  );
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"driver":"München"}');
  await transport.disconnect();
});

test("large request bodies are acknowledged chunk by chunk", async () => {
  const transport = new UsbSerialTransport(FakeSerialPort);
  await transport.connect("COM4");
  const body = Buffer.alloc(10_000, 0x61);
  const result = await transport.request("POST", "/ota/update", body, "multipart/form-data; boundary=test");
  assert.equal(result.status, 200);
  await transport.disconnect();
});

test("device hostname validation rejects URL schemes and paths", () => {
  const { validDeviceHost } = require("../bridge-utils");
  assert.equal(validDeviceHost("openhaldex.local"), true);
  assert.equal(validDeviceHost("192.168.4.1"), true);
  assert.equal(validDeviceHost("192.168.999.1"), false);
  assert.equal(validDeviceHost("bad..host.local"), false);
  assert.equal(validDeviceHost("http://openhaldex.local"), false);
  assert.equal(validDeviceHost("openhaldex.local/path"), false);
});

test("desktop navigation only stays inside the local bridge origin", () => {
  const { isLocalBridgeUrl } = require("../bridge-utils");
  const bridge = "http://127.0.0.1:43821";
  assert.equal(isLocalBridgeUrl(`${bridge}/setup.html`, bridge), true);
  assert.equal(isLocalBridgeUrl("https://example.com", bridge), false);
  assert.equal(isLocalBridgeUrl("http://127.0.0.1:8765/", bridge), false);
  assert.equal(isLocalBridgeUrl("not a URL", bridge), false);
});

test("local bridge server can start on an ephemeral port and shut down cleanly", async () => {
  const { startServer, stopServer } = require("../server");
  const url = await startServer({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /OpenHaldex-S3/);
  } finally {
    await stopServer();
  }
});
