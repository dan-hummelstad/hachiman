import Foundation
import Security

/// Error of a bridge op. The JS side gets `"<code>: <message>"`.
struct BridgeError: Error, Equatable {
    enum Code: String {
        case secureStorageUnavailable = "SecureStorageUnavailable"
        case storeCorrupt = "StoreCorrupt"
        case malformed = "Malformed"
        case unsupported = "Unsupported"
        case cancelled = "Cancelled"
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

/// Keychain store of the per-user wrap key for `IPlatformService.secureStorage`
/// (docs/gateway-protocol.md §11, §12.17). Same rules as the Electron host
/// (`apps/hachiman-electron/src/main/secure-storage.ts`):
/// - 32 random bytes per user, made on the first call and never replaced. A new key would make
///   the user's crypto store unreadable without a message.
/// - An item that is not 32 bytes is `StoreCorrupt` and stays as it is.
/// - Calls run one after another, so two first calls cannot make two keys.
/// - Fail closed: any other Keychain failure is `SecureStorageUnavailable`.
///
/// Item: generic password, service `hachiman.wrap-key`, account = userId,
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable.
final class WrapKeyStore: @unchecked Sendable {
    static let keyBytes = 32
    static let defaultService = "hachiman.wrap-key"

    private let service: String
    // ponytail: one lock for all users. Calls are rare, and this serializes per user as well.
    private let lock = NSLock()

    init(service: String = WrapKeyStore.defaultService) {
        self.service = service
    }

    /// Canonical lowercase UUID text (UserId in @hachiman/crypto).
    static func isValidUserId(_ userId: String) -> Bool {
        userId.utf8.count == 36
            && userId.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                            options: .regularExpression) != nil
    }

    func getWrapKeyBytes(userId: String) throws(BridgeError) -> Data {
        try Self.checkUserId(userId)
        lock.lock()
        defer { lock.unlock() }
        if let existing = try read(userId) { return existing }
        var raw = Data(count: Self.keyBytes)
        let rc = raw.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, Self.keyBytes, $0.baseAddress!) }
        guard rc == errSecSuccess else { throw BridgeError(.internal, "no random bytes") }
        var attrs = baseQuery(userId)
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        attrs[kSecValueData as String] = raw
        let status = SecItemAdd(attrs as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return raw
        case errSecDuplicateItem:
            // Made after our read (another process): use that key, never replace it.
            raw.resetBytes(in: 0..<raw.count)
            guard let made = try read(userId) else { throw BridgeError(.internal, "the wrap key disappeared") }
            return made
        default:
            throw Self.unavailable(status)
        }
    }

    /// Deletes the key. No error when there is none.
    func clear(userId: String) throws(BridgeError) {
        try Self.checkUserId(userId)
        lock.lock()
        defer { lock.unlock() }
        let status = SecItemDelete(baseQuery(userId) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.unavailable(status) }
    }

    private func baseQuery(_ userId: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: userId,
            kSecAttrSynchronizable as String: kCFBooleanFalse!,
        ]
    }

    private func read(_ userId: String) throws(BridgeError) -> Data? {
        var query = baseQuery(userId)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data, data.count == Self.keyBytes else {
                throw BridgeError(.storeCorrupt, "the wrap key item is corrupt")
            }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw Self.unavailable(status)
        }
    }

    private static func checkUserId(_ userId: String) throws(BridgeError) {
        guard isValidUserId(userId) else { throw BridgeError(.malformed, "userId is not a lowercase UUID") }
    }

    private static func unavailable(_ status: OSStatus) -> BridgeError {
        BridgeError(.secureStorageUnavailable, "the Keychain failed (\(status))")
    }
}
