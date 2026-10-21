import Foundation
import AppKit
import ScreenCaptureKit
import CoreGraphics

func cmdScreenshot(_ a: JSON, done: @escaping (Result<JSON, CmdError>) -> Void) {
    guard let wid = a.int("windowId"), wid > 0 else {
        return done(.failure(fail("windowId is required", "BAD_ARGS")))
    }
    let maxWidth = max(64, a.int("maxWidth") ?? 1280)
    guard CGPreflightScreenCaptureAccess() else {
        return done(.failure(fail("Screen Recording permission is missing.", "NO_SCREEN_RECORDING")))
    }
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
        if let error = error { return done(.failure(mapCaptureError(error))) }
        guard let window = content?.windows.first(where: { Int($0.windowID) == wid }) else {
            return done(.failure(fail("Window \(wid) not found.", "NO_WINDOW")))
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let pps = Double(SCShareableContent.info(for: filter).pointPixelScale)
        let nativeW = max(1.0, Double(window.frame.width) * pps)
        let targetW = min(nativeW, Double(maxWidth))
        let targetH = max(1.0, Double(window.frame.height) * targetW / max(1.0, Double(window.frame.width)))
        let config = SCStreamConfiguration()
        config.width = Int(targetW.rounded())
        config.height = Int(targetH.rounded())
        config.showsCursor = false
        config.scalesToFit = true
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
            if let error = error { return done(.failure(mapCaptureError(error))) }
            guard let image = image,
                  let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                return done(.failure(fail("Could not encode the screenshot.", "CAPTURE_FAILED")))
            }
            done(.success([
                "png": png.base64EncodedString(), "width": image.width, "height": image.height,
                "scale": targetW / max(1.0, Double(window.frame.width)),
            ]))
        }
    }
}

private func mapCaptureError(_ e: Error) -> CmdError {
    let ns = e as NSError
    if ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.userDeclined.rawValue {
        return fail("Screen Recording permission is missing.", "NO_SCREEN_RECORDING")
    }
    return fail("Screen capture failed: \(ns.localizedDescription)", "CAPTURE_FAILED")
}
