"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");

const PREFIX = "OHUSB/1 ";
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const INLINE_BODY_BYTES = 4096;
const CHUNK_BYTES = 3072;

class UsbSerialTransport extends EventEmitter {
  constructor(SerialPortClass) {
    super();
    this.SerialPortClass = SerialPortClass;
    this.port = null;
    this.path = "";
    this.version = "";
    this.buffer = Buffer.alloc(0);
    this.waiters = new Map();
    this.queue = Promise.resolve();
    this.lastError = "";
  }

  static async listPorts(SerialPortClass) {
    const ports = await SerialPortClass.list();
    return ports.map((port) => ({
      path: port.path,
      manufacturer: port.manufacturer || "",
      vendorId: port.vendorId || "",
      productId: port.productId || "",
    }));
  }

  async connect(path) {
    if (typeof path !== "string" || path.length === 0 || path.length > 256) {
      throw new Error("Select a valid Windows COM port.");
    }
    await this.disconnect();

    const port = new this.SerialPortClass({
      path,
      baudRate: 115200,
      autoOpen: false,
    });
    this.port = port;
    this.path = path;
    this.buffer = Buffer.alloc(0);
    this.lastError = "";
    port.on("data", (data) => this._onData(data));
    port.on("error", (error) => this._onPortError(error));
    port.on("close", () => this._onPortClose());
    try {
      await new Promise((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      this.port = null;
      this.path = "";
      throw error;
    }

    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const hello = await this._hello();
        if (hello.protocol !== "opdex-usb-v1") {
          throw new Error("The selected serial device does not speak the Opdex USB protocol.");
        }
        this.version = String(hello.version || "");
        this.emit("connected", this.status());
        return this.status();
      } catch (error) {
        lastError = error;
        if (this.lastError) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    await this.disconnect();
    throw new Error(`No Opdex USB response on ${path}: ${lastError?.message || "timed out"}`);
  }

  async disconnect() {
    const port = this.port;
    this.port = null;
    this.path = "";
    this.version = "";
    this.buffer = Buffer.alloc(0);
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(new Error("USB connection closed."));
      }
    }
    this.waiters.clear();
    if (port?.isOpen) {
      await new Promise((resolve) => port.close(() => resolve()));
    }
    this.emit("disconnected");
  }

  status() {
    return {
      connected: Boolean(this.port?.isOpen && !this.lastError),
      port: this.path,
      version: this.version,
      error: this.lastError,
    };
  }

  request(method, path, body, contentType) {
    const run = this.queue.then(() => this._request(method, path, body, contentType));
    this.queue = run.catch(() => {});
    return run;
  }

  async _hello() {
    const id = randomUUID();
    const received = this._waitFor(id, (message) => message.op === "hello", 1500);
    await this._write({ op: "hello", id });
    return received;
  }

  async _request(method, path, body, contentType) {
    if (!this.port?.isOpen || this.lastError) {
      throw new Error(this.lastError || "USB board is not connected.");
    }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
    if (bytes.length > MAX_REQUEST_BYTES) {
      throw new Error(`USB request exceeds the ${MAX_REQUEST_BYTES}-byte limit.`);
    }

    const id = randomUUID();
    const isText = !contentType || /^(application\/json|text\/|application\/x-www-form-urlencoded)/i.test(contentType);
    let streamed = bytes.length > INLINE_BODY_BYTES || (bytes.length > 0 && !isText);
    const header = {
      op: "request",
      id,
      method,
      path,
      contentType: contentType || "",
      stream: streamed,
    };

    if (!streamed) {
      header.body = bytes.toString("utf8");
      if (Buffer.byteLength(`${PREFIX}${JSON.stringify(header)}\n`, "utf8") > 10 * 1024) {
        streamed = true;
        header.stream = true;
        delete header.body;
      }
    }
    if (streamed) {
      header.bodyLength = bytes.length;
    } else {
      const responseWait = this._waitFor(id, (message) => message.op === "response", 180000);
      await this._write(header);
      return responseWait;
    }

    const readyWait = this._waitFor(
      id,
      (message) => message.op === "ready" || message.op === "response",
      10000,
    );
    await this._write(header);
    const ready = await readyWait;
    if (ready.op === "response") {
      return ready;
    }

    let sequence = 0;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const isLastChunk = offset + CHUNK_BYTES >= bytes.length;
      const responseWait = isLastChunk
        ? this._waitFor(id, (message) => message.op === "response", 180000)
        : null;
      if (responseWait) {
        responseWait.catch(() => {});
      }
      const ackWait = this._waitFor(
        id,
        (message) => message.op === "ack" || message.op === "response",
        10000,
      );
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
      await this._write({ op: "chunk", id, sequence, data: chunk.toString("base64") });
      const ack = await ackWait;
      if (ack.op === "response") {
        return ack;
      }
      if (ack.sequence !== sequence) {
        throw new Error("USB board acknowledged an unexpected body chunk.");
      }
      sequence += 1;
      if (isLastChunk) {
        return responseWait;
      }
    }

    return { op: "response", id, status: 200, contentType: "text/plain", body: "" };
  }

  _waitFor(id, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(id) || [];
      const waiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(timeout);
          const remaining = (this.waiters.get(id) || []).filter((candidate) => candidate !== waiter);
          if (remaining.length > 0) {
            this.waiters.set(id, remaining);
          } else {
            this.waiters.delete(id);
          }
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          const remaining = (this.waiters.get(id) || []).filter((candidate) => candidate !== waiter);
          if (remaining.length > 0) {
            this.waiters.set(id, remaining);
          } else {
            this.waiters.delete(id);
          }
          reject(error);
        },
      };
      const timeout = setTimeout(() => waiter.reject(new Error("Timed out waiting for the USB board.")), timeoutMs);
      waiters.push(waiter);
      this.waiters.set(id, waiters);
    });
  }

  async _write(envelope) {
    if (!this.port?.isOpen) {
      throw new Error("USB serial port is closed.");
    }
    const line = `${PREFIX}${JSON.stringify(envelope)}\n`;
    await new Promise((resolve, reject) => {
      this.port.write(line, (error) => (error ? reject(error) : resolve()));
    });
  }

  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.buffer = Buffer.alloc(0);
      this._onPortError(new Error("USB response frame exceeded the allowed size."));
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.startsWith(PREFIX)) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line.slice(PREFIX.length));
      } catch {
        this._onPortError(new Error("Malformed USB response from the board."));
        continue;
      }
      const waiters = this.waiters.get(String(message.id || ""));
      for (const waiter of [...(waiters || [])]) {
        if (waiter.predicate(message)) {
          waiter.resolve(message);
        }
      }
    }
  }

  _onPortError(error) {
    this.lastError = error.message || String(error);
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(new Error(this.lastError));
      }
    }
    this.waiters.clear();
    this.emit("transportError", error);
  }

  _onPortClose() {
    this.lastError = "USB serial port closed.";
    this.path = "";
    this.version = "";
    this.emit("disconnected");
  }
}

module.exports = { UsbSerialTransport, PREFIX };
