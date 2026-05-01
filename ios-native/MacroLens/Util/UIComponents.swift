import SwiftUI

// ─── Phase 0 / S5 — shared UI primitives ───────────────────────────────
//
// Common SwiftUI building blocks the upcoming tab views all reach for.
// All colors come from Theme — no hex literals here. If a tab worker
// needs a new variant, add it here so styling stays consistent across
// the native screens.

/// Title row above a section. Mirrors the web app's `.section-header`.
/// Optional trailing slot for a "See all"-style button or count badge.
struct SectionHeader<Trailing: View>: View {
    let title: String
    let subtitle: String?
    let trailing: Trailing?

    init(_ title: String,
         subtitle: String? = nil,
         @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.text)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.text2)
                }
            }
            Spacer(minLength: 8)
            if let trailing { trailing }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(_ title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = nil
    }
}

/// Centered placeholder shown when a list/section has no rows yet.
/// Optional SF Symbol + action button — workers wire the latter to a
/// "Log your first meal" / "Add a recipe" / etc. CTA.
struct EmptyState<Action: View>: View {
    let icon: String?
    let title: String
    let message: String?
    let action: Action?

    init(icon: String? = nil,
         title: String,
         message: String? = nil,
         @ViewBuilder action: () -> Action) {
        self.icon = icon
        self.title = title
        self.message = message
        self.action = action()
    }

    var body: some View {
        VStack(spacing: 10) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 28, weight: .regular))
                    .foregroundStyle(Theme.text3)
                    .padding(.bottom, 2)
            }
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.text)
            if let message {
                Text(message)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text2)
                    .multilineTextAlignment(.center)
            }
            if let action { action.padding(.top, 4) }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 20)
    }
}

extension EmptyState where Action == EmptyView {
    init(icon: String? = nil, title: String, message: String? = nil) {
        self.icon = icon
        self.title = title
        self.message = message
        self.action = nil
    }
}

/// Pill-shaped macro chip. Color routes through Theme by `kind` so the
/// calorie/protein/carb/fat color scheme stays consistent across views.
/// Optional unit suffix appended to the value (e.g. "120 g", "540 kcal").
struct MacroChip: View {
    enum Kind { case calories, protein, carbs, fat, fiber, neutral }

    let kind: Kind
    let label: String
    let value: String
    let unit: String?

    init(_ kind: Kind, label: String, value: String, unit: String? = nil) {
        self.kind = kind
        self.label = label
        self.value = value
        self.unit = unit
    }

    /// Convenience: numeric value + sensible default unit per kind.
    init(_ kind: Kind, label: String, amount: Double) {
        self.kind = kind
        self.label = label
        self.value = Self.formatAmount(amount)
        self.unit = Self.defaultUnit(for: kind)
    }

    private var color: Color {
        switch kind {
        case .calories: return Theme.cal
        case .protein:  return Theme.protein
        case .carbs:    return Theme.carbs
        case .fat:      return Theme.fat
        case .fiber:    return Theme.fiber
        case .neutral:  return Theme.text2
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(color.opacity(0.85))
            Text(value + (unit.map { " \($0)" } ?? ""))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.10), in: .rect(cornerRadius: 999))
        .overlay(RoundedRectangle(cornerRadius: 999).stroke(color.opacity(0.25), lineWidth: 1))
    }

    private static func formatAmount(_ v: Double) -> String {
        // Whole numbers for big values (calories), one decimal for grams
        // < 100 to keep chips compact. Mirrors the rounding in the web
        // dashboard's macro tile labels.
        if v >= 100 || v == v.rounded() { return String(Int(v.rounded())) }
        return String(format: "%.1f", v)
    }

    private static func defaultUnit(for kind: Kind) -> String? {
        switch kind {
        case .calories: return "kcal"
        case .protein, .carbs, .fat, .fiber: return "g"
        case .neutral:  return nil
        }
    }
}

/// Generic card wrapper. Same rounded-rect + 1px border + bg2 fill the
/// dashboard sections use. Wrap any content with `Card { … }` instead
/// of repeating the modifier chain.
struct Card<Content: View>: View {
    let padding: CGFloat
    let cornerRadius: CGFloat
    let content: Content

    init(padding: CGFloat = 16,
         cornerRadius: CGFloat = 14,
         @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.cornerRadius = cornerRadius
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bg2, in: .rect(cornerRadius: cornerRadius))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .stroke(Theme.border, lineWidth: 1)
            )
    }
}
