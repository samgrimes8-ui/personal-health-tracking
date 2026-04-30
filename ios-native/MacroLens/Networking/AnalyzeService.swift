import Foundation

/// Wrapper for the Vercel `/api/analyze` edge function that the web app
/// uses for AI-powered macro analysis. The API itself stays unchanged —
/// we just call it from Swift instead of JS.
///
/// For the dashboard's "Analyze food" path we use the `planner` feature
/// + MACROS_ONLY_PROMPT (matching `analyzePlannerDescription` in
/// src/lib/ai.js), which returns just the basics (name + macros) rather
/// than a full ingredient list.
enum AnalyzeService {
    enum AnalyzeError: LocalizedError {
        case unauthenticated
        case spendingLimitExceeded(spent: Double, limit: Double)
        case server(String)
        case parse

        var errorDescription: String? {
            switch self {
            case .unauthenticated: return "Session expired — please sign in again."
            case .spendingLimitExceeded: return "You've used all your AI Bucks this month."
            case .server(let msg): return msg
            case .parse: return "Couldn't read the analysis result. Try a more specific description."
            }
        }
    }

    /// Analyze a free-text food/meal description. Mirrors
    /// `analyzePlannerDescription(description)` in src/lib/ai.js.
    static func describe(_ description: String) async throws -> AnalysisResult {
        let macrosOnlyPrompt = """
        Respond ONLY with a JSON object, no markdown, no explanation. Format:
        {"name":"meal name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high"}
        """

        let body: [String: Any] = [
            "feature": "planner",
            "max_tokens": 2000,
            "input_type": "text",
            "action": "analyze_dashboard_describe",
            "messages": [
                [
                    "role": "user",
                    "content": "Analyze this meal/recipe and estimate macros per serving:\n\n\(description)\n\n\(macrosOnlyPrompt)",
                ]
            ]
        ]

        let session = try await SupabaseService.client.auth.session
        var request = URLRequest(url: Config.apiBaseURL.appendingPathComponent("/api/analyze"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AnalyzeError.server("No response")
        }

        if http.statusCode == 401 { throw AnalyzeError.unauthenticated }

        // 429 with code=spending_limit_exceeded is the AI-Bucks paywall.
        if http.statusCode == 429 {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let code = json["code"] as? String, code == "spending_limit_exceeded" {
                let spent = (json["spent_usd"] as? Double) ?? 0
                let limit = (json["limit_usd"] as? Double) ?? 0
                throw AnalyzeError.spendingLimitExceeded(spent: spent, limit: limit)
            }
        }

        if !(200..<300).contains(http.statusCode) {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw AnalyzeError.server(msg ?? "Request failed (\(http.statusCode))")
        }

        // Anthropic response shape: { content: [{ type:"text", text:"...JSON..." }, ...] }
        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = envelope["content"] as? [[String: Any]] else {
            throw AnalyzeError.parse
        }
        let text = content.compactMap { ($0["type"] as? String) == "text" ? $0["text"] as? String : nil }.joined()

        // The model is instructed to return JSON-only, but reality is messy.
        // Strip code-fence wrappers and try to grab the outermost {...}.
        let cleaned = extractJSON(from: text)
        guard let jsonData = cleaned.data(using: .utf8),
              let result = try? JSONDecoder().decode(AnalysisResult.self, from: jsonData) else {
            throw AnalyzeError.parse
        }
        return result
    }

    /// Pull the outermost JSON object from a string. The model usually
    /// returns clean JSON, but sometimes wraps it in ``` fences or adds
    /// chatter — same defensive parsing the web `parseJSON` does.
    private static func extractJSON(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Strip ``` fences if present
        let unfenced = trimmed
            .replacingOccurrences(of: "```json", with: "")
            .replacingOccurrences(of: "```", with: "")
        // Take from first { to last }
        guard let start = unfenced.firstIndex(of: "{"),
              let end = unfenced.lastIndex(of: "}") else {
            return unfenced
        }
        return String(unfenced[start...end])
    }
}
