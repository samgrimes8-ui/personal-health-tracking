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
            case .spendingLimitExceeded: return "You've used all your Computer Calories this month."
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

    /// Multi-result variant of describeFood. The Dashboard's text-describe
    /// path uses this so ambiguous queries ("banana") can present a picker
    /// covering small/medium/large/etc. The single-result fast path stays
    /// when the model returns exactly one candidate. Each element carries
    /// the same shape as a regular AnalysisResult — same render code reuses.
    static func describeFoodCandidates(_ description: String) async throws -> [AnalysisResult] {
        let prompt = """
        User typed: "\(description)"

        List the most likely foods this could be, with per-serving macros for each. Cover the common serving sizes when the query is generic.

        \(candidatesPrompt)
        """
        let raw = try await rawTextResponse(
            feature: "planner",
            action: "describe_food_candidates",
            inputType: "text",
            content: .text(prompt),
            maxTokens: 2000
        )
        let cleaned = extractJSON(from: raw)
        guard let data = cleaned.data(using: .utf8) else { throw AnalyzeError.parse }
        // Try the {candidates:[...]} envelope first.
        if let env = try? JSONDecoder().decode(CandidatesEnvelope.self, from: data),
           !env.candidates.isEmpty {
            return env.candidates
        }
        // Defensive: model occasionally returns a bare AnalysisResult
        // when the query is unambiguous. Wrap as a one-element list so
        // the caller can take the single-result fast path uniformly.
        if let single = try? JSONDecoder().decode(AnalysisResult.self, from: data) {
            return [single]
        }
        throw AnalyzeError.parse
    }

    /// Wrapper for the {candidates:[...]} JSON envelope describeFood-
    /// Candidates expects. Internal — callers see [AnalysisResult].
    private struct CandidatesEnvelope: Codable {
        let candidates: [AnalysisResult]
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

    /// Photo classifier — picks one of "barcode" | "label" | "food" so we
    /// can route the photo to the right downstream analysis. Mirrors
    /// classifyFoodPhoto in src/lib/ai.js. Defaults to "food" when the
    /// model returns something unexpected (safer fallback — gives the
    /// user some result instead of failing).
    static func classifyFoodPhoto(_ imageBase64: String) async throws -> String {
        let promptText = """
        Look at this photo and classify what's being shown. Pick ONE:

        - "barcode" — a product barcode (stripes + digits), typically on packaging
        - "label" — a nutrition facts panel (white rectangle, bold "Nutrition Facts" header, table of values)
        - "food" — a meal, plate of food, dish, or any food item that isn't a label or barcode

        Respond with ONLY one word: barcode, label, or food.
        """
        let raw = try await rawTextResponse(
            feature: "food",
            action: "classify_food_photo",
            inputType: "image",
            content: .imageWithText(base64: imageBase64, text: promptText),
            maxTokens: 20
        ).lowercased()

        if raw.contains("barcode") { return "barcode" }
        if raw.contains("label")   { return "label" }
        return "food"
    }

    /// Last-resort barcode reader when Vision can't decode the bars but
    /// the image still contains the printed digits. Mirrors
    /// readBarcodeFromImage in src/lib/ai.js. Returns nil when the model
    /// can't read it (so the caller can prompt for manual entry).
    static func readBarcodeFromImage(_ imageBase64: String) async throws -> String? {
        let promptText = """
        Look at the barcode in this image (the vertical black lines with numbers beneath).

        Read the printed number under the bars — this is a UPC/EAN product code, typically 12-13 digits. Small leading/trailing digits may be offset from the main group (e.g. "1 97870 05291 5" is all part of the code).

        Respond with ONLY the digits, no spaces, no other text. If you genuinely cannot read any digits at all, respond with "UNREADABLE".
        """
        let raw = try await rawTextResponse(
            feature: "food",
            action: "read_barcode_from_image",
            inputType: "image",
            content: .imageWithText(base64: imageBase64, text: promptText),
            maxTokens: 50
        ).trimmingCharacters(in: .whitespacesAndNewlines)

        if raw.isEmpty || raw.lowercased().contains("unreadable") { return nil }
        let digits = raw.filter(\.isNumber)
        return (6...14).contains(digits.count) ? digits : nil
    }

    /// Nutrition-facts-label OCR + parse via Claude. Mirrors
    /// analyzeNutritionLabel in src/lib/ai.js (sans the free-OCR
    /// pre-pass — that JS path is browser-only). Returns the same
    /// AnalysisResult shape as the other paths.
    static func analyzeNutritionLabel(_ imageBase64: String) async throws -> AnalysisResult {
        let promptText = """
        Read the nutrition facts label in this image and extract the values exactly as printed.
        Respond ONLY with a JSON object, no markdown:
        {
          "name": "product name if visible, else 'Food Item'",
          "brand": "brand name if visible or empty string",
          "serving_size": "serving size as printed",
          "calories": number,
          "protein": number,
          "carbs": number,
          "fat": number,
          "fiber": number,
          "sugar": number,
          "sodium": number,
          "confidence": "high",
          "notes": "any values that were unclear"
        }
        """
        return try await callAnalyze(
            feature: "food",
            action: "analyze_nutrition_label",
            inputType: "image",
            content: .imageWithText(base64: imageBase64, text: promptText),
            maxTokens: 600
        )
    }

    /// Generates step-by-step cooking instructions for an existing recipe.
    /// Mirrors `generateRecipeInstructions` in src/lib/ai.js — same prompt,
    /// same JSON contract: `{ steps: [...], prep_time, cook_time, tips: [...] }`.
    static func generateRecipeInstructions(_ recipe: RecipeFull) async throws -> RecipeInstructions {
        let ingredientList: String = (recipe.ingredients ?? [])
            .map { ing in
                let amt = ing.amount ?? ""
                let unit = ing.unit ?? ""
                return "\(amt) \(unit) \(ing.name)".trimmingCharacters(in: .whitespaces)
            }
            .joined(separator: "\n")

        var prompt = "Write clear, step-by-step cooking instructions for this recipe.\n\n"
        prompt += "Recipe: \(recipe.name)\n"
        if let d = recipe.description, !d.isEmpty { prompt += "Description: \(d)\n" }
        prompt += "Servings: \(Int(recipe.servings ?? 4))\n"
        if !ingredientList.isEmpty {
            prompt += "\nIngredients:\n\(ingredientList)\n"
        }
        if let url = recipe.source_url, !url.isEmpty {
            prompt += "\nSource: \(url)\n"
        }
        prompt += "\nWrite numbered steps that are concise and easy to follow on a phone while cooking.\n"
        prompt += "Include timing, temperatures, and visual cues (e.g. \"until golden brown\").\n"
        prompt += "If no ingredients are provided, estimate based on the recipe name.\n\n"
        prompt += "Return ONLY the steps as a JSON array:\n"
        prompt += #"{"steps": ["Step 1 text", "Step 2 text", ...], "prep_time": "X mins", "cook_time": "X mins", "tips": ["optional tip 1", ...]}"#

        let raw = try await rawTextResponse(
            feature: "recipe",
            action: "generate_recipe_instructions",
            inputType: "text",
            content: .text(prompt),
            maxTokens: 1500
        )
        let cleaned = extractJSON(from: raw)
        guard let data = cleaned.data(using: .utf8),
              let result = try? JSONDecoder().decode(RecipeInstructions.self, from: data),
              !result.steps.isEmpty
        else {
            throw AnalyzeError.parse
        }
        return result
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

    /// Lower-level call that returns the raw concatenated text from the
    /// Anthropic content blocks (no JSON parsing). Used by classifier +
    /// barcode-from-image where the response isn't structured.
    private static func rawTextResponse(
        feature: String,
        action: String,
        inputType: String,
        content: Content,
        maxTokens: Int
    ) async throws -> String {
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
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AnalyzeError.server("No response") }
        if http.statusCode == 401 { throw AnalyzeError.unauthenticated }
        if http.statusCode == 429,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           (json["code"] as? String) == "spending_limit_exceeded" {
            throw AnalyzeError.spendingLimitExceeded(
                spent: (json["spent_usd"] as? Double) ?? 0,
                limit: (json["limit_usd"] as? Double) ?? 0
            )
        }
        if !(200..<300).contains(http.statusCode) {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw AnalyzeError.server(msg ?? "Request failed (\(http.statusCode))")
        }

        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let blocks = envelope["content"] as? [[String: Any]] else {
            throw AnalyzeError.parse
        }
        return blocks.compactMap { ($0["type"] as? String) == "text" ? $0["text"] as? String : nil }.joined()
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

    // Full-label fields injected into every prompt. Model returns null for any
    // value it cannot confidently read — opt-in UI shows "not tracked" for
    // nulls. Fabricated zeros would silently corrupt the goals view.
    private static let fullLabelFields = """
    "saturated_fat_g": number|null,
      "trans_fat_g": number|null,
      "cholesterol_mg": number|null,
      "sodium_mg": number|null,
      "fiber_g": number|null,
      "sugar_total_g": number|null,
      "sugar_added_g": number|null,
      "vitamin_a_mcg": number|null,
      "vitamin_c_mg": number|null,
      "vitamin_d_mcg": number|null,
      "calcium_mg": number|null,
      "iron_mg": number|null,
      "potassium_mg": number|null,
    """

    private static let fullLabelRules = """

    Rules for full-label fields (saturated_fat_g, trans_fat_g, cholesterol_mg, sodium_mg, fiber_g, sugar_total_g, sugar_added_g, vitamin_a_mcg, vitamin_c_mg, vitamin_d_mcg, calcium_mg, iron_mg, potassium_mg):
    - Use null for any value you cannot read or confidently infer. Do NOT fabricate zeros.
    - vitamin_a_mcg is RAE (retinol activity equivalents), not IU.
    - All values are PER SERVING, matching serving_description / serving_grams.
    - These come from packaged-product labels, USDA data for generic foods, or restaurant nutrition info. If none of those apply, return null.
    """

    private static var macrosOnlyPrompt: String {
        """
        Respond ONLY with a JSON object, no markdown, no explanation. Format:
        {"name":"food name","serving_description":"plain-language unit, e.g. '1 medium avocado, ~150g' or '1 slice of bread, ~30g' or '1 cup cooked rice, ~195g'","serving_grams":number,"serving_oz":number,"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,\(fullLabelFields)"confidence":"low|medium|high"}

        Rules for serving fields:
        - serving_description MUST be a clear, human-readable single-serving unit. Prefer natural units (1 medium avocado, 1 large banana, 1 slice of toast, 1 large egg, 1 cup cooked rice). Always include an approximate gram weight in parentheses or after a comma — e.g. "1 medium avocado, ~150g" or "1 slice of toast (~30g)".
        - serving_grams must be a NUMBER (the same gram weight referenced in serving_description). serving_oz = serving_grams / 28.3495, rounded to one decimal.
        - All macro fields (calories/protein/carbs/fat/fiber/sugar) MUST be the values FOR ONE serving as defined above — NOT per-100g, NOT total amount the user might eat.
        - If the user describes a fraction or multiple ("half an avocado", "two slices of toast"), still return macros for ONE single natural serving and let the client apply the multiplier.
        - For foods with no natural unit (rice, pasta, oats, sauces), default to "1 cup cooked, ~Xg" or "100g" with macros for that amount.
        \(fullLabelRules)
        """
    }

    /// Prompt for the multi-candidate describeFood path. Kept in sync
    /// with CANDIDATES_PROMPT in src/lib/ai.js. Each candidate carries
    /// the same per-serving shape macrosOnlyPrompt defines, so the same
    /// AnalysisResult struct can decode either flavor.
    private static var candidatesPrompt: String {
        """
        Respond ONLY with a JSON object, no markdown, no explanation. Format:
        {"candidates":[{"name":"food name","serving_description":"plain-language unit, e.g. '1 medium avocado, ~150g'","serving_grams":number,"serving_oz":number,"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high"}]}

        Return between 1 and 10 candidates ranked by relevance (best first).
        - For ambiguous generic queries ("banana", "avocado", "pizza"), return 3-7 distinct serving sizes / variants the user might mean (small / medium / large / cup / slice / etc).
        - For specific branded queries ("McDonald's Big Mac", "Quest Cookies & Cream protein bar"), a SINGLE candidate is fine.
        - Each candidate's macros are FOR ONE serving as defined in its own serving_description (NOT per-100g). serving_grams is a NUMBER. serving_oz = serving_grams / 28.3495, one decimal.
        - serving_description MUST always include an approximate gram weight.
        - Sort by descending confidence.
        """
    }

    private static var fullAnalysisPrompt: String {
        """
        Respond ONLY with a JSON object, no markdown, no explanation. Format:
        {
          "name": "meal name",
          "description": "brief 1-sentence description",
          "servings": number,
          "serving_description": "plain-language single-serving unit, e.g. '1 medium avocado, ~150g' or '1 cup cooked, ~195g' or '1 slice (~30g)'",
          "serving_grams": number,
          "serving_oz": number,
          "calories": number,
          "protein": number,
          "carbs": number,
          "fat": number,
          "fiber": number,
          "sugar": number,
          \(fullLabelFields)
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
        - serving_description MUST include an approximate gram weight; serving_grams is a NUMBER; serving_oz = serving_grams / 28.3495, one decimal
        - Macro fields (calories/protein/carbs/fat/fiber/sugar) are PER SERVING (one of "servings"), matching serving_description / serving_grams. NOT per-100g, NOT whole-recipe totals.
        \(fullLabelRules)
        """
    }
}
