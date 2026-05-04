import SwiftUI
import PhotosUI

/// Standalone "import a recipe" sheet. The user pastes recipe text or
/// picks a photo (camera or library); we send it through AnalyzeService
/// (analyzeRecipeText / analyzeRecipePhoto), parse the AnalysisResult,
/// and hand it back to the parent edit form.
///
/// We don't write to the database here — the parent decides whether to
/// merge the result into a draft or replace existing fields. Keeping the
/// flow one-way means the user always sees the extracted result on the
/// Edit screen and can adjust before committing to a save.
struct IngredientExtractView: View {
    let initialName: String
    let initialDescription: String
    let onApply: (AnalysisResult) -> Void
    let onCancel: () -> Void

    @State private var mode: Mode = .text
    @State private var pastedText: String = ""
    @State private var pickedImage: UIImage?
    @State private var photoSelection: PhotosPickerItem?
    @State private var showCamera = false

    @State private var working = false
    @State private var error: String?
    @FocusState private var keyboardFocused: Bool

    enum Mode: String, CaseIterable, Identifiable {
        case text = "Text"
        case photo = "Photo"
        var id: String { rawValue }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Picker("Source", selection: $mode) {
                    ForEach(Mode.allCases) { m in Text(m.rawValue).tag(m) }
                }
                .pickerStyle(.segmented)

                switch mode {
                case .text: textEntry
                case .photo: photoEntry
                }

                if let err = error {
                    Text(err).font(.system(size: 12)).foregroundStyle(Theme.red)
                }

                Button {
                    Task { await runExtraction() }
                } label: {
                    HStack {
                        if working { ProgressView().controlSize(.small) }
                        else { Image(systemName: "sparkles") }
                        Text(working ? "Working..." : "Extract recipe")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundStyle(Theme.accentFG)
                    .background(Theme.accent, in: .rect(cornerRadius: 12))
                }
                .disabled(working || !canSubmit)
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
            .padding(.top, 12)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Import recipe")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { onCancel() }
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                if keyboardFocused {
                    Button("Done") { keyboardFocused = false }
                }
            }
        }
        .sheet(isPresented: $showCamera) {
            CameraSheet(image: $pickedImage)
                .ignoresSafeArea()
        }
        .onChange(of: photoSelection) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self),
                   let img = UIImage(data: data) {
                    pickedImage = img
                }
            }
        }
    }

    private var canSubmit: Bool {
        switch mode {
        case .text: return !pastedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .photo: return pickedImage != nil
        }
    }

    private var textEntry: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text("Paste a recipe")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(1.0).textCase(.uppercase)
                    .foregroundStyle(Theme.text3)
                Text("Paste in ingredients, instructions, or both. AI will extract the structured ingredient list and macros per serving.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text3)
                TextEditor(text: $pastedText)
                    .focused($keyboardFocused)
                    .font(.system(size: 14))
                    .frame(minHeight: 220)
                    .padding(8)
                    .background(Theme.bg3, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.border2, lineWidth: 1))
                    .scrollContentBackground(.hidden)
            }
        }
    }

    private var photoEntry: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Photograph or pick a recipe")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(1.0).textCase(.uppercase)
                    .foregroundStyle(Theme.text3)
                if let img = pickedImage {
                    Image(uiImage: img)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 280)
                        .frame(maxWidth: .infinity)
                        .background(Theme.bg3, in: .rect(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border, lineWidth: 1))
                } else {
                    Text("Cookbook page, recipe card, blog screenshot — anything with the text visible works.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.text3)
                }

                // Camera-first per the app-wide standard: take a photo
                // primary, library a small icon-only secondary.
                HStack(spacing: 8) {
                    Button {
                        showCamera = true
                    } label: {
                        Label("Take photo", systemImage: "camera.fill")
                            .font(.system(size: 13, weight: .medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(Theme.bg3, in: .rect(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    PhotosPicker(selection: $photoSelection,
                                 matching: .images,
                                 photoLibrary: .shared()) {
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.system(size: 16))
                            .foregroundStyle(Theme.text2)
                            .frame(width: 44, height: 38)
                            .background(Theme.bg3, in: .rect(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border2, lineWidth: 1))
                    }
                    .accessibilityLabel("Choose from library")
                }
                if pickedImage != nil {
                    Button {
                        pickedImage = nil
                        photoSelection = nil
                    } label: {
                        Text("Remove image")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.text3)
                    }
                }
            }
        }
    }

    @MainActor
    private func runExtraction() async {
        working = true
        error = nil
        defer { working = false }
        do {
            let result: AnalysisResult
            switch mode {
            case .text:
                let text = pastedText.trimmingCharacters(in: .whitespacesAndNewlines)
                let hint = initialName.trimmingCharacters(in: .whitespaces)
                result = try await AnalyzeService.analyzeRecipeText(text, hint: hint.isEmpty ? nil : hint)
            case .photo:
                guard let img = pickedImage else {
                    error = "Pick a photo first."
                    return
                }
                let resized = img.resizedForAnalysis()
                guard let b64 = resized.jpegBase64() else {
                    error = "Couldn't encode the image."
                    return
                }
                let hint = initialName.trimmingCharacters(in: .whitespaces)
                result = try await AnalyzeService.analyzeRecipePhoto(b64, hint: hint.isEmpty ? nil : hint)
            }
            onApply(result)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
