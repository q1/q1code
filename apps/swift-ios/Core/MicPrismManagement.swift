import Foundation

extension MicPrismClient {
    /// A finite route set, separate from the legacy environment-management API.
    static func managementPermission(_ input: PrismRequest) -> String? {
        if input.path == "/availability", input.method == "GET" { return "prism:inference" }
        if input.path == "/settings" {
            if input.method == "GET" { return "prism:settings:read" }
            if input.method == "PUT" { return "prism:settings:write" }
            return nil
        }
        if input.path == "/accounts", input.method == "GET" { return "prism:accounts:read" }
        if input.path == "/accounts/login", input.method == "POST" { return "prism:accounts:write" }
        let parts = input.path.split(separator: "/", omittingEmptySubsequences: false)
        if parts.count >= 4, parts[1] == "accounts", parts[2] == "login", !parts[3].isEmpty {
            if parts.count == 4, ["GET", "DELETE"].contains(input.method) { return "prism:accounts:write" }
            if parts.count == 5, parts[4] == "callback", input.method == "POST" { return "prism:accounts:write" }
            return nil
        }
        if parts.count == 3, parts[1] == "accounts", ["PATCH", "DELETE"].contains(input.method),
           let id = String(parts[2]).removingPercentEncoding, id.hasSuffix(".json"), !id.contains("/"), !id.contains("\\") {
            return "prism:accounts:write"
        }
        return nil
    }

    func management(_ input: PrismRequest, origin: String, serviceInstanceId: String, pairingRevision: Int,
        token: MicPrismTokenSource, isCurrent: @escaping @Sendable () async -> Bool) async throws -> PrismResponse {
        let mutating = input.method != "GET"
        if mutating {
            guard let expected = input.expectedService, expected.id == serviceInstanceId, expected.pairingRevision == pairingRevision,
                  let body = input.body,
                  body["serviceInstanceId"]?.stringValue == serviceInstanceId,
                  body["pairingRevision"] == .number(Double(pairingRevision)),
                  let operationId = body["operationId"]?.stringValue, UUID(uuidString: operationId) != nil,
                  let revision = body["expectedSettingsRevision"]?.stringValue, !revision.isEmpty else { throw MicPrismError.invalidResponse }
            let envelope: Set<String> = ["operationId", "serviceInstanceId", "pairingRevision", "expectedSettingsRevision"]
            let extra: Set<String>
            if input.path == "/settings" {
                extra = ["settings"]
                guard case .object(let object)? = body["settings"], object.count == 4,
                      let settings = try? JSONDecoder().decode(MicPrismPoolSettings.self, from: JSONEncoder().encode(object)), settings.valid else { throw MicPrismError.invalidResponse }
            } else if input.path == "/accounts/login" {
                extra = ["provider"]
                guard let provider = body["provider"]?.stringValue, ["anthropic", "codex", "xai"].contains(provider) else { throw MicPrismError.invalidResponse }
            } else if input.path.hasSuffix("/callback") {
                extra = ["redirectUrl"]
                guard let callback = body["redirectUrl"]?.stringValue, !callback.isEmpty else { throw MicPrismError.invalidResponse }
            } else if input.method == "PATCH" {
                extra = ["patch"]
                guard case .object(let patch)? = body["patch"], !patch.isEmpty, Set(patch.keys).isSubset(of: ["disabled", "weight", "reservePercent"]) else { throw MicPrismError.invalidResponse }
                for (key, value) in patch {
                    switch (key, value) {
                    case ("disabled", .bool): break
                    case ("weight", .number(let weight)) where weight.rounded() == weight && (0...1000000).contains(weight): break
                    case ("reservePercent", .null): break
                    case ("reservePercent", .number(let percent)) where (0...100).contains(percent): break
                    default: throw MicPrismError.invalidResponse
                    }
                }
            } else { extra = [] }
            guard Set(body.keys) == envelope.union(extra) else { throw MicPrismError.invalidResponse }
        }
        let path = input.path == "/availability" ? "/prism/v1/models/availability" : "/prism/v1" + input.path
        var raw: [String: JSONValue] = try await request(origin, path, method: input.method, body: input.body, token: token, isCurrent: isCurrent)
        if input.path == "/availability" { raw["modelAvailability"] = raw.removeValue(forKey: "models") }
        let result = try Self.response(raw)
        guard result.serviceInstanceId == serviceInstanceId, result.pairingRevision == pairingRevision else { throw MicPrismError.invalidResponse }
        if input.path == "/availability" {
            guard result.observedAt != nil, let models = result.modelAvailability, models.count <= 4096,
                  models.allSatisfy({ !$0.id.isEmpty && !$0.provider.isEmpty && $0.usableAccounts >= 0 }) else { throw MicPrismError.invalidResponse }
            return result
        }
        guard let revision = result.settingsRevision, !revision.isEmpty else { throw MicPrismError.invalidResponse }
        if mutating {
            guard result.operationId == input.body?["operationId"]?.stringValue else { throw MicPrismError.unconfirmed }
            if !input.path.hasPrefix("/accounts/login") {
                guard result.status == "applied" else { throw MicPrismError.unconfirmed }
            }
        }
        if input.path == "/settings" {
            guard let settings = result.settings, settings.valid else { throw MicPrismError.invalidResponse }
            if mutating, settings.json != input.body?["settings"] { throw MicPrismError.unconfirmed }
        }
        if input.path == "/accounts", result.accounts == nil { throw MicPrismError.invalidResponse }
        if let accounts = result.accounts {
            guard accounts.allSatisfy({ account in
                account.id.hasSuffix(".json") && !account.id.contains("/") && !account.id.contains("\\") &&
                (account.reservePercent.map { (0...100).contains($0) } ?? true) &&
                (account.quotaWindows?.allSatisfy { (0...1).contains($0.utilization) } ?? true)
            }) else { throw MicPrismError.invalidResponse }
            if input.path.hasPrefix("/accounts/"), !input.path.hasPrefix("/accounts/login") {
                let id = input.path.split(separator: "/")[1].removingPercentEncoding
                if input.method == "DELETE", accounts.contains(where: { $0.id == id }) { throw MicPrismError.unconfirmed }
                if input.method == "PATCH", case .object(let patch)? = input.body?["patch"], case .array(let entries)? = raw["accounts"] {
                    let target = entries.compactMap { value -> [String: JSONValue]? in
                        if case .object(let object) = value, object["id"]?.stringValue == id { return object }
                        return nil
                    }.first
                    guard let target, patch.allSatisfy({ target[$0.key] == $0.value }) else { throw MicPrismError.unconfirmed }
                }
            }
        }
        if input.path == "/accounts/login" {
            guard let authUrl = result.authUrl, let url = URLComponents(string: authUrl),
                  let scheme = url.scheme, ["https", "http"].contains(scheme), url.user == nil, url.password == nil,
                  let id = result.sessionId, !id.isEmpty, let flow = result.flow, ["redirect", "device"].contains(flow) else { throw MicPrismError.invalidResponse }
        } else if input.path.hasPrefix("/accounts/login/") {
            let expected = input.path.split(separator: "/")[2].removingPercentEncoding
            guard result.sessionId == expected, let status = result.status, ["pending", "completed", "failed", "cancelled"].contains(status) else { throw MicPrismError.invalidResponse }
        }
        return result
    }
}
