import Foundation

public struct PrismAccount: Decodable, Identifiable, Sendable {
    public let id: String
    public let provider: String
    public let label: String
    public let email: String?
    public let disabled: Bool
    public let weight: Int?
    public let lifecycle: PrismAccountLifecycle?
}

public struct PrismAccountLifecycle: Decodable, Sendable {
    public let status: String?
    public let unavailable: Bool?
    public let expiresAt: String?
    public let lastRefreshedAt: String?
    public let refreshNotBefore: String?
    public let retryAt: String?
    public let lastErrorStatus: Int?
    public let requiresLogin: Bool?
}

/// Additive responses keep carried clients compatible with older gateways.
public struct PrismResponse: Decodable, Sendable {
    public let capabilities: PrismCapabilities?
    public let state: String?
    public let role: String?
    public let version: String?
    public let lastError: String?
    public let lastSyncError: String?
    public let accounts: [PrismAccount]?
    public let sessionId: String?
    public let authUrl: String?
    public let flow: String?
    public let userCode: String?
    public let status: String?
    public let strategy: String?
    public let usageSource: Bool?
    public let session: MicPrismIdentitySession?
    public let discovery: MicPrismDiscovery?
    public let models: [String]?
    public let response: String?
    public let threadId: String?
    public let expiresAt: Double?
}

public struct MicPrismIdentityConfiguration: Decodable, Sendable {
    public let enabled: Bool
    public let clerkPublishableKey: String?
    public let authorityUrl: String?

    public static let disabled = MicPrismIdentityConfiguration(enabled: false, clerkPublishableKey: nil, authorityUrl: nil)
}

public struct MicPrismIdentitySession: Decodable, Sendable {
    public let subject: String
    public let permissions: [String]
    public let authorizationExpiresAt: Double
}

public struct MicPrismDiscovery: Decodable, Sendable {
    public let service: MicPrismDiscoveredService?
}

public struct MicPrismDiscoveredService: Decodable, Sendable {
    public let id: String
    public let label: String
    public let apiUrl: String
    public let inferenceUrl: String?
    public let pairingRevision: Int
}

public typealias MicPrismTokenSource = @Sendable () async throws -> String

public struct PrismCapabilities: Decodable, Sendable {
    public let inference: Bool
    public let manage: Bool
    public let accountDetails: Bool
}

/// Shared native decisions for management controls and their action handlers.
public struct PrismAccess: Sendable {
    public let accountDetails: Bool
    public let accounts: Bool
    public let routing: Bool
    public let configure: Bool

    public init(status: PrismResponse?, stale: Bool, connected: Bool, session: AuthSessionState?) {
        let scopes = session?.authenticated == true ? session?.scopes ?? [] : []
        let write = scopes.contains("access:write")
        let manage = status?.capabilities?.manage ?? write
        let live = status != nil && !stale && connected
        accountDetails = status?.capabilities?.accountDetails ?? scopes.contains("orchestration:read")
        accounts = live && status?.state == "ready" && manage && accountDetails && status?.role != "replica"
        routing = live && status?.state == "ready" && manage
        configure = live && manage && write
    }
}

public struct PrismRequest: Sendable {
    public let path: String
    public let method: String
    public let body: [String: JSONValue]?
    public let expectedService: MicPrismDiscoveredService?
    public let identityAuthorityUrl: String?

    public init(_ path: String, method: String = "GET", body: [String: JSONValue]? = nil, expectedService: MicPrismDiscoveredService? = nil, identityAuthorityUrl: String? = nil) {
        self.path = path
        self.method = method
        self.body = body
        self.expectedService = expectedService
        self.identityAuthorityUrl = identityAuthorityUrl
    }

    public static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
}
