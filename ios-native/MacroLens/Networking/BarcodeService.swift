import Foundation
@preconcurrency import Vision
import UIKit

/// Local barcode detection (free, fast — uses Apple's Vision framework)
/// + Open Food Facts lookup via the existing /api/barcode edge function.
/// First step of the food-photo pipeline; we try this before any AI call
/// so simple packaged-product scans cost zero AI Bucks.
enum BarcodeService {

    /// Returns the first barcode payload found in the image, or nil if
    /// none. Searches the symbologies common on grocery products
    /// (EAN-13/8 + UPC-E + Code 128 for hand-printed labels).
    static func detect(in image: UIImage) async -> String? {
        guard let cgImage = image.cgImage else { return nil }

        return await withCheckedContinuation { continuation in
            let request = VNDetectBarcodesRequest { request, _ in
                let payload = (request.results as? [VNBarcodeObservation])?
                    .compactMap { $0.payloadStringValue }
                    .first
                continuation.resume(returning: payload)
            }
            request.symbologies = [.ean13, .ean8, .upce, .code128]
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            DispatchQueue.global(qos: .userInitiated).async {
                try? handler.perform([request])
            }
        }
    }

    /// Look up a UPC/EAN against Open Food Facts via /api/barcode.
    /// Returns nil if the product isn't in the database (404).
    static func lookup(_ upc: String) async throws -> AnalysisResult? {
        let digits = upc.filter(\.isNumber)
        guard !digits.isEmpty else { return nil }

        var components = URLComponents(url: Config.apiBaseURL.appendingPathComponent("/api/barcode"),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "upc", value: digits)]
        let url = components.url!

        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse else { return nil }
        if http.statusCode == 404 { return nil }
        if !(200..<300).contains(http.statusCode) {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw NSError(domain: "BarcodeService", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: msg ?? "Lookup failed"])
        }

        // /api/barcode returns a flat dict close to AnalysisResult shape.
        // Decode loosely — only the fields we care about for the result
        // card. brand/servingSize are extras we tack onto the model.
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let found = json["found"] as? Bool, found else {
            return nil
        }

        return AnalysisResult(
            name: (json["name"] as? String) ?? "Product",
            description: (json["brand"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            servings: 1,
            calories: (json["calories"] as? Double) ?? 0,
            protein:  (json["protein"]  as? Double) ?? 0,
            carbs:    (json["carbs"]    as? Double) ?? 0,
            fat:      (json["fat"]      as? Double) ?? 0,
            fiber:    json["fiber"] as? Double,
            sugar:    json["sugar"] as? Double,
            confidence: (json["confidence"] as? String) ?? "high",
            notes: (json["serving_size"] as? String).map { "Per serving: \($0)" },
            ingredients: nil
        )
    }
}
