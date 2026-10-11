import UIKit
import WebKit

/// The small native hooks of the mobile UI (plan Phase 5.5): haptics, the share sheet, the
/// window appearance and the Files export sheet.
@MainActor
enum Native {
    static func haptic(_ kind: String) throws(BridgeError) {
        switch kind {
        case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        default: throw BridgeError(.malformed, "unknown haptic kind")
        }
    }

    /// The share sheet. True when the user shared, false when they cancelled.
    static func share(url: URL, text: String?, from presenter: UIViewController) async -> Bool {
        var items: [Any] = []
        if let text, !text.isEmpty { items.append(text) }
        items.append(url)
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = presenter.view
        return await withCheckedContinuation { continuation in
            var resumed = false
            // The handler can run more than once: a cancelled share extension (Mail, Messages)
            // calls it with `completed == false` while the sheet stays open. Resume once, when
            // the share finished or the sheet closed (no activity type).
            sheet.completionWithItemsHandler = { [weak sheet] activityType, completed, _, _ in
                guard !resumed, completed || activityType == nil else { return }
                resumed = true
                sheet?.completionWithItemsHandler = nil
                continuation.resume(returning: completed)
            }
            presenter.present(sheet, animated: true)
        }
    }

    /// The number of open export sheets (0 or 1). Their files are in `tmp/export/`.
    private static var openExports = 0

    /// The Files export sheet for a UTF-8 text file. True when the user saved the file, false when
    /// they cancelled. The file goes to `tmp/export/<uuid>/<name>` with complete file protection, and
    /// the app deletes it when the sheet closes. A save first deletes `tmp/export/`, so a file that a
    /// killed process left goes too.
    ///
    /// One sheet at a time: a second call while a sheet is open (a double tap) throws `Malformed`.
    /// UIKit drops a second `present` on a presenter that is still presenting, so that call would
    /// never resume, and its file would stay.
    static func saveTextFile(name: String, text: String, from presenter: UIViewController) async throws(BridgeError) -> Bool {
        guard isFileName(name) else { throw BridgeError(.malformed, "name is not a file name") }
        guard openExports == 0 else { throw BridgeError(.malformed, "an export sheet is already open") }
        let files = FileManager.default
        let root = files.temporaryDirectory.appendingPathComponent("export", isDirectory: true)
        try? files.removeItem(at: root)
        let dir = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = dir.appendingPathComponent(name, isDirectory: false)
        openExports += 1
        defer {
            openExports -= 1
            try? files.removeItem(at: dir)
        }
        do {
            try files.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(text.utf8).write(to: file, options: .completeFileProtection)
        } catch {
            throw BridgeError(.internal, "could not write the file: \(error.localizedDescription)")
        }

        // The picker holds its delegate weakly.
        let export = FileExport()
        let saved = await withCheckedContinuation { continuation in
            export.finish = { continuation.resume(returning: $0) }
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            picker.delegate = export
            // UIKit presents the picker later, when its remote view is ready, so
            // `picker.presentingViewController` is still nil after this call.
            presenter.present(picker, animated: true)
        }
        withExtendedLifetime(export) {}
        return saved
    }

    /// One path component that Files can show: not empty, not hidden, no `/`, `:` or control
    /// characters, and at most 255 UTF-8 bytes.
    nonisolated static func isFileName(_ name: String) -> Bool {
        !name.isEmpty && !name.hasPrefix(".") && name.utf8.count <= 255
            && !name.unicodeScalars.contains { $0 == "/" || $0 == ":" || CharacterSet.controlCharacters.contains($0) }
    }

    /// Light or dark system UI (status bar, sheets, keyboard) and the color behind the safe areas.
    static func setAppearance(theme: String, background: String, window: UIWindow?, webView: WKWebView?) throws(BridgeError) {
        let style: UIUserInterfaceStyle
        switch theme {
        case "dark": style = .dark
        case "light": style = .light
        default: throw BridgeError(.malformed, "theme is not dark or light")
        }
        guard let color = color(hex: background) else { throw BridgeError(.malformed, "background is not a CSS hex color") }
        window?.overrideUserInterfaceStyle = style
        window?.backgroundColor = color
        window?.rootViewController?.view.backgroundColor = color
        webView?.backgroundColor = color
        webView?.scrollView.backgroundColor = color
        webView?.underPageBackgroundColor = color
    }

    /// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
    static func color(hex: String) -> UIColor? {
        guard hex.hasPrefix("#") else { return nil }
        var digits = String(hex.dropFirst())
        guard [3, 4, 6, 8].contains(digits.count), digits.allSatisfy(\.isHexDigit) else { return nil }
        if digits.count <= 4 { digits = digits.map { "\($0)\($0)" }.joined() }
        if digits.count == 6 { digits += "ff" }
        guard let value = UInt32(digits, radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((value >> 24) & 0xff) / 255, green: CGFloat((value >> 16) & 0xff) / 255,
            blue: CGFloat((value >> 8) & 0xff) / 255, alpha: CGFloat(value & 0xff) / 255)
    }
}

@MainActor
private final class FileExport: NSObject, UIDocumentPickerDelegate {
    var finish: ((Bool) -> Void)?

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        done(true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        done(false)
    }

    /// Calls `finish` once: true when saved, false when cancelled.
    private func done(_ saved: Bool) {
        guard let finish else { return }
        self.finish = nil
        finish(saved)
    }
}
