import Foundation

/// Wrapper for the Vercel `/api/tts` edge function. Mirrors `fetchRecipeAudio`
/// in src/lib/ai.js — same JWT-bearer auth, same body shape, same cache-key
/// fields. The server caches MP3s per (recipe, step, servings, voice, version)
/// in the `recipe_audio` table + storage bucket, so repeat requests for the
/// same step cost $0 of OpenAI spend.
///
/// We keep this off `AnalyzeService` because the response is a URL, not a
/// JSON-encoded analysis. Using URLSession.shared.data(for:) returns the
/// JSON envelope; the actual MP3 is a follow-up GET that AVPlayer handles
/// directly via streaming.
enum TTSService {
    enum TTSError: LocalizedError {
        case unauthenticated
        case spendingLimitExceeded
        case server(String)
        case parse

        var errorDescription: String? {
            switch self {
            case .unauthenticated:        return "Session expired — please sign in again."
            case .spendingLimitExceeded:  return "You've used all your Computer Calories this month."
            case .server(let m):          return m
            case .parse:                  return "Couldn't read the TTS response."
            }
        }
    }

    /// Premium voice ids the OpenAI tts-1-hd model exposes. Mirror
    /// `PREMIUM_VOICES` in src/pages/app.js so the picker UI offers the
    /// same set on both platforms.
    static let voiceIds = ["nova", "shimmer", "alloy", "echo", "fable", "onyx"]

    struct Response {
        let url: URL
        let cached: Bool
    }

    /// Fetch the MP3 URL for one cooking-mode step. Returns the public
    /// recipe-audio bucket URL the cache layer wrote (or the freshly minted
    /// one on a miss). Throws on auth / spend-cap / server errors.
    static func fetchRecipeAudio(
        recipeId: String,
        stepIndex: Int,
        servings: Double,
        voiceId: String,
        instructionsVersion: Int
    ) async throws -> Response {
        let session = try await SupabaseService.client.auth.session

        var request = URLRequest(url: Config.apiBaseURL.appendingPathComponent("/api/tts"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")

        let body: [String: Any] = [
            "recipe_id": recipeId,
            "step_index": stepIndex,
            "servings": servings,
            "voice_id": voiceId,
            "instructions_version": instructionsVersion,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw TTSError.server("No response")
        }
        if http.statusCode == 401 { throw TTSError.unauthenticated }
        if http.statusCode == 429 {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (json["code"] as? String) == "spending_limit_exceeded" {
                throw TTSError.spendingLimitExceeded
            }
        }
        if !(200..<300).contains(http.statusCode) {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw TTSError.server(msg ?? "Request failed (\(http.statusCode))")
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let urlStr = json["url"] as? String,
              let url = URL(string: urlStr)
        else {
            throw TTSError.parse
        }
        let cached = (json["cached"] as? Bool) ?? false
        return Response(url: url, cached: cached)
    }
}
