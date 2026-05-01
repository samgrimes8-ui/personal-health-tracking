import SwiftUI

/// Drag-to-reorder editor for the recipe tag filter strip. Mirrors the
/// "Edit list order" patterns iOS uses elsewhere (Reminders / Photos
/// albums): a List with `.editMode = .active` so the leading drag handles
/// are always visible.
///
/// Persists via the parent's `onSave` closure rather than touching DB
/// directly — keeps this view presentation-only and lets the parent
/// reconcile the saved order with its in-memory `savedTagOrder` snapshot
/// without a refetch.
struct TagOrderEditorSheet: View {
    /// Tags in their currently-displayed order. Drives the initial @State
    /// of `order` so the user starts editing exactly what they're seeing
    /// in the filter strip.
    let initialOrder: [String]
    let onSave: ([String]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var order: [String]
    @State private var didChange: Bool = false

    init(initialOrder: [String], onSave: @escaping ([String]) -> Void) {
        self.initialOrder = initialOrder
        self.onSave = onSave
        _order = State(initialValue: initialOrder)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                instructionsBlock
                List {
                    Section {
                        ForEach(order, id: \.self) { tag in
                            HStack(spacing: 8) {
                                Image(systemName: "line.3.horizontal")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.text3)
                                Text(tag)
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.text)
                                Spacer()
                            }
                            .padding(.vertical, 2)
                        }
                        .onMove(perform: move)
                    }
                }
                .listStyle(.plain)
                .environment(\.editMode, .constant(.active))
                .scrollContentBackground(.hidden)
                .background(Theme.bg)
            }
            .background(Theme.bg)
            .navigationTitle("Reorder tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") {
                        onSave(order)
                        dismiss()
                    }
                    .foregroundStyle(Theme.accent)
                    .disabled(!didChange)
                }
            }
        }
    }

    private var instructionsBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Drag to reorder")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.text2)
            Text("New tags you create later will be appended at the end of this list — open this sheet to reposition them.")
                .font(.system(size: 11))
                .foregroundStyle(Theme.text3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    private func move(from source: IndexSet, to destination: Int) {
        order.move(fromOffsets: source, toOffset: destination)
        didChange = true
    }
}
