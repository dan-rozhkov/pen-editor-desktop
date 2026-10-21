import Foundation
import AppKit
import ApplicationServices

private let src = CGEventSource(stateID: .combinedSessionState)

private func pointer() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

private func warp(_ p: CGPoint) {
    CGWarpMouseCursorPosition(p)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?
        .post(tap: .cghidEventTap)
}

private func point(_ a: JSON) throws -> CGPoint {
    guard let x = a.dbl("x"), let y = a.dbl("y"), x.isFinite, y.isFinite else {
        throw fail("x and y are required", "BAD_ARGS")
    }
    return CGPoint(x: x, y: y)
}

private func inputReady(_ pid: pid_t, activate: Bool) throws {
    _ = try runningApp(pid)
    try requireAccessibility()
    if activate { try activateApp(pid) }
}

/// The point must belong to the app: the topmost AX element there is the app's, or (when AX gives
/// nothing) the topmost on-screen layer-0 window there is.
private func requirePointInApp(_ pid: pid_t, _ p: CGPoint) throws {
    let err = fail("The point is covered by another app's window, so no click was sent.", "POINT_NOT_IN_APP")
    let sys = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(sys, 1.0)
    var el: AXUIElement?
    if AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &el) == .success, let e = el {
        var owner: pid_t = 0
        if AXUIElementGetPid(e, &owner) == .success {
            if owner == pid { return }
            // Sideform's own overlay (click-through) is transparent: fall through to the window scan.
            if owner != getppid() { throw err }
        }
    }
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { throw err }
    let parent = getppid()
    for w in list { // front to back
        let owner = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        if owner == parent && owner != pid { continue } // Sideform's own overlay windows, any layer
        guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let bounds = w[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              frame.contains(p) else { continue }
        if owner == pid { return }
        throw err
    }
    throw err
}

func cmdClick(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    let p = try point(a)
    try inputReady(pid, activate: true)
    try requirePointInApp(pid, p)
    let (down, up, button): (CGEventType, CGEventType, CGMouseButton)
    switch a.str("button") ?? "left" {
    case "right": (down, up, button) = (.rightMouseDown, .rightMouseUp, .right)
    case "middle": (down, up, button) = (.otherMouseDown, .otherMouseUp, .center)
    case "left": (down, up, button) = (.leftMouseDown, .leftMouseUp, .left)
    default: throw fail("button must be left, right or middle", "BAD_ARGS")
    }
    let count = max(1, min(a.int("count") ?? 1, 3))
    let saved = pointer()
    warp(p)
    Thread.sleep(forTimeInterval: 0.03)
    for i in 1...count {
        for type in [down, up] {
            let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button)
            e?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            e?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.015)
        }
    }
    Thread.sleep(forTimeInterval: 0.05)
    warp(saved)
    return ["done": true]
}

func cmdMove(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    let p = try point(a)
    try inputReady(pid, activate: false)
    try requirePointInApp(pid, p)
    warp(p)
    return ["done": true]
}

func cmdScroll(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    let p = try point(a)
    try inputReady(pid, activate: false)
    try requirePointInApp(pid, p)
    // dx/dy follow the DOM convention: positive dy scrolls the content down (the view moves down).
    var remY = Int(max(-20000, min(20000, a.dbl("dy") ?? 0)))
    var remX = Int(max(-20000, min(20000, a.dbl("dx") ?? 0)))
    let saved = pointer()
    warp(p)
    Thread.sleep(forTimeInterval: 0.03)
    while remX != 0 || remY != 0 {
        let sy = max(-120, min(120, remY))
        let sx = max(-120, min(120, remX))
        remY -= sy
        remX -= sx
        CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: Int32(-sy), wheel2: Int32(-sx), wheel3: 0)?
            .post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.008)
    }
    Thread.sleep(forTimeInterval: 0.05)
    warp(saved)
    return ["done": true]
}

private func postKey(_ code: CGKeyCode, flags: CGEventFlags, unicode: [UniChar]? = nil) {
    for isDown in [true, false] {
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: isDown) else { continue }
        e.flags = flags
        if let u = unicode, !u.isEmpty {
            e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
        }
        e.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.004)
    }
}

private func typeRun(_ text: String) {
    let units = Array(text.utf16)
    var i = 0
    while i < units.count {
        var end = min(i + 20, units.count)
        if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
        postKey(0, flags: [], unicode: Array(units[i..<end]))
        i = end
    }
}

func cmdType(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    guard let text = a.str("text") else { throw fail("text is required", "BAD_ARGS") }
    try inputReady(pid, activate: true)
    let parts = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    for (i, part) in parts.enumerated() {
        if i > 0 { postKey(36, flags: []) }
        if !part.isEmpty { typeRun(part) }
    }
    return ["done": true]
}

private let keyCodes: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "escape": 53, "esc": 53, "tab": 48, "backspace": 51, "delete": 117,
    "space": 49, " ": 49, "arrowup": 126, "up": 126, "arrowdown": 125, "down": 125, "arrowleft": 123,
    "left": 123, "arrowright": 124, "right": 124, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
    "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
    ".": 47, "`": 50,
]

private func modifierFlag(_ name: String) -> CGEventFlags? {
    switch name.lowercased() {
    case "meta", "cmd", "command", "super": return .maskCommand
    case "control", "ctrl": return .maskControl
    case "alt", "option", "opt": return .maskAlternate
    case "shift": return .maskShift
    default: return nil
    }
}

func cmdKey(_ a: JSON) throws -> JSON {
    let pid = try a.pid()
    guard var key = a.str("key"), !key.isEmpty else { throw fail("key is required", "BAD_ARGS") }
    var mods = a["modifiers"] as? [String] ?? []
    if key.count > 1, key.contains("+") {
        var parts = key.components(separatedBy: "+")
        if parts.last == "" { parts.removeLast(); parts[parts.count - 1] = "+" }
        key = parts.removeLast()
        mods.append(contentsOf: parts)
    }
    var flags: CGEventFlags = []
    for m in mods {
        guard let f = modifierFlag(m) else { throw fail("Unknown modifier \(m).", "BAD_ARGS") }
        flags.insert(f)
    }
    if key.count == 1, key != key.lowercased(), key.lowercased().first!.isLetter {
        flags.insert(.maskShift)
    }
    try inputReady(pid, activate: true)
    if let code = keyCodes[key.lowercased()] {
        postKey(code, flags: flags)
    } else if key.count == 1, flags.isEmpty {
        typeRun(key)
    } else {
        throw fail("Unknown key \(key).", "BAD_ARGS")
    }
    return ["done": true]
}
