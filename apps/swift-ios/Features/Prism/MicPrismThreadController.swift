import Foundation
import Observation

@MainActor
protocol MicPrismThreadCapable: AnyObject {
    var micPrismThreads: MicPrismThreadController { get }
}

@MainActor
@Observable
final class MicPrismThreadController {
    struct Binding: Identifiable {
        var id: String { environmentID + "/" + threadID }
        let environmentID: String, threadID: String, authorityURL: String
        var expiresAt: Double
        let sessionID: String
    }
    private(set) var bindings: [String: Binding] = [:]
    private(set) var errorMessage: String?
    private let identity: () -> String?
    private let attach: (String, String, String) async throws -> PrismResponse
    private let detach: (String, String) async throws -> Void
    private var tasks: [String: Task<Void, Never>] = [:]
    private var generations: [String: Int] = [:]
    private var pending: Set<String> = []
    private var blockedSessionID: String?

    init(identity: @escaping () -> String?, attach: @escaping (String, String, String) async throws -> PrismResponse, detach: @escaping (String, String) async throws -> Void) {
        self.identity = identity; self.attach = attach; self.detach = detach
    }

    deinit { tasks.values.forEach { $0.cancel() } }

    func connect(environmentID: String, threadID: String, authorityURL: String) async {
        let key = environmentID + "/" + threadID
        guard let sessionID = identity(), sessionID != blockedSessionID, !pending.contains(key) else { return }
        let generation = generations[key] ?? 0
        pending.insert(key)
        defer { pending.remove(key) }
        do {
            let receipt = try await attach(environmentID, threadID, authorityURL)
            guard generation == (generations[key] ?? 0), sessionID == identity(), sessionID != blockedSessionID else {
                let cleanup = Task { try await detach(environmentID, threadID) }
                _ = try? await cleanup.value
                return
            }
            guard receipt.threadId == threadID, let expiresAt = receipt.expiresAt,
                  expiresAt > Date().timeIntervalSince1970 * 1000 else { throw MicPrismError.invalidResponse }
            bindings[key] = Binding(environmentID: environmentID, threadID: threadID, authorityURL: authorityURL, expiresAt: expiresAt, sessionID: sessionID)
            errorMessage = nil
            if tasks[key] == nil {
                tasks[key] = Task { [weak self] in
                    var elapsed = 0
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(1)) } catch { return }
                        guard await self?.checkSession(key) == true else { return }
                        elapsed += 1
                        if elapsed >= 45 {
                            elapsed = 0
                            await self?.renew(key)
                        }
                    }
                }
            }
        } catch {
            await disconnect(environmentID: environmentID, threadID: threadID)
            errorMessage = "Prism access could not be renewed for this thread. Check sign-in and environment permissions, then reconnect."
        }
    }

    private func checkSession(_ key: String) async -> Bool {
        guard let binding = bindings[key] else { return false }
        guard identity() == binding.sessionID else {
            await disconnect(environmentID: binding.environmentID, threadID: binding.threadID)
            return false
        }
        return true
    }

    private func renew(_ key: String) async {
        guard let binding = bindings[key] else { return }
        await connect(environmentID: binding.environmentID, threadID: binding.threadID, authorityURL: binding.authorityURL)
    }

    func disconnect(environmentID: String, threadID: String) async {
        let key = environmentID + "/" + threadID
        generations[key, default: 0] += 1
        tasks.removeValue(forKey: key)?.cancel()
        bindings.removeValue(forKey: key)
        let teardown = Task { try await detach(environmentID, threadID) }
        do { try await teardown.value }
        catch { errorMessage = "Could not confirm disconnection. Access will expire unless renewed." }
    }

    func disconnectAll() async {
        blockedSessionID = identity()
        for binding in Array(bindings.values) { await disconnect(environmentID: binding.environmentID, threadID: binding.threadID) }
    }
}
