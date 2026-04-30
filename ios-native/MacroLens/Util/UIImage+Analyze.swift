import UIKit

/// Image preprocessing for `/api/analyze`. Vercel edge functions cap the
/// request body at 4.5 MB, and Anthropic prefers images under ~5 MB
/// regardless. Web's scan-upload code resizes to 1500px max + JPEG q=0.85
/// — we do the same here for parity.
extension UIImage {
    /// Returns a copy resized so the longest edge is `maxDimension`,
    /// preserving aspect ratio. Returns the original if it's already
    /// smaller (no upscaling).
    func resizedForAnalysis(maxDimension: CGFloat = 1500) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxDimension else { return self }
        let scale = maxDimension / longest
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1.0
        return UIGraphicsImageRenderer(size: newSize, format: format).image { _ in
            self.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }

    /// JPEG → base64. Returns nil if the encoder fails. Default quality
    /// matches the web client (0.85).
    func jpegBase64(quality: CGFloat = 0.85) -> String? {
        jpegData(compressionQuality: quality)?.base64EncodedString()
    }
}
