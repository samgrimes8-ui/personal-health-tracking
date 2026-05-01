import SwiftUI

/// Modal for adding one component to a food. Three modes:
///   - Describe: free-text the component, AnalyzeService.describeFood
///     pulls macros via Claude.
///   - Barcode: live camera scan via BarcodeScannerView, plus a manual
///     UPC entry field; both routes hit /api/barcode through
///     BarcodeService.lookup.
///   - Manual: type the macros directly. Bypasses any AI/network spend.
///
/// On a successful look-up the macros render in a preview card with
/// editable qty + unit fields. The macros there are already AI-scaled
/// to the looked-up serving — adjusting qty re-multiplies the totals
/// (mirrors updatePendingQty / updatePendingUnit in src/pages/app.js).
struct AddComponentSheet: View {
    enum Mode: String, CaseIterable {
        case describe, barcode, manual
        var label: String {
            switch self {
            case .describe: return "Describe"
            case .barcode:  return "Barcode"
            case .manual:   return "Manual"
            }
        }
        var icon: String {
            switch self {
            case .describe: return "text.bubble"
            case .barcode:  return "barcode.viewfinder"
            case .manual:   return "square.and.pencil"
            }
        }
    }

    let onAdd: (FoodComponent) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var mode: Mode = .describe

    // Describe input
    @State private var describeText: String = ""

    // Barcode inputs
    @State private var manualUPC: String = ""
    @State private var showLiveScanner: Bool = false
    @State private var scannerStatus: String?

    // Manual entry inputs
    @State private var manualName: String = ""
    @State private var manualCal: String = ""
    @State private var manualProtein: String = ""
    @State private var manualCarbs: String = ""
    @State private var manualFat: String = ""
    @State private var manualFiber: String = ""
    @State private var manualSugar: String = ""

    // Pending result (post-lookup, pre-add)
    @State private var pending: PendingResult?
    @State private var pendingQty: String = "1"
    @State private var pendingUnit: String = "serving"

    @State private var working: Bool = false
    @State private var errorMsg: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    modeBar
                    Group {
                        switch mode {
                        case .describe: describeSection
                        case .barcode:  barcodeSection
                        case .manual:   manualSection
                        }
                    }

                    if let pending {
                        resultCard(pending)
                    }

                    if let errorMsg {
                        Text(errorMsg)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.red)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.red.opacity(0.08), in: .rect(cornerRadius: 8))
                    }

                    actionRow
                }
                .padding(20)
            }
            .background(Theme.bg)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Add component")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.text3)
                }
            }
            .fullScreenCover(isPresented: $showLiveScanner) {
                BarcodeScannerView(
                    onDetect: { code in
                        showLiveScanner = false
                        manualUPC = code
                        scannerStatus = "Scanned: \(code)"
                        Task { await lookupBarcode(code) }
                    },
                    onCancel: { showLiveScanner = false }
                )
            }
        }
        .presentationDetents([.large])
    }

    // MARK: - Mode bar

    private var modeBar: some View {
        HStack(spacing: 6) {
            ForEach(Mode.allCases, id: \.self) { m in
                Button {
                    mode = m
                    pending = nil
                    errorMsg = nil
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: m.icon)
                            .font(.system(size: 16))
                        Text(m.label)
                            .font(.system(size: 11, weight: .medium))
                    }
                    .foregroundStyle(mode == m ? Theme.accent : Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(mode == m ? Theme.accentSoft() : Theme.bg3, in: .rect(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(mode == m ? Theme.accent.opacity(0.35) : Theme.border, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Describe mode

    private var describeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Describe what's in the component — AI will estimate the macros.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
            TextField("e.g. 2 cups whole milk, 1 scoop vanilla whey…", text: $describeText, axis: .vertical)
                .lineLimit(2...4)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                .font(.system(size: 14))
                .foregroundStyle(Theme.text)

            Button {
                Task { await lookupDescribe() }
            } label: {
                HStack {
                    if working { ProgressView().tint(Theme.accentFG) }
                    Text(working ? "Looking up…" : "Look up with AI")
                        .font(.system(size: 14, weight: .semibold))
                }
                .foregroundStyle(Theme.accentFG)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(canLookupDescribe ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 10))
            }
            .disabled(!canLookupDescribe || working)
        }
    }

    private var canLookupDescribe: Bool {
        !describeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Barcode mode

    private var barcodeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                showLiveScanner = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "camera.viewfinder")
                        .font(.system(size: 16))
                    Text("Open camera to scan")
                        .font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Theme.bg3, in: .rect(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Theme.border2, style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                )
            }

            Text("Or type the barcode number")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)

            HStack(spacing: 8) {
                TextField("e.g. 0123456789012", text: $manualUPC)
                    .keyboardType(.numberPad)
                    .textInputField()
                Button {
                    Task { await lookupBarcode(manualUPC) }
                } label: {
                    Text("Look up")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accentFG)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(canLookupBarcode ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 10))
                }
                .disabled(!canLookupBarcode || working)
            }

            if let scannerStatus {
                Text(scannerStatus)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
        }
    }

    private var canLookupBarcode: Bool {
        manualUPC.filter(\.isNumber).count >= 6
    }

    // MARK: - Manual mode

    private var manualSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Type a component manually — no AI, no spend.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.text3)
            TextField("Component name", text: $manualName)
                .textInputField()
            HStack(spacing: 8) {
                manualMacro("Calories", text: $manualCal)
                manualMacro("Protein (g)", text: $manualProtein)
            }
            HStack(spacing: 8) {
                manualMacro("Carbs (g)", text: $manualCarbs)
                manualMacro("Fat (g)", text: $manualFat)
            }
            HStack(spacing: 8) {
                manualMacro("Fiber (g)", text: $manualFiber)
                manualMacro("Sugar (g)", text: $manualSugar)
            }
            Button {
                stageManual()
            } label: {
                Text("Use these macros")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.accentFG)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(canStageManual ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 10))
            }
            .disabled(!canStageManual)
        }
    }

    private func manualMacro(_ label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(Theme.text3)
            TextField("0", text: text)
                .keyboardType(.decimalPad)
                .textInputField()
        }
        .frame(maxWidth: .infinity)
    }

    private var canStageManual: Bool {
        !manualName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func stageManual() {
        let p = PendingResult(
            name: manualName.trimmingCharacters(in: .whitespaces),
            calories: Double(manualCal) ?? 0,
            protein:  Double(manualProtein) ?? 0,
            carbs:    Double(manualCarbs) ?? 0,
            fat:      Double(manualFat) ?? 0,
            fiber:    Double(manualFiber) ?? 0,
            sugar:    Double(manualSugar) ?? 0
        )
        pending = p
        pendingQty = "1"
        pendingUnit = "serving"
    }

    // MARK: - Result card

    @ViewBuilder
    private func resultCard(_ p: PendingResult) -> some View {
        let qty = Double(pendingQty) ?? 1
        let scaled = p.scaled(by: qty)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(p.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Spacer()
                Text("\(Int(scaled.calories.rounded())) kcal · P\(Int(scaled.protein.rounded())) C\(Int(scaled.carbs.rounded())) F\(Int(scaled.fat.rounded()))")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.text3)
            }
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Qty")
                        .font(.system(size: 10))
                        .tracking(0.8)
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                    TextField("1", text: $pendingQty)
                        .keyboardType(.decimalPad)
                        .textInputField()
                }
                .frame(width: 100)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Unit")
                        .font(.system(size: 10))
                        .tracking(0.8)
                        .textCase(.uppercase)
                        .foregroundStyle(Theme.text3)
                    TextField("serving", text: $pendingUnit)
                        .textInputField()
                }
            }
        }
        .padding(12)
        .background(Theme.bg3, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.25), lineWidth: 1))
    }

    // MARK: - Actions

    private var actionRow: some View {
        Button {
            confirmAdd()
        } label: {
            Text("Add component ✓")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.accentFG)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(pending != nil ? Theme.accent : Theme.bg4, in: .rect(cornerRadius: 12))
        }
        .disabled(pending == nil)
    }

    private func confirmAdd() {
        guard let p = pending else { return }
        let qty = max(0.0, Double(pendingQty) ?? 1)
        let scaled = p.scaled(by: qty)
        let comp = FoodComponent(
            name: p.name,
            qty: qty,
            unit: pendingUnit.trimmingCharacters(in: .whitespaces).isEmpty ? "serving" : pendingUnit.trimmingCharacters(in: .whitespaces),
            calories: scaled.calories,
            protein: scaled.protein,
            carbs: scaled.carbs,
            fat: scaled.fat,
            fiber: scaled.fiber,
            sugar: scaled.sugar
        )
        onAdd(comp)
    }

    private func lookupDescribe() async {
        let q = describeText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        working = true
        errorMsg = nil
        defer { working = false }
        do {
            let result = try await AnalyzeService.describeFood(q)
            pending = PendingResult.from(result)
            pendingQty = "1"
            pendingUnit = "serving"
        } catch {
            errorMsg = error.localizedDescription
        }
    }

    private func lookupBarcode(_ raw: String) async {
        let digits = raw.filter(\.isNumber)
        guard !digits.isEmpty else { return }
        working = true
        errorMsg = nil
        scannerStatus = "Looking up \(digits)…"
        defer { working = false }
        do {
            if let result = try await BarcodeService.lookup(digits) {
                pending = PendingResult.from(result)
                pendingQty = "1"
                pendingUnit = "serving"
                scannerStatus = nil
            } else {
                scannerStatus = nil
                errorMsg = "Barcode \(digits) not in Open Food Facts. Try Describe or Manual."
            }
        } catch {
            scannerStatus = nil
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Shared compact text-input style

private extension View {
    func textInputField() -> some View {
        self
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg3, in: .rect(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
            .font(.system(size: 14))
            .foregroundStyle(Theme.text)
    }
}

// MARK: - Pending result

struct PendingResult {
    var name: String
    var calories: Double
    var protein: Double
    var carbs: Double
    var fat: Double
    var fiber: Double
    var sugar: Double

    static func from(_ r: AnalysisResult) -> PendingResult {
        PendingResult(
            name: r.name,
            calories: r.calories,
            protein: r.protein,
            carbs: r.carbs,
            fat: r.fat,
            fiber: r.fiber ?? 0,
            sugar: r.sugar ?? 0
        )
    }

    func scaled(by qty: Double) -> PendingResult {
        PendingResult(
            name: name,
            calories: calories * qty,
            protein: protein * qty,
            carbs: carbs * qty,
            fat: fat * qty,
            fiber: fiber * qty,
            sugar: sugar * qty
        )
    }
}
