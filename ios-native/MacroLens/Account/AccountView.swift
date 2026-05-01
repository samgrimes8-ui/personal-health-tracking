import SwiftUI

/// Native Account screen. Mirrors the web `renderAccount` page —
/// profile + appearance + body-metrics summary (read-only; editing
/// lives in the Goals tab) + monthly spend + sign-in methods + sign-out
/// + delete-account flow.
///
/// What's deferred from the web equivalent: provider-channel editor,
/// admin user panel, error log, and identity link / unlink. The
/// "Manage in browser" row inside the Sign-in methods card deep-links
/// the user into the existing web Account page when they need one of
/// those flows. App Store-required surface (delete account) is fully
/// native because the webview path is too easy to bounce out of.
struct AccountView: View {
    @Environment(AppState.self) private var state
    @Environment(AuthManager.self) private var auth
    @AppStorage("macrolens_theme") private var theme: String = "system"

    @State private var showDeleteConfirm = false
    @State private var deleteText: String = ""
    @State private var deleting = false
    @State private var deleteError: String?
    @State private var signOutInProgress = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                profileCard
                appearanceCard
                bodyMetricsCard
                spendingCard
                aiInfoCard
                signInMethodsCard
                sessionCard
                dangerZoneCard
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await state.loadAccount() }
        .task { await state.loadAccount() }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Profile

    private var profileCard: some View {
        let p = state.profile
        let email = sessionEmail
        let displayName = trimmed(p?.provider_name)
            ?? email?.components(separatedBy: "@").first
            ?? "Welcome"
        return Card {
            HStack(spacing: 14) {
                avatar(initialsSource: displayName, urlString: p?.provider_avatar_url)
                VStack(alignment: .leading, spacing: 3) {
                    Text(displayName)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    if let email {
                        Text(email)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.text3)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if let badge = roleBadge {
                        Text(badge.label)
                            .font(.system(size: 11, weight: .semibold))
                            .padding(.horizontal, 9).padding(.vertical, 3)
                            .background(badge.bg, in: .rect(cornerRadius: 999))
                            .foregroundStyle(badge.fg)
                            .padding(.top, 4)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    private func avatar(initialsSource: String, urlString: String?) -> some View {
        let initials = String(initialsSource.prefix(1)).uppercased()
        return ZStack {
            Circle().fill(Theme.accentSoft(0.18))
            if let urlString, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        Text(initials)
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(Theme.accent)
                    }
                }
                .frame(width: 56, height: 56)
                .clipShape(Circle())
            } else {
                Text(initials)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Theme.accent)
            }
        }
        .frame(width: 56, height: 56)
    }

    // MARK: - Appearance

    private var appearanceCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                cardLabel("Appearance")
                HStack(spacing: 8) {
                    themeOption("light", label: "Light", subtitle: "Bright")
                    themeOption("dark", label: "Dark", subtitle: "Original")
                    themeOption("system", label: "System", subtitle: "Follow device")
                }
                Text("Currently using \(currentThemeDescription) mode. Dark mode is wired but the iOS color palette will fully adapt in a future update — until then, expect light surfaces.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func themeOption(_ id: String, label: String, subtitle: String) -> some View {
        let active = theme == id
        return Button {
            theme = id
        } label: {
            VStack(spacing: 6) {
                Text(themeIcon(id)).font(.system(size: 20))
                Text(label)
                    .font(.system(size: 13, weight: active ? .semibold : .medium))
                    .foregroundStyle(active ? Theme.accent : Theme.text2)
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12).padding(.horizontal, 8)
            .background(active ? Theme.bg4 : Theme.bg3, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10)
                .stroke(active ? Theme.accent : Theme.border2, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func themeIcon(_ id: String) -> String {
        switch id {
        case "light": return "☀️"
        case "dark":  return "🌙"
        default:      return "🖥️"
        }
    }

    private var currentThemeDescription: String {
        switch theme {
        case "light": return "light"
        case "dark":  return "dark"
        default:      return "system"
        }
    }

    // MARK: - Body metrics summary (read-only)

    private var bodyMetricsCard: some View {
        let m = state.bodyMetrics
        let lbs = m.weight_kg.map { $0 * 2.20462 }
        let muscleLbs = m.muscle_mass_kg.map { $0 * 2.20462 }
        return Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    cardLabel("Body metrics")
                    Spacer()
                    Text("Edit in Goals →")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                HStack(spacing: 8) {
                    statTile("Weight", lbs.map { String(format: "%.1f lbs", $0) } ?? "—")
                    statTile("Body fat", m.body_fat_pct.map { String(format: "%.1f%%", $0) } ?? "—")
                }
                HStack(spacing: 8) {
                    statTile("Muscle", muscleLbs.map { String(format: "%.1f lbs", $0) } ?? "—")
                    statTile("BMR", m.bmr.map { "\($0) kcal" } ?? "—")
                }
                HStack(spacing: 8) {
                    statTile("TDEE", m.tdee.map { "\($0) kcal" } ?? "—")
                    statTile("Activity", activityLabel(m.activity_level))
                }
                if m.weight_kg == nil {
                    Text("Add your body details on the Goals tab to compute personalized targets.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }
        }
    }

    private func statTile(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            Text(value)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.bg3, in: .rect(cornerRadius: 8))
    }

    private func activityLabel(_ level: String?) -> String {
        switch level {
        case "sedentary":    return "Sedentary"
        case "light":        return "Light"
        case "moderate":     return "Moderate"
        case "active":       return "Active"
        case "very_active":  return "Very active"
        default:             return "—"
        }
    }

    // MARK: - Spending / AI Bucks

    private var spendingCard: some View {
        let s = computeUsageSummary()
        return Card {
            VStack(alignment: .leading, spacing: 12) {
                cardLabel("AI Bucks this month")

                if s.isUnlimited {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(s.requestCount)")
                            .font(.system(size: 32, weight: .bold))
                            .foregroundStyle(Theme.protein)
                        Text("AI actions this month · unlimited")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text3)
                    }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(formatNumber(s.remainingBucks ?? 0))
                            .font(.system(size: 32, weight: .bold))
                            .foregroundStyle(spentColor(pct: s.spentPct))
                        Text("AI Bucks remaining of \(formatNumber(s.limitBucks ?? 0))")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.text3)
                    }
                    progressBar(pct: s.spentPct, color: spentColor(pct: s.spentPct))
                    Text("Resets on the 1st of each month")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }

                if s.role == "free" && s.spentPct >= 70 {
                    Link(destination: webPageURL("upgrade")) {
                        HStack(spacing: 6) {
                            Image(systemName: "bolt.fill")
                            Text("Upgrade to Premium")
                                .font(.system(size: 14, weight: .semibold))
                        }
                        .foregroundStyle(Theme.accentFG)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Theme.accent, in: .rect(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }

                if let override = overrideBanner {
                    overrideRow(override)
                }

                if !s.breakdown.isEmpty {
                    Divider().background(Theme.border).padding(.vertical, 2)
                    breakdownList(s.breakdown)
                }
            }
        }
    }

    private func progressBar(pct: Int, color: Color) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 999).fill(Theme.bg4)
                RoundedRectangle(cornerRadius: 999).fill(color)
                    .frame(width: max(2, geo.size.width * CGFloat(pct) / 100))
            }
        }
        .frame(height: 8)
    }

    private func spentColor(pct: Int) -> Color {
        if pct >= 90 { return Theme.red }
        if pct >= 70 { return Theme.fat }
        return Theme.accent
    }

    private func breakdownList(_ rows: [(feature: String, cost: Double)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Breakdown")
                .font(.system(size: 10))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            ForEach(rows, id: \.feature) { row in
                HStack {
                    Text(featureLabel(row.feature))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text2)
                    Spacer()
                    Text(formatNumber(row.cost * 1000))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.text)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Theme.bg3, in: .rect(cornerRadius: 6))
            }
        }
    }

    private func featureLabel(_ raw: String) -> String {
        switch raw {
        case "analyze-food":   return "Analyze food"
        case "recipe-text":    return "Recipe text"
        case "recipe-photo":   return "Recipe photo"
        case "describe-food":  return "Describe food"
        case "barcode":        return "Barcode"
        default:               return raw.replacingOccurrences(of: "-", with: " ").capitalized
        }
    }

    private struct OverrideBanner {
        let active: Bool
        let expiresLabel: String
    }

    private var overrideBanner: OverrideBanner? {
        guard let p = state.profile, p.spending_limit_usd != nil else { return nil }
        let expiresAt: Date? = {
            guard let raw = p.spending_limit_expires_at else { return nil }
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: raw) { return d }
            f.formatOptions = [.withInternetDateTime]
            return f.date(from: raw)
        }()
        let isActive = expiresAt.map { $0 > Date() } ?? true
        let label: String = {
            guard let expiresAt else { return "Permanent (no expiration)" }
            let df = DateFormatter()
            df.dateStyle = .medium
            return "Expires \(df.string(from: expiresAt))"
        }()
        return OverrideBanner(active: isActive, expiresLabel: label)
    }

    private func overrideRow(_ banner: OverrideBanner) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Custom allotment\(banner.active ? "" : " (expired)")")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.green)
                Text(banner.expiresLabel)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.green.opacity(0.08), in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.green.opacity(0.25), lineWidth: 1))
    }

    // MARK: - AI info

    private var aiInfoCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                cardLabel("AI analysis")
                Text("Food analysis is powered by Claude AI and runs securely on our servers. No API key needed — each action uses a small number of AI Bucks from your monthly allotment above.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Sign-in methods (manage in web for now)

    private var signInMethodsCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                cardLabel("Sign-in methods")
                if let email = sessionEmail {
                    HStack(spacing: 6) {
                        Text("Account email:")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.text3)
                        Text(email)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Link(destination: webPageURL("account")) {
                    HStack(spacing: 10) {
                        Image(systemName: "link")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Manage providers in browser")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.text)
                            Text("Link or unlink Google / Apple")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.text3)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right.square")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text3)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(Theme.bg3, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                }
                .buttonStyle(.plain)
                Text("Native identity linking is coming in a future update — until then, link or unlink sign-in providers from the web app.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Session

    private var sessionCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                cardLabel("Session")
                Button {
                    Task {
                        signOutInProgress = true
                        await auth.signOut()
                        signOutInProgress = false
                    }
                } label: {
                    HStack(spacing: 8) {
                        if signOutInProgress {
                            ProgressView().tint(Theme.red)
                        } else {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                        }
                        Text(signOutInProgress ? "Signing out…" : "Sign out")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .foregroundStyle(Theme.red)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.25), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(signOutInProgress)
            }
        }
    }

    // MARK: - Danger zone

    private var dangerZoneCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Danger zone")
                .font(.system(size: 13, weight: .semibold))
                .tracking(1.0)
                .textCase(.uppercase)
                .foregroundStyle(Theme.red)
            Text("Permanently delete your account. This removes every meal log entry, recipe, food item, planner row, weight check-in, body scan, and meal-plan share you've created — there's no undo. You'll be signed out immediately and won't be able to sign back in with this email.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text2)
                .fixedSize(horizontal: false, vertical: true)

            if !showDeleteConfirm {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { showDeleteConfirm = true }
                } label: {
                    Text("Delete my account")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.red)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.3), lineWidth: 1))
                }
                .buttonStyle(.plain)
            } else {
                deleteConfirmBlock
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.red.opacity(0.25), lineWidth: 1))
    }

    private var deleteConfirmBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 4) {
                Text("Type")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text2)
                Text("DELETE")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Theme.red)
                Text("to confirm:")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text2)
            }
            TextField("DELETE", text: $deleteText)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.system(size: 14, weight: .medium))
                .tracking(2)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg3, in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
            HStack(spacing: 8) {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        showDeleteConfirm = false
                        deleteText = ""
                        deleteError = nil
                    }
                } label: {
                    Text("Cancel")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text2)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Theme.bg3, in: .rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(deleting)

                Button {
                    Task { await performDelete() }
                } label: {
                    HStack {
                        if deleting { ProgressView().tint(.white) }
                        Text(deleting ? "Deleting…" : "Permanently delete")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(canDelete ? Theme.red : Theme.red.opacity(0.4),
                                in: .rect(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(!canDelete || deleting)
            }
            if let deleteError {
                Text(deleteError)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var canDelete: Bool {
        deleteText.trimmingCharacters(in: .whitespacesAndNewlines) == "DELETE"
    }

    private func performDelete() async {
        deleting = true
        deleteError = nil
        defer { deleting = false }
        do {
            try await DBService.deleteMyAccount()
            // Clear local state immediately so the post-signout shell
            // doesn't briefly flash a stale email.
            await auth.signOut()
        } catch {
            deleteError = error.localizedDescription
        }
    }

    // MARK: - Helpers

    private func cardLabel(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 12, weight: .medium))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private var sessionEmail: String? {
        if case .signedIn(let user) = auth.state, let email = user.email, !email.isEmpty {
            return email
        }
        return state.profile?.email
    }

    private func trimmed(_ s: String?) -> String? {
        guard let s else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    private struct RoleBadge {
        let label: String
        let bg: Color
        let fg: Color
    }

    private var roleBadge: RoleBadge? {
        let p = state.profile
        let role = p?.role ?? (p?.is_admin == true ? "admin" : "free")
        switch role {
        case "admin":
            return RoleBadge(label: "Admin", bg: Theme.accent.opacity(0.15), fg: Theme.accent)
        case "provider":
            return RoleBadge(label: "Provider", bg: Theme.green.opacity(0.15), fg: Theme.green)
        case "premium":
            return RoleBadge(label: "Premium", bg: Theme.carbs.opacity(0.15), fg: Theme.carbs)
        case "free":
            return RoleBadge(label: "Free", bg: Theme.bg3, fg: Theme.text3)
        default:
            return RoleBadge(label: role.capitalized, bg: Theme.bg3, fg: Theme.text3)
        }
    }

    private struct UsageSummary {
        let role: String
        let isUnlimited: Bool
        let monthSpent: Double
        let limit: Double?
        let remaining: Double?
        let limitBucks: Double?
        let remainingBucks: Double?
        let spentBucks: Double
        let spentPct: Int
        let requestCount: Int
        let breakdown: [(feature: String, cost: Double)]
    }

    private func computeUsageSummary() -> UsageSummary {
        let p = state.profile
        let role = p?.role ?? (p?.is_admin == true ? "admin" : "free")
        // Same caps as ROLE_CAPS in db.js getUsageSummary().
        let defaultCap: Double? = {
            switch role {
            case "premium":  return 10.00
            case "provider": return 50.00
            case "admin":    return nil
            default:         return 0.10
            }
        }()
        let overrideCap = p?.spending_limit_usd
        let limit = overrideCap ?? defaultCap
        let isUnlimited = limit == nil
        let usage = state.monthTokenUsage
        let monthSpent = usage.reduce(0.0) { $0 + ($1.cost_usd ?? 0) }
        let remaining = limit.map { max(0, $0 - monthSpent) }
        let pct: Int = {
            guard let limit, limit > 0 else { return 0 }
            return Int(min(100, (monthSpent / limit) * 100).rounded())
        }()
        var byFeature: [String: Double] = [:]
        for u in usage {
            let key = u.feature ?? "other"
            byFeature[key, default: 0] += u.cost_usd ?? 0
        }
        let breakdown = byFeature
            .sorted { $0.value > $1.value }
            .map { (feature: $0.key, cost: $0.value) }
        return UsageSummary(
            role: role,
            isUnlimited: isUnlimited,
            monthSpent: monthSpent,
            limit: limit,
            remaining: remaining,
            // Match usdToBucks() in src/lib/pricing.js — floor to a whole
            // buck so we never overstate the user's remaining balance.
            limitBucks: limit.map { floor($0 * 1000) },
            remainingBucks: remaining.map { floor($0 * 1000) },
            spentBucks: floor(monthSpent * 1000),
            spentPct: pct,
            requestCount: usage.count,
            breakdown: breakdown
        )
    }

    private func formatNumber(_ v: Double) -> String {
        let n = Int(v.rounded())
        let f = NumberFormatter()
        f.numberStyle = .decimal
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    private func webPageURL(_ page: String) -> URL {
        var components = URLComponents(url: Config.apiBaseURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "page", value: page)]
        return components.url ?? Config.apiBaseURL
    }
}
