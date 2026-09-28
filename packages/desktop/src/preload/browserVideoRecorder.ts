import { ipcRenderer } from "electron";

const RECORDER_PORT_CHANNEL = "lcode-browser-video-recorder:port";

// MessagePort 不能经 contextBridge 代理；专用 preload 只把 main 定向发送的 port 转交给
// 同一个受信任 recorder 文档，不暴露 ipcRenderer 或任何通用 Electron 能力。
ipcRenderer.once(RECORDER_PORT_CHANNEL, (event) => {
  const [port] = event.ports;
  if (port) window.postMessage(RECORDER_PORT_CHANNEL, "*", [port]);
});
