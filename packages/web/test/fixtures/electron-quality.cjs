const { app, BrowserWindow } = require("electron");
const path = require("node:path");

// 隔离的隐藏测试窗口，不读写正式应用 userData、不建立 Host 或 Agent。
// Electron 保留调试参数，不能用固定 argv 下标把脚本路径误当作 userData。
const fixtureUrl = process.argv
  .find((arg) => arg.startsWith("--quality-url="))
  .slice("--quality-url=".length);
const userData = process.argv
  .find((arg) => arg.startsWith("--quality-user-data="))
  .slice("--quality-user-data=".length);
app.setPath("userData", path.resolve(userData));
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(fixtureUrl);
});
app.on("window-all-closed", () => app.quit());
