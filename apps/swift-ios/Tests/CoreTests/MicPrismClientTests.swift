import XCTest
@testable import T3Code

@MainActor
final class MicPrismClientTests: XCTestCase {
    private let configuration = MicPrismIdentityConfiguration(enabled: true, clerkPublishableKey: "fixture-key", authorityUrl: "https://identity.example.test")

    func testOrdinaryUserDiscoversServiceWithoutEnvironmentCredentialsOrAccountDetails() async throws {
        let transport = MicPrismFixtureTransport()
        let api = MicPrismClient(transport: transport)
        let identity = try await api.call(PrismRequest("/identity/access"), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
        XCTAssertEqual(identity.discovery?.service?.label, "Shared Prism")
        let status = try await api.call(PrismRequest("/status"), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
        XCTAssertEqual(status.state, "access-verified")
        XCTAssertEqual(status.capabilities?.accountDetails, false)
        let requests = await transport.requests
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-session" })
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "x-mic-sc-session") == nil })
        XCTAssertFalse(requests.contains { $0.url?.path.hasPrefix("/api/") == true })
    }

    func testRoutingWriteRequiresExactPermissionBeforeGatewayRequest() async throws {
        let transport = MicPrismFixtureTransport()
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/routing", method: "PUT", body: ["strategy": .string("fill-first")]), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
            XCTFail("Expected missing routing grant")
        } catch MicPrismError.denied { }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.url?.path, "/v1/identity")
    }

    func testAuthorizedRoutingUsesDirectGatewayAndAcknowledgesSavedValue() async throws {
        let transport = MicPrismFixtureTransport(routingAllowed: true)
        let result = try await MicPrismClient(transport: transport).call(PrismRequest("/routing", method: "PUT", body: ["strategy": .string("fill-first")]), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
        XCTAssertEqual(result.strategy, "fill-first")
        let requests = await transport.requests
        XCTAssertEqual(requests.last?.url?.absoluteString, "https://prism.example.test/prism/v1/routing")
        XCTAssertEqual(requests.last?.httpMethod, "PUT")
    }

    func testRevocationDoesNotRetryOrExposeAuthorityErrorBody() async throws {
        let transport = MicPrismFixtureTransport(revoked: true)
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/status"), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
            XCTFail("Expected revocation")
        } catch MicPrismError.denied { }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
    }

    func testAccountSwitchDuringTokenRefreshStopsBeforeNetwork() async throws {
        let transport = MicPrismFixtureTransport()
        let binding = MicPrismFixtureBinding()
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/status"), configuration: configuration, token: {
                await binding.invalidate()
                return "previous-fixture-session"
            }, isCurrent: { await binding.current })
            XCTFail("Expected account-switch rejection")
        } catch MicPrismError.signedOut { }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testModelCatalogUsesFreshInferenceCredentialWithoutExposingAccountDetails() async throws {
        let transport = MicPrismFixtureTransport()
        let result = try await MicPrismClient(transport: transport).call(PrismRequest("/models"), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
        XCTAssertEqual(result.models, ["fixture-model"])
        XCTAssertNil(result.accounts)
        let requests = await transport.requests
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer msp1.fixture.inference")
        XCTAssertEqual(requests.dropLast().last?.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-session")
        XCTAssertEqual(requests.dropLast().last?.url?.path, "/v1/prism/credentials")
    }

    func testCredentialAllowsBoundedAuthorityClockSkew() async throws {
        let transport = MicPrismFixtureTransport(credentialOffsetMs: 901_000)
        let result = try await MicPrismClient(transport: transport).call(PrismRequest("/models"), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
        XCTAssertEqual(result.models, ["fixture-model"])
    }

    func testCredentialBeyondSkewAllowanceIsRejectedBeforeInference() async throws {
        let transport = MicPrismFixtureTransport(credentialOffsetMs: 931_000)
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/models"), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
            XCTFail("Expected excessive credential lifetime rejection")
        } catch MicPrismError.invalidResponse { }
        let requests = await transport.requests
        XCTAssertFalse(requests.contains { $0.url?.path == "/v1/models" })
    }

    func testOrdinaryInferenceDoesNotCreateAnEnvironmentSession() async throws {
        let transport = MicPrismFixtureTransport()
        let result = try await MicPrismClient(transport: transport).call(PrismRequest("/chat", method: "POST", body: ["model": .string("fixture-model"), "prompt": .string("Hello")]), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
        XCTAssertEqual(result.response, "Hello from Prism")
        let requests = await transport.requests
        XCTAssertEqual(requests.last?.url?.path, "/v1/chat/completions")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer msp1.fixture.inference")
        XCTAssertFalse(requests.contains { $0.url?.path.hasPrefix("/api/") == true })
    }

    func testStaleHostIntentCannotRetargetAnInferenceRequest() async throws {
        let transport = MicPrismFixtureTransport()
        let service = try JSONDecoder().decode(MicPrismDiscoveredService.self, from: Data(#"{"id":"previous-instance","label":"Previous Prism","apiUrl":"https://previous.example.test","pairingRevision":1}"#.utf8))
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/models", expectedService: service), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
            XCTFail("Expected stale-host rejection")
        } catch MicPrismError.unavailable { }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertFalse(requests.contains { $0.url?.path == "/v1/prism/credentials" })
    }

    func testUnsupportedAccountManagementNeverSendsRequest() async throws {
        let transport = MicPrismFixtureTransport(routingAllowed: true)
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/accounts"), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
            XCTFail("Expected unsupported operation")
        } catch MicPrismError.unsupported { }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }
}

private actor MicPrismFixtureBinding {
    var current = true
    func invalidate() { current = false }
}

private actor MicPrismFixtureTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let routingAllowed: Bool
    let revoked: Bool
    let credentialOffsetMs: Double
    init(routingAllowed: Bool = false, revoked: Bool = false, credentialOffsetMs: Double = 60_000) {
        self.routingAllowed = routingAllowed
        self.revoked = revoked
        self.credentialOffsetMs = credentialOffsetMs
    }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let body: String
        switch request.url!.path {
        case "/v1/identity":
            let permissions = routingAllowed ? #"["prism:inference","prism:routing:read","prism:routing:write"]"# : #"["prism:inference"]"#
            body = """
            {"contractVersion":1,"subject":"fixture-member","role":"member","permissions":\(permissions),"authorizationExpiresAt":\((Date().timeIntervalSince1970 + 60) * 1000),"authorizationRevision":"fixture-revision"}
            """
        case "/v1/prism/discovery":
            body = #"{"contractVersion":1,"selectionRevision":1,"service":{"serviceInstanceId":"fixture-prism","displayName":"Shared Prism","apiOrigin":"https://prism.example.test","inferenceOrigin":"https://prism.example.test","pairingRevision":1,"protocolVersion":1,"publicKey":"fixture-public-key","status":"paired"}}"#
        case "/prism/v1/status":
            body = #"{"serviceInstanceId":"fixture-prism","pairingRevision":1,"authorization":"current","engineHealth":"unknown"}"#
        case "/prism/v1/routing": body = #"{"strategy":"fill-first"}"#
        case "/v1/prism/credentials":
            body = """
            {"version":1,"tokenType":"Bearer","token":"msp1.fixture.inference","serviceInstanceId":"fixture-prism","pairingRevision":1,"expiresAt":\(Date().timeIntervalSince1970 * 1000 + credentialOffsetMs)}
            """
        case "/v1/models": body = #"{"data":[{"id":"fixture-model","owned_by":"private-provider"}]}"#
        case "/v1/chat/completions": body = #"{"choices":[{"message":{"content":"Hello from Prism"}}]}"#
        default: throw MicPrismError.unsupported
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: revoked ? 403 : 200, httpVersion: nil, headerFields: nil)!)
    }
}
