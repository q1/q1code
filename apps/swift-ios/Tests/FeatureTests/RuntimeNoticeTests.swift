import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Runtime notices")
struct RuntimeNoticeTests {
    @Test
    func showsTheUsageLimitWarningWithoutAnAssistantMessage() {
        let message = "Claude usage limit reached. This turn is paused until the 7-day Fable limit resets in 27h 18m."
        let warning = activity(tone: "warning", kind: "runtime.warning", summary: message,
                               payload: ["message": .string(message), "detail": .object(["status": .string("rejected")])])
        #expect(NativeFeatureClient.activityNoticeText(warning) == message)
    }

    @Test
    func showsTheRuntimeErrorMessageInsteadOfItsGenericSummary() {
        let error = activity(tone: "error", kind: "runtime.error", summary: "Runtime error",
                             payload: ["message": .string("Claude gave up after repeated API errors.")])
        #expect(NativeFeatureClient.activityNoticeText(error) == "Claude gave up after repeated API errors.")
    }

    @Test
    func preservesLegacyDetailsAndAvoidsDuplicatingTheSummary() {
        let legacy = activity(tone: "error", kind: "provider.turn.start.failed", summary: "Turn failed",
                              payload: ["detail": .string("Provider unavailable")])
        #expect(NativeFeatureClient.activityNoticeText(legacy) == "Turn failed\nProvider unavailable")
        let repeated = activity(tone: "warning", kind: "runtime.warning", summary: "Limit reached",
                                payload: ["message": .string(" "), "detail": .string("Limit reached")])
        #expect(NativeFeatureClient.activityNoticeText(repeated) == "Limit reached")
    }

    @Test
    func keepsOrdinaryActivitiesOutOfTheTranscriptAndDoesNotDumpStructuredDetails() {
        let progress = activity(tone: "info", kind: "tool.updated", summary: "Running",
                                payload: ["message": .string("Tool progress")])
        #expect(NativeFeatureClient.activityNoticeText(progress) == nil)
        let diagnostic = activity(tone: "error", kind: "runtime.error", summary: "Runtime error",
                                  payload: ["detail": .object(["internal": .string("diagnostic")])])
        #expect(NativeFeatureClient.activityNoticeText(diagnostic) == "Runtime error")
    }

    private func activity(tone: String, kind: String, summary: String, payload: [String: JSONValue]) -> OrchestrationActivity {
        OrchestrationActivity(id: "notice", tone: tone, kind: kind, summary: summary,
                              payload: .object(payload), turnId: "turn", sequence: 1,
                              createdAt: "2026-09-06T20:42:22Z")
    }
}
