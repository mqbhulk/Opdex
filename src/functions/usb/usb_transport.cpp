#include "functions/usb/usb_transport.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <Update.h>
#include <mbedtls/base64.h>
#include <string.h>

#include "functions/api/api.h"
#include "functions/storage/filelog.h"
#include "functions/storage/storage.h"

#ifndef OPENHALDEX_VERSION
#define OPENHALDEX_VERSION "dev"
#endif

static constexpr char kProtocolPrefix[] = "OHUSB/1 ";
static constexpr char kBodyPath[] = "/usb-request.tmp";
static constexpr size_t kMaxLineBytes = 12288;
static constexpr size_t kInlineBodyBytes = 4096;
static constexpr size_t kMaxApiBodyBytes = 128 * 1024;
static constexpr size_t kChunkBytes = 3072;
static constexpr size_t kMaxResponseBytes = 128 * 1024;
static constexpr size_t kMaxRequestBodyBytes = 4 * 1024 * 1024;
static constexpr uint32_t kSerialReadTimeoutMs = 5000;

class SerialProtocolScope {
public:
  SerialProtocolScope() { filelogSetSerialProtocolActive(true); }
  ~SerialProtocolScope() { filelogSetSerialProtocolActive(false); }
};

static bool readLine(String& line, uint32_t timeout_ms) {
  line = "";
  line.reserve(256);
  const uint32_t started = millis();

  while ((millis() - started) < timeout_ms) {
    while (Serial.available() > 0) {
      const int value = Serial.read();
      if (value < 0) {
        break;
      }
      if (value == '\n') {
        line.trim();
        return true;
      }
      if (value != '\r') {
        if (line.length() >= kMaxLineBytes) {
          while (Serial.available() > 0 && Serial.read() != '\n') {
          }
          return false;
        }
        line += (char)value;
      }
    }
    delay(1);
  }
  return false;
}

static void sendEnvelope(JsonDocument& response) {
  String payload;
  serializeJson(response, payload);
  Serial.print(kProtocolPrefix);
  Serial.println(payload);
}

static void sendError(const String& id, int status, const char* message) {
  JsonDocument response;
  response["op"] = "response";
  response["id"] = id;
  response["status"] = status;
  response["contentType"] = "application/json";
  JsonDocument error;
  error["error"] = message;
  String body;
  serializeJson(error, body);
  response["body"] = body;
  sendEnvelope(response);
}

static bool safeApiPath(const String& path) {
  return path.startsWith("/api/") || path == "/ota/update";
}

static bool supportedMethod(const String& method) {
  return method == "GET" || method == "POST" || method == "PUT" || method == "PATCH" || method == "DELETE";
}

static bool decodeChunk(const JsonDocument& doc, uint8_t* output, size_t output_capacity, size_t& output_length) {
  const char* encoded = doc["data"] | "";
  const size_t encoded_length = strlen(encoded);
  if (encoded_length == 0 || encoded_length > 8192) {
    return false;
  }
  size_t decoded_length = 0;
  const int result = mbedtls_base64_decode(output, output_capacity, &decoded_length,
                                           reinterpret_cast<const unsigned char*>(encoded), encoded_length);
  if (result != 0) {
    return false;
  }
  output_length = decoded_length;
  return true;
}

static bool receiveStreamedBody(const String& id, size_t body_length) {
  if (!storageFsReady()) {
    sendError(id, 500, "Device filesystem is not ready for USB request data");
    return false;
  }
  LittleFS.remove(kBodyPath);

  const size_t fs_total = LittleFS.totalBytes();
  const size_t fs_used = LittleFS.usedBytes();
  if (body_length > kMaxRequestBodyBytes || fs_used > fs_total || body_length > (fs_total - fs_used)) {
    sendError(id, 413, "USB request body exceeds available device storage");
    return false;
  }

  File body = LittleFS.open(kBodyPath, "w");
  if (!body) {
    sendError(id, 500, "Unable to create temporary USB request body");
    return false;
  }

  JsonDocument ready;
  ready["op"] = "ready";
  ready["id"] = id;
  sendEnvelope(ready);

  size_t received = 0;
  size_t expected_sequence = 0;
  uint8_t decoded[kChunkBytes];
  while (received < body_length) {
    String line;
    if (!readLine(line, kSerialReadTimeoutMs) || !line.startsWith(kProtocolPrefix)) {
      body.close();
      LittleFS.remove(kBodyPath);
      sendError(id, 408, "Timed out waiting for USB body data");
      return false;
    }

    JsonDocument chunk;
    if (deserializeJson(chunk, line.substring(sizeof(kProtocolPrefix) - 1)) != DeserializationError::Ok ||
        chunk["op"] != "chunk" || String(chunk["id"] | "") != id ||
        (size_t)(chunk["sequence"] | SIZE_MAX) != expected_sequence) {
      body.close();
      LittleFS.remove(kBodyPath);
      sendError(id, 400, "Invalid USB body chunk");
      return false;
    }

    size_t decoded_length = 0;
    if (!decodeChunk(chunk, decoded, sizeof(decoded), decoded_length) || decoded_length == 0 ||
        decoded_length > body_length - received || body.write(decoded, decoded_length) != decoded_length) {
      body.close();
      LittleFS.remove(kBodyPath);
      sendError(id, 400, "Invalid or unwritable USB body chunk");
      return false;
    }

    received += decoded_length;
    JsonDocument ack;
    ack["op"] = "ack";
    ack["id"] = id;
    ack["sequence"] = expected_sequence;
    sendEnvelope(ack);
    expected_sequence++;
  }
  body.close();
  return true;
}

static bool readRequestBodyFile(String& body) {
  File file = LittleFS.open(kBodyPath, "r");
  if (!file) {
    return false;
  }
  const size_t body_size = file.size();
  if (body_size > kMaxApiBodyBytes) {
    file.close();
    return false;
  }

  body.reserve(body_size);
  uint8_t buffer[1024];
  while (file.available() > 0) {
    const size_t count = file.read(buffer, sizeof(buffer));
    if (count == 0) {
      file.close();
      return false;
    }
    body.concat(reinterpret_cast<const char*>(buffer), count);
  }
  file.close();
  return body.length() == body_size;
}

static bool parseMultipartBoundary(const String& content_type, String& boundary) {
  const int boundary_index = content_type.indexOf("boundary=");
  if (boundary_index < 0) {
    return false;
  }
  boundary = content_type.substring(boundary_index + 9);
  boundary.trim();
  if (boundary.startsWith("\"") && boundary.endsWith("\"") && boundary.length() >= 2) {
    boundary = boundary.substring(1, boundary.length() - 1);
  }
  return boundary.length() > 0 && boundary.length() <= 200 && boundary.indexOf('\r') < 0 &&
         boundary.indexOf('\n') < 0;
}

static bool fileMatches(File& file, size_t offset, const String& expected) {
  if (offset + expected.length() > file.size() || !file.seek(offset)) {
    return false;
  }
  for (size_t i = 0; i < expected.length(); i++) {
    if (file.read() != (uint8_t)expected[i]) {
      return false;
    }
  }
  return true;
}

static bool installMultipartFirmware(const String& id, const String& content_type) {
  String boundary;
  if (!parseMultipartBoundary(content_type, boundary)) {
    sendError(id, 400, "Missing multipart boundary");
    return false;
  }

  File file = LittleFS.open(kBodyPath, "r");
  if (!file) {
    sendError(id, 500, "Unable to read uploaded firmware");
    return false;
  }

  String header;
  header.reserve(512);
  bool header_complete = false;
  while (file.available() > 0 && header.length() < 4096) {
    header += (char)file.read();
    if (header.endsWith("\r\n\r\n")) {
      header_complete = true;
      break;
    }
  }
  if (!header_complete || !header.startsWith("--" + boundary + "\r\n") || header.indexOf("filename=") < 0) {
    file.close();
    sendError(id, 400, "Invalid firmware multipart upload");
    return false;
  }

  const size_t content_start = file.position();
  const String ending = "\r\n--" + boundary + "--\r\n";
  const String ending_without_crlf = "\r\n--" + boundary + "--";
  const size_t file_size = file.size();
  size_t content_end = 0;
  if (file_size >= ending.length() && fileMatches(file, file_size - ending.length(), ending)) {
    content_end = file_size - ending.length();
  } else if (file_size >= ending_without_crlf.length() &&
             fileMatches(file, file_size - ending_without_crlf.length(), ending_without_crlf)) {
    content_end = file_size - ending_without_crlf.length();
  } else {
    file.close();
    sendError(id, 400, "Invalid firmware multipart terminator");
    return false;
  }
  if (content_end < content_start || content_end == content_start || !file.seek(content_start)) {
    file.close();
    sendError(id, 400, "Firmware upload is empty or malformed");
    return false;
  }

  const size_t firmware_size = content_end - content_start;
  if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
    file.close();
    sendError(id, 500, "Unable to start firmware update");
    return false;
  }

  uint8_t buffer[4096];
  size_t remaining = firmware_size;
  while (remaining > 0) {
    const size_t requested = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
    const size_t count = file.read(buffer, requested);
    if (count == 0 || Update.write(buffer, count) != count) {
      file.close();
      Update.abort();
      sendError(id, 500, "Firmware write failed");
      return false;
    }
    remaining -= count;
  }
  file.close();
  if (!Update.end(true)) {
    sendError(id, 500, "Firmware image validation failed");
    return false;
  }
  return true;
}

static void sendApiResponse(const String& id, int status, const String& content_type, const String& body,
                            const String& header_name = "", const String& header_value = "") {
  JsonDocument response;
  response["op"] = "response";
  response["id"] = id;
  response["status"] = status;
  response["contentType"] = content_type;
  response["body"] = body;
  if (header_name.length() > 0) {
    response["headerName"] = header_name;
    response["headerValue"] = header_value;
  }
  sendEnvelope(response);
}

static void handleRequest(const JsonDocument& request) {
  const String id = request["id"] | "";
  const String method = request["method"] | "";
  const String path = request["path"] | "";
  const String content_type = request["contentType"] | "";

  if (id.length() == 0 || id.length() > 64 || !supportedMethod(method) || !safeApiPath(path)) {
    sendError(id, 400, "Invalid USB API request");
    return;
  }

  const bool streamed = request["stream"] | false;
  const size_t body_length = request["bodyLength"] | 0;
  String inline_body;
  if (streamed) {
    if (body_length == 0) {
      sendError(id, 400, "Streamed USB request body is empty");
      return;
    }
    if (!receiveStreamedBody(id, body_length)) {
      return;
    }
  } else {
    inline_body = request["body"] | "";
    if (inline_body.length() > kInlineBodyBytes) {
      sendError(id, 413, "Inline USB request body is too large");
      return;
    }
  }

  if (path == "/ota/update") {
    if (method != "POST" || !streamed) {
      LittleFS.remove(kBodyPath);
      sendError(id, 400, "Firmware upload must use a streamed multipart POST");
      return;
    }
    const bool updated = installMultipartFirmware(id, content_type);
    LittleFS.remove(kBodyPath);
    if (updated) {
      sendApiResponse(id, 200, "text/plain", "OK");
      Serial.flush();
      delay(100);
      ESP.restart();
    }
    return;
  }

  String body = inline_body;
  if (streamed && !readRequestBodyFile(body)) {
    LittleFS.remove(kBodyPath);
    sendError(id, 413, "USB API request body exceeds the direct-dispatch limit");
    return;
  }
  LittleFS.remove(kBodyPath);

  int status = 0;
  String response_content_type;
  String response_body;
  String response_header_name;
  String response_header_value;
  if (!apiDispatchUsb(method, path, body, status, response_content_type, response_body, response_header_name,
                      response_header_value)) {
    sendError(id, 404, "API route not found");
    return;
  }
  if (response_body.length() > kMaxResponseBytes) {
    sendError(id, 502, "API response exceeds USB transport limit");
    return;
  }
  sendApiResponse(id, status, response_content_type, response_body, response_header_name, response_header_value);
}

void usbTransportProcess() {
  if (Serial.available() <= 0) {
    return;
  }

  String line;
  if (!readLine(line, kSerialReadTimeoutMs) || !line.startsWith(kProtocolPrefix)) {
    return;
  }

  SerialProtocolScope protocol_scope;
  JsonDocument request;
  if (deserializeJson(request, line.substring(sizeof(kProtocolPrefix) - 1)) != DeserializationError::Ok) {
    sendError("", 400, "Malformed USB protocol envelope");
    return;
  }

  const String operation = request["op"] | "";
  if (operation == "hello") {
    JsonDocument response;
    response["op"] = "hello";
    response["id"] = request["id"] | "";
    response["protocol"] = "opdex-usb-v1";
    response["version"] = OPENHALDEX_VERSION;
    sendEnvelope(response);
  } else if (operation == "request") {
    handleRequest(request);
  } else {
    sendError(request["id"] | "", 400, "Unsupported USB protocol operation");
  }
}
