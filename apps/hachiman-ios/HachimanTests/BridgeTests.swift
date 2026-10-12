import XCTest
@testable import Hachiman

final class BridgeTests: XCTestCase {
    func testAcceptsOnlyTheAppMainFrame() {
        XCTAssertTrue(Bridge.isTrustedSender(isMainFrame: true, scheme: "hachiman", host: "app", port: 0))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: false, scheme: "hachiman", host: "app", port: 0))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: true, scheme: "https", host: "app", port: 0))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: true, scheme: "hachiman", host: "evil", port: 0))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: true, scheme: "hachiman", host: "app.evil", port: 0))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: true, scheme: "hachiman", host: "app", port: 8080))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: true, scheme: "file", host: "", port: 0))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: true, scheme: "", host: "", port: 0))
        #if DEBUG
        XCTAssertTrue(Bridge.isTrustedSender(isMainFrame: true, scheme: "http", host: "localhost", port: 5175))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: false, scheme: "http", host: "localhost", port: 5175))
        XCTAssertFalse(Bridge.isTrustedSender(isMainFrame: true, scheme: "http", host: "localhost", port: 5173))
        #endif
    }

    func testErrorReplyText() {
        XCTAssertEqual(BridgeError(.storeCorrupt, "bad").replyText, "StoreCorrupt: bad")
        XCTAssertEqual(BridgeError(.secureStorageUnavailable, "x").replyText, "SecureStorageUnavailable: x")
    }

    func testDeepLinkEvents() {
        XCTAssertEqual(HachimanApp.event(for: URL(string: "takusen://invite/abc#k=x")!), "invite-link")
        // Only the ASWebAuthenticationSession completion sends oauth-callback.
        XCTAssertNil(HachimanApp.event(for: URL(string: "app.hachiman://oauth-callback?code=1")!))
        XCTAssertNil(HachimanApp.event(for: URL(string: "https://example.com")!))
    }

    @MainActor
    func testEventsWaitForReadyAndKeepTheirOrder() async throws {
        var scripts: [String] = []
        let bridge = Bridge(evaluate: { scripts.append($0) })
        bridge.emit("invite-link", ["url": "takusen://invite/a"])
        bridge.emit("oauth-callback", ["url": "app.hachiman://oauth-callback?code=1"])
        XCTAssertEqual(scripts, [])

        _ = try await bridge.handle("ready", [:])
        XCTAssertEqual(scripts.count, 2)
        XCTAssertTrue(scripts[0].hasPrefix("window.__hachimanNative.emit(\"invite-link\""))
        XCTAssertTrue(scripts[1].hasPrefix("window.__hachimanNative.emit(\"oauth-callback\""))
    }

    @MainActor
    func testEventsAfterReadyGoAtOnce() async throws {
        var scripts: [String] = []
        let bridge = Bridge(evaluate: { scripts.append($0) })
        _ = try await bridge.handle("ready", [:])
        bridge.emit("invite-link", ["url": "takusen://invite/a"])
        XCTAssertEqual(scripts.count, 1)
    }

    @MainActor
    func testANewPageLoadHoldsEventsUntilTheNextReady() async throws {
        var scripts: [String] = []
        let bridge = Bridge(evaluate: { scripts.append($0) })
        _ = try await bridge.handle("ready", [:])
        bridge.pageWillLoad()
        bridge.emit("invite-link", ["url": "takusen://invite/a"])
        XCTAssertEqual(scripts, [])
        _ = try await bridge.handle("ready", [:])
        XCTAssertEqual(scripts.count, 1)
    }

    @MainActor
    func testHexColors() {
        XCTAssertNotNil(Native.color(hex: "#22252c"))
        XCTAssertNotNil(Native.color(hex: "#fff"))
        XCTAssertNotNil(Native.color(hex: "#22252cff"))
        XCTAssertNil(Native.color(hex: "22252c"))
        XCTAssertNil(Native.color(hex: "#ggg"))
        XCTAssertNil(Native.color(hex: "#12345"))
    }
}
