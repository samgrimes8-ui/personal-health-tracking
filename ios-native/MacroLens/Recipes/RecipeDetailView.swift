import SwiftUI

/// View-mode recipe detail. Mirrors the right-side "view" mode of the
/// web `renderRecipeModalContent`. Read-only — to edit, the user taps
/// "Edit" which the parent reroutes to RecipeEditView.
///
/// Cooking-mode read-aloud is intentionally out of scope (web-only
/// SpeechSynthesis). Sharing is also deferred — the view-mode header
/// keeps the macro pills front-and-center so the day-to-day "what does
/// this make?" lookup is fast.
struct RecipeDetailView: View {
    let recipe: RecipeFull
    let onEdit: (RecipeFull) -> Void
    let onDeleted: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var scaledServings: Double
    @State private var isDeleting = false
    @State private var deleteError: String?

    init(recipe: RecipeFull,
         onEdit: @escaping (RecipeFull) -> Void,
         onDeleted: @escaping () -> Void) {
        self.recipe = recipe
        self.onEdit = onEdit
        self.onDeleted = onDeleted
        _scaledServings = State(initialValue: recipe.servings ?? 1)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if let desc = recipe.description, !desc.isEmpty {
                    Text(desc)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text2)
                }
                if let url = recipe.source_url, !url.isEmpty {
                    sourceLink(url)
                }
                servingsRow
                macrosRow
                if !(recipe.tags ?? []).isEmpty {
                    tagsRow
                }
                ingredientsCard
                if let err = deleteError {
                    Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
                }
                actionsRow
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .background(Theme.bg)
        .navigationTitle(recipe.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Close") { dismiss() }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Edit") { onEdit(recipe) }
                    .foregroundStyle(Theme.accent)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(recipe.name)
                .font(.system(size: 24, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 6)
    }

    private func sourceLink(_ url: String) -> some View {
        let domain: String = {
            if let u = URL(string: url) {
                return u.host?.replacingOccurrences(of: "www.", with: "") ?? url
            }
            return url
        }()
        return Link(destination: URL(string: url) ?? URL(string: "https://example.com")!) {
            HStack(spacing: 8) {
                Image(systemName: "link")
                    .foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("View original recipe")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.accent)
                    Text(domain)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
        }
    }

    private var servingsRow: some View {
        let base = recipe.servings ?? 1
        let label = recipe.serving_label ?? "serving"
        return HStack(spacing: 12) {
            Text("Servings:")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text2)
            Text("\(formatServings(base)) \(plural(label, base))")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.text)
            Spacer()
            Text("per serving")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
    }

    private var macrosRow: some View {
        HStack(spacing: 6) {
            MacroChip(.calories, label: "Cal", amount: recipe.calories ?? 0)
            MacroChip(.protein, label: "P", amount: recipe.protein ?? 0)
            MacroChip(.carbs, label: "C", amount: recipe.carbs ?? 0)
            MacroChip(.fat, label: "F", amount: recipe.fat ?? 0)
            if let fiber = recipe.fiber, fiber > 0 {
                MacroChip(.fiber, label: "Fbr", amount: fiber)
            }
            Spacer(minLength: 0)
        }
    }

    private var tagsRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Tags")
                .font(.system(size: 11, weight: .medium))
                .tracking(1.0).textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            FlowLayout(spacing: 6) {
                ForEach(recipe.tags ?? [], id: \.self) { tag in
                    Text(tag)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.carbs)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Theme.carbs.opacity(0.10), in: .rect(cornerRadius: 999))
                        .overlay(RoundedRectangle(cornerRadius: 999).stroke(Theme.carbs.opacity(0.25), lineWidth: 1))
                }
            }
        }
    }

    private var ingredientsCard: some View {
        let base = recipe.servings ?? 1
        let ingredients = recipe.ingredients ?? []
        let multiplier = (base > 0 && scaledServings > 0) ? scaledServings / base : 1.0
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Ingredients")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(1.0).textCase(.uppercase)
                    .foregroundStyle(Theme.text3)
                Spacer()
            }
            // Servings scaler
            HStack(spacing: 8) {
                Text("Base:")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                Text("\(formatServings(base)) \(plural(recipe.serving_label ?? "serving", base))")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text("→ Scale to:")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                Stepper(value: $scaledServings, in: 0.5...64, step: 0.5) {
                    Text(formatServings(scaledServings))
                        .font(.system(size: 14, weight: .semibold))
                        .frame(minWidth: 36, alignment: .leading)
                }
                .labelsHidden()
                Text(formatServings(scaledServings))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.accent)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.bg3, in: .rect(cornerRadius: 10))

            // Rows
            if ingredients.isEmpty {
                Text("No ingredients yet.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .background(Theme.bg2, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(ingredients.enumerated()), id: \.offset) { idx, ing in
                        ingredientRow(ing, multiplier: multiplier, isLast: idx == ingredients.count - 1)
                    }
                }
                .background(Theme.bg2, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
            }
        }
    }

    private func ingredientRow(_ ing: Ingredient, multiplier: Double, isLast: Bool) -> some View {
        let raw = AmountParser.parse(ing.amount.map { String($0) })
        let scaled = raw * multiplier
        let amtText: String = {
            if scaled == 0 {
                if let a = ing.amount { return AmountParser.format(a) }
                return ""
            }
            return AmountParser.format(scaled)
        }()
        return HStack(spacing: 10) {
            Text("\(amtText) \(ing.unit ?? "")")
                .font(.system(size: 13, weight: multiplier != 1 && raw > 0 ? .semibold : .regular))
                .foregroundStyle(Theme.accent)
                .frame(minWidth: 90, alignment: .leading)
            Text(ing.name)
                .font(.system(size: 13))
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .overlay(alignment: .bottom) {
            if !isLast {
                Rectangle().fill(Theme.border).frame(height: 1)
            }
        }
    }

    private var actionsRow: some View {
        HStack(spacing: 10) {
            Button(role: .destructive) {
                Task { await delete() }
            } label: {
                if isDeleting {
                    ProgressView().controlSize(.small)
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Delete").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.bordered)
            .tint(Theme.red)
            .disabled(isDeleting)

            Button {
                onEdit(recipe)
            } label: {
                Text("Edit").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(isDeleting)
        }
        .padding(.top, 6)
    }

    private func delete() async {
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await DBService.deleteRecipe(id: recipe.id)
            onDeleted()
        } catch {
            deleteError = error.localizedDescription
        }
    }

    private func formatServings(_ v: Double) -> String {
        if v.truncatingRemainder(dividingBy: 1) == 0 { return String(Int(v)) }
        return String(format: "%g", (v * 10).rounded() / 10)
    }

    private func plural(_ word: String, _ count: Double) -> String {
        count == 1 ? word : "\(word)s"
    }
}

/// Tiny flow layout — wraps tag chips onto multiple lines without us
/// reaching for an external dependency. iOS 16 has no Layout primitive
/// that does flexible wrap; this honors the project's iOS-17 target.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var rows: [[CGSize]] = [[]]
        var rowWidths: [CGFloat] = [0]
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            let lastIdx = rows.count - 1
            let trial = rowWidths[lastIdx] + (rows[lastIdx].isEmpty ? 0 : spacing) + s.width
            if trial > width && !rows[lastIdx].isEmpty {
                rows.append([s])
                rowWidths.append(s.width)
            } else {
                rows[lastIdx].append(s)
                rowWidths[lastIdx] = trial
            }
        }
        let height = rows.reduce(0) { acc, row in
            let rowH = row.map(\.height).max() ?? 0
            return acc + rowH + (acc == 0 ? 0 : spacing)
        }
        let widest = rowWidths.max() ?? 0
        return CGSize(width: min(widest, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowH: CGFloat = 0
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX && x > bounds.minX {
                x = bounds.minX
                y += rowH + spacing
                rowH = 0
            }
            sv.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
    }
}
