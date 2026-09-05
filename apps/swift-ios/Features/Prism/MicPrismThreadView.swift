import SwiftUI

struct MicPrismThreadView: View {
    @Bindable var controller: MicPrismThreadController
    let client: any FeatureClient
    let environmentID: String
    let authorityURL: String?
    let threads: [FeatureThread]
    @State private var selectedID = ""
    @State private var pending = false
    @State private var environmentAccess: AuthSessionState?

    private var canRead: Bool { environmentAccess?.authenticated == true && environmentAccess?.scopes?.contains("orchestration:read") == true }
    private var canOperate: Bool { canRead && environmentAccess?.scopes?.contains("orchestration:operate") == true }
    private var selectedThread: FeatureThread? { canRead ? threads.first { $0.id == selectedID } : nil }
    private var wireID: String? { selectedThread.map { $0.wireID ?? $0.id } }
    private var binding: MicPrismThreadController.Binding? { wireID.flatMap { controller.bindings[environmentID + "/" + $0] } }

    var body: some View {
        Section("Coding threads") {
            Text("Enable Prism for a thread you can already access. Access renews while this app is active and ends when you sign out. Choose Prism routing in the thread before sending.")
                .foregroundStyle(.secondary)
            Picker("Thread", selection: $selectedID) {
                Text("Choose a thread").tag("")
                ForEach(canRead ? threads : []) { Text($0.title).tag($0.id) }
            }.disabled(pending)
            Button(pending ? "Updating…" : binding == nil ? "Enable Prism for thread" : "Disconnect Prism") {
                guard canOperate, let wireID, let authorityURL else { return }
                pending = true
                Task {
                    defer { pending = false }
                    if binding != nil { await controller.disconnect(environmentID: environmentID, threadID: wireID) }
                    else { await controller.connect(environmentID: environmentID, threadID: wireID, authorityURL: authorityURL) }
                }
            }.disabled(pending || !canOperate || wireID == nil || authorityURL == nil)
            if let binding {
                Text("Prism connected. Access expires \(Date(timeIntervalSince1970: binding.expiresAt / 1000).formatted(date: .omitted, time: .shortened)) unless renewed.")
                    .foregroundStyle(.secondary)
            }
            if let message = controller.errorMessage { Text(message).foregroundStyle(.red) }
        }
        .task(id: environmentID) { environmentAccess = try? await client.prismSession(environmentID: environmentID) }
    }
}
