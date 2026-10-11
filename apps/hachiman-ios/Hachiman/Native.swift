import UIKit
import WebKit

/// The small native hooks of the mobile UI (plan Phase 5.5): haptics, the share sheet and the
/// window appearance.
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
