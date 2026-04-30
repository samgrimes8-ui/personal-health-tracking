import SwiftUI
import PhotosUI

/// Two image sources: camera capture and photo library. SwiftUI 16+
/// has PhotosPicker for the library half, but no first-party camera
/// component yet — we wrap UIImagePickerController for that.
///
/// Usage:
///   .sheet(isPresented: $showCamera) {
///       CameraSheet(image: $image)
///   }
///
///   PhotosPicker(selection: $selection, matching: .images) { ... }
///   .onChange(of: selection) { _, item in /* load + assign */ }
struct CameraSheet: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraSheet
        init(_ parent: CameraSheet) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage {
                parent.image = img
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
