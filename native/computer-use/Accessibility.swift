import Foundation
import AppKit
import ApplicationServices
import Darwin

// MARK: AX attribute helpers

func axCopy(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func axString(_ el: AXUIElement, _ name: String) -> String? {
    if let s = axCopy(el, name) as? String { return s }
    return nil
}

func axBool(_ el: AXUIElement, _ name: String) -> Bool? {
    guard let v = axCopy(el, name), CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }
    return CFBooleanGetValue((v as! CFBoolean))
}

func axElement(_ v: CFTypeRef?) -> AXUIElement? {
    guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    axCopy(el, "AXChildren") as? [AXUIElement] ?? []
}

func axActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success, let n = names as? [String] else { return [] }
    return n
}

private func frameOf(position p: CFTypeRef?, size s: CFTypeRef?) -> CGRect? {
    guard let p = p, let s = s,
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt),
          AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    frameOf(position: axCopy(el, "AXPosition"), size: axCopy(el, "AXSize"))
}

private func valueTextOf(_ v: CFTypeRef?) -> String? {
    guard let v = v else { return nil }
    if let s = v as? String { return s }
    if CFGetTypeID(v) == CFNumberGetTypeID() { return (v as! NSNumber).stringValue }
    return nil
}

func axValueText(_ el: AXUIElement) -> String? {
    valueTextOf(axCopy(el, "AXValue"))
}

// MARK: Read timeout policy
//
// Every read of the snapshot, read and lookup paths sets the messaging timeout on the element it is about to
// read: min(cap, time left to the command deadline), with cap 250 ms. A hung app then costs 250 ms per node,
// not 1 s, and never outlasts the command. The one-off window listing of the app element uses cap 1.0 s.
// Actions (perform, axScroll) keep 1.0 s: a press on a slow app may take longer. A timeout value of 0 would
// mean "global default", so the value never goes below 50 ms.

private let readTimeoutCap = 0.25

func axTimeout(_ el: AXUIElement, cap: Double, deadline: Date?) {
    let left = deadline.map { $0.timeIntervalSinceNow } ?? cap
    AXUIElementSetMessagingTimeout(el, Float(max(0.05, min(cap, left))))
}

// MARK: Batched node read

private let nodeAttrNames: [String] = [
    "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXFocused", "AXSelected",
    "AXExpanded", "AXIdentifier", "AXPlaceholderValue", "AXLabel", "AXHelp", "AXHidden", "AXPosition", "AXSize",
]

struct NodeAttrs {
    var raw: [String: CFTypeRef] = [:]
    var timedOut = false
    var gone = false

    func string(_ k: String) -> String? { raw[k] as? String }
    func bool(_ k: String) -> Bool? {
        guard let v = raw[k], CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }
        return CFBooleanGetValue((v as! CFBoolean))
    }
    var role: String { string("AXRole") ?? "" }
    var frame: CGRect? { frameOf(position: raw["AXPosition"], size: raw["AXSize"]) }
    var valueText: String? { valueTextOf(raw["AXValue"]) }
}

/// One AXUIElementCopyMultipleAttributeValues call per node. Values that come back as AXValue errors count as
/// missing. When the batch fails (not because of a timeout), it falls back to one read per attribute.
func axReadNode(_ el: AXUIElement, deadline: Date?) -> NodeAttrs {
    axTimeout(el, cap: readTimeoutCap, deadline: deadline)
    var out = NodeAttrs()
    var values: CFArray?
    var err = AXUIElementCopyMultipleAttributeValues(el, nodeAttrNames as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    if err == .cannotComplete {
        // A timeout, or an app that cannot answer the batch: one cheap single read tells them apart.
        // A 50 ms probe: a hung node costs the batch (250 ms) plus 50 ms, not twice the full timeout.
        AXUIElementSetMessagingTimeout(el, 0.05)
        var probe: CFTypeRef?
        let pe = AXUIElementCopyAttributeValue(el, "AXRole" as CFString, &probe)
        if pe == .cannotComplete { out.timedOut = true; return out }
        if pe == .invalidUIElement { out.gone = true; return out }
        err = .failure
        axTimeout(el, cap: readTimeoutCap, deadline: deadline)
    }
    if err == .success, let arr = values as? [AnyObject], arr.count == nodeAttrNames.count {
        for (i, v) in arr.enumerated() {
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
            out.raw[nodeAttrNames[i]] = v
        }
        return out
    }
    if err == .invalidUIElement { out.gone = true; return out }
    // The per-attribute fallback gets 300 ms in total (never past the deadline). When the budget is spent the node
    // is marked timedOut (partial) and no further attribute is read.
    let fallbackEnd = min(Date().addingTimeInterval(0.3), deadline ?? .distantFuture)
    for name in nodeAttrNames {
        let left = fallbackEnd.timeIntervalSinceNow
        if left <= 0 { out.timedOut = true; return out }
        AXUIElementSetMessagingTimeout(el, Float(max(0.05, min(readTimeoutCap, left))))
        var v: CFTypeRef?
        let e = AXUIElementCopyAttributeValue(el, name as CFString, &v)
        if e == .success, let v = v { out.raw[name] = v }
        else if e == .invalidUIElement { out.gone = true; return out }
        else if e == .cannotComplete && name == "AXRole" { out.timedOut = true; return out }
    }
    return out
}

/// AXChildren. The plain copy comes first (one call per node). Only when it fails with .cannotComplete (a timeout,
/// or an app too slow for one huge copy) are ranged pages of 100 tried. Any other failure (no value, unsupported)
/// is an empty list that counts as complete, with no extra IPC. `complete` is false when children could not be
/// read: a failed count, a failed page or the deadline. Callers that need a complete answer (the re-find search)
/// or report partial results (the walkers) must look at it.
func axChildrenPaged(_ el: AXUIElement, deadline: Date?) -> (items: [AXUIElement], complete: Bool) {
    axTimeout(el, cap: readTimeoutCap, deadline: deadline)
    var plain: CFTypeRef?
    let e = AXUIElementCopyAttributeValue(el, "AXChildren" as CFString, &plain)
    if e == .success { return (plain as? [AXUIElement] ?? [], true) }
    if e != .cannotComplete { return ([], true) }
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(el, "AXChildren" as CFString, &count) == .success, count > 100 else {
        return ([], false)
    }
    var out: [AXUIElement] = []
    var index: CFIndex = 0
    while index < count {
        if let d = deadline, Date() > d { return (out, false) }
        axTimeout(el, cap: readTimeoutCap, deadline: deadline)
        var page: CFArray?
        guard AXUIElementCopyAttributeValues(el, "AXChildren" as CFString, index, 100, &page) == .success,
              let items = page as? [AXUIElement], !items.isEmpty else { return (out, false) }
        out.append(contentsOf: items)
        index += CFIndex(items.count)
    }
    return (out, true)
}

// MARK: Process identity

/// pid + process start time. A pid that was reused by another process has another start time.
func processToken(_ pid: pid_t) -> String? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return "\(pid):\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)"
}

// MARK: Snapshot store (AX commands of different pids run in parallel: every access takes `stateLock`,
// which is never held across an AX call)

private final class Snapshot {
    let id: String
    let pid: pid_t
    let proc: String?
    let windowId: Int
    var refs: [AXUIElement]
    var metas: [Identity]
    init(id: String, pid: pid_t, proc: String?, windowId: Int, refs: [AXUIElement], metas: [Identity]) {
        self.id = id; self.pid = pid; self.proc = proc; self.windowId = windowId; self.refs = refs; self.metas = metas
    }
}

private let stateLock = NSLock()
private var snapshotRings: [pid_t: [Snapshot]] = [:] // last 8 snapshots per pid
private var manualSetAt: [pid_t: Date] = [:] // last accessibility flag set, per pid
private var manualAccepted: [pid_t: Bool] = [:] // the app took the flag (Chromium/Electron)
private var webWaitFailedAt: [String: Date] = [:] // last web-area wait that ran out, per "pid:windowId"

private func withState<T>(_ body: () -> T) -> T {
    stateLock.lock()
    defer { stateLock.unlock() }
    return body()
}

func dropSnapshots(_ pid: pid_t) {
    withState {
        snapshotRings[pid] = nil
        manualSetAt[pid] = nil
        manualAccepted[pid] = nil
        webWaitFailedAt = webWaitFailedAt.filter { !$0.key.hasPrefix("\(pid):") }
    }
}

private func findSnapshot(_ sid: String) -> Snapshot? {
    withState { snapshotRings.values.lazy.compactMap({ $0.first(where: { $0.id == sid }) }).first }
}

/// The identity of a node: base role (without subrole) and AXIdentifier. One type for the snapshot's stored
/// metadata and for every identity check.
private struct Identity {
    let role: String
    let identifier: String?

    init(_ at: NodeAttrs) {
        role = at.role
        identifier = trimmed(at.string("AXIdentifier"))
    }

    /// Same element kind? Same role, and the same identifier when the stored one has an identifier.
    func matches(_ stored: Identity) -> Bool {
        if role != stored.role { return false }
        if let want = stored.identifier { return identifier == want }
        return true
    }
}

/// Finds the element of `snapshotId`/`index` again. The retained native object is authoritative: a removed
/// element never silently resolves to a surviving one.
/// - Another process (pid or start time) is STALE.
/// - The retained element is used when its AXRole reads, the role matches and the identifier matches (if the
///   snapshot saw one).
/// - Otherwise it is re-found ONLY when the snapshot saw a non-empty AXIdentifier: a bounded search of the window
///   (depth 50, 5000 nodes) for the same role and identifier, de-duplicated with CFEqual. Exactly one match, found
///   by a search that finished, is used. Several are AMBIGUOUS, none are STALE, a search that hit the node cap or
///   the deadline is STALE ("too large"). No identifier means STALE at once: no label, bounds or path adoption.
private func lookup(_ a: JSON, deadline: Date) throws -> AXUIElement {
    guard let sid = a.str("snapshotId"), let idx = a.int("index"),
          let snap = findSnapshot(sid),
          let (ref, meta) = withState({ () -> (AXUIElement, Identity)? in
              idx >= 0 && idx < snap.refs.count ? (snap.refs[idx], snap.metas[idx]) : nil
          }) else {
        throw fail("Unknown snapshot or index. Take a new snapshot.", "STALE")
    }
    if a["pid"] != nil, a.int("pid").map({ pid_t($0) }) != snap.pid {
        throw fail("The snapshot belongs to another app. Take a new snapshot.", "STALE")
    }
    if let token = snap.proc, processToken(snap.pid) != token {
        throw fail("The app was restarted since the snapshot. Take a new snapshot.", "STALE")
    }

    // The snapshot's window must still exist. An element of a closed window can still answer AX reads
    // (TextEdit keeps the text view alive for a while after its window closed), and an action on it must not run.
    let win: WinInfo
    do {
        win = try pickWindow(snap.pid, snap.windowId != 0 ? snap.windowId : nil, deadline: deadline)
    } catch let e as CmdError where e.code == "NO_WINDOW" {
        // pickWindow skips a window whose frame read timed out, so a busy-but-open window also lands here.
        // The snapshot's CG window id still being listed means the window is not gone (alive but slow).
        guard snap.windowId != 0, cgWindows(snap.pid).contains(where: { Int($0.id) == snap.windowId }) else {
            throw fail("The window is gone. Take a new snapshot.", "STALE")
        }
        // No WinInfo: the re-find search below cannot run, so only the retained element can answer.
        let now = axReadNode(ref, deadline: deadline)
        if now.timedOut { return ref }
        if !now.gone, !now.role.isEmpty, Identity(now).matches(meta) { return ref }
        throw fail("The element is gone. Take a new snapshot.", "STALE")
    }

    // The retained element.
    let now = axReadNode(ref, deadline: deadline)
    // Alive but slow: the window-exists check above already passed, so use the retained element (never STALE).
    if now.timedOut { return ref }
    if !now.gone, !now.role.isEmpty, Identity(now).matches(meta) { return ref }

    // Gone (or another element now): re-find by identifier only.
    guard let want = meta.identifier else {
        throw fail("The element is gone. Take a new snapshot.", "STALE")
    }
    var found: [AXUIElement] = []
    var stack: [(AXUIElement, Int)] = [(win.ax, 0)]
    var visited = 0
    var complete = true
    while let (el, depth) = stack.popLast() {
        if Date() > deadline || visited >= 5000 { complete = false; break }
        visited += 1
        let at = axReadNode(el, deadline: deadline)
        if at.gone { continue }
        if at.timedOut { complete = false; continue }
        if at.bool("AXHidden") == true || skippedRoles.contains(at.role) { continue }
        // The same window-frame filter as the snapshot walker: off-window (recycled) cells do not count.
        if let f = at.frame, f.width > 0, f.height > 0, !f.intersects(win.frame) { continue }
        let id = Identity(at)
        if id.role == meta.role, id.identifier == want, !found.contains(where: { CFEqual($0, el) }) {
            found.append(el)
        }
        if depth < 50 && !leafRoles.contains(at.role) {
            let kids = axChildrenPaged(el, deadline: deadline)
            if !kids.complete { complete = false }
            for k in kids.items.reversed() { stack.append((k, depth + 1)) }
        }
    }
    if found.count > 1 { throw fail("Several elements match. Take a new snapshot.", "AMBIGUOUS") }
    if !complete {
        throw fail("The window is too large to find the element again. Take a new snapshot.", "STALE")
    }
    guard let el = found.first else { throw fail("The element is gone. Take a new snapshot.", "STALE") }
    withState { if idx < snap.refs.count { snap.refs[idx] = el } }
    return el
}

/// Deadline `seconds` after the request arrived (the watchdog answers at the command's own limit).
private func arrivalDeadline(_ a: JSON, _ seconds: Double) -> Date {
    let arrived = (a["_arrivedAt"] as? Double).map { Date(timeIntervalSince1970: $0) } ?? Date()
    return arrived.addingTimeInterval(seconds)
}

// MARK: Role tables

private let interactiveRoles: Set<String> = [
    "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXMenuButton",
    "AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField", "AXSlider", "AXIncrementor",
    "AXTab", "AXDisclosureTriangle", "AXMenuItem",
]
private let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXSecureTextField"]
private let selectRoles: Set<String> = ["AXPopUpButton", "AXComboBox"]
private let numericRoles: Set<String> = ["AXSlider", "AXIncrementor"]
private let leafRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXSearchField",
    "AXSecureTextField", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXPopUpButton",
    "AXComboBox", "AXMenuButton",
]
/// The menu bar belongs to the app element, not the window, but some windows (Finder's desktop)
/// expose it. Never walk it: its items include Shut Down and Restart.
private let skippedRoles: Set<String> = ["AXMenuBar", "AXMenuBarItem"]
/// Containers that only wrap other nodes. Without a name and without a real action they take no depth budget.
private let wrapperRoles: Set<String> = ["AXGroup", "AXGenericElement", "AXSplitGroup"]
private let wrapperActions: Set<String> = ["AXShowMenu", "AXScrollToVisible", "AXFocus", "AXRaise"]

// MARK: Window selection

private func pickWindow(_ pid: pid_t, _ windowId: Int?, deadline: Date? = nil) throws -> WinInfo {
    let wins = try windowsFor(pid, deadline: deadline)
    if let wid = windowId, wid != 0 {
        guard let w = wins.first(where: { Int($0.id) == wid }) else {
            throw fail("Window \(wid) not found.", "NO_WINDOW")
        }
        return w
    }
    // Zero-size AX windows exist (Finder's desktop); never prefer them.
    let real = wins.filter { $0.frame.width > 0 && $0.frame.height > 0 }
    if let w = real.first(where: { $0.focused && !$0.minimized }) ?? real.first(where: { $0.main && !$0.minimized })
        ?? real.first(where: { !$0.minimized }) ?? real.first {
        return w
    }
    throw fail("The app has no open window.", "NO_WINDOW")
}

// MARK: Chromium / Electron accessibility activation

private let manualAttr = "AXManualAccessibility"
private let enhancedAttr = "AXEnhancedUserInterface"
/// Substrings of a framework name (lowercase) that mark an embedded Chromium. The short ones ("cef", "edge",
/// "opera") must stand alone as a word, or "Knowledge.framework" would count.
private let chromiumNameParts: [String] = ["electron", "chromium", "chrome", "brave", "vivaldi"]
private let chromiumWordParts: [String] = ["cef", "edge", "opera"]

/// True for apps that embed Chromium: Electron, CEF and Chromium-based browsers.
private func looksLikeChromium(_ pid: pid_t) -> Bool {
    guard let url = (try? runningApp(pid))?.bundleURL else { return false }
    let dir = url.appendingPathComponent("Contents/Frameworks").path
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return false }
    return names.contains { raw in
        let n = raw.lowercased()
        if chromiumNameParts.contains(where: { n.contains($0) }) { return true }
        return chromiumWordParts.contains { n.range(of: "(^|[^a-z])\($0)([^a-z]|$)", options: .regularExpression) != nil }
    }
}

/// Turns the AX tree of an app on. Rules from agent-desktop:
/// - EVERY app gets AXManualAccessibility = true written, unconditionally (harmless where unsupported; the
///   getter and IsAttributeSettable are unreliable on Chromium). A success, a read-back of true, or
///   kAXErrorNotImplemented (Chromium answers that to a write that applied; counted ONLY for a Chromium app,
///   or a Qt/Java app would make `prepareWindow` poll for a web area that never comes) counts as applied;
/// - if that did not apply, a Chromium app gets AXEnhancedUserInterface (settable probe, write, read-back),
///   which fills the tree after a 2 s debounce: wait 2 s, but only when `waitEnd` allows it;
/// - the flag is never restored. `manualSetAt` is stamped at each write, before any sleep.
/// AXEnhancedUserInterface also changes how AppKit apps behave (animations, window management), so it is
/// written only to apps that embed Chromium.
private func activateAccessibility(_ app: AXUIElement, pid: pid_t, chromium: Bool, waitEnd: Date) -> Bool {
    withState { manualSetAt[pid] = Date() }
    let r = AXUIElementSetAttributeValue(app, manualAttr as CFString, kCFBooleanTrue)
    if r == .success || (chromium && r == .notImplemented) || axBool(app, manualAttr) == true { return true }
    guard chromium, isSettable(app, enhancedAttr) else { return false }
    if axBool(app, enhancedAttr) == true { return true }
    withState { manualSetAt[pid] = Date() }
    let er = AXUIElementSetAttributeValue(app, enhancedAttr as CFString, kCFBooleanTrue)
    let rb = axBool(app, enhancedAttr)
    guard rb == true || (rb == nil && er == .success) else { return false }
    if waitEnd.timeIntervalSinceNow >= 2.0 {
        Thread.sleep(forTimeInterval: 2.0)
    } else {
        logErr("skipped the 2 s AXEnhancedUserInterface wait: not enough time left")
    }
    return true
}

private let webBackoff: [Double] = [0.025, 0.05, 0.1, 0.2, 0.4]

/// Turns the AX tree of a Chromium/Electron app back on when its web area is empty, and waits for it.
/// Chromium turns accessibility off by itself later, so one set per helper life lost the tree after a
/// few agent runs. Measured on Electron 43: after a set the web area stays empty about 2 s, then fills
/// in one burst (1 node at 2.01 s, 334 at 2.10 s), and a new set restarts that delay. So the flag is
/// set only when the web area is empty and the last set of this pid is over 3 s old, never in the
/// wait loop. The wait uses exponential backoff (25, 50, 100, 200, then 400 ms per step) and stays inside
/// the command deadline minus 4.2 s kept for the walk (8.2 s deadline: up to 4 s of wait); a still-empty
/// web area is walked anyway (best effort).
private func prepareWindow(_ pid: pid_t, _ windowId: Int?, deadline: Date) throws -> WinInfo {
    _ = try runningApp(pid)
    try requireAccessibility()
    let app = AXUIElementCreateApplication(pid)
    axTimeout(app, cap: 1.0, deadline: deadline)
    var win = try pickWindow(pid, windowId, deadline: deadline)
    // Everything before the walk is bounded by pollEnd, not the full deadline: 4.2 s stay reserved for the walk.
    // A starved queue still gets 0.25 s for the web-content check, or a tree that is on would look off.
    let now = Date()
    let pollEnd = min(now.addingTimeInterval(4.0), deadline.addingTimeInterval(-4.2))
    if hasWebContent(win.ax, deadline: min(deadline, max(pollEnd, now.addingTimeInterval(0.25)))) { return win } // usual case: the tree is on
    // Pin the window so a re-pick cannot jump to another one.
    let pinned: Int? = (windowId ?? 0) != 0 ? windowId : Int(win.id)
    let rebuilding = withState { manualSetAt[pid] }.map { now.timeIntervalSince($0) < 3 } ?? false
    if !rebuilding {
        axTimeout(app, cap: 1.0, deadline: deadline)
        let ok = activateAccessibility(app, pid: pid, chromium: looksLikeChromium(pid), waitEnd: pollEnd)
        withState { manualAccepted[pid] = ok }
    }
    // A window whose wait ran out recently is not waited for again: it may hold no web content at all.
    let key = "\(pid):\(win.id)"
    let recentFail = withState { webWaitFailedAt[key] }.map { now.timeIntervalSince($0) < 60 } ?? false
    let accepted = withState { manualAccepted[pid] }
    if accepted == true && !recentFail {
        // Wait for a size that is above 0 and the same in two samples. Close samples (25 ms) must also
        // show a real tree (20 nodes), or a one-node first burst would pass for the whole page.
        var last = 0
        var ready = false
        var step = 0
        while Date() < pollEnd {
            let gap = webBackoff[min(step, webBackoff.count - 1)]
            step += 1
            Thread.sleep(forTimeInterval: max(0, min(gap, pollEnd.timeIntervalSinceNow)))
            win = try pickWindow(pid, pinned, deadline: deadline)
            let size = webContentSize(win.ax, until: pollEnd)
            if size > 0 && size == last && (size >= 20 || gap >= 0.1) { ready = true; break }
            last = size
        }
        withState { webWaitFailedAt[key] = ready ? nil : Date() }
    } else if accepted != true && axChildren(win.ax).isEmpty {
        // A native window that is still empty: short backoff, 0.4 s in total.
        var waited = 0.0
        for gap in webBackoff {
            let step = min(gap, 0.4 - waited, deadline.timeIntervalSinceNow)
            if step <= 0 { break }
            Thread.sleep(forTimeInterval: step)
            waited += step
            win = try pickWindow(pid, pinned, deadline: deadline)
            if !axChildren(win.ax).isEmpty { break }
        }
    }
    return win
}

/// True when the window holds an AXWebArea with at least one child. Bounded breadth-first search.
private func hasWebContent(_ win: AXUIElement, deadline: Date) -> Bool {
    var queue: [(AXUIElement, Int)] = [(win, 0)]
    var head = 0
    while head < queue.count && head < 300 && Date() < deadline {
        let (el, depth) = queue[head]
        head += 1
        axTimeout(el, cap: readTimeoutCap, deadline: deadline)
        let role = axString(el, "AXRole") ?? ""
        if skippedRoles.contains(role) { continue }
        let kids = axChildrenPaged(el, deadline: deadline).items
        if role == "AXWebArea" && !kids.isEmpty { return true }
        if depth < 12 { for k in kids { queue.append((k, depth + 1)) } }
    }
    return false
}

/// Number of elements inside the window's AXWebArea (0 = no web content). Bounded breadth-first
/// search that also stops at `until`.
private func webContentSize(_ win: AXUIElement, until: Date) -> Int {
    var queue: [(AXUIElement, Int, Bool)] = [(win, 0, false)]
    var head = 0
    var size = 0
    while head < queue.count && head < 600 && Date() < until {
        let (el, depth, inWeb) = queue[head]
        head += 1
        axTimeout(el, cap: readTimeoutCap, deadline: until)
        let role = axString(el, "AXRole") ?? ""
        if skippedRoles.contains(role) { continue }
        if inWeb { size += 1 }
        if depth < 40 { for k in axChildrenPaged(el, deadline: until).items { queue.append((k, depth + 1, inWeb || role == "AXWebArea")) } }
    }
    return size
}

// MARK: Labels

private func trimmed(_ s: String?) -> String? {
    guard let s = s else { return nil }
    let c = collapse(s)
    return c.isEmpty ? nil : c
}

/// `attrs` is the node's batched read; without it every attribute is read on its own.
private func labelFor(_ el: AXUIElement, role: String, attrs: NodeAttrs? = nil, deadline: Date? = nil,
                      kids: (() -> [AXUIElement])? = nil) -> String? {
    func str(_ name: String) -> String? { attrs != nil ? attrs!.string(name) : axString(el, name) }
    if let s = trimmed(str("AXTitle")) { return clip(s, 160) }
    if let s = trimmed(str("AXDescription")) { return clip(s, 160) }
    if let s = trimmed(str("AXLabel")) { return clip(s, 160) }
    if let t = axElement(axCopy(el, "AXTitleUIElement")) {
        axTimeout(t, cap: readTimeoutCap, deadline: deadline)
        if let s = trimmed(axString(t, "AXTitle")) ?? trimmed(axValueText(t)) { return clip(s, 160) }
    }
    if let s = trimmed(str("AXPlaceholderValue")) { return clip(s, 160) }
    if let s = trimmed(str("AXHelp")) { return clip(s, 160) }
    if !textRoles.contains(role) {
        // Last resort before the numbered fallback: the first static text inside the control.
        for c in (kids?() ?? axChildrenPaged(el, deadline: deadline).items).prefix(8) {
            axTimeout(c, cap: readTimeoutCap, deadline: deadline)
            if axString(c, "AXRole") == "AXStaticText", let s = trimmed(axValueText(c)) { return clip(s, 160) }
        }
    }
    return nil
}

private func menuOptions(_ el: AXUIElement, deadline: Date) -> [String] {
    var titles: [String] = []
    func collect(_ node: AXUIElement, _ depth: Int) {
        if depth > 3 || titles.count >= 50 || Date() > deadline { return }
        for c in axChildrenPaged(node, deadline: deadline).items {
            axTimeout(c, cap: readTimeoutCap, deadline: deadline)
            let r = axString(c, "AXRole") ?? ""
            if r == "AXMenuItem" {
                if let t = trimmed(axString(c, "AXTitle")) { titles.append(clip(t, 80)) }
            } else if r == "AXMenu" || r == "AXList" {
                collect(c, depth + 1)
            }
        }
    }
    collect(el, 0)
    return titles
}

// MARK: Walkers

private final class SnapWalker {
    let windowFrame: CGRect
    let maxElements: Int
    let deadline: Date
    var entries: [JSON] = []
    var refs: [AXUIElement] = []
    var metas: [Identity] = []
    var truncated = false
    var skippedTimeout = false // a node was skipped because its read timed out: the list is partial
    var visited = 0

    init(windowFrame: CGRect, maxElements: Int, deadline: Date) {
        self.windowFrame = windowFrame
        self.maxElements = maxElements
        self.deadline = deadline
    }

    /// A wrapper has no name, no value, no identifier and no real action. `depth` is the logical depth;
    /// `physical` only guards against runaway trees.
    private func isTransparent(_ el: AXUIElement, _ at: NodeAttrs, role: String) -> Bool {
        guard wrapperRoles.contains(role) else { return false }
        for k in ["AXTitle", "AXDescription", "AXIdentifier", "AXPlaceholderValue", "AXLabel"] where trimmed(at.string(k)) != nil {
            return false
        }
        if let v = at.valueText, !v.isEmpty { return false }
        return Set(axActions(el)).isSubset(of: wrapperActions)
    }

    func walk(_ el: AXUIElement, parentRole: String?, depth: Int, physical: Int) {
        if truncated || depth > 60 || physical > 250 { return }
        visited += 1
        if visited > 20000 || Date() > deadline { truncated = true; return }
        let at = axReadNode(el, deadline: deadline)
        if at.gone { return }
        if at.timedOut { skippedTimeout = true; return }
        if at.bool("AXHidden") == true { return }
        let role = at.role
        if skippedRoles.contains(role) { return }
        let frame = at.frame
        if let f = frame, f.width > 0, f.height > 0, !f.intersects(windowFrame) { return }
        let hasArea = frame.map { $0.width > 0 && $0.height > 0 } ?? false

        var kidsCache: [AXUIElement]?
        func kids() -> [AXUIElement] {
            if kidsCache == nil {
                let r = axChildrenPaged(el, deadline: deadline)
                if !r.complete { skippedTimeout = true } // children could not be read in full: the list is partial, the walk goes on
                kidsCache = r.items
            }
            return kidsCache!
        }

        if hasArea, let entry = makeEntry(el, at, role: role, parentRole: parentRole, kids: kids) {
            if entries.count >= maxElements { truncated = true; return }
            entries.append(entry)
            refs.append(el)
            metas.append(Identity(at))
        }
        if leafRoles.contains(role) { return }
        let nextDepth = isTransparent(el, at, role: role) ? depth : depth + 1
        for c in kids() {
            walk(c, parentRole: role, depth: nextDepth, physical: physical + 1)
            if truncated { return }
        }
    }

    private func makeEntry(_ el: AXUIElement, _ at: NodeAttrs, role: String, parentRole: String?,
                           kids: @escaping () -> [AXUIElement]) -> JSON? {
        var actions: [String]? = nil
        func hasPress() -> Bool {
            if actions == nil { actions = axActions(el) }
            return actions!.contains("AXPress")
        }
        let label = labelFor(el, role: role, attrs: at, deadline: deadline, kids: kids)
        let scroll = role == "AXScrollArea"
        let interactive = interactiveRoles.contains(role)
            || ((role == "AXRow" || role == "AXCell") && hasPress())
            || (!scroll && label != nil && hasPress())
        if !interactive && !scroll { return nil }

        let index = entries.count
        let tag = (role == "AXRadioButton" && parentRole == "AXTabGroup")
            ? "tab" : String(role.dropFirst(2)).lowercased()
        var o: JSON = ["index": index, "tag": tag]
        o["label"] = label ?? "\(tag) #\(index)"
        let sub = at.string("AXSubrole")
        o["role"] = (sub?.isEmpty == false) ? "\(role)/\(sub!)" : role

        if scroll {
            o["ops"] = [String]()
            o["scrollable"] = true
            return o
        }
        let value = at.valueText
        if textRoles.contains(role) {
            if role == "AXSecureTextField" {
                // The value is read only to test it for emptiness. It is never stored or sent.
                o["isPassword"] = true
                if let v = value, !v.isEmpty { o["hasValue"] = true }
            } else {
                o["isPassword"] = false
                if let v = value { o["value"] = clip(v, 200) }
            }
            o["ops"] = ["TYPE_TEXT"]
        } else if selectRoles.contains(role) {
            o["ops"] = ["SELECT"]
            if let v = value { o["value"] = clip(v, 200) }
            let opts = menuOptions(el, deadline: deadline)
            if !opts.isEmpty { o["options"] = opts }
        } else if numericRoles.contains(role) {
            o["ops"] = ["TYPE_TEXT"]
            if let v = value { o["value"] = clip(v, 200) }
        } else {
            o["ops"] = ["CLICK"]
        }
        if role == "AXCheckBox" || role == "AXRadioButton" || role == "AXMenuItem" {
            if let v = at.raw["AXValue"] as? NSNumber { o["checked"] = v.intValue != 0 }
        }
        if let e = at.bool("AXExpanded") { o["expanded"] = e }
        if at.bool("AXEnabled") == false { o["disabled"] = true }
        return o
    }
}

private final class ReadWalker {
    let windowFrame: CGRect
    let maxChars: Int
    let deadline: Date
    var lines: [String] = []
    var chars = 0
    var truncated = false
    var skippedTimeout = false
    var visited = 0

    init(windowFrame: CGRect, maxChars: Int, deadline: Date) {
        self.windowFrame = windowFrame
        self.maxChars = maxChars
        self.deadline = deadline
    }

    func add(_ s: String?) {
        guard let t = trimmed(s) else { return }
        if lines.last == t { return }
        if chars + t.count + 1 > maxChars {
            let room = maxChars - chars
            if room > 0 { lines.append(String(t.prefix(room))) }
            truncated = true
            return
        }
        lines.append(t)
        chars += t.count + 1
    }

    func walk(_ el: AXUIElement, depth: Int) {
        if truncated || depth > 60 { return }
        visited += 1
        if visited > 20000 || Date() > deadline { truncated = true; return }
        let at = axReadNode(el, deadline: deadline)
        if at.gone { return }
        if at.timedOut { skippedTimeout = true; return } // partial text: reported as truncated
        if at.bool("AXHidden") == true { return }
        if let f = at.frame, f.width > 0, f.height > 0, !f.intersects(windowFrame) { return }
        let role = at.role
        if skippedRoles.contains(role) { return }
        switch role {
        case "AXStaticText":
            add(at.valueText ?? at.string("AXTitle"))
            return
        case "AXHeading":
            add(at.valueText ?? at.string("AXTitle") ?? at.string("AXDescription"))
        case "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox":
            // An empty field shows its placeholder on screen; a filled one (even with spaces only) shows its value.
            let value = at.valueText ?? ""
            add(value.isEmpty ? at.string("AXPlaceholderValue") : value)
            return
        case "AXCheckBox", "AXRadioButton", "AXButton", "AXLink", "AXMenuItem":
            // The label is the visible text of a control; its children repeat it.
            add(at.string("AXTitle") ?? at.string("AXDescription") ?? labelFor(el, role: role, attrs: at, deadline: deadline))
            if role != "AXLink" { return }
        case "AXSecureTextField":
            // Never add the value. Only test it for emptiness (like the snapshot's hasValue): the placeholder shows only then.
            if (at.valueText ?? "").isEmpty { add(at.string("AXPlaceholderValue")) }
            return
        default:
            break
        }
        let r = axChildrenPaged(el, deadline: deadline)
        if !r.complete { skippedTimeout = true } // partial text: reported as truncated
        for c in r.items {
            walk(c, depth: depth + 1)
            if truncated { return }
        }
    }
}

// MARK: Commands

func cmdSnapshot(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    let deadline = arrivalDeadline(a, 8.2)
    let win = try prepareWindow(pid, a.int("windowId"), deadline: deadline)
    let maxEl = max(1, min(a.int("maxElements") ?? 120, 1000))
    let walker = SnapWalker(windowFrame: win.frame, maxElements: maxEl, deadline: deadline)
    walker.walk(win.ax, parentRole: nil, depth: 0, physical: 0)
    let sid = UUID().uuidString
    let proc = processToken(pid)
    withState {
        var ring = snapshotRings[pid] ?? []
        ring.append(Snapshot(
            id: sid, pid: pid, proc: proc, windowId: Int(win.id), refs: walker.refs, metas: walker.metas
        ))
        while ring.count > 8 { ring.removeFirst() }
        snapshotRings[pid] = ring
    }
    return [
        "snapshotId": sid, "elements": walker.entries, "truncated": walker.truncated || walker.skippedTimeout,
        "window": win.json,
    ]
}

func cmdRead(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    let deadline = arrivalDeadline(a, 8.2)
    let win = try prepareWindow(pid, a.int("windowId"), deadline: deadline)
    let walker = ReadWalker(windowFrame: win.frame, maxChars: max(1, a.int("maxChars") ?? 12000), deadline: deadline)
    walker.walk(win.ax, depth: 0)
    return ["title": win.title, "text": walker.lines.joined(separator: "\n"), "truncated": walker.truncated || walker.skippedTimeout]
}

func cmdElementFrame(_ a: JSON) throws -> JSON {
    try requireAccessibility()
    let el = try lookup(a, deadline: arrivalDeadline(a, 1.6))
    axTimeout(el, cap: readTimeoutCap, deadline: arrivalDeadline(a, 1.8))
    guard let f = axFrame(el) else { throw fail("The element is gone. Take a new snapshot.", "STALE") }
    return ["x": finite(f.origin.x), "y": finite(f.origin.y), "width": finite(f.size.width), "height": finite(f.size.height)]
}

fileprivate func mapAXError(_ e: AXError, _ what: String) -> CmdError {
    switch e {
    case .invalidUIElement: return fail("The element is gone. Take a new snapshot.", "STALE")
    case .apiDisabled: return fail("Accessibility permission is missing.", "NO_ACCESSIBILITY")
    case .actionUnsupported, .attributeUnsupported, .notImplemented:
        return fail("The element does not support \(what).", "NO_ACTION")
    default: return fail("\(what) failed (AXError \(e.rawValue)).", "AX_FAILED")
    }
}

/// The watchdog in main.swift answers 5 s after the request ARRIVED; mutating steps stop 1 s before it.
/// Time spent waiting in the queue counts. Without a stamp (tests), the deadline starts now.
private func mutationDeadline(_ a: JSON) -> Date { arrivalDeadline(a, 4.0) }

func cmdPerform(_ a: JSON) throws -> JSON {
    let deadline = mutationDeadline(a)
    try requireAccessibility() // NO_ACCESSIBILITY first, consistently: lookup reads AX too
    let el = try lookup(a, deadline: deadline.addingTimeInterval(-1.0))
    guard let action = a.str("action") else { throw fail("action is required", "BAD_ARGS") }
    AXUIElementSetMessagingTimeout(el, 1.0)
    func act(_ name: String, _ what: String) throws {
        if !axActions(el).contains(name) {
            if axCopy(el, "AXRole") == nil { throw fail("The element is gone. Take a new snapshot.", "STALE") }
            throw fail("The element has no \(what) action.", "NO_ACTION")
        }
        let r = AXUIElementPerformAction(el, name as CFString)
        if r != .success { throw mapAXError(r, what) }
    }
    switch action {
    case "press": return try pressChain(el, deadline: deadline)
    case "insertText": return try insertText(el, a, deadline: deadline)
    case "increment": try act("AXIncrement", "increment")
    case "decrement": try act("AXDecrement", "decrement")
    case "showMenu": try act("AXShowMenu", "showMenu")
    case "scrollToVisible": try act("AXScrollToVisible", "scrollToVisible")
    case "focus":
        let r = AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
        if r != .success { throw mapAXError(r, "focus") }
    case "setValue":
        guard let text = a.str("text") else { throw fail("text is required", "BAD_ARGS") }
        var newValue: CFTypeRef = text as CFString
        if let cur = axCopy(el, "AXValue"), CFGetTypeID(cur) == CFNumberGetTypeID() {
            guard let d = Double(text.trimmingCharacters(in: .whitespaces)) else {
                throw fail("This element takes a number.", "BAD_ARGS")
            }
            newValue = NSNumber(value: d)
        } else if a.str("mode") == "append", let cur = axValueText(el) {
            newValue = (cur + text) as CFString
        }
        let r = AXUIElementSetAttributeValue(el, "AXValue" as CFString, newValue)
        if r != .success { throw mapAXError(r, "setValue") }
    case "pick":
        guard let text = a.str("text") else { throw fail("text is required", "BAD_ARGS") }
        try pick(el, text)
    default:
        throw fail("Unknown action \(action).", "BAD_ARGS")
    }
    return ["done": true, "via": "ax"]
}

private func pick(_ el: AXUIElement, _ text: String) throws {
    func items(_ node: AXUIElement) -> [AXUIElement] {
        var out: [AXUIElement] = []
        for c in axChildren(node) {
            let r = axString(c, "AXRole") ?? ""
            if r == "AXMenuItem" { out.append(c) }
            else if r == "AXMenu" || r == "AXList" { out.append(contentsOf: items(c)) }
        }
        return out
    }
    var all = items(el)
    if all.isEmpty {
        if axActions(el).contains("AXPress") { _ = AXUIElementPerformAction(el, "AXPress" as CFString) }
        for _ in 0..<8 {
            Thread.sleep(forTimeInterval: 0.12)
            all = items(el)
            if !all.isEmpty { break }
        }
    }
    let want = collapse(text).lowercased()
    func title(_ i: AXUIElement) -> String { collapse(axString(i, "AXTitle") ?? "").lowercased() }
    let hit = all.first(where: { title($0) == want }) ?? all.first(where: { !want.isEmpty && title($0).contains(want) })
    guard let item = hit else {
        for m in axChildren(el) where axString(m, "AXRole") == "AXMenu" {
            _ = AXUIElementPerformAction(m, "AXCancel" as CFString)
        }
        if axString(el, "AXRole") == "AXComboBox", AXUIElementSetAttributeValue(el, "AXValue" as CFString, text as CFString) == .success {
            return
        }
        throw fail("No option matches \"\(text)\".", "NOT_FOUND")
    }
    let r = AXUIElementPerformAction(item, "AXPress" as CFString)
    if r != .success { throw mapAXError(r, "pick") }
}

// MARK: Headless click chain and text insertion
//
// Headless = semantic AX calls only: no activation, no pointer, no key events. Only ADVERTISED actions are
// performed (some apps answer .success to actions they never ran). "delivered" = the app accepted the call,
// "verified" = a re-read confirmed an effect.

private struct LightState: Equatable {
    var focused: AXUIElement?
    var selected: Bool?
    var value: String?
    var expanded: Bool?
    var hasMenu: Bool

    static func == (l: LightState, r: LightState) -> Bool {
        let sameFocus: Bool
        switch (l.focused, r.focused) {
        case (nil, nil): sameFocus = true
        case let (a?, b?): sameFocus = CFEqual(a, b)
        default: sameFocus = false
        }
        return sameFocus && l.selected == r.selected && l.value == r.value && l.expanded == r.expanded && l.hasMenu == r.hasMenu
    }
}

private func lightState(_ el: AXUIElement, pid: pid_t?) -> LightState {
    var focused: AXUIElement?
    if let p = pid {
        let app = AXUIElementCreateApplication(p)
        AXUIElementSetMessagingTimeout(app, 1.0)
        focused = axElement(axCopy(app, "AXFocusedUIElement"))
    }
    let role = axString(el, "AXRole") ?? ""
    // Never read the value of a password field.
    let value: String? = role == "AXSecureTextField" ? nil : axValueText(el)
    return LightState(
        focused: focused, selected: axBool(el, "AXSelected"), value: value, expanded: axBool(el, "AXExpanded"),
        hasMenu: axChildren(el).contains { axString($0, "AXRole") == "AXMenu" }
    )
}

private func waitForChange(_ el: AXUIElement, pid: pid_t?, from before: LightState, deadline: Date) -> Bool {
    var waited = 0.0
    while waited < 0.4 && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.04)
        waited += 0.04
        if lightState(el, pid: pid) != before { return true }
    }
    return false
}

private func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(el, name as CFString, &settable) == .success && settable.boolValue
}

/// Errors that prove the call ran nothing: the next step cannot double-act. Same split as agent-desktop's
/// classify_perform. Every other error leaves the delivery uncertain.
private func provesNotRun(_ e: AXError) -> Bool {
    switch e {
    case .actionUnsupported, .attributeUnsupported, .notImplemented, .illegalArgument, .noValue: return true
    default: return false
    }
}

private func pressChain(_ el: AXUIElement, deadline: Date) throws -> JSON {
    var pid: pid_t = 0
    let elPid: pid_t? = AXUIElementGetPid(el, &pid) == .success ? pid : nil
    let actions = axActions(el)
    let role = axString(el, "AXRole") ?? ""
    let canSelect = isSettable(el, "AXSelected") && axBool(el, "AXSelected") != true
    var steps: [String] = ["AXPress", "AXOpen", "AXConfirm"].filter { actions.contains($0) }
    if canSelect { steps.append("AXSelected") }
    if steps.isEmpty {
        if axCopy(el, "AXRole") == nil { throw fail("The element is gone. Take a new snapshot.", "STALE") }
        if let r = try focusStep(el, pid: elPid, role: role, deadline: deadline) { return r }
        throw fail("The element has no press action.", "NO_ACTION")
    }
    let before = lightState(el, pid: elPid)
    var lastError: CmdError?
    var delivered: String? // the last step the app accepted
    for (i, step) in steps.enumerated() {
        // The watchdog answers at 5 s. Never mutate after it: report what is already delivered.
        if Date() > deadline {
            if let d = delivered { return ["done": true, "via": d, "effect": "unverified"] }
            throw fail("press timed out before any action ran.", "TIMEOUT")
        }
        let r: AXError
        if step == "AXSelected" {
            r = AXUIElementSetAttributeValue(el, "AXSelected" as CFString, kCFBooleanTrue)
        } else {
            r = AXUIElementPerformAction(el, step as CFString)
        }
        if r != .success {
            if r == .invalidUIElement { throw mapAXError(r, "press") }
            if r == .apiDisabled { throw mapAXError(r, "press") }
            if provesNotRun(r) {
                // Some apps run the action and still answer with such an error. Re-read the state first:
                // if it changed, the step was delivered and no other step may run.
                if waitForChange(el, pid: elPid, from: before, deadline: deadline) {
                    return ["done": true, "via": step, "effect": "unverified", "uncertain": true]
                }
                lastError = mapAXError(r, "press")
                continue
            }
            // The app may have run it (.cannotComplete, .failure ...): stop. Never run another mutating step.
            return ["done": true, "via": step, "effect": "unverified", "uncertain": true]
        }
        delivered = step
        if waitForChange(el, pid: elPid, from: before, deadline: deadline) {
            return ["done": true, "via": step, "effect": "verified"]
        }
        // Delivered with no visible effect. Rows and cells often ignore AXPress: try the selection write.
        let more = steps[(i + 1)...].contains("AXSelected")
        if step == "AXPress" && (role == "AXRow" || role == "AXCell") && more { continue }
        return ["done": true, "via": step, "effect": "unverified"]
    }
    if let d = delivered { return ["done": true, "via": d, "effect": "unverified"] }
    if let r = try focusStep(el, pid: elPid, role: role, deadline: deadline, before: before, lastStep: steps.last) { return r }
    throw lastError ?? fail("The element has no press action.", "NO_ACTION")
}

private let focusableTextRoles: Set<String> = ["AXTextArea", "AXTextField", "AXSearchField", "AXComboBox", "AXSecureTextField"]

/// Last press step for text roles that advertise no action: write AXFocused and trust only a read-back.
/// Never activates the app and never moves the pointer. Focus on el or on one of its descendants counts.
/// `before` is the pre-press state when earlier steps failed: if the state moved since, an earlier step
/// may have acted late, so no write runs. Returns nil when the step does not apply or when the write
/// proved it ran nothing and no focus showed up (the caller then reports NO_ACTION).
private func focusStep(_ el: AXUIElement, pid: pid_t?, role: String, deadline: Date,
                       before: LightState? = nil, lastStep: String? = nil) throws -> JSON? {
    guard focusableTextRoles.contains(role), isSettable(el, "AXFocused"), axBool(el, "AXEnabled") != false else { return nil }
    let loopPath = before != nil && lastStep != nil
    // Loop path: the before-state check runs first. A state change means an earlier step may have acted late.
    if let b = before, let last = lastStep, lightState(el, pid: pid) != b {
        return ["done": true, "via": last, "effect": "unverified", "uncertain": true]
    }
    if Date() > deadline {
        // Loop path: earlier steps proved they ran nothing, so the caller reports their error (nil here).
        // TIMEOUT only on the no-steps entry path.
        if loopPath { return nil }
        throw fail("press timed out before any action ran.", "TIMEOUT")
    }
    let app: AXUIElement? = pid.map { AXUIElementCreateApplication($0) }
    /// True when the app's AXFocusedUIElement is el or a descendant of el. With `orOwn`, el's own AXFocused
    /// also counts. No call starts after `limit` (wall-clock), and each call timeout is bounded by it.
    func hasFocus(orOwn: Bool, limit: Date) -> Bool {
        if Date() >= limit { return false }
        axTimeout(el, cap: 0.25, deadline: limit)
        if orOwn && axBool(el, "AXFocused") == true { return true }
        guard let a = app else { return false }
        if Date() >= limit { return false }
        axTimeout(a, cap: 0.25, deadline: limit)
        guard let f = axElement(axCopy(a, "AXFocusedUIElement")) else { return false }
        var cur = f
        for _ in 0..<20 {
            if CFEqual(cur, el) { return true }
            if Date() >= limit { return false }
            axTimeout(cur, cap: 0.25, deadline: limit)
            guard let p = axElement(axCopy(cur, "AXParent")) else { return false }
            cur = p
        }
        return false
    }
    if hasFocus(orOwn: false, limit: deadline) { return ["done": true, "via": "AXFocused", "effect": "verified", "already": true] }
    axTimeout(el, cap: 0.5, deadline: deadline)
    let r = AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
    if r == .invalidUIElement || r == .apiDisabled { throw mapAXError(r, "press") }
    let pollEnd = min(Date().addingTimeInterval(0.4), deadline)
    while true {
        if hasFocus(orOwn: true, limit: pollEnd) { return ["done": true, "via": "AXFocused", "effect": "verified"] }
        if Date() >= pollEnd { break }
        Thread.sleep(forTimeInterval: 0.04)
    }
    if r != .success && provesNotRun(r) { return nil }
    return ["done": true, "via": "AXFocused", "effect": "unverified", "uncertain": true]
}

private func insertText(_ el: AXUIElement, _ a: JSON, deadline: Date) throws -> JSON {
    guard let text = a.str("text") else { throw fail("text is required", "BAD_ARGS") }
    let replace = a.bool("replace") == true
    let role = axString(el, "AXRole") ?? ""
    let secure = role == "AXSecureTextField"
    // Check the write path BEFORE any change: no focus, no selection while the text cannot be written.
    if !isSettable(el, "AXSelectedText") {
        if axCopy(el, "AXRole") == nil { throw fail("The element is gone. Take a new snapshot.", "STALE") }
        throw fail("The element does not support insertText.", "NO_ACTION")
    }
    _ = AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue) // best effort
    let beforeValue = secure ? nil : axCopy(el, "AXValue") as? String
    if replace {
        // Replace or fail: never append. AXNumberOfCharacters also works for secure fields.
        let length: Int?
        if let n = axCopy(el, "AXNumberOfCharacters") as? NSNumber {
            length = n.intValue
        } else if !secure, let s = axCopy(el, "AXValue") as? String {
            length = s.utf16.count
        } else {
            length = nil
        }
        let cannotReplace = fail("The text cannot be replaced through accessibility.", "NO_ACTION")
        guard let len = length else { throw cannotReplace }
        if len > 0 {
            guard isSettable(el, "AXSelectedTextRange") else { throw cannotReplace }
            var range = CFRange(location: 0, length: len)
            guard let v = AXValueCreate(.cfRange, &range),
                  AXUIElementSetAttributeValue(el, "AXSelectedTextRange" as CFString, v) == .success else {
                throw cannotReplace
            }
        }
    }
    if Date() > deadline { throw fail("insertText timed out before the text was written.", "TIMEOUT") }
    let r = AXUIElementSetAttributeValue(el, "AXSelectedText" as CFString, text as CFString)
    if r != .success { throw mapAXError(r, "insertText") }
    var verified = false
    if !secure {
        Thread.sleep(forTimeInterval: 0.05)
        if let now = axCopy(el, "AXValue") as? String {
            // Append: the value must have changed AND hold the text (it may already contain it).
            verified = replace ? now == text : (beforeValue != now && now.contains(text))
        }
    }
    return ["done": true, "via": "AXSelectedText", "effect": verified ? "verified" : "unverified"]
}

// MARK: Headless scroll

private func nearestScrollArea(_ el: AXUIElement) -> AXUIElement? {
    var cur: AXUIElement? = el
    for _ in 0..<15 {
        guard let c = cur else { return nil }
        if axString(c, "AXRole") == "AXScrollArea" { return c }
        cur = axElement(axCopy(c, "AXParent"))
    }
    return nil
}

/// The largest scroll area inside one window.
private func largestScrollArea(in root: AXUIElement) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var head = 0
    var best: (AXUIElement, CGFloat)?
    while head < queue.count && head < 2000 {
        let (el, depth) = queue[head]
        head += 1
        let role = axString(el, "AXRole") ?? ""
        if skippedRoles.contains(role) { continue }
        if role == "AXScrollArea", let f = axFrame(el) {
            let area = f.width * f.height
            if best == nil || area > best!.1 { best = (el, area) }
        }
        if depth < 8 { for k in axChildren(el) { queue.append((k, depth + 1)) } }
    }
    return best?.0
}

/// Without a windowId: the focused, main or first window of the app.
private func defaultWindow(_ app: AXUIElement) -> AXUIElement? {
    axElement(axCopy(app, "AXFocusedWindow")) ?? axElement(axCopy(app, "AXMainWindow"))
        ?? (axCopy(app, "AXWindows") as? [AXUIElement])?.first
}

/// The content the area scrolls: AXContents, else the first child that is not a scroll bar.
private func scrollContent(_ area: AXUIElement) -> AXUIElement? {
    if let c = (axCopy(area, "AXContents") as? [AXUIElement])?.first { return c }
    return axChildren(area).first { axString($0, "AXRole") != "AXScrollBar" }
}

private func scrollPosition(_ area: AXUIElement, _ bar: AXUIElement?) -> String? {
    if let b = bar, let v = axCopy(b, "AXValue") as? NSNumber { return "v\(v.doubleValue)" }
    if let first = scrollContent(area), let f = axFrame(first) { return "p\(f.origin.x),\(f.origin.y)" }
    return nil
}

func cmdAxScroll(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    let deadline = mutationDeadline(a)
    let dir = a.str("direction") ?? ""
    guard ["up", "down", "left", "right"].contains(dir) else {
        throw fail("direction must be up, down, left or right", "BAD_ARGS")
    }
    let amount = max(1, min(a.int("amount") ?? 1, 20))
    _ = try runningApp(pid)
    try requireAccessibility()
    var target: AXUIElement?
    var element: AXUIElement?
    if a["snapshotId"] != nil || a["index"] != nil {
        let el = try lookup(a, deadline: deadline.addingTimeInterval(-1.0))
        element = el
        AXUIElementSetMessagingTimeout(el, 1.0)
        target = nearestScrollArea(el)
    } else {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 1.0)
        let root: AXUIElement?
        if let wid = a.int("windowId"), wid != 0 {
            root = try pickWindow(pid, wid).ax // NO_WINDOW when the window is gone
        } else {
            root = defaultWindow(app)
        }
        target = root.flatMap { largestScrollArea(in: $0) }
    }
    let forward = dir == "down" || dir == "right"
    let horizontal = dir == "left" || dir == "right"
    if let area = target {
        AXUIElementSetMessagingTimeout(area, 1.0)
        let bar = axElement(axCopy(area, horizontal ? "AXHorizontalScrollBar" : "AXVerticalScrollBar"))
        let before = scrollPosition(area, bar)
        func verdict(_ via: String) -> JSON {
            // Apps update the scroll position asynchronously: poll up to 400 ms, not one fixed sleep.
            var ok = false
            for _ in 0..<10 {
                Thread.sleep(forTimeInterval: 0.04)
                let after = scrollPosition(area, bar)
                if before != nil && after != nil && before != after { ok = true; break }
            }
            return ["done": true, "via": via, "effect": ok ? "verified" : "unverified"]
        }
        // An AX error code does not prove that nothing ran: TextEdit answers AXScrollDownByPage with
        // kAXErrorAttributeUnsupported and still scrolls. After a failed step, re-read the position. If it moved,
        // the step was delivered: stop here, so a later step cannot scroll a second time.
        func movedAnyway() -> Bool {
            // Same polling as verdict(): up to 400 ms, every 40 ms, bounded by the deadline.
            for _ in 0..<10 {
                if Date() > deadline { break }
                Thread.sleep(forTimeInterval: 0.04)
                let now = scrollPosition(area, bar)
                if before != nil && now != nil && before != now { return true }
            }
            return false
        }
        // a) Scroll bar value first: deterministic and verifiable. One step = visible / scrollable range.
        if let b = bar, let v = (axCopy(b, "AXValue") as? NSNumber)?.doubleValue, isSettable(b, "AXValue") {
            var step = 0.1
            if let visible = axFrame(area).map({ horizontal ? $0.width : $0.height }),
               let content = scrollContent(area).flatMap({ axFrame($0) }).map({ horizontal ? $0.width : $0.height }),
               visible > 0, content > visible {
                step = max(0.01, min(1, Double(visible / (content - visible))))
            }
            let nv = max(0, min(1, v + (forward ? 1 : -1) * step * Double(amount)))
            if Date() <= deadline {
                if AXUIElementSetAttributeValue(b, "AXValue" as CFString, NSNumber(value: nv)) == .success {
                    return verdict("scrollbarValue")
                }
                if movedAnyway() { return ["done": true, "via": "scrollbarValue", "effect": "unverified", "uncertain": true] }
            }
        }
        // b) Page actions: one amount = one page.
        let pageName = ["up": "AXScrollUpByPage", "down": "AXScrollDownByPage", "left": "AXScrollLeftByPage", "right": "AXScrollRightByPage"][dir]!
        if axActions(area).contains(pageName) {
            var delivered = false
            for _ in 0..<amount {
                if Date() > deadline { break }
                if AXUIElementPerformAction(area, pageName as CFString) == .success { delivered = true; continue }
                if movedAnyway() { return ["done": true, "via": "page", "effect": "unverified", "uncertain": true] }
                break
            }
            if delivered { return verdict("page") }
        }
        if let b = bar {
            // c) Scroll bar buttons: ten clicks per amount, bounded by the deadline.
            let name = forward ? "AXIncrement" : "AXDecrement"
            if axActions(b).contains(name) {
                var delivered = false
                for _ in 0..<(amount * 10) {
                    if Date() > deadline { break }
                    if AXUIElementPerformAction(b, name as CFString) == .success { delivered = true; continue }
                    if !delivered && movedAnyway() { return ["done": true, "via": "scrollbar", "effect": "unverified", "uncertain": true] }
                    break
                }
                if delivered { return verdict("scrollbar") }
            }
        }
    }
    // d) Last resort: a wheel event delivered to the pid only (no pointer move, no activation). 500 px per amount.
    guard let frame = target.flatMap({ axFrame($0) }) ?? element.flatMap({ axFrame($0) }),
          frame.width > 0, frame.height > 0 else {
        throw fail("No scrollable area found.", "NO_ACTION")
    }
    if Date() > deadline { throw fail("axScroll timed out.", "TIMEOUT") }
    let centre = CGPoint(x: frame.midX, y: frame.midY)
    let px = amount * 500
    // The wheel event is physical input: it takes the machine-wide input lease (inputQueue). inputQueue never
    // waits on an AX queue (no input command calls axQueue or syncs to it), so this cannot deadlock.
    inputQueue.sync {
        postWheelToPid(pid, at: centre, dx: horizontal ? (forward ? px : -px) : 0, dy: horizontal ? 0 : (forward ? px : -px))
    }
    return ["done": true, "via": "wheelToPid", "effect": "unverified"]
}
