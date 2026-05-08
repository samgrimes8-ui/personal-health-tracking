import SwiftUI

/// Admin-only error log section. Mirrors the `loadErrorLogs` card in
/// the web Account page (src/pages/app.js). Lazy — the user must tap
/// "Load" before we hit the table; auto-cleared after 14 days by the
/// cleanupOldErrors() purge that runs on session start.
struct AdminErrorLogPanel: View {
    @State private var logs: [ErrorLogRow] = []
    @State private var loaded = false
    @State private var loading = false
    @State private var loadError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Error logs")
                        .font(.system(size: 12, weight: .medium))
                        .tracking(1.0)
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                    Text("Auto-cleared after 14 days")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
                Button {
                    Task { await load() }
                } label: {
                    Text(loading ? "Loading…" : (loaded ? "Refresh" : "Load"))
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

            if !loaded && !loading {
                Text("Tap Load to view recent errors across all users.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
            } else if loaded && logs.isEmpty {
                Text("No errors logged 🎉")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
            } else if loading && logs.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().scaleEffect(0.8)
                    Text("Loading…")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(logs.enumerated()), id: \.offset) { idx, log in
                        ErrorLogRowView(log: log)
                        if idx < logs.count - 1 {
                            Divider().background(Theme.border)
                        }
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
    }

    private func load() async {
        loading = true
        loadError = nil
        defer { loading = false }
        do {
            logs = try await DBService.adminErrorLogs()
            loaded = true
        } catch {
            loadError = "Failed: \(error.localizedDescription)"
        }
    }
}

private struct ErrorLogRowView: View {
    let log: ErrorLogRow
    @State private var stackOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(log.error_message ?? "—")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.red)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(formatStamp(log.created_at))
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.text3)
            }
            Text(metaLine())
                .font(.system(size: 10))
                .foregroundStyle(Theme.text3)
            if let stack = log.error_stack, !stack.isEmpty {
                DisclosureGroup(isExpanded: $stackOpen) {
                    Text(String(stack.prefix(500)))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 4)
                } label: {
                    Text("Stack trace")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.text3)
                }
                .tint(Theme.text3)
            }
        }
        .padding(.vertical, 8)
    }

    private func metaLine() -> String {
        var parts: [String] = []
        if let p = log.page, !p.isEmpty { parts.append("page: \(p)") }
        if let c = log.context, !c.isEmpty { parts.append(c) }
        if let uid = log.user_id, !uid.isEmpty {
            parts.append("user: \(uid.prefix(8))…")
        } else {
            parts.append("anonymous")
        }
        return parts.joined(separator: " · ")
    }

    private func formatStamp(_ iso: String?) -> String {
        guard let iso else { return "" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var d = f.date(from: iso)
        if d == nil { f.formatOptions = [.withInternetDateTime]; d = f.date(from: iso) }
        guard let d else { return "" }
        let df = DateFormatter()
        df.dateFormat = "MMM d, h:mm a"
        return df.string(from: d)
    }
}
