import SwiftUI

/// Account-level host recovery remains available when the selected gateway is offline.
struct MicPrismHostAdministrationView: View {
    let client: any FeatureClient
    let environmentID: String
    let authorityURL: String
    let identity: PrismResponse
    let refresh: @MainActor () async -> Void
    @State private var hostOrigin = ""
    @State private var hostLabel = ""
    @State private var publicKey = ""
    @State private var signature = ""
    @State private var existingInstanceID = ""
    @State private var challenge: MicPrismPairingChallenge?
    @State private var pairedInstanceID: String?
    @State private var pairedRevision: Int?
    @State private var confirmation: Confirmation?
    @State private var operation: Task<Void, Never>?
    @State private var generation = 0
    @State private var message: String?
    @State private var failed = false

    private struct Confirmation: Identifiable {
        let id = UUID()
        let title: String
        let action: String
        let destructive: Bool
        let selectionRevision: Int?
        let request: PrismRequest
    }
    private var allowed: Bool {
        identity.session?.permissions.contains("prism:instances:manage") == true &&
        (identity.session?.authorizationExpiresAt ?? 0) > Date().timeIntervalSince1970 * 1000
    }
    private var busy: Bool { operation != nil }
    private var targetID: String? { pairedInstanceID ?? identity.discovery?.service?.id }
    private var targetRevision: Int? { pairedRevision ?? identity.discovery?.service?.pairingRevision }

    var body: some View {
        Section("Prism host") {
            if let service = identity.discovery?.service {
                LabeledContent("Selected host", value: service.label)
                Text(service.apiUrl).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            } else {
                Text("No host selected. Pair a prepared host or select an existing paired host to enable inference.")
                    .foregroundStyle(.secondary)
            }
            if let targetID {
                if pairedInstanceID != nil { LabeledContent("Paired host", value: targetID) }
                if let revision = identity.discovery?.selectionRevision {
                    Button("Use this host for inference") {
                        confirmation = Confirmation(title: "Use Prism host \(targetID)?", action: "Use host", destructive: false, selectionRevision: identity.discovery?.selectionRevision,
                            request: PrismRequest("/identity/instances/select", method: "POST", body: [
                                "serviceInstanceId": .string(targetID), "expectedSelectionRevision": .number(Double(revision)),
                            ], identityAuthorityUrl: authorityURL))
                    }.disabled(!allowed || busy)
                }
                if let revision = targetRevision {
                    Button("Revoke this host", role: .destructive) {
                        confirmation = Confirmation(title: "Revoke Prism host \(targetID)? New requests will be rejected and active streams will stop when access is rechecked.", action: "Revoke host", destructive: true, selectionRevision: identity.discovery?.selectionRevision,
                            request: PrismRequest("/identity/instances/revoke", method: "POST", body: [
                                "serviceInstanceId": .string(targetID), "expectedPairingRevision": .number(Double(revision)),
                            ], identityAuthorityUrl: authorityURL))
                    }.disabled(!allowed || busy)
                }
            }
            if let revision = identity.discovery?.selectionRevision {
                DisclosureGroup("Use an existing paired host") {
                    TextField("Paired service instance ID", text: $existingInstanceID)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(busy)
                    Button("Select existing host") {
                        confirmation = Confirmation(title: "Use Prism host \(existingInstanceID) for inference?", action: "Use host", destructive: false, selectionRevision: identity.discovery?.selectionRevision,
                            request: PrismRequest("/identity/instances/select", method: "POST", body: [
                                "serviceInstanceId": .string(existingInstanceID), "expectedSelectionRevision": .number(Double(revision)),
                            ], identityAuthorityUrl: authorityURL))
                    }.disabled(!allowed || busy || existingInstanceID.isEmpty)
                }
            }
            DisclosureGroup("Pair a prepared host") {
                Text("The host must already serve its pairing proof at the approved origin. Create a challenge, sign its exact text with the host key, and paste the signature below. Pairing does not select the host automatically.")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("Host name", text: $hostLabel)
                    .disabled(busy || challenge != nil)
                TextField("Host origin (https://…)", text: $hostOrigin)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .disabled(busy || challenge != nil)
                TextField("Host public key", text: $publicKey, axis: .vertical)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .disabled(busy || challenge != nil)
                if let challenge {
                    Text(challenge.challenge).font(.caption.monospaced()).textSelection(.enabled)
                    ShareLink("Share exact challenge", item: challenge.challenge)
                    Text("Expires \(Date(timeIntervalSince1970: challenge.expiresAt / 1000).formatted(date: .omitted, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                    TextField("Host signature", text: $signature, axis: .vertical)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(busy)
                    Button("Complete pairing") {
                        run(PrismRequest("/identity/pairings/complete", method: "POST", body: ["challengeId": .string(challenge.challengeId), "signature": .string(signature)], identityAuthorityUrl: authorityURL))
                    }.disabled(!allowed || busy || signature.isEmpty || challenge.expiresAt <= Date().timeIntervalSince1970 * 1000)
                    Button("Discard challenge", role: .cancel) { self.challenge = nil; signature = "" }
                        .disabled(busy)
                } else {
                    Button("Create pairing challenge") {
                        run(PrismRequest("/identity/pairings/start", method: "POST", body: ["origin": .string(hostOrigin), "publicKey": .string(publicKey), "label": .string(hostLabel)], identityAuthorityUrl: authorityURL))
                    }.disabled(!allowed || busy || hostOrigin.isEmpty || publicKey.isEmpty || hostLabel.isEmpty)
                }
            }
            if busy { Text("Verifying host change…").foregroundStyle(.secondary) }
            if let message { Text(message).foregroundStyle(failed ? Color.red : Color.secondary) }
        }
        .confirmationDialog(confirmation?.title ?? "Confirm host change", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
            if let confirmation {
                Button(confirmation.action, role: confirmation.destructive ? .destructive : nil) {
                    self.confirmation = nil
                    run(confirmation.request, expectedSelectionRevision: confirmation.selectionRevision)
                }
            }
        }
        .onChange(of: identity.discovery?.selectionRevision) { _, _ in
            if confirmation != nil {
                confirmation = nil; failed = true
                message = "The selected host changed. Review the current host before continuing."
            }
        }
        .onChange(of: identity.discovery?.service?.pairingRevision) { _, _ in
            if confirmation != nil {
                confirmation = nil; failed = true
                message = "The pairing changed. Review the current host before continuing."
            }
        }
        .onDisappear {
            generation += 1
            operation?.cancel(); operation = nil; confirmation = nil; challenge = nil; signature = ""
        }
    }

    @MainActor private func run(_ request: PrismRequest, expectedSelectionRevision: Int? = nil) {
        guard allowed, !busy else { return }
        if let expectedSelectionRevision, identity.discovery?.selectionRevision != expectedSelectionRevision {
            failed = true; message = "The selected host changed. Refresh access before continuing."
            return
        }
        generation += 1
        let current = generation
        message = nil; failed = false
        operation = Task {
            defer { if generation == current { operation = nil } }
            do {
                let boundRequest = PrismRequest(request.path, method: request.method, body: request.body, identityAuthorityUrl: authorityURL, expectedSelectionRevision: expectedSelectionRevision)
                let result = try await client.prism(boundRequest, environmentID: environmentID)
                guard !Task.isCancelled, generation == current else { return }
                switch request.path {
                case "/identity/pairings/start": challenge = result.pairingChallenge
                case "/identity/pairings/complete":
                    pairedInstanceID = result.serviceInstanceId; pairedRevision = result.pairingRevision
                    challenge = nil; signature = ""
                    message = "Host paired. Choose Use this host for inference to select it."
                case "/identity/instances/select":
                    pairedInstanceID = nil; pairedRevision = nil; existingInstanceID = ""
                    message = "Host selected. Refreshing access…"
                    await refresh()
                case "/identity/instances/revoke":
                    pairedInstanceID = nil; pairedRevision = nil; challenge = nil; signature = ""
                    message = "Host revoked. Refreshing access…"
                    await refresh()
                default: break
                }
            } catch is CancellationError { }
            catch {
                guard !Task.isCancelled, generation == current else { return }
                failed = true
                message = (error as? MicPrismError)?.localizedDescription ?? "The host change could not be confirmed. Refresh access before trying again."
                if let error = error as? MicPrismError {
                    switch error {
                    case .signedOut, .denied, .pairingConflict:
                        challenge = nil; signature = ""; pairedInstanceID = nil; pairedRevision = nil
                        await refresh()
                    default: break
                    }
                }
            }
        }
    }
}
