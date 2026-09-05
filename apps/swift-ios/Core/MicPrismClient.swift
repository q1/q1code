import Foundation

public enum MicPrismError: LocalizedError, Sendable {
    case signedOut, denied, unavailable, invalidResponse, unpaired, unsupported

    public var errorDescription: String? {
        switch self {
        case .signedOut: "Sign in with mic.sc to continue."
        case .denied: "Your mic.sc account no longer has access to this Prism operation."
        case .unavailable: "Prism could not verify access. Try again when the service is available."
        case .invalidResponse: "Prism returned an unexpected response. Refresh access and try again."
        case .unpaired: "No Prism service is paired with mic.sc."
        case .unsupported: "This Prism service does not support this operation yet."
        }
    }
}

/// Direct service calls carry only the human credential, never environment or relay access.
public struct MicPrismClient: Sendable {
    private let transport: any HTTPTransport

    public init(transport: any HTTPTransport = MicPrismHTTPTransport()) {
        self.transport = transport
    }

    public func call(
        _ input: PrismRequest,
        configuration: MicPrismIdentityConfiguration,
        token: @escaping MicPrismTokenSource,
        isCurrent: @escaping @Sendable () async -> Bool
    ) async throws -> PrismResponse {
        let permission: String
        switch (input.method, input.path) {
        case ("GET", "/identity/access"), ("GET", "/status"), ("GET", "/models"), ("POST", "/chat"): permission = "prism:inference"
        case ("GET", "/routing"): permission = "prism:routing:read"
        case ("PUT", "/routing"): permission = "prism:routing:write"
        default: throw MicPrismError.unsupported
        }
        guard configuration.enabled, let origin = configuration.authorityUrl else {
            throw MicPrismError.unavailable
        }
        if let expected = input.identityAuthorityUrl, expected != origin { throw MicPrismError.unavailable }
        let identity: Identity = try await request(origin, "/v1/identity", token: token, isCurrent: isCurrent)
        guard identity.contractVersion == 1, !identity.subject.isEmpty,
              ["global_admin", "member"].contains(identity.role), !identity.authorizationRevision.isEmpty else {
            throw MicPrismError.invalidResponse
        }
        try identity.require(permission)
        let discovery: Discovery = try await request(origin, "/v1/prism/discovery", token: token, isCurrent: isCurrent)
        guard discovery.contractVersion == 1, discovery.selectionRevision >= 0 else { throw MicPrismError.invalidResponse }
        try identity.require(permission)
        if let service = discovery.service {
            guard service.status == "paired", service.protocolVersion == 1,
                  service.pairingRevision > 0, !service.serviceInstanceId.isEmpty,
                  !service.displayName.isEmpty, !service.publicKey.isEmpty else { throw MicPrismError.invalidResponse }
            _ = try Self.url(service.apiOrigin, path: "", originOnly: true)
            _ = try Self.url(service.inferenceOrigin, path: "", originOnly: true)
        }
        if let expected = input.expectedService {
            guard let service = discovery.service, expected.id == service.serviceInstanceId,
                  expected.pairingRevision == service.pairingRevision, expected.apiUrl == service.apiOrigin,
                  expected.inferenceUrl == nil || expected.inferenceUrl == service.inferenceOrigin else { throw MicPrismError.unavailable }
        }
        if input.path == "/identity/access" {
            return try Self.response([
                "session": .object([
                    "subject": .string(identity.subject),
                    "permissions": .array(identity.permissions.map(JSONValue.string)),
                    "authorizationExpiresAt": .number(identity.authorizationExpiresAt),
                ]),
                "discovery": .object(["service": discovery.service.map { service in .object([
                    "id": .string(service.serviceInstanceId), "label": .string(service.displayName),
                    "apiUrl": .string(service.apiOrigin), "inferenceUrl": .string(service.inferenceOrigin), "pairingRevision": .number(Double(service.pairingRevision)),
                ]) } ?? .null]),
            ])
        }
        guard let service = discovery.service else { throw MicPrismError.unpaired }
        if input.path == "/status" {
            let status: Status = try await request(service.apiOrigin, "/prism/v1/status", token: token, isCurrent: isCurrent)
            guard status.serviceInstanceId == service.serviceInstanceId,
                  status.pairingRevision == service.pairingRevision,
                  status.authorization == "current", status.engineHealth == "unknown" else { throw MicPrismError.invalidResponse }
            try identity.require(permission)
            // Verified access is distinct from engine readiness or provider eligibility.
            return try Self.response(["state": .string("access-verified"), "capabilities": .object([
                "inference": .bool(true), "manage": .bool(false), "accountDetails": .bool(false),
            ])])
        }
        if input.path == "/models" || input.path == "/chat" {
            let credential: Credential = try await request(origin, "/v1/prism/credentials", method: "POST", body: [
                "serviceInstanceId": .string(service.serviceInstanceId), "pairingRevision": .number(Double(service.pairingRevision)),
            ], token: token, isCurrent: isCurrent)
            let now = Date().timeIntervalSince1970 * 1000
            guard credential.version == 1, credential.tokenType == "Bearer",
                  credential.serviceInstanceId == service.serviceInstanceId,
                  credential.pairingRevision == service.pairingRevision,
                  credential.expiresAt > now, credential.expiresAt <= now + 930_000,
                  credential.token.range(of: #"^msp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else { throw MicPrismError.invalidResponse }
            try identity.require(permission)
            if input.path == "/models" {
                let catalog: Models = try await request(service.inferenceOrigin, "/v1/models", token: { credential.token }, isCurrent: isCurrent)
                guard catalog.data.count <= 4096, catalog.data.allSatisfy({ !$0.id.isEmpty && $0.id.count <= 256 }) else { throw MicPrismError.invalidResponse }
                let models = Set(catalog.data.map(\.id)).sorted()
                return try Self.response(["models": .array(models.map(JSONValue.string))])
            }
            guard let model = input.body?["model"]?.stringValue, !model.isEmpty, model.count <= 256,
                  let prompt = input.body?["prompt"]?.stringValue, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  prompt.count <= 8000, input.body?.count == 2 else { throw MicPrismError.unsupported }
            let result: Chat = try await request(service.inferenceOrigin, "/v1/chat/completions", method: "POST", body: [
                "model": .string(model), "stream": .bool(false),
                "messages": .array([.object(["role": .string("user"), "content": .string(prompt)])]),
            ], token: { credential.token }, isCurrent: isCurrent, timeout: 60)
            guard let response = result.choices.first?.message.content else { throw MicPrismError.invalidResponse }
            return try Self.response(["response": .string(response)])
        }
        if input.method == "PUT" {
            guard let strategy = input.body?["strategy"]?.stringValue,
                  ["round-robin", "weighted-round-robin", "fill-first"].contains(strategy), input.body?.count == 1 else {
                throw MicPrismError.unsupported
            }
        }
        let routing: Routing = try await request(service.apiOrigin, "/prism/v1/routing", method: input.method, body: input.body, token: token, isCurrent: isCurrent)
        guard ["round-robin", "weighted-round-robin", "fill-first"].contains(routing.strategy),
              input.method != "PUT" || routing.strategy == input.body?["strategy"]?.stringValue else { throw MicPrismError.invalidResponse }
        try identity.require(permission)
        return try Self.response(["strategy": .string(routing.strategy)])
    }

    private func request<T: Decodable>(
        _ origin: String, _ path: String, method: String = "GET", body: [String: JSONValue]? = nil,
        token: MicPrismTokenSource, isCurrent: @Sendable () async -> Bool, timeout: TimeInterval = 15
    ) async throws -> T {
        try Task.checkCancellation()
        guard await isCurrent() else { throw MicPrismError.signedOut }
        let credential: String
        do { credential = try await token() } catch { throw MicPrismError.signedOut }
        try Task.checkCancellation()
        guard await isCurrent(), !credential.isEmpty else { throw MicPrismError.signedOut }
        var request = URLRequest(url: try Self.url(origin, path: path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: HTTPURLResponse
        do { (data, response) = try await transport.data(for: request) }
        catch is CancellationError { throw CancellationError() }
        catch { throw MicPrismError.unavailable }
        try Task.checkCancellation()
        guard await isCurrent() else { throw MicPrismError.signedOut }
        switch response.statusCode {
        case 200..<300: break
        case 401: throw MicPrismError.signedOut
        case 403: throw MicPrismError.denied
        case 404, 405, 501: throw MicPrismError.unsupported
        default: throw MicPrismError.unavailable
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw MicPrismError.invalidResponse }
    }

    private static func url(_ origin: String, path: String, originOnly: Bool = false) throws -> URL {
        guard var parts = URLComponents(string: origin), let host = parts.host,
              parts.scheme == "https" || (parts.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              !originOnly || parts.path.isEmpty || parts.path == "/" else { throw MicPrismError.invalidResponse }
        parts.path = parts.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        parts.path = (parts.path.isEmpty ? "" : "/" + parts.path) + path
        guard let url = parts.url else { throw MicPrismError.invalidResponse }
        return url
    }

    private static func response(_ object: [String: JSONValue]) throws -> PrismResponse {
        try JSONDecoder().decode(PrismResponse.self, from: JSONEncoder().encode(object))
    }

    private struct Identity: Decodable {
        let contractVersion: Int, subject: String, role: String, permissions: [String]
        let authorizationExpiresAt: Double, authorizationRevision: String
        func require(_ permission: String) throws {
            guard authorizationExpiresAt > Date().timeIntervalSince1970 * 1000 else { throw MicPrismError.signedOut }
            guard permissions.contains(permission) else { throw MicPrismError.denied }
        }
    }
    private struct Discovery: Decodable {
        let contractVersion: Int, selectionRevision: Int
        let service: Service?
    }
    private struct Service: Decodable {
        let serviceInstanceId: String, displayName: String, apiOrigin: String, inferenceOrigin: String
        let pairingRevision: Int, protocolVersion: Int
        let publicKey: String, status: String
    }
    private struct Status: Decodable {
        let serviceInstanceId: String, pairingRevision: Int, authorization: String, engineHealth: String
    }
    private struct Routing: Decodable { let strategy: String }
    private struct Credential: Decodable, Sendable {
        let version: Int, tokenType: String, token: String, serviceInstanceId: String, pairingRevision: Int, expiresAt: Double
    }
    private struct Models: Decodable {
        struct Model: Decodable { let id: String }
        let data: [Model]
    }
    private struct Chat: Decodable {
        struct Choice: Decodable {
            struct Message: Decodable { let content: String? }
            let message: Message
        }
        let choices: [Choice]
    }
}

/// No ambient browser cookies, response cache, redirects, or environment authorization.
public struct MicPrismHTTPTransport: HTTPTransport {
    private let session: URLSession
    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        session = URLSession(configuration: configuration)
    }
    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request, delegate: MicPrismRedirectPolicy())
        guard let response = response as? HTTPURLResponse else { throw MicPrismError.invalidResponse }
        return (data, response)
    }
}

private final class MicPrismRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
