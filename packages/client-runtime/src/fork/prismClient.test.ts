import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  deletePrismAccount,
  getPrismStatus,
  listPrismAccounts,
  patchPrismAccount,
} from "./prismClient.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const prepared = (httpAuthorization: PreparedConnection["httpAuthorization"]) =>
  ({
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    httpBaseUrl: TARGET.httpBaseUrl,
    socketUrl: "wss://environment.example.test/ws",
    httpAuthorization,
    target: TARGET,
  }) satisfies PreparedConnection;

const capture = (respond: (url: string, init: RequestInit) => Response) => {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn = ((request, init) => {
    const url = String(request);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(respond(url, init ?? {}));
  }) satisfies typeof fetch;
  return { calls, layer: remoteHttpClientLayer(fetchFn) };
};

describe("prismClient", () => {
  it.effect("reads status with the bearer credential and decodes the body", () =>
    Effect.gen(function* () {
      const server = capture(() =>
        Response.json({ state: "ready", port: 8317, version: "7.2.147", role: "primary" }),
      );
      const status = yield* getPrismStatus({
        prepared: prepared({ _tag: "Bearer", token: "token-1" }),
        signer: Option.none(),
      }).pipe(Effect.provide(server.layer));
      expect(status).toEqual({ state: "ready", port: 8317, version: "7.2.147", role: "primary" });
      expect(server.calls[0]?.url).toBe("https://environment.example.test/api/fork/prism/status");
      expect(new Headers(server.calls[0]?.init.headers).get("authorization")).toBe(
        "Bearer token-1",
      );
    }),
  );

  it.effect("maps the 503 into PrismUnavailableError with reason and state", () =>
    Effect.gen(function* () {
      const server = capture(() =>
        Response.json(
          { _tag: "PrismUnavailableError", reason: "sidecar-not-ready", state: "starting" },
          { status: 503 },
        ),
      );
      const error = yield* listPrismAccounts({
        prepared: prepared(null),
        signer: Option.none(),
      }).pipe(Effect.provide(server.layer), Effect.flip);
      expect(error._tag).toBe("PrismUnavailableError");
      expect(error._tag === "PrismUnavailableError" && error.reason).toBe("sidecar-not-ready");
      expect(error._tag === "PrismUnavailableError" && error.state).toBe("starting");
      // Primary/local connections send the session cookie.
      expect(server.calls[0]?.init.credentials).toBe("include");
    }),
  );

  it.effect("encodes account ids into the path and sends JSON patches", () =>
    Effect.gen(function* () {
      const server = capture((url) =>
        url.endsWith("/accounts/codex-a%40example.com.json")
          ? Response.json({
              id: "codex-a@example.com.json",
              provider: "codex",
              label: "a@example.com",
              disabled: true,
              updatedAt: "2026-09-02T10:00:00.000Z",
            })
          : Response.json({ _tag: "PrismNotFoundError", id: "x" }, { status: 404 }),
      );
      const account = yield* patchPrismAccount({
        prepared: prepared(null),
        signer: Option.none(),
        id: "codex-a@example.com.json",
        patch: { disabled: true },
      }).pipe(Effect.provide(server.layer));
      expect(account.disabled).toBe(true);
      expect(server.calls[0]?.init.method).toBe("PATCH");
      const body = server.calls[0]?.init.body;
      expect(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)).toBe(
        '{"disabled":true}',
      );

      const missing = yield* deletePrismAccount({
        prepared: prepared(null),
        signer: Option.none(),
        id: "gone.json",
      }).pipe(Effect.provide(server.layer), Effect.flip);
      expect(missing._tag).toBe("PrismNotFoundError");
    }),
  );

  it.effect("passes environment auth errors through as their typed classes", () =>
    Effect.gen(function* () {
      const server = capture(() =>
        Response.json(
          {
            _tag: "EnvironmentScopeRequiredError",
            code: "insufficient_scope",
            requiredScope: "access:write",
            traceId: "trace-1",
          },
          { status: 403 },
        ),
      );
      const error = yield* deletePrismAccount({
        prepared: prepared(null),
        signer: Option.none(),
        id: "a.json",
      }).pipe(Effect.provide(server.layer), Effect.flip);
      expect(error._tag).toBe("EnvironmentScopeRequiredError");
    }),
  );
});

describe("Prism relay credential renewal", () => {
  const relay = {
    ...prepared({ _tag: "Dpop", accessToken: "stale-token", expiresAtEpochMs: 0 }),
    target: new RelayConnectionTarget({ environmentId: TARGET.environmentId, label: TARGET.label }),
  } satisfies PreparedConnection;

  const harness = (respond: (url: string, init: RequestInit) => Response) => {
    const server = capture(respond);
    const proofs: ManagedRelayDpopProofInput[] = [];
    const rejected: (string | undefined)[] = [];
    const authorization = RemoteEnvironmentAuthorization.of({
      authorizeBearer: () => Effect.die("Unexpected bearer preparation"),
      authorizeDpop: () => Effect.die("HTTP renewal must not reconnect the socket"),
      authorizeDpopHttp: (input) =>
        Effect.sync(() => {
          rejected.push(input.rejectedAccessToken);
          const renewed = input.rejectedAccessToken !== undefined;
          return {
            environmentId: TARGET.environmentId,
            label: TARGET.label,
            httpBaseUrl: renewed ? "https://renewed.example.test" : "https://current.example.test",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: renewed ? "renewed-token" : "current-token",
              expiresAtEpochMs: 3_600_000,
            },
          };
        }),
    });
    const signer = ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("test-thumbprint"),
      createProof: (input) =>
        Effect.sync(() => {
          proofs.push(input);
          return `proof-${proofs.length}`;
        }),
    });
    return {
      ...server,
      proofs,
      rejected,
      authorization,
      input: { prepared: relay, signer: Option.some(signer) },
    };
  };
  const unauthorized = () =>
    Response.json(
      {
        _tag: "EnvironmentAuthInvalidError",
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "test-trace",
      },
      { status: 401 },
    );

  it.effect("uses the runtime's current relay credential and origin without reconnecting", () =>
    Effect.gen(function* () {
      const h = harness(() => Response.json({ state: "ready", port: 8317, role: "primary" }));
      const result = yield* getPrismStatus(h.input).pipe(
        Effect.provideService(RemoteEnvironmentAuthorization, h.authorization),
        Effect.provide(h.layer),
      );
      expect(result.state).toBe("ready");
      expect(h.calls[0]?.url).toBe("https://current.example.test/api/fork/prism/status");
      expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe("DPoP current-token");
      expect(h.proofs[0]).toMatchObject({
        url: h.calls[0]?.url,
        method: "GET",
        accessToken: "current-token",
      });
      expect(h.rejected).toEqual([undefined]);
    }),
  );

  it.effect(
    "renews a rejected mutation once and signs its encoded path on the renewed origin",
    () =>
      Effect.gen(function* () {
        const h = harness((url) =>
          url.startsWith("https://current.")
            ? unauthorized()
            : Response.json({
                id: "codex-a@example.com.json",
                provider: "codex",
                label: "test account",
                disabled: true,
                updatedAt: "2026-09-05T00:00:00.000Z",
              }),
        );
        const result = yield* patchPrismAccount({
          ...h.input,
          id: "codex-a@example.com.json",
          patch: { disabled: true },
        }).pipe(
          Effect.provideService(RemoteEnvironmentAuthorization, h.authorization),
          Effect.provide(h.layer),
        );
        expect(result.disabled).toBe(true);
        expect(h.rejected).toEqual([undefined, "current-token"]);
        expect(h.calls.map((call) => call.url)).toEqual([
          "https://current.example.test/api/fork/prism/accounts/codex-a%40example.com.json",
          "https://renewed.example.test/api/fork/prism/accounts/codex-a%40example.com.json",
        ]);
        expect(h.proofs.map((proof) => proof.url)).toEqual(h.calls.map((call) => call.url));
        expect(h.proofs.map((proof) => proof.method)).toEqual(["PATCH", "PATCH"]);
        expect(new Headers(h.calls[1]?.init.headers).get("authorization")).toBe(
          "DPoP renewed-token",
        );
        expect(h.calls[1]?.init.body).toEqual(h.calls[0]?.init.body);
      }),
  );

  it.effect("returns persistent authentication failure after one renewal", () =>
    Effect.gen(function* () {
      const h = harness(unauthorized);
      const error = yield* listPrismAccounts(h.input).pipe(
        Effect.provideService(RemoteEnvironmentAuthorization, h.authorization),
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error._tag).toBe("EnvironmentAuthInvalidError");
      expect(h.calls).toHaveLength(2);
      expect(h.rejected).toEqual([undefined, "current-token"]);
    }),
  );
});
