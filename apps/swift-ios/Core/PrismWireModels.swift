import Foundation

public struct PrismAccount: Decodable, Identifiable, Sendable {
    public let id: String
    public let provider: String
    public let label: String
    public let email: String?
    public let disabled: Bool
    public let weight: Int?
    public let lifecycle: PrismAccountLifecycle?
    public let reservePercent: Double?
    public let quotaWindows: [MicPrismQuotaWindow]?
    public let eligibility: MicPrismAccountEligibility?
}

public struct MicPrismQuotaWindow: Decodable, Sendable, Identifiable {
    public let id: String
    public let utilization: Double
    public let observedAt: String
    public let resetAt: String?
}

public struct MicPrismAccountEligibility: Decodable, Sendable {
    public let available: Bool
    public let reason: String?
}

public struct MicPrismPoolSettings: Codable, Sendable, Equatable {
    public var strategy: String
    public var sessionAffinity: Bool
    public var requestRetry: Int
    public var maxRetryInterval: Int

    public static let strategies = ["round-robin", "weighted-round-robin", "fill-first", "reset-priority"]
    public var valid: Bool {
        Self.strategies.contains(strategy) && (0...10).contains(requestRetry) && (0...300).contains(maxRetryInterval)
    }
    public var json: JSONValue { .object([
        "strategy": .string(strategy), "sessionAffinity": .bool(sessionAffinity),
        "requestRetry": .number(Double(requestRetry)), "maxRetryInterval": .number(Double(maxRetryInterval)),
    ]) }
}

public struct MicPrismModelAvailability: Decodable, Sendable, Identifiable {
    public let id: String
    public let provider: String
    public let available: Bool
    public let usableAccounts: Int
    public let warnings: [String]
    public let reason: String?
    public let nextEligibleAt: String?
    public var summary: String { "\(available ? "Available" : "Unavailable") · \(usableAccounts) usable account\(usableAccounts == 1 ? "" : "s")" }
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
    public let pairingChallenge: MicPrismPairingChallenge?
    public let serviceInstanceId: String?
    public let pairingRevision: Int?
    public let selectionRevision: Int?
    public let threadId: String?
    public let expiresAt: Double?
    public let settingsRevision: String?
    public let operationId: String?
    public let settings: MicPrismPoolSettings?
    public let modelAvailability: [MicPrismModelAvailability]?
    public let observedAt: String?
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
    public let selectionRevision: Int?
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
    public let expectedSelectionRevision: Int?

    public init(_ path: String, method: String = "GET", body: [String: JSONValue]? = nil, expectedService: MicPrismDiscoveredService? = nil, identityAuthorityUrl: String? = nil, expectedSelectionRevision: Int? = nil) {
        self.path = path
        self.method = method
        self.body = body
        self.expectedService = expectedService
        self.identityAuthorityUrl = identityAuthorityUrl
        self.expectedSelectionRevision = expectedSelectionRevision
    }

    public static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
}
