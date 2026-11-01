import Foundation
import AppKit
import ApplicationServices

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

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = axCopy(el, "AXPosition"), let s = axCopy(el, "AXSize"),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    var sz = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pt),
          AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
    return CGRect(origin: pt, size: sz)
}

func axValueText(_ el: AXUIElement) -> String? {
    guard let v = axCopy(el, "AXValue") else { return nil }
    if let s = v as? String { return s }
    if CFGetTypeID(v) == CFNumberGetTypeID() { return (v as! NSNumber).stringValue }
    return nil
}

// MARK: Snapshot store (AX commands of different pids run in parallel: every access takes `stateLock`,
// which is never held across an AX call)

private struct Snapshot { let id: String; let pid: pid_t; let refs: [AXUIElement] }
private let stateLock = NSLock()
private var snapshotRings: [pid_t: [Snapshot]] = [:] // last 8 snapshots per pid
private var manualSetAt: [pid_t: Date] = [:] // last AXManualAccessibility set, per pid
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

private func lookup(_ a: JSON) throws -> AXUIElement {
    guard let sid = a.str("snapshotId"), let idx = a.int("index"),
          let snap = findSnapshot(sid),
          idx >= 0, idx < snap.refs.count else {
        throw fail("Unknown snapshot or index. Take a new snapshot.", "STALE")
    }
    if a["pid"] != nil, a.int("pid").map({ pid_t($0) }) != snap.pid {
        throw fail("The snapshot belongs to another app. Take a new snapshot.", "STALE")
    }
    return snap.refs[idx]
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

// MARK: Window selection

private func pickWindow(_ pid: pid_t, _ windowId: Int?) throws -> WinInfo {
    let wins = try windowsFor(pid)
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

/// Turns the AX tree of a Chromium/Electron app back on when its web area is empty, and waits for it.
/// Chromium turns accessibility off by itself later, so one set per helper life lost the tree after a
/// few agent runs. Measured on Electron 43: after a set the web area stays empty about 2 s, then fills
/// in one burst (1 node at 2.01 s, 334 at 2.10 s), and a new set restarts that delay. So the flag is
/// set only when the web area is empty and the last set of this pid is over 3 s old, never in the
/// wait loop. The wait stays inside the command deadline (8.2 s: up to 4 s of wait, then 4.2 s for
/// the walk); a still-empty web area is walked anyway (best effort).
private func prepareWindow(_ pid: pid_t, _ windowId: Int?, deadline: Date) throws -> WinInfo {
    _ = try runningApp(pid)
    try requireAccessibility()
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    var win = try pickWindow(pid, windowId)
    if hasWebContent(win.ax) { return win } // usual case: the tree is on
    // Pin the window so a re-pick cannot jump to another one.
    let pinned: Int? = (windowId ?? 0) != 0 ? windowId : Int(win.id)
    let now = Date()
    let rebuilding = withState { manualSetAt[pid] }.map { now.timeIntervalSince($0) < 3 } ?? false
    if !rebuilding {
        // Chromium/Electron accept the attribute; other apps return an error.
        let ok = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
        withState { manualAccepted[pid] = ok; manualSetAt[pid] = now }
    }
    // A window whose wait ran out recently is not waited for again: it may hold no web content at all.
    let key = "\(pid):\(win.id)"
    let recentFail = withState { webWaitFailedAt[key] }.map { now.timeIntervalSince($0) < 60 } ?? false
    let accepted = withState { manualAccepted[pid] }
    if accepted == true && !recentFail {
        let pollEnd = min(now.addingTimeInterval(4.0), deadline.addingTimeInterval(-4.2))
        // Wait for a size that is above 0 and the same in two samples 0.15 s apart.
        var last = 0
        var ready = false
        while Date() < pollEnd {
            Thread.sleep(forTimeInterval: 0.15)
            win = try pickWindow(pid, pinned)
            let size = webContentSize(win.ax, until: pollEnd)
            if size > 0 && size == last { ready = true; break }
            last = size
        }
        withState { webWaitFailedAt[key] = ready ? nil : Date() }
    } else if accepted != true && axChildren(win.ax).isEmpty {
        Thread.sleep(forTimeInterval: 0.4)
        win = try pickWindow(pid, pinned)
    }
    return win
}

/// True when the window holds an AXWebArea with at least one child. Bounded breadth-first search.
private func hasWebContent(_ win: AXUIElement) -> Bool {
    var queue: [(AXUIElement, Int)] = [(win, 0)]
    var head = 0
    while head < queue.count && head < 300 {
        let (el, depth) = queue[head]
        head += 1
        let role = axString(el, "AXRole") ?? ""
        if skippedRoles.contains(role) { continue }
        let kids = axChildren(el)
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
        let role = axString(el, "AXRole") ?? ""
        if skippedRoles.contains(role) { continue }
        if inWeb { size += 1 }
        if depth < 40 { for k in axChildren(el) { queue.append((k, depth + 1, inWeb || role == "AXWebArea")) } }
    }
    return size
}

// MARK: Labels

private func trimmed(_ s: String?) -> String? {
    guard let s = s else { return nil }
    let c = collapse(s)
    return c.isEmpty ? nil : c
}

private func labelFor(_ el: AXUIElement, role: String) -> String? {
    if let s = trimmed(axString(el, "AXTitle")) { return clip(s, 160) }
    if let s = trimmed(axString(el, "AXDescription")) { return clip(s, 160) }
    if let s = trimmed(axString(el, "AXLabel")) { return clip(s, 160) }
    if let t = axElement(axCopy(el, "AXTitleUIElement")) {
        if let s = trimmed(axString(t, "AXTitle")) ?? trimmed(axValueText(t)) { return clip(s, 160) }
    }
    if let s = trimmed(axString(el, "AXPlaceholderValue")) { return clip(s, 160) }
    if let s = trimmed(axString(el, "AXHelp")) { return clip(s, 160) }
    if !textRoles.contains(role) {
        // Last resort before the numbered fallback: the first static text inside the control.
        for c in axChildren(el).prefix(8) where axString(c, "AXRole") == "AXStaticText" {
            if let s = trimmed(axValueText(c)) { return clip(s, 160) }
        }
    }
    return nil
}

private func menuOptions(_ el: AXUIElement) -> [String] {
    var titles: [String] = []
    func collect(_ node: AXUIElement, _ depth: Int) {
        if depth > 3 || titles.count >= 50 { return }
        for c in axChildren(node) {
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
    var truncated = false
    var visited = 0

    init(windowFrame: CGRect, maxElements: Int, deadline: Date) {
        self.windowFrame = windowFrame
        self.maxElements = maxElements
        self.deadline = deadline
    }

    func walk(_ el: AXUIElement, parentRole: String?, depth: Int) {
        if truncated || depth > 60 { return }
        visited += 1
        if visited > 20000 || Date() > deadline { truncated = true; return }
        if axBool(el, "AXHidden") == true { return }
        let role = axString(el, "AXRole") ?? ""
        if skippedRoles.contains(role) { return }
        let frame = axFrame(el)
        if let f = frame, f.width > 0, f.height > 0, !f.intersects(windowFrame) { return }
        let hasArea = frame.map { $0.width > 0 && $0.height > 0 } ?? false

        if hasArea, let entry = makeEntry(el, role: role, parentRole: parentRole) {
            if entries.count >= maxElements { truncated = true; return }
            entries.append(entry)
            refs.append(el)
        }
        if leafRoles.contains(role) { return }
        for c in axChildren(el) {
            walk(c, parentRole: role, depth: depth + 1)
            if truncated { return }
        }
    }

    private func makeEntry(_ el: AXUIElement, role: String, parentRole: String?) -> JSON? {
        var actions: [String]? = nil
        func hasPress() -> Bool {
            if actions == nil { actions = axActions(el) }
            return actions!.contains("AXPress")
        }
        let label = labelFor(el, role: role)
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
        let sub = axString(el, "AXSubrole")
        o["role"] = (sub?.isEmpty == false) ? "\(role)/\(sub!)" : role

        if scroll {
            o["ops"] = [String]()
            o["scrollable"] = true
            return o
        }
        if textRoles.contains(role) {
            if role == "AXSecureTextField" {
                o["isPassword"] = true
                if let v = axValueText(el), !v.isEmpty { o["hasValue"] = true }
            } else {
                o["isPassword"] = false
                if let v = axValueText(el) { o["value"] = clip(v, 200) }
            }
            o["ops"] = ["TYPE_TEXT"]
        } else if selectRoles.contains(role) {
            o["ops"] = ["SELECT"]
            if let v = axValueText(el) { o["value"] = clip(v, 200) }
            let opts = menuOptions(el)
            if !opts.isEmpty { o["options"] = opts }
        } else if numericRoles.contains(role) {
            o["ops"] = ["TYPE_TEXT"]
            if let v = axValueText(el) { o["value"] = clip(v, 200) }
        } else {
            o["ops"] = ["CLICK"]
        }
        if role == "AXCheckBox" || role == "AXRadioButton" || role == "AXMenuItem" {
            if let v = axCopy(el, "AXValue") as? NSNumber { o["checked"] = v.intValue != 0 }
        }
        if let e = axBool(el, "AXExpanded") { o["expanded"] = e }
        if axBool(el, "AXEnabled") == false { o["disabled"] = true }
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
        if axBool(el, "AXHidden") == true { return }
        if let f = axFrame(el), f.width > 0, f.height > 0, !f.intersects(windowFrame) { return }
        let role = axString(el, "AXRole") ?? ""
        if skippedRoles.contains(role) { return }
        switch role {
        case "AXStaticText":
            add(axValueText(el) ?? axString(el, "AXTitle"))
            return
        case "AXHeading":
            add(axValueText(el) ?? axString(el, "AXTitle") ?? axString(el, "AXDescription"))
        case "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox":
            // An empty field shows its placeholder on screen; a filled one (even with spaces only) shows its value.
            let value = axValueText(el) ?? ""
            add(value.isEmpty ? axString(el, "AXPlaceholderValue") : value)
            return
        case "AXCheckBox", "AXRadioButton", "AXButton", "AXLink", "AXMenuItem":
            // The label is the visible text of a control; its children repeat it.
            add(axString(el, "AXTitle") ?? axString(el, "AXDescription") ?? labelFor(el, role: role))
            if role != "AXLink" { return }
        case "AXSecureTextField":
            // Never add the value. Only test it for emptiness (like the snapshot's hasValue): the placeholder shows only then.
            if (axValueText(el) ?? "").isEmpty { add(axString(el, "AXPlaceholderValue")) }
            return
        default:
            break
        }
        for c in axChildren(el) {
            walk(c, depth: depth + 1)
            if truncated { return }
        }
    }
}

// MARK: Commands

func cmdSnapshot(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    let deadline = Date().addingTimeInterval(8.2)
    let win = try prepareWindow(pid, a.int("windowId"), deadline: deadline)
    let maxEl = max(1, min(a.int("maxElements") ?? 120, 1000))
    let walker = SnapWalker(windowFrame: win.frame, maxElements: maxEl, deadline: deadline)
    walker.walk(win.ax, parentRole: nil, depth: 0)
    let sid = UUID().uuidString
    withState {
        var ring = snapshotRings[pid] ?? []
        ring.append(Snapshot(id: sid, pid: pid, refs: walker.refs))
        while ring.count > 8 { ring.removeFirst() }
        snapshotRings[pid] = ring
    }
    return [
        "snapshotId": sid, "elements": walker.entries, "truncated": walker.truncated,
        "window": win.json,
    ]
}

func cmdRead(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    let deadline = Date().addingTimeInterval(8.2)
    let win = try prepareWindow(pid, a.int("windowId"), deadline: deadline)
    let walker = ReadWalker(windowFrame: win.frame, maxChars: max(1, a.int("maxChars") ?? 12000), deadline: deadline)
    walker.walk(win.ax, depth: 0)
    return ["title": win.title, "text": walker.lines.joined(separator: "\n"), "truncated": walker.truncated]
}

func cmdElementFrame(_ a: JSON) throws -> JSON {
    let el = try lookup(a)
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
private func mutationDeadline(_ a: JSON) -> Date {
    let arrived = (a["_arrivedAt"] as? Double).map { Date(timeIntervalSince1970: $0) } ?? Date()
    return arrived.addingTimeInterval(4.0)
}

func cmdPerform(_ a: JSON) throws -> JSON {
    let deadline = mutationDeadline(a)
    let el = try lookup(a) // STALE first: it needs no permission
    try requireAccessibility()
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
    throw lastError ?? fail("The element has no press action.", "NO_ACTION")
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
    var target: AXUIElement?
    var element: AXUIElement?
    if a["snapshotId"] != nil || a["index"] != nil {
        let el = try lookup(a)
        try requireAccessibility()
        element = el
        AXUIElementSetMessagingTimeout(el, 1.0)
        target = nearestScrollArea(el)
    } else {
        try requireAccessibility()
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
