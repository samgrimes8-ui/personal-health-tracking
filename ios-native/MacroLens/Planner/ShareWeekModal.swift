import SwiftUI
import CoreImage.CIFilterBuiltins

#if canImport(UIKit)
import UIKit
#endif

/// Modal for sharing the visible week as a private link. Mints a
/// `meal_plan_shares` row with an embedded snapshot of the week's meals
/// + recipes, then surfaces the public URL with a copy button + QR code.
///
/// Mirrors createMealPlanShare() in src/lib/db.js — same shape of
/// `plan_data`, same `is_active=true`, same short share token.
struct ShareWeekModal: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    let weekStart: String

    @State private var phase: Phase = .ready
    @State private var token: String?
    @State private var label: String = ""
    @State private var errorMsg: String?

    enum Phase { case ready, minting, done }

    private var shareUrl: String? {
        guard let t = token else { return nil }
        return "https://personal-health-tracking.vercel.app/api/share/\(t)"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    summary
                    if phase == .done, let url = shareUrl {
                        linkSection(url: url)
                    } else {
                        actionSection
                    }
                }
                .padding(20)
            }
            .background(Theme.bg)
            .navigationTitle("Share week")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Couldn't create share", isPresented: Binding(
                get: { errorMsg != nil },
                set: { if !$0 { errorMsg = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: { Text(errorMsg ?? "") }
        }
    }

    // MARK: - Subviews

    private var summary: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                Text("Week of \(PlannerDateMath.weekLabel(weekStart))")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text("\(plannedCount) planned meals")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                Text("Anyone with the link can view this plan and copy it into their own planner.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
            }
        }
    }

    private var actionSection: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("Optional label")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.text2)
                TextField("e.g. \"High-protein week\"", text: $label)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await mint() }
                } label: {
                    HStack {
                        if phase == .minting { ProgressView().tint(.white) }
                        Text(phase == .minting ? "Generating link…" : "Generate share link")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.accent, in: .rect(cornerRadius: 10))
                    .foregroundStyle(Theme.accentFG)
                }
                .buttonStyle(.plain)
                .disabled(phase == .minting || plannedCount == 0)
                if plannedCount == 0 {
                    Text("Add at least one planned meal to share this week.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }
            }
        }
    }

    private func linkSection(url: String) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("Share link")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.text2)
                HStack {
                    Text(url)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Theme.text2)
                        .lineLimit(2)
                        .truncationMode(.middle)
                    Spacer()
                    Button {
                        copy(url)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.accent)
                            .padding(8)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy link")
                }
                .padding(10)
                .background(Theme.bg3, in: .rect(cornerRadius: 8))

                if let qr = qrImage(for: url) {
                    HStack {
                        Spacer()
                        Image(uiImage: qr)
                            .interpolation(.none)
                            .resizable()
                            .frame(width: 200, height: 200)
                        Spacer()
                    }
                    .padding(.top, 6)
                }

                ShareLink(item: url) {
                    HStack {
                        Image(systemName: "square.and.arrow.up")
                        Text("Share via…")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Theme.bg2, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                    .foregroundStyle(Theme.text)
                }
            }
        }
    }

    // MARK: - State

    private var plannedCount: Int {
        state.plannerByDay.reduce(0) { $0 + $1.count }
    }

    // MARK: - Actions

    private func mint() async {
        phase = .minting
        do {
            let result = try await PlannerSharingService.createShare(
                weekStart: weekStart,
                label: label.isEmpty ? nil : label
            )
            token = result.shareToken
            phase = .done
        } catch {
            errorMsg = error.localizedDescription
            phase = .ready
        }
    }

    private func copy(_ url: String) {
#if canImport(UIKit)
        UIPasteboard.general.string = url
#endif
    }

    // MARK: - QR

#if canImport(UIKit)
    private func qrImage(for string: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let outputImage = filter.outputImage else { return nil }
        let scaled = outputImage.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
#else
    private func qrImage(for string: String) -> UIImage? { nil }
#endif
}
