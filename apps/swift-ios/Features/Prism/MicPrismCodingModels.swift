import SwiftUI

/// Coding views use aggregate eligibility only. The gateway remains authoritative for each request.
@MainActor @Observable
final class MicPrismCodingModels {
    private(set) var identityEnabled: Bool?
    private(set) var models: [MicPrismModelAvailability] = []
    private(set) var error: String?
    private(set) var observed = false
    private var scope = ""

    func observe(client: any FeatureClient, environmentID: String, identityID: String) async {
        let key = environmentID + ":" + identityID
        if scope != key {
            scope = key; models = []; error = nil; observed = false; identityEnabled = nil
        }
        repeat {
            do {
                let configuration = try await client.prismIdentityConfiguration(environmentID: environmentID)
                guard !Task.isCancelled, scope == key else { return }
                identityEnabled = configuration.enabled
                guard configuration.enabled else { models = []; error = nil; return }
                let result = try await client.prism(PrismRequest("/availability", identityAuthorityUrl: configuration.authorityUrl), environmentID: environmentID)
                guard !Task.isCancelled, scope == key else { return }
                guard let availability = result.modelAvailability else { throw MicPrismError.invalidResponse }
                models = availability; error = nil; observed = true
            } catch is CancellationError { return }
            catch {
                guard !Task.isCancelled, scope == key else { return }
                self.error = (error as? MicPrismError)?.localizedDescription ?? "Prism availability could not be checked."
            }
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
        } while !Task.isCancelled
    }

    static func isPooled(providerID: String, providers: [FeatureProvider], selection: FeatureSelection?) -> Bool {
        guard let provider = providers.first(where: { $0.id == providerID }),
              ["codex", "claudeAgent"].contains(provider.driver) else { return false }
        return selection?.providerID != providerID || selection?.options.first(where: { $0.id == "prism-route" })?.value != .string("direct")
    }

    func reason(providerID: String, modelID: String, providers: [FeatureProvider], selection: FeatureSelection?) -> String? {
        guard identityEnabled != false, Self.isPooled(providerID: providerID, providers: providers, selection: selection) else { return nil }
        if let error { return error }
        guard observed else { return "Checking Prism eligibility…" }
        guard let model = models.first(where: { $0.id == modelID }), model.available else { return "Model unavailable from Prism." }
        return nil
    }
}

struct MicPrismCodingStatus: View {
    let client: any FeatureClient
    let environment: FeatureEnvironment
    let observation: MicPrismCodingModels
    let providers: [FeatureProvider]
    let selection: FeatureSelection?
    @State private var showingDetails = false

    private var selected: MicPrismModelAvailability? { observation.models.first { $0.id == selection?.modelID } }
    private var label: String {
        if observation.error != nil { return "Offline" }
        if let selected { return "\(selected.available ? "Ready" : "Unavailable") · \(selected.usableAccounts)" }
        return observation.observed ? "Unavailable · 0" : "Checking…"
    }

    var body: some View {
        if observation.identityEnabled != false, let selection,
           MicPrismCodingModels.isPooled(providerID: selection.providerID, providers: providers, selection: selection) {
            Button("Prism · " + label) { showingDetails = true }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .sheet(isPresented: $showingDetails) {
                    NavigationStack {
                        Form {
                            Text(observation.error ?? selected?.summary ?? "The selected model has no verified Prism eligibility.")
                            ForEach(selected?.warnings ?? [], id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")) }
                            NavigationLink("Accounts and settings") { PrismView(client: client, environments: [environment]) }
                        }
                        .navigationTitle("Prism")
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingDetails = false } } }
                    }
                }
        }
    }
}
