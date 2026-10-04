"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { SerialPort } = require("serialport");
const { validDeviceHost } = require("./bridge-utils");
const { UsbSerialTransport } = require("./serial-bridge");

const HOST = "127.0.0.1";
const PORT = Number(process.env.OPDEX_BRIDGE_PORT || 8765);
const DATA_ROOT = path.resolve(process.env.OPDEX_DATA_ROOT || path.resolve(__dirname, "..", "data"));
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const transport = new UsbSerialTransport(SerialPort);
let connection = { mode: "wifi", host: "openhaldex.local" };

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function readBody(request, limit = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let overflow = false;
    request.on("data", (chunk) => {
      if (overflow) {
        return;
      }
      length += chunk.length;
      if (length > limit) {
        overflow = true;
        const error = new Error(`Request body exceeds ${limit} bytes.`);
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!overflow) {
        resolve(Buffer.concat(chunks, length));
      }
    });
    request.on("error", reject);
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".dbc": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
  }[ext] || "application/octet-stream";
}

async function sendDeviceRequest(request, response, body) {
  const parsed = new URL(request.url, `http://${HOST}:${PORT}`);
  if (connection.mode === "usb") {
    if (!transport.status().connected) {
      sendJson(response, 503, { error: "USB board is not connected." });
      return;
    }
    const result = await transport.request(
      request.method,
      `${parsed.pathname}${parsed.search}`,
      body,
      request.headers["content-type"] || "",
    );
    const responseBody = Buffer.from(String(result.body || ""));
    const headers = {
      "content-type": result.contentType || "application/json",
      "content-length": responseBody.length,
      "cache-control": "no-store",
    };
    if (result.headerName === "Content-Disposition") {
      headers["content-disposition"] = result.headerValue;
    } else if (result.headerName === "Cache-Control") {
      headers["cache-control"] = result.headerValue;
    }
    response.writeHead(Number(result.status) || 502, headers);
    response.end(responseBody);
    return;
  }

  const upstream = await fetch(`http://${connection.host}${parsed.pathname}${parsed.search}`, {
    method: request.method,
    headers: request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {},
    body: body.length ? body : undefined,
  });
  const responseBody = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/octet-stream",
    "content-length": responseBody.length,
    "cache-control": "no-store",
  });
  response.end(responseBody);
}

async function isWifiDeviceReachable(host) {
  try {
    const response = await fetch(`http://${host}/api/status`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function sendStatic(request, response) {
  const parsed = new URL(request.url, `http://${HOST}:${PORT}`);
  let relativePath;
  try {
    relativePath = decodeURIComponent(parsed.pathname === "/" ? "/index.html" : parsed.pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid asset path." });
    return;
  }
  const filePath = path.resolve(DATA_ROOT, `.${relativePath}`);
  const relativeToRoot = path.relative(DATA_ROOT, filePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    sendJson(response, 403, { error: "Asset path is outside the UI directory." });
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(response, 404, { error: "UI asset not found." });
      return;
    }
    response.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "content-length": stats.size,
      "cache-control": "no-cache",
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      fs.createReadStream(filePath).pipe(response);
    }
  });
}

async function handleRequest(request, response) {
  const parsed = new URL(request.url, `http://${HOST}:${PORT}`);
  if (request.method === "GET" && parsed.pathname === "/bridge/status") {
    const wifiConnected =
      connection.mode === "wifi" ? await isWifiDeviceReachable(connection.host) : false;
    sendJson(response, 200, {
      mode: connection.mode,
      host: connection.host,
      wifiConnected,
      usb: transport.status(),
    });
    return;
  }
  if (request.method === "GET" && parsed.pathname === "/bridge/ports") {
    sendJson(response, 200, { ports: await UsbSerialTransport.listPorts(SerialPort) });
    return;
  }
  if (request.method === "POST" && parsed.pathname === "/bridge/connection") {
    const body = await readBody(request, 8192);
    let input;
    try {
      input = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(response, 400, { error: "Expected a JSON connection request." });
      return;
    }
    if (input.mode === "usb") {
      const status = await transport.connect(input.port);
      connection = { mode: "usb", host: connection.host };
      sendJson(response, 200, { mode: connection.mode, usb: status });
      return;
    }
    if (input.mode === "wifi") {
      const host = input.host || connection.host;
      if (!validDeviceHost(host)) {
        sendJson(response, 400, { error: "Enter a valid device hostname or IPv4 address." });
        return;
      }
      await transport.disconnect();
      connection = { mode: "wifi", host };
      sendJson(response, 200, { mode: connection.mode, host: connection.host });
      return;
    }
    sendJson(response, 400, { error: "Connection mode must be wifi or usb." });
    return;
  }

  if (parsed.pathname.startsWith("/api/") || parsed.pathname === "/ota/update") {
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      sendJson(response, 405, { error: "HTTP method is not supported by the device bridge." });
      return;
    }
    const body = request.method === "GET" || request.method === "DELETE" ? Buffer.alloc(0) : await readBody(request);
    await sendDeviceRequest(request, response, body);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "UI assets are read-only." });
    return;
  }
  sendStatic(request, response);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (response.headersSent || response.destroyed) {
      response.destroy(error);
      return;
    }
    sendJson(response, error.statusCode || 502, { error: error.message || "Device bridge request failed." });
  });
});
server.requestTimeout = 15 * 60 * 1000;

function startServer(options = {}) {
  const host = options.host || HOST;
  const port = options.port === undefined ? PORT : options.port;
  if (server.listening) {
    const address = server.address();
    return Promise.resolve(`http://${host}:${address.port}`);
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(`http://${host}:${address.port}`);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function stopServer() {
  await transport.disconnect();
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

module.exports = { server, transport, startServer, stopServer, validDeviceHost };

if (require.main === module) {
  startServer().then((url) => {
    console.log(`OpenHaldex USB bridge listening at ${url}`);
    console.log("Set the Nativefier target URL to this address.");
  }).catch((error) => {
    console.error(`Unable to start OpenHaldex USB bridge: ${error.message}`);
    process.exitCode = 1;
  });

  process.on("SIGINT", () => stopServer().finally(() => process.exit(0)));
  process.on("SIGTERM", () => stopServer().finally(() => process.exit(0)));
}
