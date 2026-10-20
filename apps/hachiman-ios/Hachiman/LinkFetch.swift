import Foundation
import os

/// The `fetchLink` bridge op: one https GET for a link preview (contract §11
/// `fetchLinkResource`, §12.8.1). Only this device runs it, for a link in a message that it
/// sends. An ephemeral session: no cookies, no cache, no credentials. At most `maxRedirects`
/// hops, each https; a total timeout; a body cap.
///
/// ponytail: URLSession has no connect-time address hook, so only an IP literal host is
/// checked. A name that resolves to a LAN address still goes out (iOS gates the local network
/// behind a permission that the app does not declare). Upgrade: resolve with getaddrinfo and
/// connect to the checked address.
enum LinkFetch {
    static let maxRedirects = 3
    static let timeout: TimeInterval = 5
    /// The largest body a caller may ask for.
    static let maxBytesCap = 8 * 1024 * 1024
    private static let userAgent = "Mozilla/5.0 (compatible; HachimanLinkPreview/1.0)"

    struct Resource: Equatable {
        let url: URL
        /// Lowercase, without parameters. "" when the server sent none.
        let contentType: String
        let body: Data
    }

    /// https, a host, no user or password, and no loopback, private or link-local IP literal.
    nonisolated static func isAllowed(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host(percentEncoded: false),
              !host.isEmpty, url.user == nil, url.password == nil
        else { return false }
        return !isPrivateLiteral(host)
    }

    /// True for an IPv4 or IPv6 literal in a non-public range. False for a name.
    nonisolated static func isPrivateLiteral(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        var v4 = in_addr()
        if inet_pton(AF_INET, host, &v4) == 1 {
            return isPrivateV4(withUnsafeBytes(of: v4.s_addr) { Array($0) })
        }
        var v6 = in6_addr()
        guard inet_pton(AF_INET6, host.split(separator: "%").first.map(String.init) ?? host, &v6) == 1
        else { return false }
        let b = withUnsafeBytes(of: v6) { Array($0) }
        if b.allSatisfy({ $0 == 0 }) { return true }  // ::
        if b[0..<15].allSatisfy({ $0 == 0 }) && b[15] == 1 { return true }  // ::1
        if b[0] & 0xfe == 0xfc { return true }  // fc00::/7
        if b[0] == 0xfe && b[1] & 0xc0 == 0x80 { return true }  // fe80::/10
        // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
        if b[0..<10].allSatisfy({ $0 == 0 }) && ((b[10] == 0xff && b[11] == 0xff) || (b[10] == 0 && b[11] == 0)) {
            return isPrivateV4(Array(b[12..<16]))
        }
        return false
    }

    private nonisolated static func isPrivateV4(_ o: [UInt8]) -> Bool {
        switch (o[0], o[1]) {
        case (0, _), (127, _), (10, _), (169, 254), (192, 168): return true
        case (172, 16...31): return true
        default: return false
        }
    }

    /// nil for any refusal or failure.
    static func fetch(_ url: URL, maxBytes: Int) async -> Resource? {
        guard isAllowed(url), maxBytes > 0 else { return nil }
        let cap = min(maxBytes, maxBytesCap)
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config, delegate: RedirectGuard(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("text/html,image/*;q=0.9", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            // A refused redirect returns the 3xx itself.
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let final = http.url, isAllowed(final),
                  http.expectedContentLength <= Int64(cap)
            else {
                bytes.task.cancel()
                return nil
            }
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count > cap {
                    bytes.task.cancel()
                    return nil
                }
            }
            return Resource(url: final, contentType: (http.mimeType ?? "").lowercased(), body: body)
        } catch {
            return nil
        }
    }
}

/// Follows a redirect only to an allowed URL, at most `LinkFetch.maxRedirects` times.
private final class RedirectGuard: NSObject, URLSessionTaskDelegate {
    private let hops = OSAllocatedUnfairLock(initialState: 0)

    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest
    ) async -> URLRequest? {
        guard let url = request.url, LinkFetch.isAllowed(url) else { return nil }
        let allowed = hops.withLock { count -> Bool in
            guard count < LinkFetch.maxRedirects else { return false }
            count += 1
            return true
        }
        return allowed ? request : nil
    }
}
