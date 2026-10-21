import Foundation
import AppKit
import ApplicationServices

func cmdPermissions(_ a: JSON) -> JSON {
    var ax = AXIsProcessTrusted()
    var sr = CGPreflightScreenCaptureAccess()
    if a.bool("prompt") == true {
        if !ax {
            ax = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        }
        if !sr {
            sr = CGRequestScreenCaptureAccess()
        }
    }
    return ["accessibility": ax, "screenRecording": sr]
}

func cmdListApps() -> JSON {
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && !$0.isTerminated }
        .map { app -> JSON in
            var o: JSON = [
                "pid": Int(app.processIdentifier),
                "name": app.localizedName ?? app.bundleURL?.deletingPathExtension().lastPathComponent ?? "pid \(app.processIdentifier)",
                "active": app.isActive,
                "hidden": app.isHidden,
            ]
            if let b = app.bundleIdentifier { o["bundleId"] = b }
            if let p = app.bundleURL?.path { o["bundlePath"] = p }
            if let e = app.executableURL?.path { o["executablePath"] = e }
            return o
        }
    return ["apps": apps]
}

struct WinInfo {
    let ax: AXUIElement
    let id: UInt32
    let title: String
    let frame: CGRect
    let onScreen: Bool
    let minimized: Bool
    let main: Bool
    let focused: Bool

    var json: JSON {
        [
            "windowId": Int(id), "title": title,
            "x": finite(frame.origin.x), "y": finite(frame.origin.y),
            "width": finite(frame.size.width), "height": finite(frame.size.height),
        ]
    }
}

private struct CGWin {
    let id: UInt32
    let title: String
    let frame: CGRect
    let onScreen: Bool
}

private func cgWindows(_ pid: pid_t) -> [CGWin] {
    guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [CGWin] = []
    for w in list {
        guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let num = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let bounds = w[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { continue }
        out.append(CGWin(
            id: num,
            title: w[kCGWindowName as String] as? String ?? "",
            frame: frame,
            onScreen: (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
        ))
    }
    return out
}

private func boundsDistance(_ a: CGRect, _ b: CGRect) -> CGFloat {
    abs(a.origin.x - b.origin.x) + abs(a.origin.y - b.origin.y)
        + abs(a.size.width - b.size.width) + abs(a.size.height - b.size.height)
}

/// AX windows of the app, matched to CGWindowIDs of the same pid (layer 0): the closest bounds win,
/// every CG window is used once, and the title breaks ties. windowId 0 only when no CG window is left
/// (or the AX window has no area, like Finder's desktop).
func windowsFor(_ pid: pid_t) throws -> [WinInfo] {
    try requireAccessibility()
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    let axWins = axCopy(app, "AXWindows") as? [AXUIElement] ?? []
    let pool = cgWindows(pid)
    struct Ax { let el: AXUIElement; let frame: CGRect; let title: String; let minimized: Bool }
    var items: [Ax] = []
    for w in axWins {
        guard let frame = axFrame(w) else { continue }
        items.append(Ax(el: w, frame: frame, title: axString(w, "AXTitle") ?? "", minimized: axBool(w, "AXMinimized") ?? false))
    }
    var pairs: [(d: CGFloat, titleMiss: Int, ax: Int, cg: Int)] = []
    for (i, it) in items.enumerated() where it.frame.width > 0 && it.frame.height > 0 {
        for (j, c) in pool.enumerated() {
            pairs.append((boundsDistance(it.frame, c.frame), c.title == it.title ? 0 : 1, i, j))
        }
    }
    pairs.sort { ($0.d, $0.titleMiss, $0.ax, $0.cg) < ($1.d, $1.titleMiss, $1.ax, $1.cg) }
    var axToCg: [Int: Int] = [:]
    var usedCg = Set<Int>()
    for p in pairs where axToCg[p.ax] == nil && !usedCg.contains(p.cg) {
        axToCg[p.ax] = p.cg
        usedCg.insert(p.cg)
    }
    var out: [WinInfo] = []
    for (i, it) in items.enumerated() {
        var id: UInt32 = 0
        var onScreen = !it.minimized
        if let j = axToCg[i] {
            id = pool[j].id
            onScreen = pool[j].onScreen
        }
        out.append(WinInfo(
            ax: it.el, id: id, title: it.title, frame: it.frame, onScreen: onScreen, minimized: it.minimized,
            main: axBool(it.el, "AXMain") ?? false, focused: axBool(it.el, "AXFocused") ?? false
        ))
    }
    return out
}

func cmdWindows(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    _ = try runningApp(pid)
    let wins = try windowsFor(pid).map { w -> JSON in
        var o = w.json
        o["onScreen"] = w.onScreen
        o["minimized"] = w.minimized
        o["main"] = w.main
        o["focused"] = w.focused
        return o
    }
    return ["windows": wins]
}

private var watched = Set<pid_t>()
private var watchSources: [DispatchSourceProcess] = []
private let watchLock = NSLock()

func cmdWatch(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    _ = try runningApp(pid)
    watchLock.lock()
    defer { watchLock.unlock() }
    if watched.contains(pid) { return ["done": true] }
    let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .global())
    src.setEventHandler {
        src.cancel()
        watchLock.lock()
        let owned = watchSources.contains { $0 === src }
        watchSources.removeAll { $0 === src }
        if owned { watched.remove(pid) }
        watchLock.unlock()
        if owned { Output.shared.send(["event": "appTerminated", "pid": Int(pid)]) }
        axQueue.async { dropSnapshots(pid) }
    }
    src.resume()
    // The process may have exited before the source was registered: then no event ever comes.
    if kill(pid, 0) != 0 && errno == ESRCH {
        src.cancel()
        throw fail("No running app with pid \(pid).", "NOT_FOUND")
    }
    watched.insert(pid)
    watchSources.append(src)
    return ["done": true]
}

func cmdActivate(_ a: JSON) throws -> JSON {
    try activateApp(try a.pid())
    return ["done": true]
}

func activateApp(_ pid: pid_t) throws {
    let app = try runningApp(pid)
    if app.isHidden { app.unhide() }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return }
    // AXFrontmost works for any trusted process; activate() is only cooperative on macOS 14+.
    _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXFrontmost" as CFString, kCFBooleanTrue)
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid { app.activate() }
    for _ in 0..<20 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return }
        Thread.sleep(forTimeInterval: 0.03)
    }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return }
    throw fail("The app did not come to the front, so no input was sent. Ask the user to bring it to the front.", "NOT_FRONTMOST")
}
