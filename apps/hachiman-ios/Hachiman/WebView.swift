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
        // The page draws edge to edge and pads itself with env(safe-area-inset-*).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "LaunchBackground")
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: AppSchemeHandler.startURL))
    }

    /// Whether a URL is a page of the app itself.
    static func isAppURL(_ url: URL?) -> Bool {
        url?.scheme == AppSchemeHandler.scheme && url?.host == AppSchemeHandler.host && url?.port == nil
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
        webView.load(URLRequest(url: AppSchemeHandler.startURL))
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
