@preconcurrency import AVFoundation
import UIKit

/// A full-screen QR scanner (`AVCaptureMetadataOutput`, type `.qr`) with a Cancel button.
/// WKWebView has no `BarcodeDetector`, so the device link Scan tab (M22) uses this.
@MainActor
final class QRScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    /// The text of the first QR code, or nil when the user cancels.
    static func scan(from presenter: UIViewController) async throws(BridgeError) -> String? {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            throw BridgeError(.unsupported, "camera access is denied")
        }
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera)
        else { throw BridgeError(.unsupported, "no camera") }
        return await withCheckedContinuation { continuation in
            let scanner = QRScanner(input: input) { continuation.resume(returning: $0) }
            scanner.modalPresentationStyle = .fullScreen
            presenter.present(scanner, animated: true)
        }
    }

    private let session = AVCaptureSession()
    private let input: AVCaptureDeviceInput
    private var finish: ((String?) -> Void)?

    private init(input: AVCaptureDeviceInput, finish: @escaping (String?) -> Void) {
        self.input = input
        self.finish = finish
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let output = AVCaptureMetadataOutput()
        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        }
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)

        let cancel = UIButton(configuration: .filled())
        cancel.configuration?.title = String(localized: "Cancel")
        cancel.configuration?.baseBackgroundColor = UIColor(white: 0.15, alpha: 0.9)
        cancel.configuration?.cornerStyle = .capsule
        cancel.addAction(UIAction { [weak self] _ in self?.done(nil) }, for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)
        NSLayoutConstraint.activate([
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            cancel.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            cancel.widthAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.first { $0 is AVCaptureVideoPreviewLayer }?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let session = self.session
        // startRunning blocks until the camera runs.
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        // Dismissed by a swipe or by the system: count it as a cancel.
        done(nil)
    }

    nonisolated func metadataOutput(
        _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection
    ) {
        let text = metadataObjects.lazy.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }.first
        guard let text else { return }
        MainActor.assumeIsolated { done(text) }
    }

    private func done(_ text: String?) {
        guard let finish else { return }
        self.finish = nil
        finish(text)
        if presentingViewController != nil, !isBeingDismissed {
            dismiss(animated: true)
        }
    }
}
