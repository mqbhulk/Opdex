"use strict";

function validDeviceHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) {
    return false;
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return host.split(".").every((part) => Number(part) <= 255);
  }
  if (!host.toLowerCase().endsWith(".local")) {
    return false;
  }
  return host
    .split(".")
    .every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function isLocalBridgeUrl(value, bridgeUrl) {
  try {
    const target = new URL(value);
    const bridge = new URL(bridgeUrl);
    return target.origin === bridge.origin;
  } catch {
    return false;
  }
}

module.exports = { validDeviceHost, isLocalBridgeUrl };
