import Foundation

public struct MicPrismPairingChallenge: Codable, Sendable {
    public let challengeId: String
    public let challenge: String
    public let origin: String
    public let publicKey: String
    public let expiresAt: Double
}

extension MicPrismClient {
    /// Recovery stays on the authority: an absent or unreachable previous host must not block it.
    func pairing(
        _ input: PrismRequest, origin: String, subject: String,
        token: MicPrismTokenSource, isCurrent: @Sendable () async -> Bool
    ) async throws -> PrismResponse {
        guard let body = input.body else { throw MicPrismError.invalidPairing }
        switch input.path {
        case "/identity/pairings/start":
            guard body.count == 3, let host = body["origin"]?.stringValue,
                  let publicKey = body["publicKey"]?.stringValue,
                  let label = body["label"]?.stringValue,
                  Self.validPairingHost(host), Self.matches(publicKey, #"^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{43}$"#),
                  !label.isEmpty, label.count <= 80, label == label.trimmingCharacters(in: .whitespacesAndNewlines),
                  label.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else { throw MicPrismError.invalidPairing }
            let result: MicPrismPairingChallenge = try await request(origin, "/v1/prism/pairings/start", method: "POST", body: body, token: token, isCurrent: isCurrent)
            let proof: PairingProof
            do { proof = try JSONDecoder().decode(PairingProof.self, from: Data(result.challenge.utf8)) }
            catch { throw MicPrismError.invalidResponse }
            let now = Date().timeIntervalSince1970 * 1000
            guard Self.validChallengeID(result.challengeId), result.challenge.utf8.count <= 4096,
                  result.origin == host, result.publicKey == publicKey, result.expiresAt > now, result.expiresAt <= now + 330_000,
                  proof.domain == "mic.sc/prism-pairing/v1", Self.matches(proof.nonce, #"^[A-Za-z0-9_-]{43}$"#),
                  proof.subject == subject, proof.challengeId == result.challengeId, proof.origin == host,
                  proof.publicKey == publicKey, proof.expiresAt == result.expiresAt,
                  proof.expectedPairingRevision >= 0,
                  proof.expectedServiceInstanceId.map(Self.validInstanceID) ?? true else { throw MicPrismError.invalidResponse }
            // Preserve the exact bytes returned by mic.sc; reserializing the proof breaks its signature.
            return try Self.response(["pairingChallenge": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(result))])
        case "/identity/pairings/complete":
            guard body.count == 2, let id = body["challengeId"]?.stringValue, Self.validChallengeID(id),
                  let signature = body["signature"]?.stringValue, Self.matches(signature, #"^[A-Za-z0-9_-]{86}$"#) else { throw MicPrismError.invalidPairing }
            let result: PairedInstance = try await request(origin, "/v1/prism/pairings/complete", method: "POST", body: body, token: token, isCurrent: isCurrent)
            guard Self.validInstanceID(result.serviceInstanceId), result.pairingRevision > 0 else { throw MicPrismError.invalidResponse }
            return try Self.response(["serviceInstanceId": .string(result.serviceInstanceId), "pairingRevision": .number(Double(result.pairingRevision))])
        case "/identity/instances/select":
            guard body.count == 2, let id = body["serviceInstanceId"]?.stringValue, Self.validInstanceID(id),
                  let revision = Self.revision(body["expectedSelectionRevision"]), revision < Int.max else { throw MicPrismError.invalidPairing }
            let result: SelectedInstance = try await request(origin, "/v1/prism/instances/select", method: "POST", body: body, token: token, isCurrent: isCurrent)
            guard result.serviceInstanceId == id, [revision, revision + 1].contains(result.selectionRevision) else { throw MicPrismError.invalidResponse }
            return try Self.response(["serviceInstanceId": .string(id), "selectionRevision": .number(Double(result.selectionRevision))])
        case "/identity/instances/revoke":
            guard body.count == 2, let id = body["serviceInstanceId"]?.stringValue, Self.validInstanceID(id),
                  let revision = Self.revision(body["expectedPairingRevision"]), revision > 0, revision < Int.max else { throw MicPrismError.invalidPairing }
            let result: RevokedInstance = try await request(origin, "/v1/prism/instances/revoke", method: "POST", body: body, token: token, isCurrent: isCurrent)
            guard result.serviceInstanceId == id, result.pairingRevision == revision + 1, result.selectionRevision >= 0 else { throw MicPrismError.invalidResponse }
            return try Self.response(["serviceInstanceId": .string(id), "pairingRevision": .number(Double(result.pairingRevision)), "selectionRevision": .number(Double(result.selectionRevision))])
        default: throw MicPrismError.unsupported
        }
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
    private static func validInstanceID(_ value: String) -> Bool { matches(value, #"^[A-Za-z0-9_.:~-]{1,256}$"#) }
    private static func validChallengeID(_ value: String) -> Bool { matches(value, #"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#) }
    private static func validPairingHost(_ value: String) -> Bool {
        guard value.count <= 256, let url = try? url(value, path: "", originOnly: true), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.path.isEmpty, value == url.absoluteString else { return false }
        return true
    }
    private static func revision(_ value: JSONValue?) -> Int? {
        guard case .number(let number)? = value, number.isFinite, number >= 0, number < Double(Int.max), number.rounded() == number else { return nil }
        return Int(number)
    }
    private struct PairingProof: Decodable {
        let domain: String, challengeId: String, nonce: String, subject: String, origin: String, publicKey: String
        let expiresAt: Double, expectedPairingRevision: Int
        let expectedServiceInstanceId: String?
    }
    private struct PairedInstance: Decodable { let serviceInstanceId: String, pairingRevision: Int }
    private struct SelectedInstance: Decodable { let serviceInstanceId: String, selectionRevision: Int }
    private struct RevokedInstance: Decodable { let serviceInstanceId: String, pairingRevision: Int, selectionRevision: Int }
}
