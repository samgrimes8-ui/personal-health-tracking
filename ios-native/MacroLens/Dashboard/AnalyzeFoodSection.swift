import SwiftUI

/// Text-describe path for AI analysis. User types a meal description,
/// taps Analyze, sees macros + a Log button. Camera/photo path is a
/// follow-up — the entire camera + photo picker + base64 upload flow
/// is its own milestone.
struct AnalyzeFoodSection: View {
    @Environment(AppState.self) private var state
    @State private var description: String = ""
    @State private var analyzing: Bool = false
    @State private var result: AnalysisResult?
    @State private var error: String?
    @State private var loggingResult: Bool = false
    @State private var logged: Bool = false
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("Analyze food")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.text)
                Text("⚡ AI")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Theme.accentSoft(), in: .rect(cornerRadius: 999))
                    .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.accent.opacity(0.3), lineWidth: 1))
                Spacer()
            }
            .padding(.horizontal, 20).padding(.vertical, 14)

            Divider().background(Theme.border)

            VStack(spacing: 12) {
                inputArea
                if let error {
                    errorBanner(error)
                }
                if let result {
                    resultCard(result)
                }
            }
            .padding(12)
        }
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
    }

    // MARK: - Input

    private var inputArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                if description.isEmpty {
                    Text("Describe what you ate. e.g. \"grilled chicken bowl with rice and broccoli\"")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text3)
                        .padding(.horizontal, 13).padding(.vertical, 11)
                }
                TextEditor(text: $description)
                    .focused($inputFocused)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .frame(minHeight: 80)
            }
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))

            Button {
                Task { await analyze() }
            } label: {
                HStack {
                    if analyzing { ProgressView().tint(Theme.accentFG) }
                    Text(analyzing ? "Analyzing…" : "Analyze with AI")
                        .font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(Theme.accentFG)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(canAnalyze ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 10))
            }
            .disabled(!canAnalyze || analyzing)
        }
    }

    private var canAnalyze: Bool {
        !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func errorBanner(_ msg: String) -> some View {
        Text(msg)
            .font(.system(size: 12))
            .foregroundStyle(Theme.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 11).padding(.vertical, 8)
            .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.red.opacity(0.25), lineWidth: 1))
    }

    // MARK: - Result

    private func resultCard(_ r: AnalysisResult) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(r.name)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Spacer()
                if let conf = r.confidence {
                    Text(conf.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.text3)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.bg3, in: .rect(cornerRadius: 4))
                }
            }

            HStack(spacing: 6) {
                pill("\(Int(r.calories)) kcal", color: Theme.cal)
                pill("\(Int(r.protein))g P", color: Theme.protein)
                pill("\(Int(r.carbs))g C", color: Theme.carbs)
                pill("\(Int(r.fat))g F", color: Theme.fat)
            }

            HStack {
                Button {
                    description = ""; result = nil; error = nil; logged = false
                } label: {
                    Text("Discard")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(Theme.bg3, in: .rect(cornerRadius: 8))
                }

                Button {
                    Task { await logResult(r) }
                } label: {
                    HStack {
                        if loggingResult { ProgressView().tint(Theme.accentFG) }
                        Text(logged ? "✓ Logged" : (loggingResult ? "Logging…" : "+ Log this meal"))
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(Theme.accentFG)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(logged ? Theme.green : Theme.accent, in: .rect(cornerRadius: 8))
                }
                .disabled(loggingResult || logged)
            }
        }
        .padding(12)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
    }

    private func pill(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(color.opacity(0.12), in: .rect(cornerRadius: 999))
            .overlay(RoundedRectangle(cornerRadius: 999).stroke(color.opacity(0.3), lineWidth: 1))
    }

    // MARK: - Actions

    private func analyze() async {
        inputFocused = false
        analyzing = true
        error = nil
        result = nil
        logged = false
        defer { analyzing = false }
        do {
            result = try await AnalyzeService.describe(description)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func logResult(_ r: AnalysisResult) async {
        loggingResult = true
        defer { loggingResult = false }
        do {
            try await state.logMeal(
                name: r.name,
                calories: r.calories,
                protein: r.protein,
                carbs: r.carbs,
                fat: r.fat,
                fiber: r.fiber ?? 0
            )
            logged = true
        } catch {
            self.error = "Saved analysis but couldn't log: \(error.localizedDescription)"
        }
    }
}
