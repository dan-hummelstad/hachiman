import XCTest
@testable import Hachiman

final class LinkFetchTests: XCTestCase {
    func testAllowsOnlyHttpsToAPublicHost() {
        XCTAssertTrue(LinkFetch.isAllowed(URL(string: "https://example.com/a")!))
        XCTAssertTrue(LinkFetch.isAllowed(URL(string: "https://93.184.216.34/")!))
        XCTAssertFalse(LinkFetch.isAllowed(URL(string: "http://example.com/")!))
        XCTAssertFalse(LinkFetch.isAllowed(URL(string: "https://user:pw@example.com/")!))
        XCTAssertFalse(LinkFetch.isAllowed(URL(string: "file:///etc/hosts")!))
        for host in ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "[::1]", "[fe80::1]", "[fd00::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"] {
            XCTAssertFalse(LinkFetch.isAllowed(URL(string: "https://\(host)/")!), host)
        }
    }

    func testPrivateLiteralLeavesNamesAlone() {
        XCTAssertFalse(LinkFetch.isPrivateLiteral("localhost.example"))
        XCTAssertFalse(LinkFetch.isPrivateLiteral("172.32.0.1"))
        XCTAssertFalse(LinkFetch.isPrivateLiteral("2606:4700::1111"))
    }

    func testRefusesBeforeAnyRequest() async {
        let none = await LinkFetch.fetch(URL(string: "https://127.0.0.1/")!, maxBytes: 100)
        XCTAssertNil(none)
        let zero = await LinkFetch.fetch(URL(string: "https://example.com/")!, maxBytes: 0)
        XCTAssertNil(zero)
    }
}
