import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection, type ServerConfig } from "@t3tools/contracts";
import { buildModelOptions, resolveNewTaskModelSelection } from "../../lib/modelOptions";
import { applyMicPrismModelAvailability } from "./micPrismModelOptions.logic";

const config = {
  environment: { capabilities: { forkFlags: { prism: true, "mic-identity": true } } },
  providers: [{ instanceId: "claude", driver: "claudeAgent", enabled: true, installed: true,
    auth: { status: "authenticated" }, models: [{ slug: "claude-test", name: "Claude test", capabilities: null }] }],
  settings: { providerInstances: {} },
} as unknown as ServerConfig;
const selection: ModelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-test" };
const observation = (available: boolean) => ({ value: {
  serviceInstanceId: "pc", pairingRevision: 1, observedAt: "2026-09-05T00:00:00Z",
  models: [{ id: "claude-test", provider: "anthropic", available, usableAccounts: available ? 2 : 0, warnings: [] }],
}, error: null });

describe("Prism coding model eligibility", () => {
  it("keeps an unavailable draft selected while disabling its picker row", () => {
    const options = applyMicPrismModelAvailability(config, buildModelOptions(config, selection), selection, observation(false));
    expect(options[0]?.isUnavailable).toBe(true);
    expect(resolveNewTaskModelSelection({ draftSelection: selection, projectDefaultSelection: null, stickySelection: null, modelOptions: options })).toEqual(selection);
  });
  it("disables stale observations even when the last response was eligible", () => {
    const options = applyMicPrismModelAvailability(config, buildModelOptions(config, selection), selection, { ...observation(true), error: "Prism offline" });
    expect(options[0]?.isUnavailable).toBe(true);
    expect(options[0]?.subtitle).toBe("Prism offline");
  });
  it("preserves the explicit direct route when choosing another model", () => {
    const direct = { ...selection, model: "older-model", options: [{ id: "prism-route", value: "direct" }] };
    const options = applyMicPrismModelAvailability(config, buildModelOptions(config, direct), direct, observation(false));
    expect(options.every((option) => !option.isUnavailable)).toBe(true);
    expect(options[0]?.selection.options).toContainEqual({ id: "prism-route", value: "direct" });
  });
  it("restores eligibility when the host reports usable accounts again", () => {
    const options = applyMicPrismModelAvailability(config, buildModelOptions(config, selection), selection, observation(true));
    expect(options[0]?.isUnavailable).toBe(false);
    expect(options[0]?.subtitle).toContain("2 usable accounts");
  });
});
