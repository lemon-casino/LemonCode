import AppKit
import CoreFoundation
import Darwin
import Foundation

private let maxInputLineBytes = 48 * 1024 * 1024
private let maxPngBytes = 32 * 1024 * 1024
private let maxBase64Bytes = ((maxPngBytes + 2) / 3) * 4
private let maxImageDimension = 16_384
private let maxDecodedPixelCount = 40_000_000
private let maxTitleBytes = 256
private let maxCommandIdBytes = 128
private let pngSignature: [UInt8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
private let readyFrame = Data("{\"type\":\"ready\",\"version\":1}\n".utf8)
private let failureLine = Data("Computer Use PiP presenter rejected its input.\n".utf8)

private enum PresenterCommand {
    case show(id: String, png: Data, width: Int, height: Int, title: String?)
    case hide(id: String)
    case close(id: String)
}

private struct InvalidPresenterCommand: Error {
    let id: String?

    init(id: String? = nil) {
        self.id = id
    }
}

private func writeApplied(id: String) {
    FileHandle.standardOutput.write(Data("{\"id\":\"\(id)\",\"type\":\"applied\"}\n".utf8))
}

private func writeError(id: String) {
    FileHandle.standardOutput.write(
        Data("{\"id\":\"\(id)\",\"type\":\"error\",\"error\":\"invalid_command\"}\n".utf8)
    )
}

private func requireCommandId(_ value: Any?) throws -> String {
    guard let id = value as? String,
        !id.isEmpty,
        id.utf8.count <= maxCommandIdBytes,
        id.utf8.allSatisfy({
            ($0 >= 0x30 && $0 <= 0x39)
                || ($0 >= 0x41 && $0 <= 0x5a)
                || ($0 >= 0x61 && $0 <= 0x7a)
                || $0 == 0x2d || $0 == 0x2e || $0 == 0x3a || $0 == 0x5f
        })
    else {
        throw InvalidPresenterCommand()
    }
    return id
}

private func requireInteger(_ value: Any?, maximum: Int) throws -> Int {
    guard let number = value as? NSNumber,
        CFGetTypeID(number as CFTypeRef) != CFBooleanGetTypeID()
    else {
        throw InvalidPresenterCommand()
    }
    let doubleValue = number.doubleValue
    guard doubleValue.isFinite,
        doubleValue.rounded(.towardZero) == doubleValue,
        doubleValue > 0,
        doubleValue <= Double(maximum)
    else {
        throw InvalidPresenterCommand()
    }
    return Int(doubleValue)
}

private func parsePng(_ encoded: String, width: Int, height: Int) throws -> Data {
    guard !encoded.isEmpty, encoded.utf8.count <= maxBase64Bytes,
        let png = Data(base64Encoded: encoded),
        png.count <= maxPngBytes,
        png.base64EncodedString() == encoded
    else {
        throw InvalidPresenterCommand()
    }

    let header = [UInt8](png.prefix(24))
    guard header.count == 24,
        header.prefix(8).elementsEqual(pngSignature),
        header[12...15].elementsEqual([0x49, 0x48, 0x44, 0x52])
    else {
        throw InvalidPresenterCommand()
    }

    func readUInt32(_ offset: Int) -> Int {
        header[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) }
    }

    guard readUInt32(16) == width, readUInt32(20) == height else {
        throw InvalidPresenterCommand()
    }
    let (pixelCount, overflow) = width.multipliedReportingOverflow(by: height)
    guard !overflow, pixelCount <= maxDecodedPixelCount else {
        throw InvalidPresenterCommand()
    }
    return png
}

private func parsePresenterCommand(_ line: Data) throws -> PresenterCommand {
    // 只接受 JSON object 的 UTF-8 单行规范形状；拒绝外围空白可避免多种等价线格式
    // 在父子进程间形成不同的解析结果。
    guard line.first == 0x7b, line.last == 0x7d,
        String(data: line, encoding: .utf8) != nil,
        let object = try JSONSerialization.jsonObject(with: line) as? [String: Any]
    else {
        throw InvalidPresenterCommand()
    }

    // 先固定可信 id，再校验 type 和负载；否则合法 id 搭配坏 type 时会丢失关联，
    // Helper 无法把 presenter 的失败结算到对应命令。
    let id = try requireCommandId(object["id"])
    let keys = Set(object.keys)
    do {
        guard let type = object["type"] as? String else {
            throw InvalidPresenterCommand()
        }
        switch type {
        case "show":
            let requiredKeys: Set<String> = ["id", "type", "pngBase64", "width", "height"]
            let allowedKeys = requiredKeys.union(["title"])
            guard requiredKeys.isSubset(of: keys), keys.isSubset(of: allowedKeys),
                let encoded = object["pngBase64"] as? String
            else {
                throw InvalidPresenterCommand()
            }
            let width = try requireInteger(object["width"], maximum: maxImageDimension)
            let height = try requireInteger(object["height"], maximum: maxImageDimension)
            var title: String?
            if let rawTitle = object["title"] {
                guard let candidate = rawTitle as? String,
                    candidate.utf8.count <= maxTitleBytes,
                    !candidate.unicodeScalars.contains(where: {
                        CharacterSet.controlCharacters.contains($0)
                    })
                else {
                    throw InvalidPresenterCommand()
                }
                title = candidate.isEmpty ? nil : candidate
            }
            return .show(
                id: id,
                png: try parsePng(encoded, width: width, height: height),
                width: width,
                height: height,
                title: title
            )
        case "hide":
            guard keys == Set(["id", "type"]) else { throw InvalidPresenterCommand() }
            return .hide(id: id)
        case "close":
            guard keys == Set(["id", "type"]) else { throw InvalidPresenterCommand() }
            return .close(id: id)
        default:
            throw InvalidPresenterCommand()
        }
    } catch {
        throw InvalidPresenterCommand(id: id)
    }
}

private final class PassivePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class PresenterWindowController {
    private let panel: PassivePanel
    private let rootView = NSView()
    private let imageView = NSImageView()
    private let titleLabel = NSTextField(labelWithString: "")

    init() {
        panel = PassivePanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.animationBehavior = .utilityWindow
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.isExcludedFromWindowsMenu = true

        rootView.wantsLayer = true
        rootView.layer?.backgroundColor =
            NSColor.windowBackgroundColor.withAlphaComponent(0.96).cgColor
        rootView.layer?.cornerRadius = 8
        rootView.layer?.masksToBounds = true
        rootView.autoresizingMask = [.width, .height]

        imageView.imageAlignment = .alignCenter
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageFrameStyle = .none
        imageView.wantsLayer = true
        imageView.layer?.backgroundColor = NSColor.black.cgColor

        titleLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.maximumNumberOfLines = 1

        rootView.addSubview(imageView)
        rootView.addSubview(titleLabel)
        panel.contentView = rootView
    }

    func show(png: Data, width: Int, height: Int, title: String?) throws {
        // 头部校验限制了解码预算，但仍需让 AppKit 真正解码一次，避免合法 IHDR 包装的损坏
        // 数据被当成可展示成功。
        guard let representation = NSBitmapImageRep(data: png),
            representation.pixelsWide == width,
            representation.pixelsHigh == height
        else {
            throw InvalidPresenterCommand()
        }
        let image = NSImage(size: NSSize(width: CGFloat(width), height: CGFloat(height)))
        image.addRepresentation(representation)
        imageView.image = image

        let screen = NSScreen.main ?? NSScreen.screens.first
        let visibleFrame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let maximumWidth = min(CGFloat(480), visibleFrame.width * 0.38)
        let maximumHeight = min(CGFloat(320), visibleFrame.height * 0.38)
        let scale = min(
            CGFloat(1),
            min(
                maximumWidth / CGFloat(width),
                maximumHeight / CGFloat(height)
            )
        )
        let imageWidth = max(CGFloat(200), floor(CGFloat(width) * scale))
        let imageHeight = max(CGFloat(120), floor(CGFloat(height) * scale))
        let padding: CGFloat = 10
        let titleHeight: CGFloat = title == nil ? 0 : 26
        let panelWidth = imageWidth + padding * 2
        let panelHeight = imageHeight + padding * 2 + titleHeight
        let origin = NSPoint(
            x: visibleFrame.maxX - panelWidth - 24,
            y: visibleFrame.minY + 24
        )

        panel.setFrame(
            NSRect(x: origin.x, y: origin.y, width: panelWidth, height: panelHeight),
            display: true
        )
        imageView.frame = NSRect(
            x: padding,
            y: padding,
            width: imageWidth,
            height: imageHeight
        )
        titleLabel.isHidden = title == nil
        titleLabel.stringValue = title ?? ""
        titleLabel.frame = NSRect(
            x: padding,
            y: padding + imageHeight,
            width: imageWidth,
            height: titleHeight
        )

        // orderFrontRegardless 只调整窗口顺序；配合 nonactivatingPanel 和 canBecomeKey=false，
        // 展示 PiP 不会切换当前应用，也不会夺走键盘焦点。
        panel.orderFrontRegardless()
    }

    func hide() {
        panel.orderOut(nil)
    }

    func close() {
        panel.orderOut(nil)
        panel.close()
    }
}

private final class StdinCommandReader {
    private let input = FileHandle.standardInput
    private let queue = DispatchQueue(label: "dev.zcode.cua-helper.pip-presenter.stdin")
    private var buffer = Data()
    private var stopped = false
    private var commandInFlight = false
    private let onCommand: (PresenterCommand) -> Void
    private let onFailure: (String?) -> Void
    private let onEnd: () -> Void

    init(
        onCommand: @escaping (PresenterCommand) -> Void,
        onFailure: @escaping (String?) -> Void,
        onEnd: @escaping () -> Void
    ) {
        self.onCommand = onCommand
        self.onFailure = onFailure
        self.onEnd = onEnd
    }

    func start() {
        listenForInput()
    }

    func resumeAfterApplied() {
        queue.async { [weak self] in
            guard let self, !stopped, commandInFlight else { return }
            commandInFlight = false
            if buffer.contains(0x0a) {
                // readabilityHandler 暂停后，系统同一读取块的尾部仍在 buffer；逐条恢复，
                // 避免多张大图在 AppKit 提交前无界排入 main queue。
                let pending = buffer
                buffer.removeAll(keepingCapacity: true)
                consume(pending)
            } else {
                listenForInput()
            }
        }
    }

    private func listenForInput() {
        input.readabilityHandler = { [weak self] handle in
            // 回调一触发就撤销监听，只允许一个系统读取块进入私有队列；否则主线程繁忙时
            // readabilityHandler 可持续读入数据，绕过单命令在途限制。
            handle.readabilityHandler = nil
            let chunk = handle.availableData
            self?.queue.async { [weak self] in
                guard let self, !stopped, !commandInFlight else { return }
                consume(chunk)
                if !stopped && !commandInFlight {
                    listenForInput()
                }
            }
        }
    }

    private func pauseReading() {
        input.readabilityHandler = nil
    }

    private func stopReading() {
        stopped = true
        pauseReading()
    }

    private func fail(id: String? = nil) {
        guard !stopped else { return }
        stopReading()
        DispatchQueue.main.async { [onFailure] in onFailure(id) }
    }

    private func consume(_ chunk: Data) {
        guard !stopped else { return }
        if chunk.isEmpty {
            let hasPartialFrame = !buffer.isEmpty
            stopReading()
            DispatchQueue.main.async { [onFailure, onEnd] in
                if hasPartialFrame { onFailure(nil) } else { onEnd() }
            }
            return
        }

        guard let newline = chunk.firstIndex(of: 0x0a) else {
            guard buffer.count + chunk.count <= maxInputLineBytes else {
                fail()
                return
            }
            buffer.append(chunk)
            return
        }

        let segment = chunk[..<newline]
        guard buffer.count + segment.count <= maxInputLineBytes else {
            fail()
            return
        }
        buffer.append(contentsOf: segment)
        if buffer.last == 0x0d { buffer.removeLast() }
        guard !buffer.isEmpty else {
            fail()
            return
        }
        let line = buffer
        let remainderStart = chunk.index(after: newline)
        let remainder = chunk[remainderStart...]
        guard remainder.count <= maxInputLineBytes else {
            fail()
            return
        }
        buffer = Data(remainder)
        do {
            let command = try parsePresenterCommand(line)
            commandInFlight = true
            pauseReading()
            DispatchQueue.main.async { [onCommand] in onCommand(command) }
            if case .close(_) = command {
                stopReading()
            }
        } catch let error as InvalidPresenterCommand {
            fail(id: error.id)
        } catch {
            fail()
        }
    }
}

private final class PresenterApplicationDelegate: NSObject, NSApplicationDelegate {
    private let controller = PresenterWindowController()
    private var reader: StdinCommandReader?
    private var terminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 首帧固定握手使 Helper 只在 AppKit 就绪后开放 PiP；后续 stdout 仅承载
        // 与命令 id 对应的 applied/error，避免把 stdin 写入成功误判为界面已更新。
        FileHandle.standardOutput.write(readyFrame)
        reader = StdinCommandReader(
            onCommand: { [weak self] command in self?.handle(command) },
            onFailure: { [weak self] id in self?.terminate(status: 1, errorId: id) },
            onEnd: { [weak self] in self?.terminate(status: 0) }
        )
        reader?.start()
    }

    private func handle(_ command: PresenterCommand) {
        guard !terminating else { return }
        switch command {
        case let .show(id, png, width, height, title):
            do {
                try controller.show(png: png, width: width, height: height, title: title)
                writeApplied(id: id)
                reader?.resumeAfterApplied()
            } catch {
                terminate(status: 1, errorId: id)
            }
        case let .hide(id):
            controller.hide()
            writeApplied(id: id)
            reader?.resumeAfterApplied()
        case let .close(id):
            terminate(status: 0, appliedId: id)
        }
    }

    private func terminate(status: Int32, appliedId: String? = nil, errorId: String? = nil) {
        guard !terminating else { return }
        terminating = true
        controller.close()
        if let appliedId {
            writeApplied(id: appliedId)
        }
        if status != 0 {
            if let errorId {
                writeError(id: errorId)
            }
            FileHandle.standardError.write(failureLine)
        }
        Darwin.exit(status)
    }
}

let application = NSApplication.shared
let applicationDelegate = PresenterApplicationDelegate()
application.delegate = applicationDelegate
_ = application.setActivationPolicy(.accessory)
application.run()
