import UIKit
import XCTest
@testable import Hachiman

final class SaveTextFileTests: XCTestCase {
    func testFileNames() {
        XCTAssertTrue(Native.isFileName("hachiman-recovery-key.txt"))
        XCTAssertTrue(Native.isFileName("Recovery key (Hachiman) ✓.txt"))
        XCTAssertTrue(Native.isFileName(String(repeating: "a", count: 255)))
        XCTAssertFalse(Native.isFileName(String(repeating: "a", count: 256)))
        XCTAssertFalse(Native.isFileName(String(repeating: "é", count: 128)))
        for bad in ["", ".", "..", ".hidden", "../key.txt", "a/b.txt", "/key.txt", "a:b.txt", "a\nb.txt", "a\u{0}b.txt"] {
            XCTAssertFalse(Native.isFileName(bad), bad)
        }
    }

    @MainActor
    private func topController() throws -> UIViewController {
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        var top = try XCTUnwrap(window?.rootViewController)
        while let next = top.presentedViewController { top = next }
        return top
    }

    @MainActor
    private func waitForPicker(on presenter: UIViewController) async throws -> UIDocumentPickerViewController {
        for _ in 0..<200 {
            if let picker = presenter.presentedViewController as? UIDocumentPickerViewController { return picker }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("no picker")
        throw CancellationError()
    }

    @MainActor
    private func waitForNothingPresented(on presenter: UIViewController) async throws {
        for _ in 0..<100 where presenter.presentedViewController != nil {
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    private var exportRoot: URL { FileManager.default.temporaryDirectory.appendingPathComponent("export", isDirectory: true) }

    private func exportedFiles() -> [String] {
        let files = FileManager.default
        guard let dirs = try? files.contentsOfDirectory(atPath: exportRoot.path) else { return [] }
        return dirs.flatMap { dir in
            ((try? files.contentsOfDirectory(atPath: exportRoot.appendingPathComponent(dir).path)) ?? []).map { "\(dir)/\($0)" }
        }
    }

    @MainActor
    func testCancelResolvesFalseAndDeletesTheTempFile() async throws {
        let presenter = try topController()
        // A file that a killed process left.
        let left = exportRoot.appendingPathComponent("LEFT", isDirectory: true)
        try FileManager.default.createDirectory(at: left, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: left.appendingPathComponent("key.txt"))

        let task = Task { try await Native.saveTextFile(name: "key.txt", text: "secret ✓", from: presenter) }
        let picker = try await waitForPicker(on: presenter)
        let names = exportedFiles()
        XCTAssertEqual(names.count, 1)
        XCTAssertTrue(names.first?.hasSuffix("/key.txt") ?? false)
        XCTAssertFalse(names.first?.hasPrefix("LEFT/") ?? true)
        if let name = names.first {
            XCTAssertEqual(try String(contentsOf: exportRoot.appendingPathComponent(name), encoding: .utf8), "secret ✓")
        }

        picker.dismiss(animated: false)
        picker.delegate?.documentPickerWasCancelled?(picker)
        let saved = try await task.value
        XCTAssertFalse(saved)
        XCTAssertEqual(exportedFiles(), [])
        try await waitForNothingPresented(on: presenter)
    }

    @MainActor
    func testAPickedDestinationResolvesTrue() async throws {
        let presenter = try topController()
        let task = Task { try await Native.saveTextFile(name: "key.txt", text: "secret", from: presenter) }
        let picker = try await waitForPicker(on: presenter)
        picker.dismiss(animated: false)
        picker.delegate?.documentPicker?(picker, didPickDocumentsAt: [URL(fileURLWithPath: "/tmp/key.txt")])
        // A late second callback changes nothing.
        picker.delegate?.documentPickerWasCancelled?(picker)
        let saved = try await task.value
        XCTAssertTrue(saved)
        XCTAssertEqual(exportedFiles(), [])
        try await waitForNothingPresented(on: presenter)
    }

    @MainActor
    func testASecondSaveWhileTheSheetIsOpenIsRefused() async throws {
        let presenter = try topController()
        let first = Task { try await Native.saveTextFile(name: "key.txt", text: "secret", from: presenter) }
        let picker = try await waitForPicker(on: presenter)
        do {
            _ = try await Native.saveTextFile(name: "key.txt", text: "secret", from: presenter)
            XCTFail("no error")
        } catch {
            XCTAssertEqual(error.code, .malformed)
        }
        // The refused call wrote nothing: only the file of the open sheet is there.
        XCTAssertEqual(exportedFiles().count, 1)

        picker.dismiss(animated: false)
        picker.delegate?.documentPickerWasCancelled?(picker)
        let saved = try await first.value
        XCTAssertFalse(saved)
        XCTAssertEqual(exportedFiles(), [])
        try await waitForNothingPresented(on: presenter)

        // The next save works again.
        let next = Task { try await Native.saveTextFile(name: "key.txt", text: "secret", from: presenter) }
        let again = try await waitForPicker(on: presenter)
        again.dismiss(animated: false)
        again.delegate?.documentPickerWasCancelled?(again)
        let savedAgain = try await next.value
        XCTAssertFalse(savedAgain)
        try await waitForNothingPresented(on: presenter)
    }

    @MainActor
    func testABadNameIsMalformed() async throws {
        let presenter = try topController()
        do {
            _ = try await Native.saveTextFile(name: "../key.txt", text: "x", from: presenter)
            XCTFail("no error")
        } catch {
            XCTAssertEqual(error.code, .malformed)
        }
    }

    @MainActor
    func testTheBridgeOpChecksItsArguments() async throws {
        let bridge = Bridge(evaluate: { _ in })
        do {
            _ = try await bridge.handle("saveTextFile", ["name": "key.txt"])
            XCTFail("no error")
        } catch let error as BridgeError {
            XCTAssertEqual(error.code, .malformed)
        }
    }
}
