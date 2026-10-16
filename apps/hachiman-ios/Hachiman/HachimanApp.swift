import SwiftUI

@main
struct HachimanApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var host = WebHost()

    init() {
        AudioSession.configure()
    }

    var body: some Scene {
        WindowGroup {
            WebView(host: host)
                .ignoresSafeArea()
                .background(Color("LaunchBackground"))
                .onOpenURL { url in
                    if let event = Self.event(for: url) {
                        host.bridge.emit(event, ["url": url.absoluteString])
                    }
                }
        }
    }

    /// `takusen://invite/...` is an invite link. The app does not register `app.hachiman`:
    /// only the ASWebAuthenticationSession completion sends `oauth-callback`, so another app
    /// cannot push a callback into a sign-in.
    nonisolated static func event(for url: URL) -> String? {
        url.scheme?.lowercased() == "takusen" ? "invite-link" : nil
    }
}
