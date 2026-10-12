import XCTest
@testable import Hachiman

final class AppSchemeHandlerTests: XCTestCase {
    private var base: URL!
    private var root: URL!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        root = base.appendingPathComponent("WebApp", isDirectory: true)
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try Data("<html>".utf8).write(to: root.appendingPathComponent("index.html"))
        try Data("default-src 'self'\n".utf8).write(to: root.appendingPathComponent("csp-header.txt"))
        try Data("x".utf8).write(to: root.appendingPathComponent("assets/app.js"))
        try Data("w".utf8).write(to: root.appendingPathComponent("assets/rnnoise.wasm"))
        try Data("secret".utf8).write(to: base.appendingPathComponent("secret.txt"))
        try fm.createSymbolicLink(
            at: root.appendingPathComponent("escape.txt"), withDestinationURL: base.appendingPathComponent("secret.txt"))
        try fm.createSymbolicLink(at: root.appendingPathComponent("up"), withDestinationURL: base)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    private func resolve(_ path: String) -> AppSchemeHandler.Resolution {
        AppSchemeHandler.resolve(path: path, root: root)
    }

    private func name(_ resolution: AppSchemeHandler.Resolution) -> String? {
        guard case .file(let url) = resolution else { return nil }
        return url.lastPathComponent
    }

    /// The decoded path, as the handler reads it from the request URL.
    private func decodedPath(_ url: String) -> String {
        URL(string: url)!.path(percentEncoded: false)
    }

    func testServesFiles() {
        XCTAssertEqual(name(resolve("/index.html")), "index.html")
        XCTAssertEqual(name(resolve("/assets/app.js")), "app.js")
        XCTAssertEqual(name(resolve("/")), "index.html")
        XCTAssertEqual(name(resolve("")), "index.html")
    }

    func testSpaFallbackOnlyForExtensionlessPaths() {
        XCTAssertEqual(name(resolve("/guilds/123/channels")), "index.html")
        XCTAssertEqual(name(resolve("/assets")), "index.html")
        XCTAssertEqual(resolve("/assets/missing.js"), .notFound)
        XCTAssertEqual(resolve("/favicon.ico"), .notFound)
    }

    func testRejectsTraversal() {
        XCTAssertEqual(resolve("/../secret.txt"), .notFound)
        XCTAssertEqual(resolve("/assets/../../secret.txt"), .notFound)
        XCTAssertEqual(resolve("/assets/../index.html"), .notFound)
        XCTAssertEqual(resolve("/./index.html"), .notFound)
        XCTAssertEqual(resolve("/..\\secret.txt"), .notFound)
        // Dot segments with no extension are rejected too, not sent to the SPA fallback.
        XCTAssertEqual(resolve("/.."), .notFound)
    }

    func testRejectsEncodedTraversal() {
        XCTAssertEqual(decodedPath("hachiman://app/%2e%2e/secret.txt"), "/../secret.txt")
        XCTAssertEqual(resolve(decodedPath("hachiman://app/%2e%2e/secret.txt")), .notFound)
        XCTAssertEqual(resolve(decodedPath("hachiman://app/assets/%2E%2E/%2e%2e/secret.txt")), .notFound)
        XCTAssertEqual(resolve(decodedPath("hachiman://app/..%2fsecret.txt")), .notFound)
        XCTAssertEqual(resolve(decodedPath("hachiman://app/%252e%252e/secret.txt")), .notFound)
    }

    func testAbsolutePathsStayInsideRoot() {
        // Extension-less, so the SPA fallback: index.html under root, never /etc/passwd.
        XCTAssertEqual(name(resolve("//etc/passwd")), "index.html")
        XCTAssertEqual(resolve("//etc/hosts.txt"), .notFound)
        XCTAssertEqual(resolve(base.appendingPathComponent("secret.txt").path), .notFound)
    }

    func testRejectsSymlinkEscape() {
        XCTAssertEqual(resolve("/escape.txt"), .notFound)
        XCTAssertEqual(resolve("/up/secret.txt"), .notFound)
    }

    @MainActor
    func testEveryResponseCarriesTheCspHeader() throws {
        let handler = AppSchemeHandler(root: root)
        for (url, status) in [("hachiman://app/assets/app.js", 200), ("hachiman://app/", 200), ("hachiman://app/missing.js", 404)] {
            let (response, _) = handler.response(for: URL(string: url)!)
            XCTAssertEqual(response.statusCode, status, url)
            XCTAssertEqual(response.value(forHTTPHeaderField: "Content-Security-Policy"), "default-src 'self'", url)
        }
        let (js, body) = handler.response(for: URL(string: "hachiman://app/assets/app.js")!)
        XCTAssertEqual(js.value(forHTTPHeaderField: "Content-Type"), "text/javascript; charset=utf-8")
        XCTAssertEqual(body, Data("x".utf8))
    }

    @MainActor
    func testNoPolicyFileFailsClosed() throws {
        try FileManager.default.removeItem(at: root.appendingPathComponent("csp-header.txt"))
        let (response, body) = AppSchemeHandler(root: root).response(for: URL(string: "hachiman://app/index.html")!)
        XCTAssertEqual(response.statusCode, 500)
        XCTAssertTrue(body.isEmpty)
    }

    func testMimeTypes() {
        XCTAssertEqual(AppSchemeHandler.mimeType(for: URL(fileURLWithPath: "/a/rnnoise.wasm")), "application/wasm")
        XCTAssertEqual(AppSchemeHandler.mimeType(for: URL(fileURLWithPath: "/a/app.js")), "text/javascript; charset=utf-8")
        XCTAssertEqual(AppSchemeHandler.mimeType(for: URL(fileURLWithPath: "/a/index.html")), "text/html; charset=utf-8")
        XCTAssertEqual(AppSchemeHandler.mimeType(for: URL(fileURLWithPath: "/a/style.css")), "text/css; charset=utf-8")
        XCTAssertEqual(AppSchemeHandler.mimeType(for: URL(fileURLWithPath: "/a/logo.png")), "image/png")
    }
}
