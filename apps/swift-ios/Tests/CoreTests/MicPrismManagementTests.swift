import XCTest
@testable import T3Code

@MainActor
final class MicPrismManagementTests: XCTestCase {
    private let configuration = MicPrismIdentityConfiguration(enabled: true, clerkPublishableKey: "fixture", authorityUrl: "https://identity.example.test")
    private let operationID = "e847e41e-86ca-4e99-8816-4b3a55d1f4b1"
    private func service() throws -> MicPrismDiscoveredService {
        try JSONDecoder().decode(MicPrismDiscoveredService.self, from: Data(#"{"id":"pc-prism","label":"PC Prism","apiUrl":"https://prism.example.test","pairingRevision":1}"#.utf8))
    }
    private var settings: JSONValue { .object(["strategy": .string("reset-priority"), "sessionAffinity": .bool(false), "requestRetry": .number(3), "maxRetryInterval": .number(30)]) }
    private var envelope: [String: JSONValue] { ["operationId": .string(operationID), "serviceInstanceId": .string("pc-prism"), "pairingRevision": .number(1), "expectedSettingsRevision": .string("revision-a")] }

    func testSettingsWriteCarriesHostRevisionAndConfirmsAppliedSettings() async throws {
        let transport = MicPrismManagementTransport()
        let api = MicPrismClient(transport: transport)
        let result = try await api.call(PrismRequest("/settings", method: "PUT", body: envelope.merging(["settings": settings]) { _, new in new }, expectedService: service()), configuration: configuration, token: { "fixture-session" }, isCurrent: { true })
        XCTAssertEqual(result.settings?.strategy, "reset-priority")
        XCTAssertEqual(result.settingsRevision, "revision-b")
        let calls = await transport.requests
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(calls.last?.url?.path, "/prism/v1/settings")
        XCTAssertNil(calls.last?.value(forHTTPHeaderField: "x-mic-sc-session"))
        let sent = try JSONDecoder().decode([String: JSONValue].self, from: XCTUnwrap(calls.last?.httpBody))
        XCTAssertEqual(sent["expectedSettingsRevision"], .string("revision-a"))
    }

    func testSettingsConflictDoesNotReplayTheMutation() async throws {
        let transport = MicPrismManagementTransport(status: 409)
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/settings", method: "PUT", body: envelope.merging(["settings": settings]) { _, new in new }, expectedService: service()), configuration: configuration, token: { "fixture" }, isCurrent: { true })
            XCTFail("Expected stale settings conflict")
        } catch MicPrismError.settingsConflict { }
        let calls = await transport.requests
        XCTAssertEqual(calls.filter { $0.httpMethod == "PUT" }.count, 1)
    }

    func testSettingsGrantIsRequiredBeforeAccessingTheHost() async throws {
        let transport = MicPrismManagementTransport(manage: false)
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/settings"), configuration: configuration, token: { "fixture" }, isCurrent: { true })
            XCTFail("Expected settings permission denial")
        } catch MicPrismError.denied { }
        let calls = await transport.requests
        XCTAssertEqual(calls.count, 1)
    }

    func testAvailabilityExposesOnlyAggregateModelData() async throws {
        let transport = MicPrismManagementTransport(manage: false)
        let result = try await MicPrismClient(transport: transport).call(PrismRequest("/availability"), configuration: configuration, token: { "fixture" }, isCurrent: { true })
        XCTAssertEqual(result.modelAvailability?.first?.usableAccounts, 0)
        XCTAssertEqual(result.modelAvailability?.first?.available, false)
        XCTAssertNil(result.accounts)
    }

    func testWrongOperationReceiptIsNotAccepted() async throws {
        let transport = MicPrismManagementTransport(operationID: "e3f4a41e-06fb-4f01-b132-4bc99c97ed26")
        do {
            _ = try await MicPrismClient(transport: transport).call(PrismRequest("/settings", method: "PUT", body: envelope.merging(["settings": settings]) { _, new in new }, expectedService: service()), configuration: configuration, token: { "fixture" }, isCurrent: { true })
            XCTFail("Expected receipt rejection")
        } catch MicPrismError.unconfirmed { }
    }

    func testEscapedAccountPathIsEncodedOnlyOnce() throws {
        let url = try MicPrismClient.url("https://prism.example.test", path: "/prism/v1/accounts/" + PrismRequest.component("my account.json"))
        XCTAssertEqual(url.path, "/prism/v1/accounts/my account.json")
        XCTAssertFalse(url.absoluteString.contains("%25"))
    }
}

private actor MicPrismManagementTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let manage: Bool
    let status: Int
    let operationID: String
    init(manage: Bool = true, status: Int = 200, operationID: String = "e847e41e-86ca-4e99-8816-4b3a55d1f4b1") {
        self.manage = manage; self.status = status; self.operationID = operationID
    }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let body: String
        let responseStatus: Int
        switch request.url!.path {
        case "/v1/identity":
            let permissions = manage ? #"["prism:inference","prism:settings:read","prism:settings:write","prism:accounts:read","prism:accounts:write"]"# : #"["prism:inference"]"#
            body = """
            {"contractVersion":1,"subject":"fixture","role":"member","permissions":\(permissions),"authorizationRevision":"1","authorizationExpiresAt":4070908800000}
            """
            responseStatus = 200
        case "/v1/prism/discovery":
            body = #"{"contractVersion":1,"selectionRevision":1,"service":{"serviceInstanceId":"pc-prism","displayName":"PC","apiOrigin":"https://prism.example.test","inferenceOrigin":"https://prism.example.test","pairingRevision":1,"protocolVersion":1,"publicKey":"fixture","status":"paired"}}"#
            responseStatus = 200
        case "/prism/v1/settings":
            body = """
            {"serviceInstanceId":"pc-prism","pairingRevision":1,"settingsRevision":"revision-b","operationId":"\(operationID)","status":"applied","settings":{"strategy":"reset-priority","sessionAffinity":false,"requestRetry":3,"maxRetryInterval":30}}
            """
            responseStatus = status
        case "/prism/v1/models/availability":
            body = #"{"serviceInstanceId":"pc-prism","pairingRevision":1,"observedAt":"2026-09-05T00:00:00Z","models":[{"id":"fixture-model","provider":"codex","available":false,"usableAccounts":0,"warnings":["prism_soft_reserve"]}]}"#
            responseStatus = 200
        default: throw MicPrismError.unsupported
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: responseStatus, httpVersion: nil, headerFields: nil)!)
    }
}
