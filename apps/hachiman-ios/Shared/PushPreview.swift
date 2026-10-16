import CryptoKit
import Foundation
import Security

/// Push previews (contract §12.22). A sender seals the sender name and the text to the push key
/// of this device; Takusen relays only ciphertext. The app makes the keys (`push.register`), and
/// the Notification Service Extension opens the previews. Both targets build this file and share
/// the Keychain access group `HachimanKeychainGroup` (Info.plist).
///
/// HPKE base mode, DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM, info
/// "hachiman push preview v1", aad = the device id (UTF-8). The sealed text is base64url(enc ‖ ct).
enum PushPreview {
    struct Content: Decodable, Equatable {
        /// The title: the sender, and the channel of a guild message.
        let t: String
        /// The body: the text, or "Sent an attachment".
        let b: String
        /// The channel id.
        let c: String
    }

    /// One push key: the raw P-256 private key and the device it is for.
    struct Key: Codable {
        let key: Data
        let deviceId: String
    }

    static let info = Data("hachiman push preview v1".utf8)

    /// Opens `sealed` with the first key that fits. Nil when none does: the alert stays "New message".
    static func open(_ sealed: String, keys: [Key]) -> Content? {
        guard let bytes = Data(base64URL: sealed), bytes.count > 65 else { return nil }
        let enc = bytes.prefix(65)
        let ct = bytes.dropFirst(65)
        for k in keys {
            guard let privateKey = try? P256.KeyAgreement.PrivateKey(rawRepresentation: k.key),
                  var recipient = try? HPKE.Recipient(
                      privateKey: privateKey, ciphersuite: .P256_SHA256_AES_GCM_256, info: info, encapsulatedKey: enc),
                  let plaintext = try? recipient.open(ct, authenticating: Data(k.deviceId.utf8)),
                  let content = try? JSONDecoder().decode(Content.self, from: plaintext)
            else { continue }
            return content
        }
        return nil
    }
}

/// The push keys in the shared Keychain group: "current" and the one before it ("previous"), so
/// a push sealed before a rotation still opens. After the first unlock, this device only.
enum PushKeyStore {
    static let service = "hachiman.push-key"

    static var group: String? { Bundle.main.object(forInfoDictionaryKey: "HachimanKeychainGroup") as? String }

    /// A new key for `deviceId`. Returns its 65-byte uncompressed public point.
    static func rotate(deviceId: String) throws -> Data {
        let key = P256.KeyAgreement.PrivateKey()
        if let current = read("current") { try write("previous", current) }
        try write("current", PushPreview.Key(key: key.rawRepresentation, deviceId: deviceId))
        return key.publicKey.x963Representation
    }

    static func keys() -> [PushPreview.Key] { ["current", "previous"].compactMap(read) }

    private static func query(_ account: String) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    private static func read(_ account: String) -> PushPreview.Key? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(PushPreview.Key.self, from: data)
    }

    private static func write(_ account: String, _ key: PushPreview.Key) throws {
        SecItemDelete(query(account) as CFDictionary)
        var q = query(account)
        q[kSecValueData as String] = try JSONEncoder().encode(key)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "push key not saved"])
        }
    }
}

extension Data {
    init?(base64URL text: String) {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        s += String(repeating: "=", count: (4 - s.count % 4) % 4)
        self.init(base64Encoded: s)
    }

    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
