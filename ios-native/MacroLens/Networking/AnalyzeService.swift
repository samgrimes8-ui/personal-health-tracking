import Foundation

/// Wrapper for the Vercel `/api/analyze` edge function. Mirrors the four
/// JS callers in src/lib/ai.js:
///
///   describeFood(text)       → analyzePlannerDescription   (MACROS_ONLY)
///   analyzeFoodPhoto(b64)    → analyzePhoto                (FULL — w/ ingredients)
///   analyzeRecipeText(text)  → analyzeRecipe               (FULL — w/ ingredients)
///   analyzeRecipePhoto(b64)  → analyzeRecipePhoto          (FULL — w/ ingredients,
///                                                            recipe-specialized prompt)
///
/// Each is one shot at the same endpoint with a different `feature`
/// telemetry tag and a different prompt. Returns a single AnalysisResult
/// — recipe paths populate `ingredients`, the food-describe path leaves
/// it nil.
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
            case .parse: return "Couldn't read the analysis result. Try a more specific input."
            }
        }
    }

    // MARK: - Public entry points

    static func describeFood(_ description: String) async throws -> AnalysisResult {
        try await callAnalyze(
            feature: "planner",
            action: "analyze_dashboard_describe",
            inputType: "text",
            content: .text("Analyze this meal/recipe and estimate macros per serving:\n\n\(description)\n\n\(macrosOnlyPrompt)"),
            maxTokens: 2000
        )
    }

    static func analyzeFoodPhoto(_ imageBase64: String, hint: String? = nil) async throws -> AnalysisResult {
        let promptText = """
        Analyze this image. It may be a food photo, a recipe page, a recipe card, or a screenshot of a recipe. Extract the recipe name, estimate macros per serving, and list all ingredients. \(fullAnalysisPrompt)
        \(hint.map { "\n\nMeal name hint: \($0)" } ?? "")
        """
        return try await callAnalyze(
            feature: "photo",
            action: "analyze_photo",
            inputType: "image",
            content: .imageWithText(base64: imageBase64, text: promptText),
            maxTokens: 3000
        )
    }

    static func analyzeRecipeText(_ recipe: String, hint: String? = nil) async throws -> AnalysisResult {
        let promptText = """
        Analyze this recipe and estimate macros + list all ingredients needed per serving:

        \(recipe)\(hint.map { "\n\nMeal name: \($0)" } ?? "")

        \(fullAnalysisPrompt)
        """
        return try await callAnalyze(
            feature: "recipe",
            action: "analyze_recipe",
            inputType: "text",
            content: .text(promptText),
            maxTokens: 2000
        )
    }

    static func analyzeRecipePhoto(_ imageBase64: String, hint: String? = nil) async throws -> AnalysisResult {
        let promptText = """
        This image contains a written recipe — from a cookbook, a recipe card, a blog post, or a social media screenshot.

        Read the recipe carefully. Extract the recipe name, the number of servings it makes, the full ingredient list with amounts as written, and estimate accurate macros PER SERVING.

        If servings aren't stated explicitly, infer a reasonable number from the ingredient quantities (e.g. 1 lb ground beef → ~4 servings).

        \(fullAnalysisPrompt)\(hint.map { "\n\nMeal name hint: \($0)" } ?? "")
        """
        return try await callAnalyze(
            feature: "recipe",
            action: "analyze_recipe_photo",
            inputType: "image",
            content: .imageWithText(base64: imageBase64, text: promptText),
            maxTokens: 3000
        )
    }

    // MARK: - Internal

    private enum Content {
        case text(String)
        case imageWithText(base64: String, text: String)
    }

    private static func callAnalyze(
        feature: String,
        action: String,
        inputType: String,
        content: Content,
        maxTokens: Int
    ) async throws -> AnalysisResult {

        let userMessage: [String: Any]
        switch content {
        case .text(let s):
            userMessage = ["role": "user", "content": s]
        case .imageWithText(let b64, let text):
            userMessage = [
                "role": "user",
                "content": [
                    ["type": "image", "source": ["type": "base64", "media_type": "image/jpeg", "data": b64]],
                    ["type": "text", "text": text],
                ] as [Any]
            ]
        }

        let body: [String: Any] = [
            "feature": feature,
            "max_tokens": maxTokens,
            "input_type": inputType,
            "action": action,
            "messages": [userMessage],
        ]

        let session = try await SupabaseService.client.auth.session
        var request = URLRequest(url: Config.apiBaseURL.appendingPathComponent("/api/analyze"))
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AnalyzeError.server("No response")
        }

        if http.statusCode == 401 { throw AnalyzeError.unauthenticated }

        if http.statusCode == 429 {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (json["code"] as? String) == "spending_limit_exceeded" {
                let spent = (json["spent_usd"] as? Double) ?? 0
                let limit = (json["limit_usd"] as? Double) ?? 0
                throw AnalyzeError.spendingLimitExceeded(spent: spent, limit: limit)
            }
        }

        if http.statusCode == 413 {
            throw AnalyzeError.server("Image too large for the server. Try a smaller photo.")
        }

        if !(200..<300).contains(http.statusCode) {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw AnalyzeError.server(msg ?? "Request failed (\(http.statusCode))")
        }

        // Anthropic envelope: { content: [{ type:"text", text:"..." }, { type:"tool_use", ... }] }
        // We're after the concatenated text blocks.
        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let blocks = envelope["content"] as? [[String: Any]] else {
            throw AnalyzeError.parse
        }
        let text = blocks.compactMap {
            ($0["type"] as? String) == "text" ? $0["text"] as? String : nil
        }.joined()

        let cleaned = extractJSON(from: text)
        guard let jsonData = cleaned.data(using: .utf8),
              let result = try? JSONDecoder().decode(AnalysisResult.self, from: jsonData) else {
            throw AnalyzeError.parse
        }
        return result
    }

    /// Pull the outermost JSON object from a model response. Handles
    /// stray prose, ```json fences, etc. — same defensive parsing the
    /// web parseJSON does.
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

    // MARK: - Prompts (kept in sync with src/lib/ai.js)

    private static let macrosOnlyPrompt = """
    Respond ONLY with a JSON object, no markdown, no explanation. Format:
    {"name":"meal name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high"}
    """

    private static let fullAnalysisPrompt = """
    Respond ONLY with a JSON object, no markdown, no explanation. Format:
    {
      "name": "meal name",
      "description": "brief 1-sentence description",
      "servings": number,
      "calories": number,
      "protein": number,
      "carbs": number,
      "fat": number,
      "fiber": number,
      "sugar": number,
      "confidence": "low|medium|high",
      "notes": "any important caveats or empty string",
      "ingredients": [
        {"name": "ingredient name", "amount": number, "unit": "oz/lbs/cups/tbsp/tsp/cloves/whole/slices", "category": "produce|protein|dairy|pantry|spices|grains|frozen|bakery|beverages"}
      ]
    }

    Rules:
    - amount must be a NUMBER (not a string)
    - category required on every ingredient: produce|protein|dairy|pantry|spices|grains|frozen|bakery|beverages
    - List every ingredient needed; empty array only if it's a packaged item with no recipe
    """
}
