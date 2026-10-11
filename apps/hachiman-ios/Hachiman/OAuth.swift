import AuthenticationServices
import UIKit

/// Sign-in through `ASWebAuthenticationSession`. The redirect URI
/// `app.hachiman://oauth-callback` is already registered for the desktop client, so Takusen
/// needs no change. The session catches its own callback; the URL goes to JS as the
/// `oauth-callback` event.
@MainActor
final class OAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let callbackScheme = "app.hachiman"

    private var session: ASWebAuthenticationSession?
    /// Counts the sessions, so the completion of a replaced session does not release the new one.
    private var generation = 0
    private weak var anchor: UIWindow?

    /// Starts a session. A cancel by the user sends no event: the sign-in screen stays as it is.
    func begin(url: URL, anchor: UIWindow?, onCallback: @escaping @MainActor (URL) -> Void) throws(BridgeError) {
        session?.cancel()
        self.anchor = anchor
        generation += 1
        let mine = generation
        let session = ASWebAuthenticationSession(url: url, callback: .customScheme(Self.callbackScheme)) { [weak self] callback, _ in
            Task { @MainActor in
                guard let self else { return }
                if self.generation == mine { self.session = nil }
                if let callback { onCallback(callback) }
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        guard session.start() else {
            self.session = nil
            throw BridgeError(.internal, "the sign-in session did not start")
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            anchor ?? UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }
}
