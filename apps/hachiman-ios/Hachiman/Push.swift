import UIKit
import UserNotifications

/// APNs registration for the `push.register` bridge op (contract §4 Push), and the taps on
/// notifications. The sender and the text of a push are sealed to this device (§12.22); the
/// Notification Service Extension opens them.
@MainActor
final class Push: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Push()

    private var waiting: [CheckedContinuation<Data, Error>] = []
    private var pendingOpen: String?

    /// Receives the channel of a tapped push (HachimanApp sends it to the page as `push-open`).
    /// A tap from before (a cold start opens the app first) goes to it at once.
    var onOpen: ((String) -> Void)? {
        didSet {
            if let onOpen, let id = pendingOpen {
                pendingOpen = nil
                onOpen(id)
            }
        }
    }

    /// The `c` of the payload (Takusen's channel id). The page opens it only when the account
    /// can (PushService).
    nonisolated static func channelId(of userInfo: [AnyHashable: Any]) -> String? {
        guard let id = userInfo["c"] as? String, UUID(uuidString: id) != nil else { return nil }
        return id.lowercased()
    }

    private func open(_ channelId: String) {
        if let onOpen { onOpen(channelId) } else { pendingOpen = channelId }
    }

    /// Asks for permission (once; later calls answer at once), then registers with APNs and
    /// makes a new push key for `deviceId` (§12.22). The hex token, `sandbox` (a Debug build
    /// talks to the APNs sandbox) and the base64url public point, or nil when the user refused.
    func register(deviceId: String) async throws -> [String: Any]? {
        guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        else { return nil }
        let token = try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
            UIApplication.shared.registerForRemoteNotifications()
        }
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        let pushKey = try PushKeyStore.rotate(deviceId: deviceId)
        return ["token": Self.hex(token), "sandbox": sandbox, "pushKey": pushKey.base64URL]
    }

    func didRegister(_ token: Data) { resume(.success(token)) }
    func didFail(_ error: Error) { resume(.failure(error)) }

    private func resume(_ result: Result<Data, Error>) {
        let all = waiting
        waiting.removeAll()
        for continuation in all { continuation.resume(with: result) }
    }

    nonisolated static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// In front, the app has the gateway and shows the message itself: no banner.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions { [] }

    /// A tap on a notification: open its chat.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let id = Self.channelId(of: response.notification.request.content.userInfo)
        else { return }
        await MainActor.run { Push.shared.open(id) }
    }
}

/// The UIKit callbacks that SwiftUI does not offer: the APNs token.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = Push.shared
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.didRegister(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Push.shared.didFail(error)
    }
}
