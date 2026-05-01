import SwiftUI
import Charts

/// Native Goals page. v1 covers the read paths + weight check-in (the
/// recurring action). Body-metrics editor + goal-settings editor +
/// scan-upload are deferred to follow-ups; today the user taps
/// "Edit details in browser" if they need to change those.
///
/// Sections, top to bottom:
///   1. Greeting
///   2. Log weight CTA — primary button, opens LogWeightSheet.
///   3. Weekly average weight chart (Swift Charts).
///   4. Body metrics summary — read-only, shows BMR/TDEE.
///   5. Goal settings summary — read-only, shows daily targets.
///   6. History — collapsible weekly / monthly / yearly tiers,
///      DEXA / InBody scans surfaced as standalone callouts in
///      the older tier.
struct GoalsView: View {
    @Environment(AppState.self) private var state
    @State private var showLogSheet = false
    @State private var editingCheckin: CheckinRow?
    @State private var expandedBuckets: Set<String> = []
    @State private var pendingDelete: CheckinRow?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                greeting

                Button {
                    editingCheckin = nil
                    showLogSheet = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "scalemass.fill")
                        Text("Log weight + InBody / DEXA")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(Theme.accentFG)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.accent, in: .rect(cornerRadius: 12))
                }

                if !state.allCheckins.isEmpty {
                    weightChartCard
                }

                bodyMetricsCard
                goalSettingsCard

                if !state.allCheckins.isEmpty {
                    historyCard
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(Theme.bg)
        .refreshable { await state.loadGoals() }
        .task { await state.loadGoals() }
        .navigationTitle("Goals & Body")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showLogSheet) {
            LogWeightSheet(editing: editingCheckin)
                .environment(state)
        }
        .confirmationDialog(
            pendingDelete.map { confirmDeleteTitle(for: $0) } ?? "",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete check-in", role: .destructive) {
                if let target = pendingDelete {
                    Task { try? await state.deleteCheckin(id: target.id) }
                }
                pendingDelete = nil
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("This can't be undone.")
        }
    }

    private func confirmDeleteTitle(for entry: CheckinRow) -> String {
        let raw = entry.scan_date ?? entry.checked_in_at?.prefix(10).description ?? ""
        guard raw.count >= 10 else { return "Delete this check-in?" }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        guard let d = f.date(from: String(raw.prefix(10))) else { return "Delete this check-in?" }
        let out = DateFormatter()
        out.dateFormat = "MMM d, yyyy"
        return "Delete check-in from \(out.string(from: d))?"
    }

    // MARK: - Sections

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Goals & Body")
                .font(.system(size: 26, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
            Text("Track your metrics, log your progress.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.text3)
        }
        .padding(.top, 12)
    }

    private var weightChartCard: some View {
        let weeklies = CheckinHistory.weeklyAverages(from: state.allCheckins, maxWeeks: 12)
        let firstKg = weeklies.first?.avgKg
        let lastKg = weeklies.last?.avgKg
        let deltaLbs: Double? = {
            guard let f = firstKg, let l = lastKg, weeklies.count >= 2 else { return nil }
            return (l - f) * 2.20462
        }()

        // Tight y-axis: zoom into the actual weight band with 15%
        // headroom (or ±1 lb minimum so a perfectly flat week still
        // shows a sensible range). Default `.automatic` left huge gaps
        // — e.g. 0–300 lbs — burying a 212–222 trend near the top.
        let lbsValues = weeklies.map { $0.avgKg * 2.20462 }
        let minLbs = lbsValues.min() ?? 0
        let maxLbs = lbsValues.max() ?? 0
        let pad = max((maxLbs - minLbs) * 0.15, 1.0)
        let yDomain = (minLbs - pad)...(maxLbs + pad)

        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionTitle("Weekly average weight")
                Spacer()
                if let d = deltaLbs {
                    Text("\(d >= 0 ? "+" : "")\(String(format: "%.1f", d)) lbs over \(weeklies.count) weeks")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
            }

            Chart {
                ForEach(Array(weeklies.enumerated()), id: \.offset) { i, w in
                    LineMark(x: .value("Week", i),
                             y: .value("lbs", w.avgKg * 2.20462))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Theme.accent)
                    AreaMark(x: .value("Week", i),
                             y: .value("lbs", w.avgKg * 2.20462))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Theme.accent.opacity(0.18))
                }
            }
            .chartYScale(domain: yDomain)
            .chartXAxis(.hidden)
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
                    AxisGridLine().foregroundStyle(Theme.border)
                    AxisValueLabel().font(.system(size: 10))
                }
            }
            .frame(height: 140)
        }
        .padding(16)
        .background(Theme.bg2, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
    }

    private var bodyMetricsCard: some View {
        let m = state.bodyMetrics
        let lbs = m.weight_kg.map { $0 * 2.20462 }
        // Whole card pushes a full editor — height / age / sex / activity
        // / BF / muscle live one tap away. Summary stays clean & read-only.
        return NavigationLink {
            BodyMetricsDetailView()
                .environment(state)
        } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    sectionTitle("Body metrics")
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.text3)
                }
                HStack(spacing: 8) {
                    statTile("Weight",   lbs.map { "\(String(format: "%.1f", $0)) lbs" } ?? "—",     Theme.text)
                    statTile("Body fat", m.body_fat_pct.map { "\(String(format: "%.1f", $0))%" } ?? "—", Theme.text)
                    statTile("BMR",      m.bmr.map { "\($0) kcal" } ?? "—",                          Theme.text)
                    statTile("TDEE",     m.tdee.map { "\($0) kcal" } ?? "—",                         Theme.text)
                }
            }
            .padding(16)
            .background(Theme.bg2, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var goalSettingsCard: some View {
        let g = state.goals
        let m = state.bodyMetrics
        let directionLabel: String? = {
            switch m.weight_goal {
            case "lose":     return "Lose fat"
            case "gain":     return "Build muscle"
            case "maintain": return "Maintain"
            default:         return nil
            }
        }()
        // Whole card pushes the full Daily Targets editor — keeps the
        // summary clean & read-only at the top level (per UX direction).
        return NavigationLink {
            DailyTargetsDetailView()
                .environment(state)
        } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    sectionTitle("Daily targets")
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.text3)
                }
                HStack(spacing: 8) {
                    statTile("Calories",  g.calories.map { "\($0)" } ?? "—",  Theme.cal)
                    statTile("Protein",   g.protein.map { "\($0)g" } ?? "—",  Theme.protein)
                    statTile("Carbs",     g.carbs.map { "\($0)g" } ?? "—",    Theme.carbs)
                    statTile("Fat",       g.fat.map { "\($0)g" } ?? "—",      Theme.fat)
                }
                if let directionLabel {
                    Text("\(directionLabel) · \(m.pace?.capitalized ?? "Moderate") pace")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }
            }
            .padding(16)
            .background(Theme.bg2, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var historyCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(CheckinHistory.tiers(from: state.allCheckins), id: \.title) { tier in
                VStack(alignment: .leading, spacing: 6) {
                    Text(tier.title)
                        .font(.system(size: 11, weight: .medium))
                        .tracking(1.0)
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)

                    ForEach(tier.buckets) { bucket in
                        // Surface DEXA/InBody scans as standalone rows
                        // ABOVE the bucket — same as the web treatment
                        // we shipped earlier. Lets a 2023 DEXA scan be
                        // one tap away even when buried in a yearly avg.
                        ForEach(bucket.scans) { scan in
                            scanCalloutRow(scan)
                        }
                        bucketRow(bucket)
                    }
                }
            }
        }
    }

    // MARK: - Row factories

    private func bucketRow(_ bucket: CheckinHistory.Bucket) -> some View {
        let expanded = expandedBuckets.contains(bucket.id)
        let weightLbs = bucket.avgWeightKg.map { $0 * 2.20462 }
        return VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    if expanded { expandedBuckets.remove(bucket.id) }
                    else        { expandedBuckets.insert(bucket.id) }
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .frame(width: 14)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(bucket.label)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.text)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(weightLbs.map { String(format: "%.1f lbs", $0) } ?? "—")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.accent)
                        Text("\(bucket.entries.count) reading\(bucket.entries.count == 1 ? "" : "s")")
                            .font(.system(size: 10))
                            .foregroundStyle(Theme.text3)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(spacing: 6) {
                    ForEach(bucket.entries) { entry in
                        entryRow(entry)
                    }
                }
                .padding(.top, 6)
            }
        }
    }

    private func scanCalloutRow(_ scan: CheckinRow) -> some View {
        let scanLabel = scan.scan_type?.uppercased() ?? "SCAN"
        let dateStr = scan.scan_date ?? scan.checked_in_at?.prefix(10).description ?? ""
        let lbs = scan.weight_kg.map { $0 * 2.20462 }
        // Tap pushes a detail view with the full body-comp / segmental
        // / DEXA breakdown — same data the web shows in buildCheckinRow.
        // Edit + delete live inside the detail view so this row stays
        // a clean read-only summary.
        return NavigationLink {
            ScanDetailView(scan: scan)
                .environment(state)
        } label: {
            HStack(spacing: 10) {
                Text("📄")
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(scanLabel) · \(formatDate(dateStr))")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.text)
                    Text(scanSummary(scan, lbs: lbs))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.accentSoft(0.06), in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.2), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func entryRow(_ entry: CheckinRow) -> some View {
        let dateStr = entry.scan_date ?? entry.checked_in_at?.prefix(10).description ?? ""
        let lbs = entry.weight_kg.map { $0 * 2.20462 }
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(formatDate(dateStr))
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.text)
                let extras = [
                    entry.body_fat_pct.map { String(format: "%.1f%% BF", $0) },
                    entry.muscle_mass_kg.map { String(format: "%.1f lbs muscle", $0 * 2.20462) },
                    entry.notes,
                ].compactMap { $0 }.joined(separator: " · ")
                if !extras.isEmpty {
                    Text(extras)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.text3)
                        .lineLimit(2)
                }
            }
            Spacer()
            Text(lbs.map { String(format: "%.1f lbs", $0) } ?? "—")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.text2)
            Button {
                editingCheckin = entry
                showLogSheet = true
            } label: {
                Image(systemName: "pencil")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .frame(width: 26, height: 26)
                    .background(Theme.bg2, in: .rect(cornerRadius: 6))
            }
            Button {
                pendingDelete = entry
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                    .frame(width: 26, height: 26)
                    .background(Theme.bg2, in: .rect(cornerRadius: 6))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Theme.bg2, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
        .padding(.leading, 14)
    }

    // MARK: - Helpers

    private func sectionTitle(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 13, weight: .medium))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    /// Single shared tile used by both the BODY METRICS row and the
    /// DAILY TARGETS row. Equal-width via `.frame(maxWidth: .infinity)`
    /// inside an `HStack(spacing: 8)`. Header + value both clamp to one
    /// line with `.minimumScaleFactor(0.6)` so long values like
    /// "212.5 lbs" / "3216 kcal" don't push neighboring tiles around or
    /// wrap headers like "CALORIES" → "CALORIE / S". Value+unit live on
    /// a single line in the same font (no separate small unit row).
    private func statTile(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.caption)
                .fontWeight(.semibold)
                .tracking(0.5)
                .foregroundStyle(Theme.text3)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(value)
                .font(.title3)
                .fontWeight(.semibold)
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.bg3, in: .rect(cornerRadius: 8))
    }

    private func editInBrowserHint(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(Theme.text3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
    }

    private func formatDate(_ ymd: String) -> String {
        guard ymd.count >= 10 else { return ymd }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        guard let d = f.date(from: String(ymd.prefix(10))) else { return ymd }
        let out = DateFormatter()
        out.dateFormat = "MMM d, yyyy"
        return out.string(from: d)
    }

    private func scanSummary(_ scan: CheckinRow, lbs: Double?) -> String {
        var parts: [String] = []
        if let lbs { parts.append(String(format: "%.1f lbs", lbs)) }
        if let bf = scan.body_fat_pct { parts.append(String(format: "%.1f%% BF", bf)) }
        if let m = scan.muscle_mass_kg { parts.append(String(format: "%.1f lbs muscle", m * 2.20462)) }
        return parts.joined(separator: " · ")
    }
}
