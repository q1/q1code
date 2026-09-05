import XCTest
@testable import T3Code

@MainActor
final class MicPrismPairingTests: XCTestCase {
    private let configuration = MicPrismIdentityConfiguration(enabled: true, clerkPublishableKey: "fixture-key", authorityUrl: "https://identity.example.test")
    private let host = "https://new-prism.example.test"
    private let key = "MCowBQYDK2VwAyEA" + String(repeating: "a", count: 43)
    private let challengeID = "12345678-1234-4234-8234-123456789abc"

    private func call(_ transport: PairingFixtureTransport, _ path: String, body: [String: JSONValue]? = nil) async throws -> PrismResponse {
        try await MicPrismClient(transport: transport).call(PrismRequest(path, method: body == nil ? "GET" : "POST", body: body), configuration: configuration, token: { "fixture-human-session" }, isCurrent: { true })
    }

    func testManagerCanDiscoverAnUnpairedAccountWithoutInferenceGrant() async throws {
        let transport = PairingFixtureTransport()
        let result = try await call(transport, "/identity/access")
        XCTAssertNil(result.discovery?.service)
        XCTAssertEqual(result.discovery?.selectionRevision, 4)
        XCTAssertEqual(result.session?.permissions, ["prism:instances:manage"])
    }

    func testRoutingOnlyIdentityCanReadOverviewWithoutInferenceGrant() async throws {
        let transport = PairingFixtureTransport(permissions: ["prism:routing:read"])
        let result = try await call(transport, "/identity/access")
        XCTAssertEqual(result.session?.permissions, ["prism:routing:read"])
        XCTAssertEqual(result.discovery?.selectionRevision, 4)
    }

    func testZeroGrantIdentityCanReadOverviewButCannotManageHosts() async throws {
        let transport = PairingFixtureTransport(permissions: [])
        let result = try await call(transport, "/identity/access")
        XCTAssertEqual(result.session?.permissions, [])
        do {
            _ = try await call(transport, "/identity/instances/select", body: ["serviceInstanceId": .string("fixture-host"), "expectedSelectionRevision": .number(4)])
            XCTFail("Expected host management denial")
        } catch MicPrismError.denied { }
        let requests = await transport.requests
        XCTAssertFalse(requests.contains { $0.httpMethod == "POST" })
    }

    func testExpiredIdentityCannotReadOverview() async throws {
        let transport = PairingFixtureTransport(expired: true)
        do {
            _ = try await call(transport, "/identity/access")
            XCTFail("Expected expired identity rejection")
        } catch MicPrismError.signedOut { }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
    }

    func testStartUsesOnlyAuthorityAndPreservesExactChallenge() async throws {
        let transport = PairingFixtureTransport()
        let result = try await call(transport, "/identity/pairings/start", body: ["origin": .string(host), "publicKey": .string(key), "label": .string("Primary PC")])
        XCTAssertEqual(result.pairingChallenge?.challengeId, challengeID)
        XCTAssertTrue(result.pairingChallenge?.challenge.hasPrefix("{\n") == true)
        let requests = await transport.requests
        XCTAssertEqual(requests.map { $0.url!.path }, ["/v1/identity", "/v1/prism/discovery", "/v1/prism/pairings/start"])
        XCTAssertTrue(requests.allSatisfy { $0.url?.host == "identity.example.test" && $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-human-session" })
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Cookie") == nil && $0.value(forHTTPHeaderField: "x-mic-sc-session") == nil })
    }

    func testOrdinaryInferenceGrantDoesNotPermitHostChanges() async throws {
        let transport = PairingFixtureTransport(manage: false)
        do {
            _ = try await call(transport, "/identity/instances/revoke", body: ["serviceInstanceId": .string("fixture-host"), "expectedPairingRevision": .number(2)])
            XCTFail("Expected permission denial")
        } catch MicPrismError.denied { }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
    }

    func testChallengeForAnotherSubjectIsRejected() async throws {
        let transport = PairingFixtureTransport(wrongSubject: true)
        do {
            _ = try await call(transport, "/identity/pairings/start", body: ["origin": .string(host), "publicKey": .string(key), "label": .string("Primary PC")])
            XCTFail("Expected challenge binding rejection")
        } catch MicPrismError.invalidResponse { }
    }

    func testCompletionDoesNotImplicitlySelectHost() async throws {
        let transport = PairingFixtureTransport()
        let result = try await call(transport, "/identity/pairings/complete", body: ["challengeId": .string(challengeID), "signature": .string(String(repeating: "a", count: 86))])
        XCTAssertEqual(result.serviceInstanceId, "fixture-host")
        XCTAssertEqual(result.pairingRevision, 2)
        let requests = await transport.requests
        XCTAssertFalse(requests.contains { $0.url?.path == "/v1/prism/instances/select" })
    }

    func testSelectionSendsObservedRevisionAndRejectsMismatchedAcknowledgement() async throws {
        let transport = PairingFixtureTransport(wrongRevision: true)
        do {
            _ = try await call(transport, "/identity/instances/select", body: ["serviceInstanceId": .string("fixture-host"), "expectedSelectionRevision": .number(4)])
            XCTFail("Expected acknowledgement mismatch")
        } catch MicPrismError.invalidResponse { }
        let requests = await transport.requests
        let body = try JSONDecoder().decode([String: JSONValue].self, from: XCTUnwrap(requests.last?.httpBody))
        XCTAssertEqual(body["expectedSelectionRevision"], .number(4))
    }

    func testRevocationAcknowledgesNewPairingRevisionWithoutGatewayAccess() async throws {
        let transport = PairingFixtureTransport()
        let result = try await call(transport, "/identity/instances/revoke", body: ["serviceInstanceId": .string("fixture-host"), "expectedPairingRevision": .number(2)])
        XCTAssertEqual(result.pairingRevision, 3)
        let requests = await transport.requests
        XCTAssertTrue(requests.allSatisfy { $0.url?.host == "identity.example.test" })
    }

    func testFreshDiscoveryRejectsRevocationConfirmedAgainstPreviousSelection() async throws {
        let transport = PairingFixtureTransport()
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/identity/instances/revoke", method: "POST", body: ["serviceInstanceId": .string("fixture-host"), "expectedPairingRevision": .number(2)], expectedSelectionRevision: 3), configuration: configuration, token: { "fixture-human-session" }, isCurrent: { true })
            XCTFail("Expected selected-host conflict before revocation")
        } catch MicPrismError.pairingConflict { }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertFalse(requests.contains { $0.httpMethod == "POST" })
    }

    func testConflictDoesNotRetryMutationOrExposeBackendBody() async throws {
        let transport = PairingFixtureTransport(conflict: true)
        do {
            _ = try await call(transport, "/identity/instances/select", body: ["serviceInstanceId": .string("fixture-host"), "expectedSelectionRevision": .number(4)])
            XCTFail("Expected revision conflict")
        } catch MicPrismError.pairingConflict { }
        let requests = await transport.requests
        XCTAssertEqual(requests.filter { $0.httpMethod == "POST" }.count, 1)
    }

    func testSessionChangeDuringTokenRefreshPreventsMutation() async throws {
        let transport = PairingFixtureTransport()
        let binding = PairingFixtureBinding()
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/identity/instances/revoke", method: "POST", body: ["serviceInstanceId": .string("fixture-host"), "expectedPairingRevision": .number(2)]), configuration: configuration, token: {
                await binding.nextToken()
            }, isCurrent: { await binding.current })
            XCTFail("Expected old-session rejection")
        } catch MicPrismError.signedOut { }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertFalse(requests.contains { $0.httpMethod == "POST" })
    }

    func testMalformedOriginAndExtraFieldsDoNotReachMutation() async throws {
        let transport = PairingFixtureTransport()
        do {
            _ = try await call(transport, "/identity/pairings/start", body: ["origin": .string(host + "/path"), "publicKey": .string(key), "label": .string("Primary PC"), "unexpected": .bool(true)])
            XCTFail("Expected invalid pairing input")
        } catch MicPrismError.invalidPairing { }
        let requests = await transport.requests
        XCTAssertFalse(requests.contains { $0.httpMethod == "POST" })
    }
}

private actor PairingFixtureBinding {
    var current = true
    private var count = 0
    func nextToken() -> String {
        count += 1
        if count == 3 { current = false }
        return "fixture-human-session"
    }
}

private actor PairingFixtureTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let manage: Bool
    let wrongSubject: Bool
    let wrongRevision: Bool
    let conflict: Bool
    let permissions: [String]?
    let expired: Bool
    init(manage: Bool = true, wrongSubject: Bool = false, wrongRevision: Bool = false, conflict: Bool = false, permissions: [String]? = nil, expired: Bool = false) {
        self.manage = manage; self.wrongSubject = wrongSubject; self.wrongRevision = wrongRevision; self.conflict = conflict
        self.permissions = permissions; self.expired = expired
    }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let body: [String: Any]
        let now = Date().timeIntervalSince1970 * 1000
        switch request.url!.path {
        case "/v1/identity":
            body = ["contractVersion": 1, "subject": "fixture-admin", "role": "member", "permissions": permissions ?? [manage ? "prism:instances:manage" : "prism:inference"], "authorizationExpiresAt": now + (expired ? -60_000 : 60_000), "authorizationRevision": "revision-1"]
        case "/v1/prism/discovery":
            body = ["contractVersion": 1, "selectionRevision": 4, "service": NSNull()]
        case "/v1/prism/pairings/start":
            let id = "12345678-1234-4234-8234-123456789abc"
            let origin = "https://new-prism.example.test"
            let key = "MCowBQYDK2VwAyEA" + String(repeating: "a", count: 43)
            let expires = now + 300_000
            let proof: [String: Any] = ["domain": "mic.sc/prism-pairing/v1", "challengeId": id, "nonce": String(repeating: "b", count: 43), "subject": wrongSubject ? "another-admin" : "fixture-admin", "origin": origin, "publicKey": key, "expiresAt": expires, "expectedServiceInstanceId": NSNull(), "expectedPairingRevision": 0]
            body = ["challengeId": id, "challenge": String(decoding: try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self), "origin": origin, "publicKey": key, "expiresAt": expires]
        case "/v1/prism/pairings/complete": body = ["serviceInstanceId": "fixture-host", "pairingRevision": 2]
        case "/v1/prism/instances/select": body = ["serviceInstanceId": "fixture-host", "selectionRevision": wrongRevision ? 9 : 5]
        case "/v1/prism/instances/revoke": body = ["serviceInstanceId": "fixture-host", "pairingRevision": 3, "selectionRevision": 5]
        default: throw MicPrismError.unsupported
        }
        return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(url: request.url!, statusCode: conflict && request.httpMethod == "POST" ? 409 : 200, httpVersion: nil, headerFields: nil)!)
    }
}
