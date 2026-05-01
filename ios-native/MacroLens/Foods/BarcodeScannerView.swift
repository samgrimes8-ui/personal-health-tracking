import SwiftUI
import AVFoundation
import UIKit

/// Live camera barcode scanner. Drops an AVCaptureSession into a
/// UIViewController with AVCaptureMetadataOutput watching for the
/// symbologies most common on grocery products. The first detected
/// payload triggers `onDetect` and the parent dismisses the sheet.
///
/// Permission state is handled inline — if the user previously denied
/// camera access we surface a settings link rather than just failing
/// silently. On simulator there's no camera, so we render a friendly
/// "no camera available" message; for sim development the parent can
/// fall back to the manual-entry text field.
struct BarcodeScannerView: View {
    let onDetect: (String) -> Void
    let onCancel: () -> Void

    @State private var permission: AVAuthorizationStatus = .notDetermined
    @State private var scanned: Bool = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch permission {
            case .authorized:
                BarcodeCameraView { code in
                    guard !scanned else { return }
                    scanned = true
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    onDetect(code)
                }
                .ignoresSafeArea()
                overlay
            case .notDetermined:
                ProgressView().tint(.white)
            case .denied, .restricted:
                deniedState
            @unknown default:
                deniedState
            }
        }
        .onAppear { refreshPermission() }
    }

    private var overlay: some View {
        VStack {
            HStack {
                Button {
                    onCancel()
                } label: {
                    Text("Cancel")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.ultraThinMaterial, in: .rect(cornerRadius: 999))
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)

            Spacer()

            ZStack {
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.white.opacity(0.85), lineWidth: 2)
                    .frame(width: 280, height: 160)
                Text("Center the barcode in the frame")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(0.85))
                    .offset(y: 100)
            }

            Spacer()
        }
    }

    private var deniedState: some View {
        VStack(spacing: 12) {
            Image(systemName: "camera.fill.badge.ellipsis")
                .font(.system(size: 36))
                .foregroundStyle(.white.opacity(0.85))
            Text("Camera access needed")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
            Text("Enable camera access in Settings to scan barcodes.")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Open Settings")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.black)
                    .padding(.horizontal, 18).padding(.vertical, 10)
                    .background(.white, in: .rect(cornerRadius: 10))
            }
            Button("Close") { onCancel() }
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.7))
                .padding(.top, 6)
        }
    }

    private func refreshPermission() {
        let cur = AVCaptureDevice.authorizationStatus(for: .video)
        if cur == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in
                    self.permission = granted ? .authorized : .denied
                }
            }
        } else {
            self.permission = cur
        }
    }
}

/// UIKit bridge for the actual capture session. SwiftUI doesn't have a
/// first-party camera-preview component, so we wrap a UIViewController.
private struct BarcodeCameraView: UIViewControllerRepresentable {
    let onDetect: (String) -> Void

    func makeUIViewController(context: Context) -> BarcodeCameraController {
        let vc = BarcodeCameraController()
        vc.onDetect = onDetect
        return vc
    }

    func updateUIViewController(_ uiViewController: BarcodeCameraController, context: Context) {}
}

final class BarcodeCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onDetect: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var didEmit = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if !session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.session.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            session.stopRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    private func configureSession() {
        session.beginConfiguration()
        session.sessionPreset = .high

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            session.commitConfiguration()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        // Subset the symbologies the picker actually supports — checking
        // the available list keeps us forward-compatible if Apple drops
        // one in a future iOS release.
        let desired: [AVMetadataObject.ObjectType] = [.ean13, .ean8, .upce, .code128, .code39, .code93, .qr]
        output.metadataObjectTypes = desired.filter { output.availableMetadataObjectTypes.contains($0) }

        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        previewLayer.frame = view.bounds
        view.layer.addSublayer(previewLayer)
        self.preview = previewLayer

        session.commitConfiguration()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !didEmit else { return }
        guard let first = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let payload = first.stringValue, !payload.isEmpty else { return }
        didEmit = true
        // Stop the session promptly so the preview freezes on the moment
        // of capture rather than continuing to update behind the dismiss.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.stopRunning()
        }
        onDetect?(payload)
    }
}
