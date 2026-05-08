import SwiftUI

/// Admin-only user-management section that appears in the Account tab
/// when the signed-in user has role == "admin" (or the legacy is_admin
/// flag). Mirrors the web admin panel rendered by loadAdminPanel in
/// src/pages/app.js — summary metrics + per-user role/suspend control.
struct AdminUserPanel: View {
    @State private var users: [AdminUserRow] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var actingOn: String?
    @State private var actionError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Admin panel — all users")
                    .font(.system(size: 12, weight: .medium))
                    .tracking(1.0)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.text3)
                Spacer()
                Button {
                    Task { await load() }
                } label: {
                    Text(loading ? "Refreshing…" : "Refresh")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
                .disabled(loading)
            }

            if let loadError {
                Text(loadError)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.red)
            }

            if loading && users.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().scaleEffect(0.8)
                    Text("Loading users…")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }
            }

            if !users.isEmpty {
                summaryGrid
                Text("All users — \(users.count) total")
                    .font(.system(size: 10))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(Theme.text3)
                VStack(spacing: 8) {
                    ForEach(users) { user in
                        userRow(user)
                    }
                }
                if let actionError {
                    Text(actionError)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.red)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
        .task { await load() }
    }

    // MARK: summary tiles

    private var summaryGrid: some View {
        // Same four stats as web: total, active, spend, AI tokens.
        let totalUsers = users.count
        let activeUsers = users.filter { $0.account_status == "active" }.count
        let spendMonth = users.reduce(0.0) { $0 + ($1.spent_this_month_usd ?? 0) }
        let spendAllTime = users.reduce(0.0) { $0 + ($1.total_spent_usd ?? 0) }
        let logsMonth = users.reduce(0) { $0 + ($1.log_entries_this_month ?? 0) }
        let tokensMonth = users.reduce(0) { $0 + ($1.tokens_this_month ?? 0) }
        let newThisMonth = users.filter { isThisMonth($0.created_at) }.count
        let cards: [(label: String, value: String, sub: String, color: Color)] = [
            ("Total users", "\(totalUsers)", "\(newThisMonth) new this month", Theme.accent),
            ("Active", "\(activeUsers)", "\(totalUsers - activeUsers) inactive", Theme.protein),
            ("Spend this month", String(format: "$%.3f", spendMonth),
                String(format: "$%.3f all time", spendAllTime), Theme.fat),
            ("AI tokens (month)", "\(tokensMonth/1000)k",
                "\(logsMonth) meals logged", Theme.carbs),
        ]
        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            ForEach(cards, id: \.label) { card in
                VStack(alignment: .leading, spacing: 4) {
                    Text(card.label)
                        .font(.system(size: 10))
                        .tracking(0.8)
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                    Text(card.value)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(card.color)
                    Text(card.sub)
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.text3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Theme.bg3, in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
            }
        }
    }

    // MARK: user row

    private func userRow(_ u: AdminUserRow) -> some View {
        let isNew = isThisMonth(u.created_at)
        let spentPct: Double = {
            let cap = u.spending_limit_usd ?? 10
            guard cap > 0 else { return 0 }
            return min(100, ((u.spent_this_month_usd ?? 0) / cap) * 100)
        }()
        let spendBarColor: Color = spentPct > 80 ? Theme.red
            : (spentPct > 50 ? Theme.fat : Theme.protein)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(u.email ?? "—")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.text)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if isNew {
                            Text("NEW")
                                .font(.system(size: 9, weight: .bold))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.green.opacity(0.2), in: .rect(cornerRadius: 4))
                                .foregroundStyle(Theme.green)
                        }
                    }
                    Text(metaLine(u))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                roleMenu(for: u)
                suspendButton(for: u)
            }
            HStack(spacing: 8) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2).fill(Theme.bg4)
                        RoundedRectangle(cornerRadius: 2).fill(spendBarColor)
                            .frame(width: max(2, geo.size.width * CGFloat(spentPct) / 100))
                    }
                }
                .frame(height: 4)
                Text(spendLine(u))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
        }
        .padding(12)
        .background(Theme.bg3, in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1))
    }

    private func roleMenu(for u: AdminUserRow) -> some View {
        let current = u.role ?? "free"
        return Menu {
            ForEach(["admin", "provider", "premium", "free"], id: \.self) { role in
                Button {
                    Task { await setRole(userId: u.user_id, role: role) }
                } label: {
                    if role == current {
                        Label(roleLabel(role), systemImage: "checkmark")
                    } else {
                        Text(roleLabel(role))
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(roleLabel(current))
                    .font(.system(size: 11, weight: .medium))
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
            }
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.bg2, in: .rect(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border2, lineWidth: 1))
        }
        .disabled(actingOn == u.user_id)
    }

    private func suspendButton(for u: AdminUserRow) -> some View {
        let active = u.account_status == "active"
        return Button {
            Task { await toggleSuspend(u) }
        } label: {
            Image(systemName: active ? "pause.fill" : "play.fill")
                .font(.system(size: 11))
                .foregroundStyle(active ? Theme.text3 : Theme.protein)
                .frame(width: 28, height: 24)
                .background(Theme.bg2, in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border2, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(actingOn == u.user_id)
    }

    // MARK: actions

    private func load() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            users = try await DBService.adminUserOverview()
        } catch {
            loadError = "Failed: \(error.localizedDescription)"
        }
    }

    private func setRole(userId: String, role: String) async {
        actingOn = userId
        actionError = nil
        defer { actingOn = nil }
        do {
            try await DBService.adminSetUserRole(userId: userId, role: role)
            await load()
        } catch {
            actionError = "Couldn't change role: \(error.localizedDescription)"
        }
    }

    private func toggleSuspend(_ u: AdminUserRow) async {
        actingOn = u.user_id
        actionError = nil
        defer { actingOn = nil }
        let next = (u.account_status == "active") ? "suspended" : "active"
        do {
            try await DBService.adminSetAccountStatus(userId: u.user_id, status: next)
            await load()
        } catch {
            actionError = "Couldn't update status: \(error.localizedDescription)"
        }
    }

    // MARK: helpers

    private func roleLabel(_ r: String) -> String {
        switch r {
        case "admin":    return "Admin"
        case "provider": return "Provider"
        case "premium":  return "Premium"
        case "free":     return "Free"
        default:         return r.capitalized
        }
    }

    private func isThisMonth(_ iso: String?) -> Bool {
        guard let iso else { return false }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: iso)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: iso) }
        guard let d else { return false }
        let cal = Calendar.current
        return cal.component(.year, from: d) == cal.component(.year, from: Date())
            && cal.component(.month, from: d) == cal.component(.month, from: Date())
    }

    private func formatShortDate(_ iso: String?) -> String {
        guard let iso else { return "?" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: iso)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: iso) }
        guard let d else { return "?" }
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df.string(from: d)
    }

    private func metaLine(_ u: AdminUserRow) -> String {
        "Joined \(formatShortDate(u.created_at)) · "
            + "Last \(formatShortDate(u.last_active)) · "
            + "\(u.log_entries_total ?? 0) meals · "
            + "\(u.recipe_count ?? 0) recipes"
    }

    private func spendLine(_ u: AdminUserRow) -> String {
        let spent = u.spent_this_month_usd ?? 0
        let cap = u.spending_limit_usd ?? 10
        let req = u.requests_this_month ?? 0
        let tk = (u.tokens_this_month ?? 0) / 1000
        return String(format: "$%.3f / $%.0f · %d req · %dk tok", spent, cap, req, tk)
    }
}
