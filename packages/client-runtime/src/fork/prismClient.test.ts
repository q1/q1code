import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
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
