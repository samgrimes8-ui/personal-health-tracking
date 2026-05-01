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
    /// Returns nil if the product isn't in the database (404) OR the
    /// upstream returned something we can't make sense of (HTML error
    /// page from the edge layer, OFF outage, etc.) — callers in the
    /// food-photo pipeline treat nil as "barcode unavailable, fall
    /// through to AI" rather than as a hard failure.
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

        // Some upstream failures (Vercel 502, OFF outage, /api/barcode
        // catching a malformed OFF response) return an HTML error page
        // even on a 200, OR a JSON body whose `error` field embeds the
        // raw JS "Unexpected token < … is not valid JSON" string. Both
        // crashed the old parser. Detect both shapes up front and return
        // nil so the photo pipeline can keep going.
        if !looksLikeJSON(data) { return nil }

        if !(200..<300).contains(http.statusCode) {
            let raw = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            let msg = cleanedErrorMessage(raw) ?? "Barcode lookup unavailable"
            throw NSError(domain: "BarcodeService", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: msg])
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

    /// First non-whitespace byte heuristic — JSON objects/arrays start
    /// with `{` or `[`, HTML/XML error pages with `<`. Used to short-
    /// circuit the parser before it surfaces a confusing JSON-parse
    /// error to the UI.
    private static func looksLikeJSON(_ data: Data) -> Bool {
        for byte in data {
            if byte == UInt8(ascii: " ") || byte == UInt8(ascii: "\n")
                || byte == UInt8(ascii: "\r") || byte == UInt8(ascii: "\t") {
                continue
            }
            return byte == UInt8(ascii: "{") || byte == UInt8(ascii: "[")
        }
        return false
    }

    /// Strip the noisy "Unexpected token <, …" JS parser snippet that
    /// leaks through when /api/barcode forwards the OFF parse error
    /// verbatim. Keeps the message readable instead of dumping HTML.
    private static func cleanedErrorMessage(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        if raw.contains("Unexpected token") || raw.contains("<html") {
            return "Barcode lookup unavailable"
        }
        return raw
    }
}
