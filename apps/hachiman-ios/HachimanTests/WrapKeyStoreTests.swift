import XCTest
@testable import Hachiman

final class WrapKeyStoreTests: XCTestCase {
    // A separate Keychain service, so the tests never touch a real user's key.
    private let store = WrapKeyStore(service: "hachiman.wrap-key.tests")
    private let userId = "0b6f5d3e-9a41-4c2b-8e7f-1d2c3b4a5f60"

    override func tearDown() {
        try? store.clear(userId: userId)
    }

    func testCreatesOnceAndReturnsTheSameBytes() throws {
        try store.clear(userId: userId)
        let first = try store.getWrapKeyBytes(userId: userId)
        XCTAssertEqual(first.count, 32)
        XCTAssertNotEqual(first, Data(count: 32))
        let second = try store.getWrapKeyBytes(userId: userId)
        XCTAssertEqual(first, second)
        // A second store (a second launch) reads the same key.
        XCTAssertEqual(try WrapKeyStore(service: "hachiman.wrap-key.tests").getWrapKeyBytes(userId: userId), first)
    }

    func testClearRemovesTheKey() throws {
        let first = try store.getWrapKeyBytes(userId: userId)
        try store.clear(userId: userId)
        try store.clear(userId: userId)
        let next = try store.getWrapKeyBytes(userId: userId)
        XCTAssertNotEqual(first, next)
    }

    func testConcurrentFirstCallsMakeOneKey() throws {
        try store.clear(userId: userId)
        let results = ResultBox()
        let store = self.store, userId = self.userId
        DispatchQueue.concurrentPerform(iterations: 8) { _ in
            results.append(try? store.getWrapKeyBytes(userId: userId))
        }
        XCTAssertEqual(results.values.count, 8)
        XCTAssertEqual(Set(results.values).count, 1)
    }

    func testRejectsMalformedUserId() {
        for bad in ["", "not-a-uuid", "0B6F5D3E-9A41-4C2B-8E7F-1D2C3B4A5F60", "../0b6f5d3e-9a41-4c2b-8e7f-1d2c3b4a5f60"] {
            XCTAssertThrowsError(try store.getWrapKeyBytes(userId: bad)) { error in
                XCTAssertEqual((error as? BridgeError)?.code, .malformed)
            }
            XCTAssertThrowsError(try store.clear(userId: bad))
        }
    }
}

private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Data] = []

    func append(_ value: Data?) {
        guard let value else { return }
        lock.lock()
        items.append(value)
        lock.unlock()
    }

    var values: [Data] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}
