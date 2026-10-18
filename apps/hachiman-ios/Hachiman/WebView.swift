import SwiftUI
import WebKit

/// Owns the one WKWebView that runs the shared UI from `hachiman://app/index.html`, and its bridge.
@MainActor
final class WebHost: NSObject, WKNavigationDelegate, WKUIDelegate {
    let bridge = Bridge()
    let webView: WKWebView

    override init() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(root: AppSchemeHandler.bundledRoot), forURLScheme: AppSchemeHandler.scheme)
        // Persistent: the IndexedDB crypto store must survive restarts.
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Pinch zoom stays possible, as in Safari: the UI has fixed px text and no Dynamic Type,
        // so zoom is the only way to enlarge it. `maximum-scale=1` in index.html still stops the
        // zoom when a field gets focus.
        config.ignoresViewportScaleLimits = true
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: Bridge.handlerName)

        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        bridge.webView = webView
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        // No long-press link preview: it would fetch the page before the user opens the link, and
        // the long press is the message action gesture. Links open only through decidePolicyFor.
        webView.allowsLinkPreview = false
        // The page is a fixed frame, so the document does not rubber-band. Inner scrollers keep
        // their own bounce and momentum.
        webView.scrollView.bounces = false
        // The page draws edge to edge and pads itself with env(safe-area-inset-*).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "LaunchBackground")
        #if DEBUG
        webView.isInspectable = true
        #endif
        // The bar above the keyboard (previous, next, Done) stays: WebKit has no public API to hide
        // it. The page sits on top of it, because the visual viewport ends above the bar.
        loadStart()
    }

    /// Loads the bundled app. A Debug build loads the dev server instead when it answers.
    private func loadStart() {
        #if DEBUG
        Task {
            var probe = URLRequest(url: AppSchemeHandler.devServerURL, timeoutInterval: 1)
            probe.httpMethod = "HEAD"
            let up = (try? await URLSession.shared.data(for: probe)) != nil
            NSLog("[hachiman] %@", up ? "dev server: hot reload" : "no dev server: bundled WebApp")
            webView.load(URLRequest(url: up ? AppSchemeHandler.devServerURL : AppSchemeHandler.startURL))
        }
        #else
        webView.load(URLRequest(url: AppSchemeHandler.startURL))
        #endif
    }

    static func isAppURL(_ url: URL?) -> Bool {
        #if DEBUG
        if AppSchemeHandler.isDevServer(scheme: url?.scheme, host: url?.host, port: url?.port) { return true }
        #endif
        return url?.scheme == AppSchemeHandler.scheme && url?.host == AppSchemeHandler.host && url?.port == nil
    }

    // MARK: - WKNavigationDelegate

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if Self.isAppURL(url) {
            decisionHandler(.allow)
            return
        }
        // Subframes may start blank (editor and sandbox iframes); nothing loads from there.
        if !isMainFrame, url?.absoluteString == "about:blank" || url?.absoluteString == "about:srcdoc" {
            decisionHandler(.allow)
            return
        }
        if isMainFrame, let url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            UIApplication.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        bridge.pageWillLoad()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridge.pageWillLoad()
        loadStart()
    }

    // MARK: - WKUIDelegate

    /// `window.open` and `target=_blank`: http(s) opens in the system browser, nothing opens here.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            UIApplication.shared.open(url)
        }
        return nil
    }

    /// No WebKit menu or preview on a long press: the long press is the app's own gesture (message
    /// actions, hold menus). This is a second guard beside `allowsLinkPreview = false`.
    func webView(
        _ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
        completionHandler: @escaping @MainActor @Sendable (UIContextMenuConfiguration?) -> Void
    ) {
        completionHandler(nil)
    }

    /// Microphone and camera only for the app's main frame. iOS still shows its own prompt.
    func webView(
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
    ) {
        let trusted = Bridge.isTrustedSender(
            isMainFrame: frame.isMainFrame, scheme: origin.protocol, host: origin.host, port: origin.port)
        decisionHandler(trusted ? .grant : .deny)
    }
}

struct WebView: UIViewRepresentable {
    let host: WebHost

    func makeUIView(context: Context) -> WKWebView { host.webView }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
