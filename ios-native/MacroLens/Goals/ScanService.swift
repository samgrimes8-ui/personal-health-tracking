import Foundation
import Supabase

/// AI proxy + storage helpers for InBody / DEXA scan uploads.
///
/// Mirrors two pieces of the web codebase:
///   - extractBodyScan() at src/lib/ai.js:468-529  — calls /api/analyze
///     with feature="food", action="extract_body_scan" and the same
///     35-field prompt, returns BodyScanExtract.
///   - uploadScanFile() at src/lib/db.js:989-998   — uploads to the
///     "body-scans" Supabase Storage bucket at <user_id>/<ts>.<ext>.
///
/// The two stages are kept separate so the UI can choose to attach a
/// file even when AI extraction fails (matches the web's resilient
/// "auto-extract failed — enter values manually" path).
enum ScanService {
    enum ScanError: LocalizedError {
        case unauthenticated
        case spendingLimitExceeded(spent: Double, limit: Double)
        case server(String)
        case parse
        case unsupportedMedia

        var errorDescription: String? {
            switch self {
            case .unauthenticated:           return "Session expired — please sign in again."
            case .spendingLimitExceeded:     return "You've used all your Computer Calories this month."
            case .server(let m):             return m
            case .parse:                     return "Couldn't read the scan. Try a clearer photo."
            case .unsupportedMedia:          return "Unsupported file type — use a JPEG, PNG, or PDF."
            }
        }
    }

    // MARK: - AI extraction

    /// Posts a base64-encoded scan to /api/analyze and parses the JSON
    /// extract. `mediaType` is one of: image/jpeg, image/png, image/webp,
    /// image/gif, application/pdf — Claude's supported set. The web app
    /// resizes images to ≤1500px before calling; the iOS picker is
    /// expected to do the same upstream.
    static func extractBodyScan(imageBase64 base64: String, mediaType: String) async throws -> BodyScanExtract {
        let prompt = scanPrompt
        let block: [String: Any]
        switch mediaType {
        case "application/pdf":
            block = ["type": "document",
                     "source": ["type": "base64", "media_type": "application/pdf", "data": base64]]
        case "image/jpeg", "image/png", "image/webp", "image/gif":
            block = ["type": "image",
                     "source": ["type": "base64", "media_type": mediaType, "data": base64]]
        default:
            throw ScanError.unsupportedMedia
        }

        let body: [String: Any] = [
            "feature": "food",
            "max_tokens": 800,
            "input_type": mediaType == "application/pdf" ? "pdf" : "image",
            "action": "extract_body_scan",
            "messages": [[
                "role": "user",
                "content": [
                    block,
                    ["type": "text", "text": prompt]
                ] as [Any]
            ]]
        ]

        let session = try await SupabaseService.client.auth.session
        var request = URLRequest(url: Config.apiBaseURL.appendingPathComponent("/api/analyze"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ScanError.server("No response") }
        if http.statusCode == 401 { throw ScanError.unauthenticated }
        if http.statusCode == 429,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           (json["code"] as? String) == "spending_limit_exceeded" {
            throw ScanError.spendingLimitExceeded(
                spent: (json["spent_usd"] as? Double) ?? 0,
                limit: (json["limit_usd"] as? Double) ?? 0
            )
        }
        if http.statusCode == 413 {
            throw ScanError.server("Image too large for the server. Try a smaller photo.")
        }
        if !(200..<300).contains(http.statusCode) {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ScanError.server(msg ?? "Request failed (\(http.statusCode))")
        }

        // Anthropic envelope: { content: [{ type:"text", text:"..." }, ...] }
        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let blocks = envelope["content"] as? [[String: Any]] else {
            throw ScanError.parse
        }
        let text = blocks.compactMap { ($0["type"] as? String) == "text" ? $0["text"] as? String : nil }.joined()
        let cleaned = extractJSON(from: text)
        guard let jsonData = cleaned.data(using: .utf8),
              let extract = try? JSONDecoder().decode(BodyScanExtract.self, from: jsonData) else {
            throw ScanError.parse
        }
        return extract
    }

    // MARK: - Storage

    /// Uploads the raw scan file to the body-scans bucket. Returns the
    /// storage path so the caller can persist it on the checkin row
    /// (scan_file_path column) for later signed-URL retrieval.
    /// Mirrors uploadScanFile in db.js — same path convention
    /// (<userId>/<timestamp>.<ext>) so the web app can read iOS uploads
    /// and vice versa.
    static func uploadScan(data: Data, fileExtension ext: String, contentType: String) async throws -> String {
        let userId = try await SupabaseService.client.auth.session.user.id.uuidString
        let path = "\(userId)/\(Int(Date().timeIntervalSince1970 * 1000)).\(ext.lowercased())"
        let options = FileOptions(cacheControl: "3600", contentType: contentType, upsert: false)
        _ = try await SupabaseService.client.storage
            .from("body-scans")
            .upload(path, data: data, options: options)
        return path
    }

    // MARK: - Internals

    private static func extractJSON(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let unfenced = trimmed
            .replacingOccurrences(of: "```json", with: "")
            .replacingOccurrences(of: "```", with: "")
        guard let start = unfenced.firstIndex(of: "{"),
              let end = unfenced.lastIndex(of: "}") else {
            return unfenced
        }
        return String(unfenced[start...end])
    }

    /// Prompt is byte-identical to src/lib/ai.js so the action key
    /// 'extract_body_scan' costs the same and the JSON contract matches
    /// the BodyScanExtract decoder one-to-one.
    private static let scanPrompt = """
    You are reading a body composition scan (InBody or DEXA). Extract every numeric value you can find.

    KEY RULES:
    - Values may be in lbs OR kg. If weight > 100 it is likely lbs — convert to kg (divide by 2.20462)
    - PBF / body_fat_pct is a PERCENTAGE (e.g. 17.0), NOT body fat mass in lbs
    - Segmental values: extract both the weight (lbs/kg) and the % of normal shown
    - Return null for any field not visible in the scan

    Return ONLY this JSON object, no markdown, no extra text:
    {
      "scan_type": "inbody or dexa",
      "scan_date": "YYYY-MM-DD or null",
      "weight_kg": null,
      "body_fat_pct": null,
      "body_fat_mass_kg": null,
      "muscle_mass_kg": null,
      "lean_body_mass_kg": null,
      "bone_mass_kg": null,
      "total_body_water_kg": null,
      "intracellular_water_kg": null,
      "extracellular_water_kg": null,
      "ecw_tbw_ratio": null,
      "protein_kg": null,
      "minerals_kg": null,
      "bmr": null,
      "bmi": null,
      "inbody_score": null,
      "visceral_fat_level": null,
      "body_cell_mass_kg": null,
      "smi": null,
      "seg_lean_left_arm_kg": null,
      "seg_lean_right_arm_kg": null,
      "seg_lean_trunk_kg": null,
      "seg_lean_left_leg_kg": null,
      "seg_lean_right_leg_kg": null,
      "seg_lean_left_arm_pct": null,
      "seg_lean_right_arm_pct": null,
      "seg_lean_trunk_pct": null,
      "seg_lean_left_leg_pct": null,
      "seg_lean_right_leg_pct": null,
      "bone_mineral_density": null,
      "t_score": null,
      "z_score": null,
      "android_fat_pct": null,
      "gynoid_fat_pct": null,
      "android_gynoid_ratio": null,
      "vat_area_cm2": null
    }
    """
}
