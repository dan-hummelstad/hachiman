import Foundation
import UIKit
import WebKit

/// Error of a bridge op. The JS side gets `"<code>: <message>"`.
struct BridgeError: Error, Equatable {
    enum Code: String {
        case secureStorageUnavailable = "SecureStorageUnavailable"
        case storeCorrupt = "StoreCorrupt"
        case malformed = "Malformed"
        case unsupported = "Unsupported"
        case `internal` = "Internal"
    }

    let code: Code
    let message: String

    init(_ code: Code, _ message: String) {
        self.code = code
        self.message = message
    }

    var replyText: String { "\(code.rawValue): \(message)" }
}

/// The `hachiman` script message handler: JS calls
/// `window.webkit.messageHandlers.hachiman.postMessage({op, ...args})` and gets the reply value,
/// or a rejection `"<Code>: <message>"`. Native events go to `window.__hachimanNative.emit`.
/// The JS half is `src/platforms/ios/bridge.ts`.
@MainActor
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "hachiman"

    weak var webView: WKWebView?
    private let wrapKeys: WrapKeyStore
    private let oauth = OAuth()
    private var pageReady = false
    private var pendingEvents: [(type: String, payload: [String: Any])] = []
    /// Runs an event script in the page. Tests pass their own; nil uses `webView`.
    private let evaluate: ((String) -> Void)?

    init(wrapKeys: WrapKeyStore = WrapKeyStore(), evaluate: ((String) -> Void)? = nil) {
        self.wrapKeys = wrapKeys
        self.evaluate = evaluate
    }

    /// Accepts a message only from the main frame of `hachiman://app` (no port), and in Debug
    /// builds also of the dev server.
    nonisolated static func isTrustedSender(isMainFrame: Bool, scheme: String, host: String, port: Int) -> Bool {
        guard isMainFrame else { return false }
        #if DEBUG
        if AppSchemeHandler.isDevServer(scheme: scheme, host: host, port: port) { return true }
        #endif
        return scheme == AppSchemeHandler.scheme && host == AppSchemeHandler.host && port == 0
    }

    static func isTrustedSender(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        return isTrustedSender(isMainFrame: frame.isMainFrame, scheme: origin.protocol, host: origin.host, port: origin.port)
    }

    // MARK: - Events (native → JS)

    /// Sends an event to the page. Events wait until the page sends `ready`, so none is lost
    /// before the JS defines `window.__hachimanNative`.
    func emit(_ type: String, _ payload: [String: Any]) {
        guard pageReady else {
            pendingEvents.append((type, payload))
            return
        }
        guard let typeJSON = Self.json(type), let payloadJSON = Self.json(payload) else { return }
        let script = "window.__hachimanNative.emit(\(typeJSON), \(payloadJSON))"
        if let evaluate { evaluate(script) } else { webView?.evaluateJavaScript(script) }
    }

    /// A new document is loading: hold events until it sends `ready` again.
    func pageWillLoad() {
        pageReady = false
    }

    private static func json(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - Ops (JS → native)

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard Self.isTrustedSender(message.frameInfo),
              let body = message.body as? [String: Any],
              let op = body["op"] as? String
        else {
            replyHandler(nil, BridgeError(.malformed, "untrusted sender or no op").replyText)
            return
        }
        Task { @MainActor in
            do {
                let value = try await self.handle(op, body)
                replyHandler(value ?? NSNull(), nil)
            } catch let error as BridgeError {
                replyHandler(nil, error.replyText)
            } catch {
                replyHandler(nil, BridgeError(.internal, String(describing: error)).replyText)
            }
        }
    }

    func handle(_ op: String, _ args: [String: Any]) async throws -> Any? {
        switch op {
        case "ready":
            pageReady = true
            let events = pendingEvents
            pendingEvents.removeAll()
            for event in events { emit(event.type, event.payload) }
            return nil

        case "wrapKey.get":
            let userId = try string(args, "userId")
            let store = wrapKeys
            // Keychain calls can block; keep them off the main thread.
            var bytes = try await Task.detached { try store.getWrapKeyBytes(userId: userId) }.value
            defer { bytes.resetBytes(in: 0..<bytes.count) }
            return bytes.base64EncodedString()

        case "wrapKey.clear":
            let userId = try string(args, "userId")
            let store = wrapKeys
            try await Task.detached { try store.clear(userId: userId) }.value
            return nil

        case "oauth.begin":
            let url = try webURL(args)
            try oauth.begin(url: url, anchor: webView?.window) { [weak self] callback in
                self?.emit("oauth-callback", ["url": callback.absoluteString])
            }
            return nil

        case "haptic":
            try Native.haptic(try string(args, "kind"))
            return nil

        case "share":
            let url = try webURL(args)
            let text = args["text"] as? String
            let from = try presenter()
            return await Native.share(url: url, text: text, from: from)

        case "scanQr":
            let from = try presenter()
            return try await QRScanner.scan(from: from)

        case "saveTextFile":
            let name = try string(args, "name")
            let text = try string(args, "text")
            let from = try presenter()
            return try await Native.saveTextFile(name: name, text: text, from: from)

        case "fetchLink":
            let url = try webURL(args)
            guard let maxBytes = args["maxBytes"] as? Int else { throw BridgeError(.malformed, "maxBytes is not an integer") }
            guard let r = await LinkFetch.fetch(url, maxBytes: maxBytes) else { return nil }
            return ["url": r.url.absoluteString, "contentType": r.contentType, "body": r.body.base64EncodedString()]

        case "setAppearance":
            try Native.setAppearance(
                theme: try string(args, "theme"), background: try string(args, "background"),
                window: webView?.window, webView: webView)
            return nil

        case "push.register":
            let deviceId = try string(args, "deviceId")
            guard UUID(uuidString: deviceId) != nil else { throw BridgeError(.malformed, "deviceId is not a UUID") }
            let discardOld = args["discardOld"] as? Bool ?? false
            return try await Push.shared.register(deviceId: deviceId.lowercased(), discardOld: discardOld)

        default:
            throw BridgeError(.unsupported, "unknown op \(op)")
        }
    }

    private func string(_ args: [String: Any], _ key: String) throws(BridgeError) -> String {
        guard let value = args[key] as? String else { throw BridgeError(.malformed, "\(key) is not a string") }
        return value
    }

    private func webURL(_ args: [String: Any]) throws(BridgeError) -> URL {
        let text = try string(args, "url")
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host != nil
        else { throw BridgeError(.malformed, "url is not an http(s) URL") }
        return url
    }

    private func presenter() throws(BridgeError) -> UIViewController {
        guard var top = webView?.window?.rootViewController else {
            throw BridgeError(.internal, "no view controller to present from")
        }
        while let next = top.presentedViewController { top = next }
        return top
    }
}
