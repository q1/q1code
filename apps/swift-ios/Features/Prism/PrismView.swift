import SwiftUI
import ClerkKit
import ClerkKitUI

public struct PrismView: View {
    private let client: any FeatureClient
    private let environments: [FeatureEnvironment]
    @Environment(\.scenePhase) private var scenePhase
    @State private var environmentID = ""
    @State private var status: PrismResponse?
    @State private var session: AuthSessionState?
    @State private var loadedEnvironmentID = ""
    @State private var stale = false
    @State private var strategy = ""
    @State private var accounts: [PrismAccount] = []
    @State private var errorMessage: String?
    @State private var pending = false
    @State private var login: PrismResponse?
    @State private var loginEnvironmentID = ""
    @State private var callback = ""
    @State private var loginCheck = 0
    @State private var removing: PrismAccount?
    @State private var confirmingRestart = false
    @State private var identityConfiguration = MicPrismIdentityConfiguration.disabled
    @State private var identity: PrismResponse?
    @State private var showingIdentitySignIn = false
    @State private var loadGeneration = 0

    public init(client: any FeatureClient, environments: [FeatureEnvironment]) {
        self.client = client
        self.environments = environments.filter { $0.isEnabled && $0.prismEnabled == true }
    }

    private var connected: Bool {
        guard let environment = environments.first(where: { $0.id == environmentID }) else { return false }
        return environment.connectionState == nil || environment.connectionState == .connected
    }

    private var currentStatus: PrismResponse? { loadedEnvironmentID == environmentID ? status : nil }
    private var access: PrismAccess { PrismAccess(status: currentStatus, stale: stale, connected: connected, session: loadedEnvironmentID == environmentID ? session : nil) }
    private var writable: Bool { access.accounts && !pending }
    private var identityController: T3ConnectController? {
        guard let controller = (client as? any T3ConnectCapable)?.t3ConnectController,
              let expectedKey = identityConfiguration.clerkPublishableKey,
              controller.resolution.configuration?.clerkPublishableKey == expectedKey else { return nil }
        return controller
    }

    public var body: some View {
        Form {
            if identityConfiguration.enabled {
                Section("mic.sc account") {
                    if let controller = identityController, controller.clerk != nil {
                        if let knownIdentity = identity {
                            if let subject = knownIdentity.session?.subject { Text(subject) }
                            if let service = knownIdentity.discovery?.service { LabeledContent("Paired Prism", value: service.label) }
                            Button("Sign out of mic.sc") {
                                identity = nil; status = nil; accounts = []; stale = true
                                Task { await (client as? any T3ConnectCapable)?.signOutT3Connect() }
                            }
                        } else {
                            Button("Sign in with mic.sc") { showingIdentitySignIn = true }
                        }
                        Text("Prism access keeps the permissions of your environment connections separate.")
                            .foregroundStyle(.secondary)
                    } else {
                        Text("This build uses another sign-in service. Use a build configured for this mic.sc account service, or open q1code in a browser.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Section {
                Picker("Environment", selection: $environmentID) {
                    ForEach(environments) { environment in Text(environment.name).tag(environment.id) }
                }
                .disabled(login != nil || pending)
                LabeledContent("Gateway", value: stale || !connected ? "Offline" : currentStatus?.state ?? "Checking…")
                if (stale || !connected), let state = currentStatus?.state {
                    Text("Last known state: \(state). Management is unavailable until the connection recovers.")
                        .foregroundStyle(.secondary)
                }
                if let role = currentStatus?.role { LabeledContent("Pool role", value: role) }
                if let version = currentStatus?.version { LabeledContent("Engine", value: version) }
                if currentStatus?.role == "replica" {
                    Text("Manage accounts on the primary environment. This gateway receives serving credentials and cannot refresh them.")
                }
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                if currentStatus?.lastSyncError != nil { Text("Account sync needs attention on this environment.").foregroundStyle(.red) }
            } header: { Text("Prism") }

            if access.accountDetails {
                Section("Gateway settings") {
                    Toggle("Show pooled accounts on Usage → Limits", isOn: Binding(get: { currentStatus?.usageSource ?? true }, set: { enabled in
                        Task { await change(PrismRequest("/usage-source", method: "PUT", body: ["enabled": .bool(enabled)])) }
                    })).disabled(!access.configure || pending)
                    Button("Restart") { confirmingRestart = true }.disabled(!access.configure || pending)
                    Picker("Routing strategy", selection: Binding(get: { strategy }, set: { value in
                        Task { await change(PrismRequest("/routing", method: "PUT", body: ["strategy": .string(value)])) }
                    })) {
                        Text("Unknown").tag("")
                        Text("Round robin").tag("round-robin")
                        Text("Weighted round robin").tag("weighted-round-robin")
                        Text("Fill first").tag("fill-first")
                    }.disabled(!access.routing || pending || strategy.isEmpty)
                }

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
                                .disabled(!writable)
                            Button("Submit callback") { Task { await submitCallback() } }
                                .disabled(callback.isEmpty || !writable)
                        }
                        Button("Check sign-in") { loginCheck += 1 }.disabled(!writable)
                        Button("Cancel sign-in", role: .cancel) { Task { await cancelLogin() } }.disabled(!writable)
                    } else {
                        Button("Sign in to Claude") { Task { await beginLogin("anthropic") } }.disabled(!writable)
                        Button("Sign in to ChatGPT / Codex") { Task { await beginLogin("codex") } }.disabled(!writable)
                        Button("Sign in to Grok") { Task { await beginLogin("xai") } }.disabled(!writable)
                    }
                }
            } else {
                Section("Prism access") {
                    Text("Pooled account details and management require administrative access.")
                }
            }
        }
        .navigationTitle("Prism")
        .onChange(of: environmentID) { _, _ in
            loadGeneration += 1
            identityConfiguration = .disabled; identity = nil; session = nil
            status = nil; accounts = []; strategy = ""; stale = false
        }
        .onReceive(NotificationCenter.default.publisher(for: .t3ConnectSessionChanged)) { _ in
            loadGeneration += 1
            identity = nil; status = nil; accounts = []; stale = true
            Task { await load() }
        }
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
        .task(id: (login?.sessionId ?? "") + String(loginCheck) + String(access.accounts) + String(describing: scenePhase)) {
            guard access.accounts, scenePhase == .active, let id = login?.sessionId else { return }
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
        .confirmationDialog("Restart Prism? Requests will fail until it is ready again.", isPresented: $confirmingRestart) {
            Button("Restart", role: .destructive) { Task { await change(PrismRequest("/restart", method: "POST")) } }
        }
        .sheet(isPresented: $showingIdentitySignIn, onDismiss: { Task { await load() } }) {
            if let clerk = identityController?.clerk {
                AuthView(mode: .signInOrUp).environment(clerk)
            }
        }
    }

    @MainActor private func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        let selected = environmentID
        guard !selected.isEmpty else { return }
        do {
            let config = try await client.prismIdentityConfiguration(environmentID: selected)
            guard selected == environmentID, generation == loadGeneration, !Task.isCancelled else { return }
            identityConfiguration = config
            if config.enabled {
                let nextIdentity = try await client.prism(PrismRequest("/identity/access"), environmentID: selected)
                guard selected == environmentID, generation == loadGeneration, !Task.isCancelled else { return }
                identity = nextIdentity
            } else { identity = nil }
            let nextStatus = try await client.prism(PrismRequest("/status"), environmentID: selected)
            let nextSession = try? await client.prismSession(environmentID: selected)
            guard selected == environmentID, generation == loadGeneration, !Task.isCancelled else { return }
            if loadedEnvironmentID != selected { accounts = []; strategy = "" }
            loadedEnvironmentID = selected
            status = nextStatus; session = nextSession; stale = false; errorMessage = nil
        } catch is CancellationError { }
        catch {
            guard selected == environmentID, generation == loadGeneration else { return }
            stale = true; errorMessage = "Prism is unavailable. Check the connection and whether Prism is enabled on this environment."
            return
        }
        guard selected == environmentID, generation == loadGeneration, access.accountDetails, currentStatus?.state == "ready", !Task.isCancelled else { return }
        do {
            let nextAccounts = try await client.prism(PrismRequest("/accounts"), environmentID: selected).accounts ?? []
            let nextRouting = try await client.prism(PrismRequest("/routing"), environmentID: selected).strategy ?? ""
            guard selected == environmentID, generation == loadGeneration, !Task.isCancelled else { return }
            accounts = nextAccounts; strategy = nextRouting
        } catch is CancellationError { }
        catch {
            guard selected == environmentID, generation == loadGeneration else { return }
            errorMessage = "Could not load Prism management details. Check your account permissions."
        }
    }

    @MainActor private func change(_ request: PrismRequest) async {
        let allowed = request.path == "/restart" || request.path == "/usage-source"
            ? access.configure : request.path == "/routing" ? access.routing : access.accounts
        guard allowed, !pending else { return }
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
        guard writable, let id = login?.sessionId else { return }
        pending = true
        defer { pending = false }
        do {
            _ = try await client.prism(PrismRequest("/accounts/login/" + PrismRequest.component(id) + "/callback", method: "POST", body: ["redirectUrl": .string(callback)]), environmentID: loginEnvironmentID)
            callback = ""
        } catch { errorMessage = "The callback was not accepted. Check the sign-in flow and try again." }
    }

    @MainActor private func cancelLogin() async {
        guard writable, let id = login?.sessionId else { return }
        pending = true
        defer { pending = false }
        do {
            _ = try await client.prism(PrismRequest("/accounts/login/" + PrismRequest.component(id), method: "DELETE"), environmentID: loginEnvironmentID)
            login = nil; callback = ""
        } catch { errorMessage = "Could not cancel sign-in. Try again." }
    }
}
