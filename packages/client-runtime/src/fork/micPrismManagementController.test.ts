import { describe, expect, it } from "@effect/vitest";
import { MicIdentityUnauthorizedError } from "@q1code/core/micIdentity";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type { HttpClient } from "effect/unstable/http";
import type { MicPrismManagementClientError } from "./micPrismManagement.ts";
import { createMicPrismManagementController, type MicPrismManagementRunner } from "./micPrismManagementController.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";

/** Promise UI calls execute on a test-owned worker fiber with the test's services and cancellation. */
const testRunner = Effect.gen(function* () {
  type Job = {
    effect: Effect.Effect<unknown, MicPrismManagementClientError, HttpClient.HttpClient | Crypto.Crypto>;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
  const jobs = yield* Queue.unbounded<Job>();
  yield* Effect.forever(Effect.gen(function* () {
    const job = yield* Queue.take(jobs);
    const cancelled = Effect.callback<never, MicIdentityUnauthorizedError>((resume) => {
      const abort = () => resume(Effect.fail(new MicIdentityUnauthorizedError({ reason: "revoked-session" })));
      if (job.signal.aborted) abort();
      else job.signal.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => job.signal.removeEventListener("abort", abort));
    });
    const result = yield* Effect.raceFirst(job.effect, cancelled).pipe(Effect.result);
    if (result._tag === "Success") job.resolve(result.success);
    else job.reject(result.failure);
  })).pipe(Effect.forkChild);
  const run: MicPrismManagementRunner = (effect, signal) => new Promise((resolve, reject) => {
    Queue.offerUnsafe(jobs, { effect, signal, resolve: (value) => resolve(value as Effect.Success<typeof effect>), reject });
  });
  return run;
});

const settings = { strategy: "reset-priority" as const, sessionAffinity: false, requestRetry: 2, maxRetryInterval: 30 };
const binding = { serviceInstanceId: "pc-prism", pairingRevision: 1 };
const account = { id: "codex.json", provider: "codex", label: "Account", disabled: false, updatedAt: "2026-09-05T12:00:00Z", reservePercent: 3 };
const grants = ["prism:accounts:read", "prism:accounts:write", "prism:settings:read", "prism:settings:write"];
function fixture() {
  let status = 200;
  let revision = "a";
  const writes: RequestInit[] = [];
  let nextRead: (() => Promise<Response>) | undefined;
  const http = remoteHttpClientLayer((async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/identity") return Response.json({ contractVersion: 1, subject: "owner", role: "member", permissions: grants, authorizationRevision: "1", authorizationExpiresAt: 4070908800000 });
    if (path === "/v1/prism/discovery") return Response.json({ contractVersion: 1, selectionRevision: 1, service: { ...binding, displayName: "PC", apiOrigin: "https://pc.example.test", inferenceOrigin: "https://pc.example.test", status: "paired", protocolVersion: 1, publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    if (init?.method && init.method !== "GET") { writes.push(init); return new Response("private failure", { status: status === 200 ? 409 : status }); }
    if (nextRead) { const read = nextRead; nextRead = undefined; return read(); }
    if (status !== 200) return new Response("private failure", { status });
    if (path === "/prism/v1/accounts") return Response.json({ ...binding, settingsRevision: revision, accounts: [account] });
    return Response.json({ ...binding, settingsRevision: revision, settings });
  }) satisfies typeof fetch);
  const layer = Layer.merge(http, Layer.succeed(Crypto.Crypto, Crypto.make({ randomBytes: (size) => new Uint8Array(size), digest: () => Effect.die("unused") })));
  return { layer, writes, input: {
    baseUrl: "https://identity.example.test", getToken: () => Effect.succeed("fixture"),
    expectedService: { id: "pc-prism", pairingRevision: 1, apiUrl: "https://pc.example.test" },
  }, fail: (code: number) => { status = code; }, revise: () => { revision = "b"; }, hold: (read: () => Promise<Response>) => { nextRead = read; } };
}

describe("Prism management view lifecycle", () => {
  it.effect("does not queue or retry a conflicting edit", () => Effect.gen(function* () {
    const h = fixture();
    yield* Effect.gen(function* () {
      const run = yield* testRunner;
      const controller = createMicPrismManagementController({ input: h.input, permissions: grants, run });
      controller.activate();
      yield* Effect.promise(() => controller.refresh());
      yield* Effect.promise(() => controller.setSettings(settings, "a"));
      expect(controller.getSnapshot().error).toContain("changed since");
      expect(h.writes).toHaveLength(1);
      yield* Effect.promise(() => controller.setSettings(settings, "a"));
      expect(h.writes).toHaveLength(1);
      h.revise();
      yield* Effect.promise(() => controller.refresh());
      expect(controller.getSnapshot().settings?.settingsRevision).toBe("b");
      expect(h.writes).toHaveLength(1);
      controller.dispose();
    }).pipe(Effect.provide(h.layer));
  }));

  it.effect("discards an account response that arrives after permission revocation", () => Effect.gen(function* () {
    const h = fixture();
    yield* Effect.gen(function* () {
      const run = yield* testRunner;
      const controller = createMicPrismManagementController({ input: h.input, permissions: grants, run });
      let entered!: () => void;
      let release!: (response: Response) => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const response = new Promise<Response>((resolve) => { release = resolve; });
      h.hold(() => { entered(); return response; });
      controller.activate();
      const loading = controller.refresh();
      yield* Effect.promise(() => started);
      controller.updatePermissions(["prism:settings:read"]);
      release(Response.json({ ...binding, settingsRevision: "a", accounts: [account] }));
      yield* Effect.promise(() => loading);
      expect(controller.getSnapshot().accounts).toBeNull();
      expect(controller.getSnapshot().loading).toBe(false);
      controller.dispose();
    }).pipe(Effect.provide(h.layer));
  }));

  it.effect("retains last known state while offline and disables writes until an explicit fresh read", () => Effect.gen(function* () {
    const h = fixture();
    yield* Effect.gen(function* () {
      const run = yield* testRunner;
      const controller = createMicPrismManagementController({ input: h.input, permissions: grants, run });
      controller.activate();
      yield* Effect.promise(() => controller.refresh());
      expect(controller.getSnapshot().accounts?.accounts).toEqual([account]);
      h.fail(503);
      yield* Effect.promise(() => controller.refresh());
      expect(controller.getSnapshot().accounts?.accounts).toEqual([account]);
      expect(controller.getSnapshot().error).toBeTruthy();
      yield* Effect.promise(() => controller.deleteAccount(account.id, "a"));
      expect(h.writes).toHaveLength(0);
      h.fail(200); h.revise();
      yield* Effect.promise(() => controller.refresh());
      expect(controller.getSnapshot().accounts?.settingsRevision).toBe("b");
      expect(controller.getSnapshot().error).toBeNull();
      controller.dispose();
    }).pipe(Effect.provide(h.layer));
  }));

  it.effect("drops cached account details when read permission is removed", () => Effect.gen(function* () {
    const h = fixture();
    yield* Effect.gen(function* () {
      const run = yield* testRunner;
      const controller = createMicPrismManagementController({ input: h.input, permissions: grants, run });
      controller.activate();
      yield* Effect.promise(() => controller.refresh());
      controller.updatePermissions(["prism:settings:read"]);
      expect(controller.getSnapshot().accounts).toBeNull();
      expect(controller.getSnapshot().settings?.settings).toEqual(settings);
      yield* Effect.promise(() => controller.deleteAccount(account.id, "a"));
      expect(h.writes).toHaveLength(0);
      controller.dispose();
    }).pipe(Effect.provide(h.layer));
  }));

  it.effect("can reactivate after disposal without retaining a stuck loading state", () => Effect.gen(function* () {
    const h = fixture();
    yield* Effect.gen(function* () {
      const run = yield* testRunner;
      const controller = createMicPrismManagementController({ input: h.input, permissions: grants, run });
      controller.activate();
      const loading = controller.refresh();
      controller.dispose();
      yield* Effect.promise(() => loading);
      controller.activate();
      yield* Effect.promise(() => controller.refresh());
      expect(controller.getSnapshot().loading).toBe(false);
      expect(controller.getSnapshot().accounts?.accounts).toEqual([account]);
      controller.dispose();
    }).pipe(Effect.provide(h.layer));
  }));
});
