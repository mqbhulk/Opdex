"use strict";

const path = require("node:path");
const { app, BrowserWindow, dialog, shell } = require("electron");
const { isLocalBridgeUrl } = require("./bridge-utils");

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow;
let bridge;
let shuttingDown = false;

async function createMainWindow() {
  process.env.OPDEX_DATA_ROOT = app.isPackaged
    ? path.join(process.resourcesPath, "data")
    : path.resolve(__dirname, "..", "data");

  bridge = require("./server");
  const bridgeUrl = await bridge.startServer({ host: "127.0.0.1", port: 0 });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#111827",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isLocalBridgeUrl(url, bridgeUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
    }
  });

  try {
    await mainWindow.loadURL(bridgeUrl);
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Opdex could not start",
      message: "The local UI server failed to load.",
      detail: error.message,
    });
    app.quit();
  }
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  if (gotSingleInstanceLock) {
    createMainWindow().catch(async (error) => {
      await dialog.showMessageBox({
        type: "error",
        title: "Opdex could not start",
        message: "The desktop bridge failed to start.",
        detail: error.message,
      });
      app.quit();
    });
  }
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", (event) => {
  if (!bridge || shuttingDown) {
    return;
  }
  event.preventDefault();
  shuttingDown = true;
  bridge.stopServer().finally(() => app.quit());
});

module.exports = { isLocalBridgeUrl };
