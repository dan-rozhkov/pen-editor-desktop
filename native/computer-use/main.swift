import Foundation
import AppKit
import ApplicationServices

signal(SIGPIPE, SIG_IGN)

// A window-server connection is needed by CoreGraphics / ScreenCaptureKit. No Dock icon.
let nsApp = NSApplication.shared
nsApp.setActivationPolicy(.prohibited)

/// AX commands run on one serial queue PER PID (created lazily), so a slow app never blocks another one.
/// Commands without a pid share `axSharedQueue`. Physical input stays on ONE global queue (`inputQueue`).
let axSharedQueue = DispatchQueue(label: "sideform.cu.ax")
private var axQueues: [pid_t: DispatchQueue] = [:]
private let axQueuesLock = NSLock()

func axQueue(for pid: pid_t) -> DispatchQueue {
    axQueuesLock.lock()
    defer { axQueuesLock.unlock() }
    if let q = axQueues[pid] { return q }
    let q = DispatchQueue(label: "sideform.cu.ax.\(pid)")
    axQueues[pid] = q
    return q
}

/// Forgets a pid's queue (its app ended). Work already queued on it still runs to its end.
func removeAxQueue(_ pid: pid_t) {
    axQueuesLock.lock()
    axQueues[pid] = nil
    axQueuesLock.unlock()
}

/// The queue for a command: the pid's queue when the request carries a valid pid, else the shared one.
private func axQueue(_ obj: JSON) -> DispatchQueue {
    if let p = obj.int("pid"), p > 0 { return axQueue(for: pid_t(p)) }
    return axSharedQueue
}
let inputQueue = DispatchQueue(label: "sideform.cu.input")
let miscQueue = DispatchQueue(label: "sideform.cu.misc")

// Child AX elements otherwise use the 6 s default messaging timeout.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)

private func sync(_ r: Responder, _ body: @escaping () throws -> JSON) {
    // The watchdog already answered (TIMEOUT): the caller was told the action failed, so it must never run late.
    if r.isFinished {
        logErr("skipped a queued command that already timed out (id \(r.id))")
        return
    }
    do { r.finish(.success(try body())) }
    catch let e as CmdError { r.finish(.failure(e)) }
    catch { r.finish(.failure(fail("\(error)", "INTERNAL"))) }
}

func handle(_ line: String) {
    // Arrival time of the request: the watchdog starts now, so mutation deadlines count from here.
    let arrivedAt = Date().timeIntervalSince1970
    guard let data = line.data(using: .utf8),
          let parsed = (try? JSONSerialization.jsonObject(with: data)) as? JSON else {
        Output.shared.send(["id": NSNull(), "ok": false, "error": "Request is not a JSON object.", "code": "BAD_ARGS"])
        return
    }
    var stamped = parsed
    stamped["_arrivedAt"] = arrivedAt
    let obj = stamped
    let r = Responder(id: obj["id"] ?? NSNull())
    guard let cmd = obj["cmd"] as? String else {
        r.finish(.failure(fail("cmd is required", "BAD_ARGS")))
        return
    }
    let timeout: Double
    switch cmd {
    // snapshot/read may wait up to 4 s for a Chromium AX tree to come back (Accessibility.swift).
    case "snapshot", "read": timeout = 9
    case "screenshot", "perform", "axScroll": timeout = 5
    case "type": timeout = 10
    default: timeout = 2
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
        r.finish(.failure(fail("\(cmd) timed out after \(Int(timeout)) s.", "TIMEOUT")))
    }
    switch cmd {
    case "ping": miscQueue.async { sync(r) { ["version": 1] } }
    case "permissions": miscQueue.async { sync(r) { cmdPermissions(obj) } }
    case "listApps": miscQueue.async { sync(r) { cmdListApps() } }
    case "watch": miscQueue.async { sync(r) { try cmdWatch(obj) } }
    case "windows": axQueue(obj).async { sync(r) { try cmdWindows(obj) } }
    case "snapshot": axQueue(obj).async { sync(r) { try cmdSnapshot(obj) } }
    case "perform": axQueue(obj).async { sync(r) { try cmdPerform(obj) } }
    case "axScroll": axQueue(obj).async { sync(r) { try cmdAxScroll(obj) } }
    case "elementFrame": axQueue(obj).async { sync(r) { try cmdElementFrame(obj) } }
    case "read": axQueue(obj).async { sync(r) { try cmdRead(obj) } }
    case "screenshot": miscQueue.async { cmdScreenshot(obj) { r.finish($0) } }
    case "click": inputQueue.async { sync(r) { try cmdClick(obj) } }
    case "move": inputQueue.async { sync(r) { try cmdMove(obj) } }
    case "scroll": inputQueue.async { sync(r) { try cmdScroll(obj) } }
    case "type": inputQueue.async { sync(r) { try cmdType(obj) } }
    case "key": inputQueue.async { sync(r) { try cmdKey(obj) } }
    case "activate": inputQueue.async { sync(r) { try cmdActivate(obj) } }
    default: r.finish(.failure(fail("Unknown cmd \(cmd).", "BAD_ARGS")))
    }
}

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        handle(line)
    }
    exit(0) // stdin closed: the parent is gone
}
reader.start()
logErr("started, pid \(getpid())")
nsApp.run()
