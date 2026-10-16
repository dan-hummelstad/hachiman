import UIKit
import UserNotifications

/// APNs registration for the `push.register` bridge op (contract §4 Push). Takusen sends a
/// content-free alert ("New message"): it cannot read the sender or the text.
@MainActor
final class Push: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Push()

    private var waiting: [CheckedContinuation<Data, Error>] = []

    /// Asks for permission (once; later calls answer at once), then registers with APNs.
    /// The hex token and `sandbox` (a Debug build talks to the APNs sandbox), or nil when the
    /// user refused.
    func register() async throws -> [String: Any]? {
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
        return ["token": Self.hex(token), "sandbox": sandbox]
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
