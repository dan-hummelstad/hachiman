import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves `hachiman://app/<path>` from the bundled `WebApp/` folder (the Vite build).
/// The origin is the same as the Electron host, so Takusen CORS already allows it.
/// Every response carries the `Content-Security-Policy` header from `WebApp/csp-header.txt`,
/// as Electron sends it: a Worker script does not get the policy of the page.
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    nonisolated static let scheme = "hachiman"
    nonisolated static let host = "app"
    nonisolated static let startURL = URL(string: "hachiman://app/index.html")!
    /// Written by the Vite build (vite.config.ts); the Copy WebApp phase fails without it.
    nonisolated static let cspFile = "csp-header.txt"

    enum Resolution: Equatable {
        case file(URL)
        case notFound
    }

    private let root: URL
    /// Nil when the build has no policy file: then every request fails (fail closed).
    private let csp: String?

    init(root: URL) {
        self.root = root
        let text = try? String(contentsOf: root.appendingPathComponent(Self.cspFile), encoding: .utf8)
        let policy = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        csp = policy?.isEmpty == false ? policy : nil
    }

    /// The `WebApp/` folder in the app bundle.
    static var bundledRoot: URL {
        Bundle.main.bundleURL.appendingPathComponent("WebApp", isDirectory: true)
    }

    /// Maps a decoded URL path to a file under `root`. Rejects `..`, `.`, backslashes, NUL and
    /// anything that resolves (also through a symlink) outside `root`. A missing path without a
    /// file extension falls back to `index.html` (SPA routes); any other miss is `.notFound`.
    nonisolated static func resolve(path: String, root: URL) -> Resolution {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        for part in parts where part == ".." || part == "." || part.contains("\\") || part.contains("\0") {
            return .notFound
        }
        let rootPath = root.resolvingSymlinksInPath().standardizedFileURL.path
        let index = URL(fileURLWithPath: rootPath).appendingPathComponent("index.html")

        if parts.isEmpty { return regularFile(index, inside: rootPath) ? .file(index) : .notFound }

        var candidate = URL(fileURLWithPath: rootPath, isDirectory: true)
        for part in parts { candidate.appendPathComponent(part) }
        let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
        if regularFile(resolved, inside: rootPath) { return .file(resolved) }

        if (parts.last ?? "").contains(".") { return .notFound }
        return regularFile(index, inside: rootPath) ? .file(index) : .notFound
    }

    nonisolated private static func regularFile(_ url: URL, inside rootPath: String) -> Bool {
        let path = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard path.hasPrefix(rootPath + "/") else { return false }
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
    }

    nonisolated static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "txt": return "text/plain; charset=utf-8"
        default:
            return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }

    /// The response and body for a request URL.
    func response(for url: URL?) -> (HTTPURLResponse, Data) {
        let responseURL = url ?? Self.startURL
        guard let csp else {
            return (Self.httpResponse(responseURL, 500, ["Content-Type": "text/plain; charset=utf-8", "Content-Length": "0"]), Data())
        }
        var resolution = Resolution.notFound
        if let url, url.scheme == Self.scheme, url.host == Self.host, url.port == nil {
            resolution = Self.resolve(path: url.path(percentEncoded: false), root: root)
        }
        guard case .file(let file) = resolution, let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            return (Self.httpResponse(responseURL, 404, [
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": "0",
                "Content-Security-Policy": csp,
            ]), Data())
        }
        return (Self.httpResponse(responseURL, 200, [
            "Content-Type": Self.mimeType(for: file),
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
            "Content-Security-Policy": csp,
        ]), data)
    }

    nonisolated private static func httpResponse(_ url: URL, _ status: Int, _ headers: [String: String]) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let (response, data) = response(for: task.request.url)
        task.didReceive(response)
        if !data.isEmpty { task.didReceive(data) }
        task.didFinish()
    }

    // Every task finishes inside `start`, so there is nothing to cancel.
    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}
