import XCTest
@testable import Hachiman

final class PushTests: XCTestCase {
    /// Takusen accepts only lowercase hex of the token bytes (`PUT /push`).
    func testHexToken() {
        XCTAssertEqual(Push.hex(Data([0x00, 0x0f, 0xa0, 0xff])), "000fa0ff")
        XCTAssertEqual(Push.hex(Data()), "")
    }
}
