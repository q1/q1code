import SwiftUI

/// Account and settings mutations remain bound to the viewed host and its last observed revision.
struct MicPrismManagementView: View {
    let client: any FeatureClient
    let environmentID: String
    let authorityURL: String
    let service: MicPrismDiscoveredService
    let permissions: [String]
    let enabled: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var accounts: PrismResponse?
    @State private var settings: PrismResponse?
    @State private var availability: PrismResponse?
    @State private var login: PrismResponse?
    @State private var loginStatus: PrismResponse?
    @State private var callback = ""
    @State private var loading = false
    @State private var operation: Task<Void, Never>?
    @State private var errorMessage: String?
    @State private var notice: String?
    @State private var removing: PrismAccount?
    @State private var removalRevision: String?
    private var pending: Bool { loading || operation != nil }
    private var writable: Bool { enabled && !pending && errorMessage == nil }
    private var accountWrite: Bool { writable && permissions.contains("prism:accounts:write") }
    private var loginPending: Bool { login != nil && (loginStatus == nil || loginStatus?.status == "pending") }

    var body: some View {
        Group {
            Section("Prism management") {
                Text(enabled && errorMessage == nil ? "Manage \(service.label). Changes are confirmed by the host." : "Last known state. Changes are paused until Prism reconnects.")
                    .foregroundStyle(.secondary)
                if let errorMessage { Text(errorMessage).foregroundStyle(.red) }
                if let notice { Text(notice).foregroundStyle(.secondary) }
                Button(loading ? "Refreshing…" : "Refresh state") { Task { await load() } }
                    .disabled(!enabled || pending)
            }
            if let models = availability?.modelAvailability {
                Section("Model availability") {
                    if models.isEmpty { Text("No models are configured.").foregroundStyle(.secondary) }
                    ForEach(models) { model in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.id)
                            Text(model.summary).font(.caption).foregroundStyle(.secondary)
                            ForEach(model.warnings, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            if let pool = accounts?.accounts, let revision = accounts?.settingsRevision {
                Section("Provider accounts") {
                    if pool.isEmpty { Text("Add a subscription to start the pool.").foregroundStyle(.secondary) }
                    ForEach(pool) { account in
                        MicPrismAccountEditor(account: account, revision: revision, enabled: accountWrite, save: { patch, expected in
                            write("/accounts/" + PrismRequest.component(account.id), method: "PATCH", extra: ["patch": .object(patch)], revision: expected)
                        }, remove: { removing = account; removalRevision = revision })
                    }
                }
                if permissions.contains("prism:accounts:write") {
                    Section("Add or reconnect account") {
                        Text("Provider sign-in is saved on \(service.label).").foregroundStyle(.secondary)
                        if let login {
                            Text(loginStatus?.status == "completed" ? "Sign-in saved. Check account health and model availability before using it." : loginStatus?.status == "failed" ? "Sign-in failed. Start another login to reconnect." : loginStatus?.status == "cancelled" ? "Sign-in cancelled." : "Complete the provider sign-in and check its result here.")
                            if loginPending {
                                if let code = login.userCode { Text(code).font(.title3.monospaced()).textSelection(.enabled) }
                                if let url = login.authUrl.flatMap(URL.init(string:)) {
                                    Button("Open provider sign-in") { openURL(url) }.disabled(!accountWrite)
                                }
                                if login.flow == "redirect" {
                                    TextField("Completed callback URL", text: $callback)
                                        .textInputAutocapitalization(.never).autocorrectionDisabled().disabled(!accountWrite)
                                    Button("Complete sign-in") { changeLogin(cancel: false) }
                                        .disabled(!accountWrite || callback.isEmpty)
                                }
                                Button("Cancel sign-in", role: .cancel) { changeLogin(cancel: true) }.disabled(!accountWrite)
                            } else {
                                Button("Add another account") { self.login = nil; loginStatus = nil; callback = "" }.disabled(pending)
                            }
                        } else {
                            Button("Add Claude") { startLogin("anthropic", revision: revision) }.disabled(!accountWrite)
                            Button("Add ChatGPT / Codex") { startLogin("codex", revision: revision) }.disabled(!accountWrite)
                            Button("Add Grok") { startLogin("xai", revision: revision) }.disabled(!accountWrite)
                        }
                    }
                }
            }
            if let value = settings?.settings, let revision = settings?.settingsRevision {
                MicPrismSettingsEditor(settings: value, revision: revision, enabled: writable && permissions.contains("prism:settings:write")) { draft, expected in
                    write("/settings", method: "PUT", extra: ["settings": draft.json], revision: expected)
                }
            }
        }
        .task(id: String(enabled) + String(describing: scenePhase)) {
            guard enabled, scenePhase == .active else { return }
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(loginPending ? 2 : 10))
            }
        }
        .confirmationDialog("Remove this provider account? Sign in again to restore it.", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove account", role: .destructive) {
                guard let account = removing, let revision = removalRevision else { return }
                removing = nil
                write("/accounts/" + PrismRequest.component(account.id), method: "DELETE", extra: [:], revision: revision)
            }
        }
        .onChange(of: enabled) { _, value in if !value { operation?.cancel(); operation = nil } }
        .onChange(of: permissions) { _, next in
            operation?.cancel(); operation = nil
            if !next.contains("prism:accounts:read") { accounts = nil }
            if !next.contains("prism:settings:read") { settings = nil }
            if !next.contains("prism:inference") { availability = nil }
        }
        .onDisappear { operation?.cancel(); operation = nil; callback = "" }
    }

    private func request(_ path: String, method: String = "GET", body: [String: JSONValue]? = nil) -> PrismRequest {
        PrismRequest(path, method: method, body: body, expectedService: service, identityAuthorityUrl: authorityURL)
    }
    private func envelope(_ revision: String, extra: [String: JSONValue]) -> [String: JSONValue] {
        ["operationId": .string(UUID().uuidString), "serviceInstanceId": .string(service.id), "pairingRevision": .number(Double(service.pairingRevision)), "expectedSettingsRevision": .string(revision)].merging(extra) { _, new in new }
    }
    @MainActor private func load(afterWrite: Bool = false) async {
        guard enabled, !loading, operation == nil || afterWrite else { return }
        loading = true
        defer { loading = false }
        do {
            if permissions.contains("prism:accounts:read") {
                let value = try await client.prism(request("/accounts"), environmentID: environmentID)
                try Task.checkCancellation(); accounts = value
            }
            if permissions.contains("prism:settings:read") {
                let value = try await client.prism(request("/settings"), environmentID: environmentID)
                try Task.checkCancellation(); settings = value
            }
            if permissions.contains("prism:inference") {
                let value = try await client.prism(request("/availability"), environmentID: environmentID)
                try Task.checkCancellation(); availability = value
            }
            if let sessionID = login?.sessionId, permissions.contains("prism:accounts:write") {
                let value = try await client.prism(request("/accounts/login/" + PrismRequest.component(sessionID)), environmentID: environmentID)
                try Task.checkCancellation(); loginStatus = value
            }
            errorMessage = nil
        } catch is CancellationError { }
        catch { report(error) }
    }
    @MainActor private func write(_ path: String, method: String, extra: [String: JSONValue], revision: String) {
        let permission = path == "/settings" ? "prism:settings:write" : "prism:accounts:write"
        guard writable, permissions.contains(permission) else { return }
        notice = nil
        let input = request(path, method: method, body: envelope(revision, extra: extra))
        operation = Task {
            defer { operation = nil }
            do {
                let result = try await client.prism(input, environmentID: environmentID)
                try Task.checkCancellation()
                if path == "/accounts/login" { login = result; loginStatus = nil }
                else { notice = "Confirmed by Prism." }
                await load(afterWrite: true)
            } catch is CancellationError { }
            catch { report(error) }
        }
    }
    @MainActor private func startLogin(_ provider: String, revision: String) {
        callback = ""
        write("/accounts/login", method: "POST", extra: ["provider": .string(provider)], revision: revision)
    }
    @MainActor private func changeLogin(cancel: Bool) {
        guard accountWrite, let sessionID = login?.sessionId else { return }
        let callbackURL = callback
        callback = ""; notice = nil
        operation = Task {
            defer { operation = nil }
            do {
                let path = "/accounts/login/" + PrismRequest.component(sessionID)
                let latest = try await client.prism(request(path), environmentID: environmentID)
                try Task.checkCancellation()
                guard latest.status == "pending", let revision = latest.settingsRevision else { loginStatus = latest; return }
                let input = request(path + (cancel ? "" : "/callback"), method: cancel ? "DELETE" : "POST", body: envelope(revision, extra: cancel ? [:] : ["redirectUrl": .string(callbackURL)]))
                let result = try await client.prism(input, environmentID: environmentID)
                try Task.checkCancellation(); loginStatus = result
                await load(afterWrite: true)
            } catch is CancellationError { }
            catch { report(error) }
        }
    }
    @MainActor private func report(_ error: any Error) {
        errorMessage = (error as? MicPrismError)?.localizedDescription ?? "Prism could not confirm the request. Refresh its state before trying again."
        if let failure = error as? MicPrismError {
            switch failure {
            case .signedOut, .denied: accounts = nil; settings = nil; availability = nil; login = nil; loginStatus = nil
            default: break
            }
        }
    }
}

private struct MicPrismAccountEditor: View {
    let account: PrismAccount
    let revision: String
    let enabled: Bool
    let save: ([String: JSONValue], String) -> Void
    let remove: () -> Void
    @State private var active: Bool
    @State private var reserve: String
    @State private var weight: Int
    @State private var expected: String
    @State private var dirty = false
    init(account: PrismAccount, revision: String, enabled: Bool, save: @escaping ([String: JSONValue], String) -> Void, remove: @escaping () -> Void) {
        self.account = account; self.revision = revision; self.enabled = enabled; self.save = save; self.remove = remove
        _active = State(initialValue: !account.disabled); _reserve = State(initialValue: account.reservePercent.map { String($0) } ?? "")
        _weight = State(initialValue: account.weight ?? 1); _expected = State(initialValue: revision)
    }
    private var valid: Bool { reserve.isEmpty || Double(reserve).map { (0...100).contains($0) } == true }
    var body: some View {
        DisclosureGroup(account.email ?? account.label) {
            Text(account.provider + (account.lifecycle?.requiresLogin == true ? " · Sign-in required" : "")).font(.caption).foregroundStyle(.secondary)
            Text(account.eligibility?.available == true ? "Eligible to serve" : account.eligibility?.reason?.replacingOccurrences(of: "_", with: " ") ?? "Serving eligibility is unverified.").font(.caption).foregroundStyle(.secondary)
            ForEach(account.quotaWindows ?? []) { window in
                Text("\(window.id): \((window.utilization * 100).formatted(.number.precision(.fractionLength(1))))% used").font(.caption).foregroundStyle(.secondary)
            }
            Toggle("Enabled", isOn: Binding(get: { active }, set: { active = $0; dirty = true })).disabled(!enabled)
            TextField("Soft reserve % (empty turns it off)", text: Binding(get: { reserve }, set: { reserve = $0; dirty = true })).keyboardType(.decimalPad).disabled(!enabled)
            Stepper("Weight: \(weight)", value: Binding(get: { weight }, set: { weight = $0; dirty = true }), in: 0...1000000).disabled(!enabled)
            if dirty && expected != revision { Button("Prism changed — load current values") { reset() } }
            Button("Save account") {
                save(["disabled": .bool(!active), "reservePercent": reserve.isEmpty ? .null : .number(Double(reserve) ?? 3), "weight": .number(Double(weight))], expected)
                dirty = false
            }.disabled(!enabled || !dirty || !valid)
            Button("Remove account", role: .destructive, action: remove).disabled(!enabled)
        }
        .onChange(of: revision) { _, _ in if !dirty { reset() } }
    }
    private func reset() { active = !account.disabled; reserve = account.reservePercent.map { String($0) } ?? ""; weight = account.weight ?? 1; expected = revision; dirty = false }
}

private struct MicPrismSettingsEditor: View {
    let settings: MicPrismPoolSettings
    let revision: String
    let enabled: Bool
    let save: (MicPrismPoolSettings, String) -> Void
    @State private var draft: MicPrismPoolSettings
    @State private var expected: String
    @State private var dirty = false
    init(settings: MicPrismPoolSettings, revision: String, enabled: Bool, save: @escaping (MicPrismPoolSettings, String) -> Void) {
        self.settings = settings; self.revision = revision; self.enabled = enabled; self.save = save
        _draft = State(initialValue: settings); _expected = State(initialValue: revision)
    }
    var body: some View {
        Section("Pool settings") {
            Picker("Account selection", selection: $draft.strategy) {
                Text("Round robin").tag("round-robin"); Text("Weighted round robin").tag("weighted-round-robin")
                Text("Fill first").tag("fill-first"); Text("Reset priority").tag("reset-priority")
            }.disabled(!enabled)
            DisclosureGroup("Advanced settings") {
                Toggle("Prefer the same account within a session", isOn: $draft.sessionAffinity).disabled(!enabled)
                Stepper("Extra retry rounds: \(draft.requestRetry)", value: $draft.requestRetry, in: 0...10).disabled(!enabled)
                Stepper("Maximum retry interval: \(draft.maxRetryInterval)s", value: $draft.maxRetryInterval, in: 0...300).disabled(!enabled)
            }
            if dirty && expected != revision { Button("Prism changed — load current values") { reset() } }
            Button("Save settings") { save(draft, expected); dirty = false }.disabled(!enabled || !dirty || !draft.valid)
        }
        .onChange(of: draft) { _, value in if value != settings { dirty = true } }
        .onChange(of: revision) { _, _ in if !dirty { reset() } }
    }
    private func reset() { draft = settings; expected = revision; dirty = false }
}
