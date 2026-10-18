import CryptoKit
import XCTest
@testable import Hachiman

final class PushTests: XCTestCase {
    /// Takusen accepts only lowercase hex of the token bytes (`PUT /push`).
    func testHexToken() {
        XCTAssertEqual(Push.hex(Data([0x00, 0x0f, 0xa0, 0xff])), "000fa0ff")
        XCTAssertEqual(Push.hex(Data()), "")
    }

    /// A tap opens the `c` of the payload, lowercased; anything that is not a UUID opens nothing.
    func testChannelIdOfATappedPush() {
        XCTAssertEqual(Push.channelId(of: ["c": "0B8F7A7E-3C1D-4E2F-9A6B-5C4D3E2F1A0B"]), "0b8f7a7e-3c1d-4e2f-9a6b-5c4d3e2f1a0b")
        XCTAssertNil(Push.channelId(of: ["c": "javascript:alert(1)"]))
        XCTAssertNil(Push.channelId(of: ["c": 7]))
        XCTAssertNil(Push.channelId(of: [:]))
    }

    /// A preview that the crypto Worker's `@hpke/core` sealed (§12.22) opens with CryptoKit.
    private let key = Data(base64Encoded: "ya+p2EW6dRZrXCFXZ7HWk05Qw9s26JsSe4piKxIPZyE=")!
    private let deviceId = "22222222-2222-4222-8222-222222222222"
    private let sealed =
        "BKF6-FA_r42TrJKNQ2cIGpCTRSuxahiuIWfYxZ_Zyv6SEf9ajlmm0rOxdowiKmT7PpAkhIqOxSVHfUL6gl30PN_6D4D2Dy3HiHz6O709l9ch6F5IticPhgL69_vfmzIsgvdImoEMQEsVc3iz3Mkuss1uebum32zqyA"

    func testOpensAPreviewSealedByTheWorker() throws {
        let pub = try P256.KeyAgreement.PrivateKey(rawRepresentation: key).publicKey.x963Representation
        XCTAssertEqual(pub.base64URL, "BGD-1LolWp0xyWHrdMY1bWjASbiSO2H6bOZpYi5g8p-2eQP-EAi4vJmkGunpVii8ZPLxsgwtfp9Rd6PClNRGIpk")
        let got = PushPreview.open(sealed, keys: [.init(key: key, deviceId: deviceId)])
        XCTAssertEqual(got, PushPreview.Content(t: "alice", b: "héllo 👋", c: "c1"))
    }

    func testAWrongKeyOrDeviceOpensNothing() {
        let other = P256.KeyAgreement.PrivateKey().rawRepresentation
        XCTAssertNil(PushPreview.open(sealed, keys: [.init(key: other, deviceId: deviceId)]))
        XCTAssertNil(PushPreview.open(sealed, keys: [.init(key: key, deviceId: "33333333-3333-4333-8333-333333333333")]))
        // The second key fits: a push sealed before a rotation still opens.
        XCTAssertNotNil(PushPreview.open(sealed, keys: [.init(key: other, deviceId: deviceId), .init(key: key, deviceId: deviceId)]))
        XCTAssertNil(PushPreview.open("not base64!", keys: [.init(key: key, deviceId: deviceId)]))
    }
}
