import SwiftUI

public struct PrismView: View {
    private let client: any FeatureClient
    private let environments: [FeatureEnvironment]
    @Environment(\.scenePhase) private var scenePhase
    @State private var environmentID = ""
    @State private var status: PrismResponse?
    @State private var accounts: [PrismAccount] = []
    @State private var errorMessage: String?
    @State private var pending = false
    @State private var login: PrismResponse?
    @State private var loginEnvironmentID = ""
    @State private var callback = ""
    @State private var loginCheck = 0
    @State private var removing: PrismAccount?

    public init(client: any FeatureClient, environments: [FeatureEnvironment]) {
        self.client = client
        self.environments = environments.filter { $0.isEnabled && $0.prismEnabled == true }
    }

    private var writable: Bool { status?.state == "ready" && status?.role != "replica" && !pending }

    public var body: some View {
        Form {
            Section {
                Picker("Environment", selection: $environmentID) {
                    ForEach(environments) { environment in Text(environment.name).tag(environment.id) }
                }
                .disabled(login != nil || pending)
                LabeledContent("Gateway", value: status?.state ?? "Checking…")
                if let role = status?.role { LabeledContent("Pool role", value: role) }
                if let version = status?.version { LabeledContent("Engine", value: version) }
                if status?.role == "replica" {
                    Text("Manage accounts on the primary environment. This gateway receives serving credentials and cannot refresh them.")
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                if status?.lastSyncError != nil { Text("Account sync needs attention on this environment.").foregroundStyle(.red) }
            } header: { Text("Prism") }

            Section("Accounts") {
                if accounts.isEmpty { Text("No accounts available. Sign in on the primary environment to add one.") }
                ForEach(accounts) { account in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(account.email ?? account.label).font(.headline)
                        Text(account.provider).font(.caption).foregroundStyle(.secondary)
                        if account.lifecycle?.requiresLogin == true {
                            Label("Sign-in required", systemImage: "exclamationmark.circle").foregroundStyle(.red)
                        } else if account.lifecycle?.unavailable == true {
                            Text("Unavailable").foregroundStyle(.secondary)
                        }
                        Text(account.lifecycle?.expiresAt.map { "Token expiry: \($0)" } ?? "Token expiry unknown")
                            .font(.caption).foregroundStyle(.secondary)
                        Toggle("Enabled", isOn: Binding(get: { !account.disabled }, set: { enabled in
                            Task { await change(PrismRequest("/accounts/" + PrismRequest.component(account.id), method: "PATCH", body: ["disabled": .bool(!enabled)])) }
                        })).disabled(!writable)
                        Button("Remove account", role: .destructive) { removing = account }.disabled(!writable)
                    }
                }
            }

            Section("Add account") {
                if let login {
                    if let rawURL = login.authUrl, let url = URL(string: rawURL) {
                        Link("Continue sign-in", destination: url)
                    }
                    if let code = login.userCode { Text(code).font(.body.monospaced()).textSelection(.enabled) }
                    if login.flow != "device" {
                        TextField("Completed callback URL", text: $callback)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Submit callback") { Task { await submitCallback() } }
                            .disabled(callback.isEmpty || pending)
                    }
                    Button("Check sign-in") { loginCheck += 1 }.disabled(pending)
                    Button("Cancel sign-in", role: .cancel) { Task { await cancelLogin() } }.disabled(pending)
                } else {
                    Button("Sign in to Claude") { Task { await beginLogin("anthropic") } }.disabled(!writable)
                    Button("Sign in to ChatGPT / Codex") { Task { await beginLogin("codex") } }.disabled(!writable)
                    Button("Sign in to Grok") { Task { await beginLogin("xai") } }.disabled(!writable)
                }
            }
        }
        .navigationTitle("Prism")
        .refreshable { await load() }
        .task {
            environmentID = environments.first(where: \.isActive)?.id ?? environments.first?.id ?? ""
        }
        .task(id: environmentID + String(describing: scenePhase)) {
            guard scenePhase == .active, !environmentID.isEmpty else { return }
            repeat {
                await load()
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
            } while !Task.isCancelled
        }
        .task(id: (login?.sessionId ?? "") + String(loginCheck)) {
            guard let id = login?.sessionId else { return }
            while !Task.isCancelled {
                do {
                    let result = try await client.prism(PrismRequest("/accounts/login/" + PrismRequest.component(id)), environmentID: loginEnvironmentID)
                    if result.status == "completed" {
                        login = nil; callback = ""; await load(); return
                    }
                    if result.status == "failed" || result.status == "cancelled" {
                        login = nil; callback = ""; errorMessage = "Sign-in did not complete. Try again."; return
                    }
                    try await Task.sleep(for: .seconds(2))
                } catch is CancellationError { return }
                catch { errorMessage = "Could not check sign-in. Retry or cancel the flow."; return }
            }
        }
        .confirmationDialog("Remove this account from the shared pool?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove", role: .destructive) {
                guard let account = removing else { return }
                removing = nil
                Task { await change(PrismRequest("/accounts/" + PrismRequest.component(account.id), method: "DELETE")) }
            }
        }
    }

    @MainActor private func load() async {
        let selected = environmentID
        guard !selected.isEmpty else { return }
        do {
            let nextStatus = try await client.prism(PrismRequest("/status"), environmentID: selected)
            let nextAccounts = nextStatus.state == "ready"
                ? try await client.prism(PrismRequest("/accounts"), environmentID: selected).accounts ?? [] : []
            guard selected == environmentID, !Task.isCancelled else { return }
            status = nextStatus; accounts = nextAccounts; errorMessage = nil
        } catch is CancellationError { }
        catch {
            guard selected == environmentID else { return }
            status = nil; accounts = []; errorMessage = "Prism is unavailable. Check the connection and whether Prism is enabled on this environment."
        }
    }

    @MainActor private func change(_ request: PrismRequest) async {
        guard !pending else { return }
        pending = true
        defer { pending = false }
        do { _ = try await client.prism(request, environmentID: environmentID); await load() }
        catch { errorMessage = "The account change failed. Manage pooled accounts on the primary environment." }
    }

    @MainActor private func beginLogin(_ provider: String) async {
        guard writable else { return }
        pending = true
        defer { pending = false }
        loginEnvironmentID = environmentID
        do { login = try await client.prism(PrismRequest("/accounts/login", method: "POST", body: ["provider": .string(provider)]), environmentID: loginEnvironmentID) }
        catch { errorMessage = "Could not start sign-in. Check the primary gateway." }
    }

    @MainActor private func submitCallback() async {
        guard let id = login?.sessionId else { return }
        pending = true
        defer { pending = false }
        do {
            _ = try await client.prism(PrismRequest("/accounts/login/" + PrismRequest.component(id) + "/callback", method: "POST", body: ["redirectUrl": .string(callback)]), environmentID: loginEnvironmentID)
            callback = ""
        } catch { errorMessage = "The callback was not accepted. Check the sign-in flow and try again." }
    }

    @MainActor private func cancelLogin() async {
        guard let id = login?.sessionId else { return }
        pending = true
        defer { pending = false }
        do {
            _ = try await client.prism(PrismRequest("/accounts/login/" + PrismRequest.component(id), method: "DELETE"), environmentID: loginEnvironmentID)
            login = nil; callback = ""
        } catch { errorMessage = "Could not cancel sign-in. Try again." }
    }
}
