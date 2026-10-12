import WebKit
import XCTest
@testable import Hachiman

@MainActor
final class WebViewTests: XCTestCase {
    func testContentViewLosesTheInputAccessoryBar() throws {
        let webView = WKWebView(frame: .zero)
        let contentClass: AnyClass = try XCTUnwrap(NSClassFromString("WKContentView"))
        let content = try XCTUnwrap(webView.scrollView.subviews.first { $0.isKind(of: contentClass) })
        let selector = #selector(getter: UIResponder.inputAccessoryView)
        let original = class_getMethodImplementation(contentClass, selector)

        XCTAssertTrue(WebHost.hideInputAccessoryBar(of: webView))
        XCTAssertTrue(content.isKind(of: contentClass))
        XCTAssertNotEqual(class_getMethodImplementation(object_getClass(content), selector), original)
        XCTAssertNil(content.inputAccessoryView)
        // A second web view reuses the subclass.
        XCTAssertTrue(WebHost.hideInputAccessoryBar(of: WKWebView(frame: .zero)))
    }
}
