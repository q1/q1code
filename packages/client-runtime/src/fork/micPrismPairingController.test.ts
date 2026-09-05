import { describe, expect, it } from "@effect/vitest";
import type { MicIdentityAccess } from "@q1code/core/micIdentityApi";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { createMicPrismPairingController } from "./micPrismPairingController.ts";

const origin = "https://host.example.test";
const publicKey = "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const challengeId = "12345678-1234-4234-8234-123456789012";
const start = { origin, publicKey, label: "PC Prism" };
function access(): MicIdentityAccess {
  return {
    session: {
      version: 1,
      subject: "owner",
      sessionId: "session-owner",
      state: "active",
      globalAdmin: false,
      capabilities: { inference: false, manage: false, accountDetails: false },
      permissions: ["prism:instances:manage"],
      authorizationRevision: "1",
      authorizationExpiresAt: 4070908800000,
      expiresAt: "2099-01-01T00:00:00Z",
    },
    discovery: {
      version: 1,
      selectionRevision: 4,
      service: {
        id: "old-pc",
        label: "Old PC",
        apiUrl: origin,
        inferenceUrl: origin,
        revision: "1",
        pairingRevision: 1,
        protocolVersion: 1,
        publicKey,
        status: "paired",
      },
    },
  };
}
function harness() {
  let facts = access();
  let current = true;
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The Promise controller and its real HTTP client share the live clock; only the injected ceremony clock advances.
  let now = Effect.runSync(Clock.currentTimeMillis);
  let refreshes = 0;
  let failedStatus: number | undefined;
  let hold: (() => Promise<Response>) | undefined;
  const signals: AbortSignal[] = [];
  const mutations: { path: string; body: unknown }[] = [];
  const proof = {
    challengeId,
    origin,
    publicKey,
    expiresAt: now + 300000,
    challenge: JSON.stringify(
      {
        domain: "mic.sc/prism-pairing/v1",
        challengeId,
        nonce: "a".repeat(43),
        subject: "owner",
        origin,
        publicKey,
        expiresAt: now + 300000,
        expectedServiceInstanceId: null,
        expectedPairingRevision: 0,
      },
      null,
      2,
    ),
  };
  const fetchFn = (async (request, init) => {
    const path = new URL(String(request)).pathname;
    if (path === "/v1/identity")
      return Response.json({
        contractVersion: 1,
        subject: facts.session.subject,
        sessionId: facts.session.sessionId,
        role: "member",
        permissions: facts.session.permissions,
        authorizationExpiresAt: facts.session.authorizationExpiresAt,
        authorizationRevision: "1",
      });
    if (path === "/v1/prism/discovery")
      return Response.json({
        contractVersion: 1,
        selectionRevision: facts.discovery.selectionRevision,
        service: null,
      });
    mutations.push({
      path,
      body: JSON.parse(
        typeof init?.body === "string"
          ? init.body
          : new TextDecoder().decode(init?.body as Uint8Array),
      ),
    });
    if (hold) return hold();
    if (failedStatus) return new Response("private upstream failure", { status: failedStatus });
    if (path.endsWith("/start")) return Response.json(proof);
    if (path.endsWith("/complete"))
      return Response.json({ serviceInstanceId: "new-pc", pairingRevision: 1 });
    if (path.endsWith("/select"))
      return Response.json({ serviceInstanceId: "new-pc", selectionRevision: 5 });
    return Response.json({ serviceInstanceId: "old-pc", pairingRevision: 2, selectionRevision: 5 });
  }) satisfies typeof fetch;
  const controller = createMicPrismPairingController({
    input: {
      baseUrl: "https://authority.example.test",
      getToken: () => Effect.succeed("fixture"),
      isCurrent: () => current,
    },
    access: facts,
    run: (effect, signal) => {
      signals.push(signal);
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Exercise the UI runtime boundary and AbortSignal cancellation through the actual typed HTTP client.
      return Effect.runPromise(effect.pipe(Effect.provide(remoteHttpClientLayer(fetchFn))), {
        signal,
      });
    },
    onChanged: () => {
      refreshes++;
    },
    now: () => now,
  });
  return {
    controller,
    signals,
    mutations,
    proof,
    refreshes: () => refreshes,
    update(next: MicIdentityAccess) {
      facts = next;
      controller.updateAccess(next);
    },
    expire() {
      now = proof.expiresAt;
    },
    invalidate() {
      current = false;
    },
    fail(status: number) {
      failedStatus = status;
    },
    hold(operation: () => Promise<Response>) {
      hold = operation;
    },
  };
}

describe("mic.sc host administration workflow", () => {
  it("keeps the exact challenge and requires explicit selection after pairing", async () => {
    const h = harness();
    expect(await h.controller.start(start)).toBe(true);
    expect(h.controller.getSnapshot().challenge?.challenge).toBe(h.proof.challenge);
    expect(await h.controller.complete("s".repeat(86))).toBe(true);
    expect(h.mutations.map((call) => call.path)).toEqual([
      "/v1/prism/pairings/start",
      "/v1/prism/pairings/complete",
    ]);
    h.update(access());
    expect(h.controller.getSnapshot().notice).toContain("Host paired");
    expect(await h.controller.select(4)).toBe(true);
    expect(h.mutations.at(-1)?.body).toEqual({
      serviceInstanceId: "new-pc",
      expectedSelectionRevision: 4,
    });
    expect(h.controller.getSnapshot().notice).toBe("Shared Prism host updated.");
  });

  it("rejects a challenge at its expiry without sending its signature", async () => {
    const h = harness();
    await h.controller.start(start);
    h.expire();
    expect(await h.controller.complete("s".repeat(86))).toBe(false);
    expect(h.mutations).toHaveLength(1);
    expect(h.controller.getSnapshot().error).toContain("expired");
  });

  it("does not give inference-only users administration access", async () => {
    const h = harness();
    const next = access();
    h.update({ ...next, session: { ...next.session, permissions: ["prism:inference"] } });
    expect(await h.controller.start(start)).toBe(false);
    h.controller.prepareRevoke();
    expect(h.controller.getSnapshot().confirmation).toBeNull();
    expect(h.mutations).toHaveLength(0);
  });

  it("rejects a stale displayed selection revision without substituting the fresh revision", async () => {
    const h = harness();
    await h.controller.start(start);
    await h.controller.complete("s".repeat(86));
    const next = access();
    h.update({ ...next, discovery: { ...next.discovery, selectionRevision: 5 } });
    expect(await h.controller.select(4)).toBe(false);
    expect(h.mutations).toHaveLength(2);
    expect(h.controller.getSnapshot().paired?.serviceInstanceId).toBe("new-pc");
    expect(h.controller.getSnapshot().error).toContain("shared host changed");
  });

  it("captures revoke confirmation and rejects a changed host even after refresh", async () => {
    const h = harness();
    h.controller.prepareRevoke();
    expect(h.controller.getSnapshot().confirmation?.id).toBe("old-pc");
    const next = access();
    h.update({ ...next, discovery: { ...next.discovery, selectionRevision: 5 } });
    expect(await h.controller.revoke()).toBe(false);
    expect(h.mutations).toHaveLength(0);
    expect(h.controller.getSnapshot().confirmation).toBeNull();
    expect(h.controller.getSnapshot().error).toContain("shared host changed");
  });

  it("revokes only the explicitly captured host and preserves its confirmed notice", async () => {
    const h = harness();
    expect(await h.controller.revoke()).toBe(false);
    h.controller.prepareRevoke();
    expect(await h.controller.revoke()).toBe(true);
    expect(h.mutations[0]?.body).toEqual({
      serviceInstanceId: "old-pc",
      expectedPairingRevision: 1,
    });
    h.update({ ...access(), discovery: { version: 1, selectionRevision: 5, service: null } });
    expect(h.controller.getSnapshot().notice).toBe("Host access revoked.");
  });

  it("reports sanitized failures without replaying a rejected mutation on refresh", async () => {
    const h = harness();
    h.fail(409);
    expect(await h.controller.start(start)).toBe(false);
    expect(h.refreshes()).toBe(1);
    h.update(access());
    expect(h.mutations).toHaveLength(1);
    expect(h.controller.getSnapshot().error).toBe(
      "The host or pairing changed. Refresh and start again.",
    );
  });

  it("admits one mutation, aborts on disposal and ignores a late response", async () => {
    const h = harness();
    let release!: (response: Response) => void;
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.hold(() => {
      entered();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const first = h.controller.start(start);
    await entry;
    expect(await h.controller.start(start)).toBe(false);
    h.controller.dispose();
    expect(h.signals[0]?.aborted).toBe(true);
    release(Response.json(h.proof));
    expect(await first).toBe(false);
    expect(h.controller.getSnapshot().challenge).toBeNull();
    expect(h.controller.getSnapshot().busy).toBe(false);
    h.controller.activate();
    expect(h.mutations).toHaveLength(1);
  });

  it("aborts an active mutation when the administration grant is removed", async () => {
    const h = harness();
    let release!: (response: Response) => void;
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.hold(() => {
      entered();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const pending = h.controller.start(start);
    await entry;
    const next = access();
    h.update({ ...next, session: { ...next.session, permissions: [] } });
    expect(h.signals[0]?.aborted).toBe(true);
    release(Response.json(h.proof));
    expect(await pending).toBe(false);
    expect(h.controller.getSnapshot().challenge).toBeNull();
    expect(h.mutations).toHaveLength(1);
  });

  it("discards pending confirmation and challenge when identity changes", async () => {
    const h = harness();
    await h.controller.start(start);
    h.controller.prepareRevoke();
    h.invalidate();
    h.update(access());
    expect(h.controller.getSnapshot().challenge).toBeNull();
    expect(h.controller.getSnapshot().confirmation).toBeNull();
    expect(await h.controller.complete("s".repeat(86))).toBe(false);
    expect(h.mutations).toHaveLength(1);
  });

  it("supports Strict Mode setup after cleanup without restoring a ceremony", async () => {
    const h = harness();
    h.controller.dispose();
    h.controller.activate();
    expect(await h.controller.start(start)).toBe(true);
    h.controller.dispose();
    h.controller.activate();
    expect(h.controller.getSnapshot().challenge).toBeNull();
    expect(h.mutations).toHaveLength(1);
  });
});
