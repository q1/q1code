import XCTest
@testable import T3Code

@MainActor
final class MicPrismCodingModelsTests: XCTestCase {
    private let providers = [
        FeatureProvider(id: "claude", name: "Claude", driver: "claudeAgent"),
        FeatureProvider(id: "codex-work", name: "Codex", driver: "codex"),
        FeatureProvider(id: "cursor", name: "Cursor", driver: "cursor"),
    ]

    func testUnverifiedPooledModelIsUnavailableWithoutChangingTheSelection() {
        let selection = FeatureSelection(providerID: "claude", modelID: "claude-test")
        let observation = MicPrismCodingModels()
        XCTAssertNotNil(observation.reason(providerID: selection.providerID, modelID: selection.modelID, providers: providers, selection: selection))
        XCTAssertEqual(selection.modelID, "claude-test")
    }

    func testExplicitDirectProviderDoesNotDependOnPrism() {
        let selection = FeatureSelection(providerID: "codex-work", modelID: "gpt-test", options: [FeatureModelOptionSelection(id: "prism-route", value: .string("direct"))])
        XCTAssertNil(MicPrismCodingModels().reason(providerID: selection.providerID, modelID: selection.modelID, providers: providers, selection: selection))
    }

    func testUnrelatedProviderRemainsIndependent() {
        XCTAssertFalse(MicPrismCodingModels.isPooled(providerID: "cursor", providers: providers, selection: nil))
        XCTAssertTrue(MicPrismCodingModels.isPooled(providerID: "claude", providers: providers, selection: nil))
    }
}
