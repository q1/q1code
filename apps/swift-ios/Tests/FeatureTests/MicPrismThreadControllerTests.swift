import XCTest
@testable import T3Code

@MainActor
final class MicPrismThreadControllerTests: XCTestCase {
    func testDisconnectDuringConnectionCannotRestoreTheBinding() async throws {
        let gate = MicPrismAttachGate()
        var disconnects = 0
        let controller = MicPrismThreadController(identity: { "session-a" }, attach: { _, _, _ in try await gate.attach() }, detach: { _, _ in disconnects += 1 })
        let connect = Task { await controller.connect(environmentID: "env", threadID: "thread", authorityURL: "https://identity.example.test") }
        await gate.waitUntilAttached()
        await controller.disconnect(environmentID: "env", threadID: "thread")
        await gate.finish(try receipt())
        await connect.value
        XCTAssertTrue(controller.bindings.isEmpty)
        XCTAssertEqual(disconnects, 2)
    }

    func testAccountSwitchDuringConnectionDisconnectsTheOldBroker() async throws {
        let gate = MicPrismAttachGate()
        var session = "session-a"
        var disconnects = 0
        let controller = MicPrismThreadController(identity: { session }, attach: { _, _, _ in try await gate.attach() }, detach: { _, _ in disconnects += 1 })
        let connect = Task { await controller.connect(environmentID: "env", threadID: "thread", authorityURL: "https://identity.example.test") }
        await gate.waitUntilAttached()
        session = "session-b"
        await gate.finish(try receipt())
        await connect.value
        XCTAssertTrue(controller.bindings.isEmpty)
        XCTAssertEqual(disconnects, 1)
    }

    func testSignOutPreventsReconnectUsingTheSameSession() async throws {
        var connects = 0
        var disconnects = 0
        let value = try receipt()
        let controller = MicPrismThreadController(identity: { "session-a" }, attach: { _, _, _ in connects += 1; return value }, detach: { _, _ in disconnects += 1 })
        await controller.connect(environmentID: "env", threadID: "thread", authorityURL: "https://identity.example.test")
        XCTAssertEqual(controller.bindings.count, 1)
        await controller.disconnectAll()
        await controller.connect(environmentID: "env", threadID: "thread", authorityURL: "https://identity.example.test")
        XCTAssertTrue(controller.bindings.isEmpty)
        XCTAssertEqual(connects, 1)
        XCTAssertEqual(disconnects, 1)
    }

    func testCancelledRenewalStillSendsIndependentDisconnect() async throws {
        var disconnects = 0
        let value = try receipt()
        let controller = MicPrismThreadController(identity: { "session-a" }, attach: { _, _, _ in value }, detach: { _, _ in
            try Task.checkCancellation()
            disconnects += 1
        })
        await controller.connect(environmentID: "env", threadID: "thread", authorityURL: "https://identity.example.test")
        let cancelled = Task { await controller.disconnect(environmentID: "env", threadID: "thread") }
        cancelled.cancel()
        await cancelled.value
        XCTAssertEqual(disconnects, 1)
        XCTAssertTrue(controller.bindings.isEmpty)
    }

    private func receipt() throws -> PrismResponse {
        let body = "{\"threadId\":\"thread\",\"expiresAt\":\((Date().timeIntervalSince1970 + 900) * 1000)}"
        return try JSONDecoder().decode(PrismResponse.self, from: Data(body.utf8))
    }
}

private actor MicPrismAttachGate {
    private var started = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var response: CheckedContinuation<PrismResponse, any Error>?
    func attach() async throws -> PrismResponse {
        try await withCheckedThrowingContinuation { continuation in
            response = continuation; started = true; waiter?.resume(); waiter = nil
        }
    }
    func waitUntilAttached() async {
        if started { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func finish(_ value: PrismResponse) { response?.resume(returning: value); response = nil }
}
