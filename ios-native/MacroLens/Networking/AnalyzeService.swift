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
    ///
    /// Envelope-level parsed_quantity_g / parsed_quantity_servings (from
    /// queries like "15g butter" or "two slices toast") are forwarded onto
    /// EVERY candidate so the picker UI can apply the same multiplier
    /// regardless of which candidate the user picks. The model returns
    /// them once on the envelope; we fan out to each result so downstream
    /// log-flow code can stay candidate-only.
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
            return env.candidates.map { c in
                var copy = c
                if copy.parsed_quantity_g == nil { copy.parsed_quantity_g = env.parsed_quantity_g }
                if copy.parsed_quantity_servings == nil { copy.parsed_quantity_servings = env.parsed_quantity_servings }
                return copy
            }
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
    /// Candidates expects. Internal — callers see [AnalysisResult]. The
    /// envelope-level parsed_quantity fields apply uniformly to whichever
    /// candidate the user picks.
    private struct CandidatesEnvelope: Codable {
        let candidates: [AnalysisResult]
        let parsed_quantity_g: Double?
        let parsed_quantity_servings: Double?
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

    /// Web-search-backed recipe import. Mirrors `analyzeDishBySearch` in
    /// src/lib/ai.js — kicks off Anthropic's web_search tool to pull the
    /// full recipe off the URL the user pasted (or to find one matching
    /// the dish name when no URL is given). Used by the "Paste a link"
    /// path of the new-recipe method picker.
    static func analyzeDishBySearch(_ dishName: String, link: String?) async throws -> AnalysisResult {
        let query: String
        if let link, !link.isEmpty {
            query = "Search for the recipe \"\(dishName)\" from this URL: \(link). Find the full ingredient list and serving size."
        } else {
            query = "Search for the recipe \"\(dishName)\". Find the full ingredient list and serving size."
        }
        let promptText = "\(query)\n\nAfter searching, return ONLY a JSON object with the macros per serving and full ingredient list. \(fullAnalysisPrompt)"

        let userMessage: [String: Any] = ["role": "user", "content": promptText]
        let body: [String: Any] = [
            "feature": "search",
            "max_tokens": 4000,
            "input_type": "text",
            "action": "analyze_dish_by_search",
            "messages": [userMessage],
            "tools": [["type": "web_search_20250305", "name": "web_search"]],
        ]
        let text = try await rawTextWithEnvelope(body: body)
        guard !text.isEmpty else {
            throw AnalyzeError.server("No response — try being more specific with the dish name")
        }
        let cleaned = extractJSON(from: text)
        guard let data = cleaned.data(using: .utf8),
              let result = try? JSONDecoder().decode(AnalysisResult.self, from: data)
        else {
            throw AnalyzeError.server("Could not extract recipe data — try pasting the ingredients directly")
        }
        return result
    }

    /// Generates a complete recipe (macros + ingredients + step-by-step
    /// instructions) from a free-text prompt — "high protein chicken
    /// dinner under 600 calories", "what to do with leftover salmon", etc.
    /// Mirrors `generateRecipeFromMood` in src/lib/ai.js. Drives the
    /// "✨ Generate a recipe" path of the new-recipe method picker.
    static func generateRecipeFromMood(_ prompt: String) async throws -> RecipeFromMood {
        let promptText = """
        Generate a complete recipe based on this request: "\(prompt)"

        Create something practical, delicious and realistic for a home cook.
        Calculate accurate macros per serving.

        Return ONLY this JSON (no markdown):
        {
          "name": "Recipe name",
          "description": "One line description",
          "servings": number,
          "serving_label": "serving",
          "calories": number,
          "protein": number,
          "carbs": number,
          "fat": number,
          "fiber": number,
          "sugar": number,
          "ingredients": [{"amount":"1","unit":"cup","name":"ingredient"}],
          "instructions": {"steps":["Step 1","Step 2"],"prep_time":"X mins","cook_time":"X mins","tips":["optional tip"]},
          "notes": "any notes about substitutions or variations"
        }
        """
        let raw = try await rawTextResponse(
            feature: "recipe",
            action: "generate_recipe_from_mood",
            inputType: "text",
            content: .text(promptText),
            maxTokens: 2000
        )
        let cleaned = extractJSON(from: raw)
        guard let data = cleaned.data(using: .utf8),
              let result = try? JSONDecoder().decode(RecipeFromMood.self, from: data),
              !result.name.isEmpty
        else {
            throw AnalyzeError.parse
        }
        return result
    }

    /// Photo extraction that returns BOTH ingredients AND step-by-step
    /// instructions, so a single shot from a cookbook page populates the
    /// whole recipe. Mirrors `extractRecipeFromPhoto` in src/lib/ai.js.
    /// Different from `analyzeRecipePhoto` (which returns only macros +
    /// ingredients) — that one's for the dashboard's "snap a meal" flow.
    static func extractRecipeFromPhoto(_ imageBase64: String) async throws -> RecipeFromPhoto {
        let promptText = """
        This is a photo of a recipe from a cookbook or recipe card. Extract the complete recipe.

        Return ONLY this JSON (no markdown):
        {
          "name": "recipe name",
          "description": "one line description",
          "servings": number,
          "serving_label": "serving",
          "ingredients": [
            { "amount": "1", "unit": "cup", "name": "ingredient name" }
          ],
          "instructions": ["Step 1 text", "Step 2 text"],
          "prep_time": "X mins or null",
          "cook_time": "X mins or null",
          "notes": "any tips or notes from the recipe or null"
        }

        If ingredient has no unit (e.g. "2 eggs"), set unit to "".
        Extract every ingredient and every step exactly as written.
        """
        let raw = try await rawTextResponse(
            feature: "recipe",
            action: "extract_recipe_from_photo",
            inputType: "image",
            content: .imageWithText(base64: imageBase64, text: promptText),
            maxTokens: 2000
        )
        let cleaned = extractJSON(from: raw)
        guard let data = cleaned.data(using: .utf8),
              let result = try? JSONDecoder().decode(RecipeFromPhoto.self, from: data),
              !result.name.isEmpty
        else {
            throw AnalyzeError.parse
        }
        return result
    }

    /// AI-parses a free-text ingredient list into structured rows. Used by
    /// the "Add manually" → paste-ingredients pre-step in the new-recipe
    /// method picker — the user pastes a blob from a recipe page, AI
    /// returns clean amount/unit/name triples to seed the form. Mirrors
    /// `extractIngredients` in src/lib/ai.js.
    static func extractIngredients(_ text: String) async throws -> [RecipeIngredient] {
        let promptText = """
        For this recipe text:

        \(text)

        List every ingredient as a JSON array. Be specific with amounts.

        Respond ONLY with a JSON object, no markdown:
        {
          "ingredients": [
            {"name": "chicken breast", "amount": "3", "unit": "lbs"},
            {"name": "olive oil", "amount": "2", "unit": "tbsp"}
          ]
        }
        """
        struct Envelope: Decodable { let ingredients: [RecipeIngredient] }
        let raw = try await rawTextResponse(
            feature: "recipe",
            action: "extract_ingredients",
            inputType: "text",
            content: .text(promptText),
            maxTokens: 1500
        )
        let cleaned = extractJSON(from: raw)
        guard let data = cleaned.data(using: .utf8),
              let env = try? JSONDecoder().decode(Envelope.self, from: data)
        else {
            throw AnalyzeError.parse
        }
        return env.ingredients
    }

    /// Lower-level helper that posts an arbitrary JSON body to /api/analyze
    /// and returns the concatenated text from the Anthropic content blocks.
    /// Used by `analyzeDishBySearch` because that path needs a `tools` field
    /// in the body which the standard `callAnalyze` doesn't expose.
    private static func rawTextWithEnvelope(body: [String: Any]) async throws -> String {
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

    /// Detect a quantity hint in the freeform query and surface it as a
    /// structured field so the iOS preview can pre-fill the log input.
    /// PER-SERVING macros stay unchanged — the client multiplies by
    /// (parsed_quantity_g / serving_grams) or by parsed_quantity_servings
    /// at log time. Kept in sync with PARSED_QUANTITY_RULES in src/lib/ai.js.
    private static let parsedQuantityRules = """

    Parsing quantity hints in the query (CRITICAL):
    - If the user's query contains a quantity hint, return it as parsed_quantity_g (grams) OR parsed_quantity_servings (multiple of one serving). Pick whichever the hint most naturally maps to. Leave both null when the query is a bare food name.
    - "15g butter" → parsed_quantity_g: 15
    - "1 tbsp olive oil" → parsed_quantity_g: 14 (1 tbsp ≈ 14g for oils/butter; ≈ 21g for syrup; ≈ 13g for honey — pick the per-substance value)
    - "2 tablespoons peanut butter" → parsed_quantity_g: 32 (2 × 16g)
    - "6 oz steak" → parsed_quantity_g: 170 (6 × 28.3495, rounded)
    - "100g chicken" → parsed_quantity_g: 100
    - "half avocado" / "1/2 avocado" / "0.5 avocado" → parsed_quantity_servings: 0.5
    - "quarter cup rice" / "1/4 cup rice" → parsed_quantity_servings: 0.25 (assuming the chosen serving IS 1 cup)
    - "two slices toast" / "2 slices of toast" → parsed_quantity_servings: 2
    - "3 eggs" / "three eggs" → parsed_quantity_servings: 3
    - "1.5 bananas" → parsed_quantity_servings: 1.5
    - "a banana" / "one banana" / bare "banana" → parsed_quantity_servings: null (default to 1 serving)
    - Range like "1-2 slices" → skip (return null for both)
    - Both fields are NUMBERS or null. Never both set; prefer parsed_quantity_g when grams/oz/lbs/tbsp/tsp/cup are explicit; prefer parsed_quantity_servings for natural-piece counts.
    - For multi-candidate results: parse the quantity ONCE on the envelope (not per candidate) — the user's quantity applies to whichever candidate they pick.
    """

    /// Pick the SMALLEST REASONABLE serving someone might consume in a
    /// single meal/snack. Wholesale package sizes (1 cup of butter, 1 lb
    /// of pasta) make logging a few grams come out as a tiny fraction of
    /// a serving, which is unusable. Kept verbatim in sync with
    /// NATURAL_SERVING_RULES in src/lib/ai.js.
    private static let naturalServingRules = """

    Picking the natural single serving (CRITICAL — don't skip):
    - Choose the SMALLEST REASONABLE serving someone might eat at one sitting, NOT the wholesale package size.
    - Fats / oils / butter / mayonnaise / nut butter / syrup / honey / heavy cream → "1 tablespoon (~14-21g)"
    - Bread → "1 slice (~30g)" (NOT a loaf)
    - Cheese → "1 oz (~28g)" or "1 slice" (NOT a block or pound)
    - Nuts → "1 oz (~28g) (~23 almonds)" or similar count (NOT a cup)
    - Cooked rice / pasta → "1 cup (~150-195g)"
    - DRY pasta → "2 oz (~57g)" (NOT a pound or box)
    - Whole produce → the piece itself: "1 medium banana, ~118g", "1 large egg (~50g)", "1 medium avocado, ~150g"
    - Meat / fish / poultry → "4 oz (~113g) cooked"
    - Beverages → "1 cup (~240ml)" or "1 can (~355ml)"
    - Specific branded products → use the manufacturer's printed serving size
    Test: if 1 tbsp / 1 slice / 1 piece of the food is something a normal person might consume at once, use THAT. Never pick a unit so large that 15g of the food works out to a tiny fraction of a serving.
    """

    private static var macrosOnlyPrompt: String {
        """
        Respond ONLY with a JSON object, no markdown, no explanation. Format:
        {"name":"food name","serving_description":"plain-language unit, e.g. '1 medium avocado, ~150g' or '1 slice of bread, ~30g' or '1 cup cooked rice, ~195g'","serving_grams":number,"serving_oz":number,"parsed_quantity_g":number|null,"parsed_quantity_servings":number|null,"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,\(fullLabelFields)"confidence":"low|medium|high"}

        Rules for serving fields:
        - serving_description MUST be a clear, human-readable single-serving unit. Always include an approximate gram weight in parentheses or after a comma — e.g. "1 medium avocado, ~150g" or "1 slice of toast (~30g)".
        - serving_grams must be a NUMBER (the same gram weight referenced in serving_description). serving_oz = serving_grams / 28.3495, rounded to one decimal.
        - All macro fields (calories/protein/carbs/fat/fiber/sugar) MUST be the values FOR ONE serving as defined above — NOT per-100g, NOT total amount the user might eat.
        - If the user describes a fraction or multiple ("half an avocado", "two slices of toast"), still return macros for ONE single natural serving and let the client apply the multiplier.
        \(naturalServingRules)
        \(parsedQuantityRules)
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
        {"parsed_quantity_g":number|null,"parsed_quantity_servings":number|null,"candidates":[{"name":"food name","serving_description":"plain-language unit, e.g. '1 medium avocado, ~150g'","serving_grams":number,"serving_oz":number,"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"confidence":"low|medium|high"}]}

        Return between 1 and 10 candidates ranked by relevance (best first).
        - For UNAMBIGUOUS generic queries ("butter", "olive oil", "milk"), return ONE candidate with the natural single-serving unit (see rules below). Multi-result picker is for genuinely ambiguous queries only.
        - For genuinely ambiguous generic queries ("banana", "avocado", "pizza"), return 3-5 distinct natural serving sizes (small / medium / large piece, etc) — NOT wholesale variants.
        - For specific branded queries ("McDonald's Big Mac", "Quest Cookies & Cream protein bar"), a SINGLE candidate is fine.
        - Each candidate's macros are FOR ONE serving as defined in its own serving_description (NOT per-100g). serving_grams is a NUMBER. serving_oz = serving_grams / 28.3495, one decimal.
        - serving_description MUST always include an approximate gram weight.
        - Sort by descending confidence.
        - parsed_quantity_g / parsed_quantity_servings live on the ENVELOPE (not per candidate) — the user's quantity hint applies to whichever candidate they pick.
        \(naturalServingRules)
        \(parsedQuantityRules)
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
        \(naturalServingRules)
        \(fullLabelRules)
        """
    }
}

/// Decoded shape returned by `generateRecipeFromMood` — the AI emits a
/// complete recipe with macros, ingredients, AND instructions in one
/// shot, so the new-recipe Generate path can hand the user a fully
/// populated form. Mirrors the JSON spec in `generateRecipeFromMood`
/// (src/lib/ai.js).
struct RecipeFromMood: Decodable {
    var name: String
    var description: String?
    var servings: Double?
    var serving_label: String?
    var calories: Double?
    var protein: Double?
    var carbs: Double?
    var fat: Double?
    var fiber: Double?
    var sugar: Double?
    var ingredients: [RecipeIngredient]?
    var instructions: RecipeInstructions?
    var notes: String?
}

/// Decoded shape returned by `extractRecipeFromPhoto`. Same idea as
/// RecipeFromMood but the JSON contract differs: instructions arrive as
/// a flat `[String]` (steps) plus loose prep_time/cook_time fields,
/// matching the cookbook-extraction prompt. We reshape into the canonical
/// `RecipeInstructions` struct in the caller.
struct RecipeFromPhoto: Decodable {
    var name: String
    var description: String?
    var servings: Double?
    var serving_label: String?
    var ingredients: [RecipeIngredient]?
    var instructions: [String]?
    var prep_time: String?
    var cook_time: String?
    var notes: String?

    /// Convert the loose prep/cook/steps fields into the unified
    /// `RecipeInstructions` shape the rest of the iOS code uses.
    func toRecipeInstructions() -> RecipeInstructions? {
        guard let steps = instructions, !steps.isEmpty else { return nil }
        return RecipeInstructions(
            steps: steps,
            prep_time: prep_time,
            cook_time: cook_time,
            tips: nil
        )
    }
}
