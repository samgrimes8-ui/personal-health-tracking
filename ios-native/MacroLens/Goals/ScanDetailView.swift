import SwiftUI

/// Full body-composition breakdown for one InBody / DEXA checkin row.
/// Mirrors buildCheckinRow at src/pages/app.js:4110-4213 — same four
/// sections in the same order, same field set, same units rules.
///
/// Pushed from the Goals page's scan callout row (tap → detail). Keeps
/// the high-level Goals tab clean while making the long-tail scan data
/// (segmental lean per limb, BMR/BMI/InBody score, DEXA T/Z scores,
/// android-vs-gynoid fat distribution, VAT) one tap away.
struct ScanDetailView: View {
    let scan: CheckinRow
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @State private var showEdit = false
    @State private var confirmDelete = false

    private var dateLabel: String {
        let raw = scan.scan_date ?? scan.checked_in_at?.prefix(10).description ?? ""
        guard raw.count >= 10 else { return raw }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        guard let d = f.date(from: String(raw.prefix(10))) else { return raw }
        let out = DateFormatter()
        out.dateFormat = "MMM d, yyyy"
        return out.string(from: d)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                headerCard
                if !coreMetrics.isEmpty { coreCard }
                if scan.hasExtended { bodyCompositionCard }
                if scan.hasSegmental { segmentalCard }
                if scan.hasDexa { dexaCard }
                if let notes = scan.notes, !notes.isEmpty { notesCard(notes) }
                actionRow
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
            .padding(.top, 6)
        }
        .background(Theme.bg)
        .navigationTitle(scan.scan_type?.uppercased() ?? "Scan")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showEdit) {
            LogWeightSheet(editing: scan)
                .environment(state)
        }
        .confirmationDialog("Delete this scan?",
                            isPresented: $confirmDelete,
                            titleVisibility: .visible) {
            Button("Delete \(scan.scan_type?.uppercased() ?? "scan") · \(dateLabel)", role: .destructive) {
                Task {
                    try? await state.deleteCheckin(id: scan.id)
                    dismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes the scan + every extracted metric (body comp, segmental, DEXA). Can't be undone.")
        }
    }

    // MARK: - Sections

    private var headerCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text.image.fill")
                    .foregroundStyle(Theme.accent)
                Text(scan.scan_type?.uppercased() ?? "SCAN")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(0.8)
                    .foregroundStyle(Theme.accent)
            }
            Text(dateLabel)
                .font(.system(size: 22, weight: .semibold, design: .serif))
                .foregroundStyle(Theme.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var coreCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Headline")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(coreMetrics, id: \.label) { item in
                    metricCell(item.value, item.label, item.color)
                }
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var bodyCompositionCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Body composition")
            FlowPills(pills: bodyCompositionPills)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var segmentalCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Segmental lean mass")
            HStack(spacing: 6) {
                segmentalCell("L Arm", scan.seg_lean_left_arm_kg, scan.seg_lean_left_arm_pct)
                segmentalCell("R Arm", scan.seg_lean_right_arm_kg, scan.seg_lean_right_arm_pct)
                segmentalCell("Trunk", scan.seg_lean_trunk_kg, scan.seg_lean_trunk_pct)
                segmentalCell("L Leg", scan.seg_lean_left_leg_kg, scan.seg_lean_left_leg_pct)
                segmentalCell("R Leg", scan.seg_lean_right_leg_kg, scan.seg_lean_right_leg_pct)
            }
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var dexaCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("DEXA analysis")
            FlowPills(pills: dexaPills)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private func notesCard(_ notes: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Notes")
            Text(notes)
                .font(.system(size: 13))
                .foregroundStyle(Theme.text2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(Theme.bg2, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            Button {
                showEdit = true
            } label: {
                Label("Edit", systemImage: "pencil")
                    .font(.system(size: 13, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.bg3, in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    .foregroundStyle(Theme.text2)
            }
            .buttonStyle(.plain)
            Button {
                confirmDelete = true
            } label: {
                Label("Delete", systemImage: "trash")
                    .font(.system(size: 13, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.red.opacity(0.25), lineWidth: 1))
                    .foregroundStyle(Theme.red)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Data shaping

    private struct MetricItem {
        let value: String
        let label: String
        let color: Color
    }

    /// Headline numbers — same six the web shows in its core grid.
    private var coreMetrics: [MetricItem] {
        var items: [MetricItem] = []
        if let w = scan.weight_kg {
            items.append(.init(value: String(format: "%.1f lbs", w * 2.20462), label: "Weight", color: Theme.accent))
        }
        if let bf = scan.body_fat_pct {
            items.append(.init(value: String(format: "%g%%", bf), label: "Body fat", color: Theme.fat))
        }
        if let m = scan.muscle_mass_kg {
            items.append(.init(value: String(format: "%.1f lbs", m * 2.20462), label: "Muscle", color: Theme.protein))
        }
        if let lean = scan.lean_body_mass_kg {
            items.append(.init(value: String(format: "%.1f lbs", lean * 2.20462), label: "Lean mass", color: Theme.protein))
        }
        if let bmr = scan.bmr {
            items.append(.init(value: "\(bmr) kcal", label: "BMR", color: Theme.carbs))
        }
        if let bmi = scan.bmi {
            items.append(.init(value: String(format: "%g", bmi), label: "BMI", color: Theme.text2))
        }
        return items
    }

    private var bodyCompositionPills: [(String, String)] {
        var pills: [(String, String)] = []
        if let v = scan.total_body_water_kg { pills.append(("TBW", String(format: "%.1f lbs", v * 2.20462))) }
        if let v = scan.body_fat_mass_kg    { pills.append(("Fat mass", String(format: "%.1f lbs", v * 2.20462))) }
        if let v = scan.visceral_fat_level  { pills.append(("Visceral fat", "Level \(formatNumeric(v))")) }
        if let v = scan.ecw_tbw_ratio       { pills.append(("ECW/TBW", String(format: "%g", v))) }
        if let v = scan.inbody_score        { pills.append(("InBody score", "\(v)/100")) }
        if let v = scan.smi                 { pills.append(("SMI", String(format: "%g kg/m²", v))) }
        if let v = scan.protein_kg          { pills.append(("Protein", String(format: "%.1f lbs", v * 2.20462))) }
        if let v = scan.minerals_kg         { pills.append(("Minerals", String(format: "%.1f lbs", v * 2.20462))) }
        if let v = scan.body_cell_mass_kg   { pills.append(("BCM", String(format: "%.1f lbs", v * 2.20462))) }
        return pills
    }

    private var dexaPills: [(String, String)] {
        var pills: [(String, String)] = []
        if let v = scan.bone_mineral_density { pills.append(("BMD", String(format: "%g g/cm²", v))) }
        if let v = scan.t_score              { pills.append(("T-score", String(format: "%g", v))) }
        if let v = scan.z_score              { pills.append(("Z-score", String(format: "%g", v))) }
        if let v = scan.android_fat_pct      { pills.append(("Android fat", String(format: "%g%%", v))) }
        if let v = scan.gynoid_fat_pct       { pills.append(("Gynoid fat", String(format: "%g%%", v))) }
        if let v = scan.android_gynoid_ratio { pills.append(("A/G ratio", String(format: "%g", v))) }
        if let v = scan.vat_area_cm2         { pills.append(("VAT", String(format: "%g cm²", v))) }
        return pills
    }

    // MARK: - Building blocks

    private func sectionTitle(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 11, weight: .medium))
            .tracking(1.0)
            .textCase(.uppercase)
            .foregroundStyle(Theme.text3)
    }

    private func metricCell(_ value: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Theme.bg3, in: .rect(cornerRadius: 8))
    }

    private func segmentalCell(_ label: String, _ kg: Double?, _ pct: Double?) -> some View {
        VStack(spacing: 3) {
            Text(kg.map { String(format: "%.1f", $0 * 2.20462) } ?? "—")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text(pct.map { String(format: "%g%%", $0) } ?? "")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(pct.map { $0 >= 100 ? Theme.protein : Theme.fat } ?? Theme.text3)
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Theme.bg3, in: .rect(cornerRadius: 6))
    }

    private func formatNumeric(_ v: Double) -> String {
        if v == v.rounded() { return String(Int(v)) }
        return String(format: "%g", v)
    }
}

/// Wrapping pill row used for the Body Composition + DEXA blocks.
/// Each pill shows label + value separated by a colon. Reuses the
/// project's existing FlowLayout (Recipes/RecipeDetailView.swift).
struct FlowPills: View {
    let pills: [(String, String)]

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(Array(pills.enumerated()), id: \.offset) { _, p in
                pill(p.0, p.1)
            }
        }
    }

    private func pill(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label + ":")
                .foregroundStyle(Theme.text3)
            Text(value)
                .foregroundStyle(Theme.text)
                .fontWeight(.medium)
        }
        .font(.system(size: 11))
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Theme.bg3, in: .rect(cornerRadius: 4))
    }
}
