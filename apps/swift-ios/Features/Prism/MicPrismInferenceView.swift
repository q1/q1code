import SwiftUI

/// Inference uses service authorization only; it does not create an environment agent session.
struct MicPrismInferenceView: View {
    let client: any FeatureClient
    let environmentID: String
    let enabled: Bool
    let service: MicPrismDiscoveredService
    let authorityUrl: String?
    @State private var models: [String] = []
    @State private var model = ""
    @State private var prompt = ""
    @State private var response = ""
    @State private var errorMessage: String?
    @State private var loadingModels = false
    @State private var request: Task<Void, Never>?
    @State private var requestGeneration = 0

    var body: some View {
        Section("Try a model") {
            Text("Send a prompt through your paired Prism service. Listed models may be unavailable when provider capacity changes.")
                .foregroundStyle(.secondary)
            Picker("Model", selection: $model) {
                if model.isEmpty { Text("Models unavailable").tag("") }
                ForEach(models, id: \.self) { Text($0).tag($0) }
            }.disabled(!enabled || request != nil || loadingModels)
            Button(loadingModels ? "Loading models…" : "Refresh models") { Task { await loadModels() } }
                .disabled(!enabled || request != nil || loadingModels)
            TextEditor(text: $prompt)
                .frame(minHeight: 100)
                .accessibilityLabel("Prompt for Prism")
                .disabled(!enabled || request != nil)
            if request != nil {
                Text("Waiting for a response…").foregroundStyle(.secondary)
                Button("Cancel request", role: .cancel) { cancel() }
            } else {
                Button("Send to Prism") { send() }
                    .disabled(!enabled || model.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.count > 8000)
            }
            if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
            if !response.isEmpty { Text(response).textSelection(.enabled) }
        }
        .task { await loadModels() }
        .onDisappear { request?.cancel(); request = nil; requestGeneration += 1 }
    }

    @MainActor private func loadModels() async {
        guard enabled, !loadingModels, request == nil else { return }
        loadingModels = true
        defer { loadingModels = false }
        do {
            let result = try await client.prism(PrismRequest("/models", expectedService: service, identityAuthorityUrl: authorityUrl), environmentID: environmentID)
            guard !Task.isCancelled else { return }
            models = result.models ?? []
            if !models.contains(model) { model = models.first ?? "" }
            errorMessage = models.isEmpty ? "No models are listed by this Prism service." : nil
        } catch is CancellationError { }
        catch { report(error) }
    }

    @MainActor private func send() {
        guard enabled, request == nil, !model.isEmpty, !prompt.isEmpty, prompt.count <= 8000 else { return }
        response = ""; errorMessage = nil
        requestGeneration += 1
        let generation = requestGeneration
        let input = PrismRequest("/chat", method: "POST", body: ["model": .string(model), "prompt": .string(prompt)], expectedService: service, identityAuthorityUrl: authorityUrl)
        request = Task {
            defer { if generation == requestGeneration { request = nil } }
            do {
                let result = try await client.prism(input, environmentID: environmentID)
                guard !Task.isCancelled, generation == requestGeneration else { return }
                response = result.response ?? ""
            } catch is CancellationError { }
            catch {
                guard !Task.isCancelled, generation == requestGeneration else { return }
                report(error)
            }
        }
    }

    @MainActor private func cancel() {
        request?.cancel(); request = nil; requestGeneration += 1
        errorMessage = "Request cancelled."
    }

    @MainActor private func report(_ error: any Error) {
        if let error = error as? MicPrismError {
            errorMessage = error.localizedDescription
            if case .denied = error { response = ""; models = []; model = "" }
            if case .signedOut = error { response = ""; models = []; model = "" }
        } else { errorMessage = "Prism could not complete the request. Refresh access and try again." }
    }
}
