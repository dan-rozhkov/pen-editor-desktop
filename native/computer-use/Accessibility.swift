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

// MARK: Snapshot store (all access happens on the AX queue)

private struct Snapshot { let id: String; let pid: pid_t; let refs: [AXUIElement] }
private var snapshotRings: [pid_t: [Snapshot]] = [:] // last 8 snapshots per pid
private var manualSetAt: [pid_t: Date] = [:] // last AXManualAccessibility set, per pid
private var manualAccepted: [pid_t: Bool] = [:] // the app took the flag (Chromium/Electron)
private var webWaitFailedAt: [String: Date] = [:] // last web-area wait that ran out, per "pid:windowId"

func dropSnapshots(_ pid: pid_t) {
    snapshotRings[pid] = nil
    manualSetAt[pid] = nil
    manualAccepted[pid] = nil
    webWaitFailedAt = webWaitFailedAt.filter { !$0.key.hasPrefix("\(pid):") }
}

private func lookup(_ a: JSON) throws -> AXUIElement {
    guard let sid = a.str("snapshotId"), let idx = a.int("index"),
          let snap = snapshotRings.values.lazy.compactMap({ $0.first(where: { $0.id == sid }) }).first,
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
    let rebuilding = manualSetAt[pid].map { now.timeIntervalSince($0) < 3 } ?? false
    if !rebuilding {
        // Chromium/Electron accept the attribute; other apps return an error.
        manualAccepted[pid] = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
        manualSetAt[pid] = now
    }
    // A window whose wait ran out recently is not waited for again: it may hold no web content at all.
    let key = "\(pid):\(win.id)"
    let recentFail = webWaitFailedAt[key].map { now.timeIntervalSince($0) < 60 } ?? false
    if manualAccepted[pid] == true && !recentFail {
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
        webWaitFailedAt[key] = ready ? nil : Date()
    } else if manualAccepted[pid] != true && axChildren(win.ax).isEmpty {
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
    var ring = snapshotRings[pid] ?? []
    ring.append(Snapshot(id: sid, pid: pid, refs: walker.refs))
    while ring.count > 8 { ring.removeFirst() }
    snapshotRings[pid] = ring
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

private func mapAXError(_ e: AXError, _ what: String) -> CmdError {
    switch e {
    case .invalidUIElement: return fail("The element is gone. Take a new snapshot.", "STALE")
    case .apiDisabled: return fail("Accessibility permission is missing.", "NO_ACCESSIBILITY")
    case .actionUnsupported, .attributeUnsupported, .notImplemented:
        return fail("The element does not support \(what).", "NO_ACTION")
    default: return fail("\(what) failed (AXError \(e.rawValue)).", "AX_FAILED")
    }
}

func cmdPerform(_ a: JSON) throws -> JSON {
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
    case "press": try act("AXPress", "press")
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
