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
}

public struct PrismRequest: Sendable {
    public let path: String
    public let method: String
    public let body: [String: JSONValue]?

    public init(_ path: String, method: String = "GET", body: [String: JSONValue]? = nil) {
        self.path = path
        self.method = method
        self.body = body
    }

    public static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
}
