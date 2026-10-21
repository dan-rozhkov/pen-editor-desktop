import Foundation
import AppKit
import ApplicationServices

typealias JSON = [String: Any]

struct CmdError: Error {
    let message: String
    let code: String?
}

func fail(_ message: String, _ code: String? = nil) -> CmdError {
    CmdError(message: message, code: code)
}

func logErr(_ s: String) {
    try? FileHandle.standardError.write(contentsOf: Data(("[computer-use] " + s + "\n").utf8))
}

final class Output {
    static let shared = Output()
    private let lock = NSLock()

    func send(_ obj: JSON) {
        guard JSONSerialization.isValidJSONObject(obj),
              var data = try? JSONSerialization.data(withJSONObject: obj) else {
            logErr("dropped an unserializable message")
            return
        }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
}

/// Answers one request exactly once (the watchdog and the real work race for it).
final class Responder {
    let id: Any
    private var done = false
    private let lock = NSLock()

    init(id: Any) { self.id = id }

    var isFinished: Bool {
        lock.lock()
        defer { lock.unlock() }
        return done
    }

    func finish(_ result: Result<JSON, CmdError>) {
        lock.lock()
        if done { lock.unlock(); return }
        done = true
        lock.unlock()
        var out: JSON
        switch result {
        case .success(let value):
            out = value
            out["ok"] = true
        case .failure(let e):
            out = ["ok": false, "error": e.message]
            if let c = e.code { out["code"] = c }
        }
        out["id"] = id
        Output.shared.send(out)
    }
}

extension Dictionary where Key == String, Value == Any {
    func str(_ k: String) -> String? { self[k] as? String }
    func int(_ k: String) -> Int? { (self[k] as? NSNumber)?.intValue }
    func dbl(_ k: String) -> Double? { (self[k] as? NSNumber)?.doubleValue }
    func bool(_ k: String) -> Bool? {
        guard let n = self[k] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }
    func pid() throws -> pid_t {
        guard let p = int("pid"), p > 0 else { throw fail("pid is required", "BAD_ARGS") }
        return pid_t(p)
    }
}

func finite(_ v: CGFloat) -> Int {
    let d = Double(v)
    return d.isFinite ? Int(d.rounded()) : 0
}

func clip(_ s: String, _ n: Int) -> String {
    s.count > n ? String(s.prefix(n)) : s
}

func collapse(_ s: String) -> String {
    s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
}

func runningApp(_ pid: pid_t) throws -> NSRunningApplication {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
        throw fail("No running app with pid \(pid).", "NOT_FOUND")
    }
    return app
}

func requireAccessibility() throws {
    if !AXIsProcessTrusted() {
        throw fail("Accessibility permission is missing.", "NO_ACCESSIBILITY")
    }
}
