// 输出「系统设置」主窗口的屏幕几何，供 CUA 权限浮窗吸附定位。
//
// 为什么需要这个独立二进制：吸附只需要一个数据 —— 系统设置窗口的 bounds。取它的正确 API 是
// CGWindowListCopyWindowInfo，而它**不需要任何 TCC 权限**（只有取窗口*图像*才需要 Screen
// Recording）。这一点是整个方案成立的前提：授权引导运行时恰恰还没有辅助功能/录屏权限。
// Electron 侧没有这个 API 的绑定，其余途径都不通 —— osascript + System Events 需要辅助功能
// 权限（死结），desktopCapturer 只给窗口名不给 bounds，koffi 这类 FFI 自身是 native addon
// 需要 electron-rebuild。所以用一个不到 100KB、无 bundle 的命令行程序。
//
// 常驻设计：每 interval 输出一行 JSON。父进程只 spawn 一次并读 stdout —— 每帧起一个进程的
// 开销（~10ms × 每秒 7 次）完全不可接受。
//
// 用法：lcode-window-bounds [intervalMs]   默认 150ms

import CoreGraphics
import Foundation

let intervalMs = UInt32(CommandLine.arguments.dropFirst().first.flatMap { UInt32($0) } ?? 150)
// 系统设置在不同 macOS 版本/语言下的进程名不同；13+ 是 "System Settings"，更早是
// "System Preferences"，中文系统则是本地化名称。
let settingsOwners = ["System Settings", "System Preferences", "系统设置", "系統設定"]

// 行缓冲：父进程逐行读取，默认的全缓冲会让数据卡在 stdio 缓冲区里直到写满 4KB。
setvbuf(stdout, nil, _IOLBF, 0)

while true {
    var windows: [[String: Any]] = []

    if let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] {
        for window in list {
            guard let owner = window[kCGWindowOwnerName as String] as? String,
                settingsOwners.contains(where: { owner.contains($0) }),
                let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
                let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { continue }

            windows.append([
                "x": rect.origin.x,
                "y": rect.origin.y,
                "w": rect.size.width,
                "h": rect.size.height,
                // 消费方只认 layer 0（普通窗口）。设置页还会带出 layer > 0 的辅助层
                // （工具提示、弹出选择器），吸附到它们会把面板扔到屏幕角落。
                "layer": window[kCGWindowLayer as String] as? Int ?? -1,
            ])
        }
    }

    // 即使没有匹配窗口也输出空数组：父进程据此知道「设置页已关闭」而不是「探测挂了」。
    if let data = try? JSONSerialization.data(withJSONObject: windows),
        let line = String(data: data, encoding: .utf8)
    {
        print(line)
    }

    usleep(intervalMs * 1000)
}
