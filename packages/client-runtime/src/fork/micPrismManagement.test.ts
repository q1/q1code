import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  cancelMicPrismLogin,
  completeMicPrismLogin,
  deleteMicPrismAccount,
  getMicPrismAccounts,
  getMicPrismAvailability,
  getMicPrismSettings,
  patchMicPrismAccount,
  setMicPrismSettings,
  startMicPrismLogin,
} from "./micPrismManagement.ts";

const binding = { serviceInstanceId: "prism-pc", pairingRevision: 1 };
const state = { ...binding, settingsRevision: "revision-a" };
const operationId = "3d41b5ed-5f6e-4ca2-8064-9d0bb44690f0";
const settings = {
  strategy: "reset-priority" as const,
  sessionAffinity: false,
  requestRetry: 3,
  maxRetryInterval: 30,
};
const account = {
  id: "codex.json",
  provider: "codex",
  label: "Account",
  disabled: false,
  updatedAt: "2026-09-05T12:00:00Z",
  reservePercent: 3,
};
const permissions = [
  "prism:inference",
  "prism:accounts:read",
  "prism:accounts:write",
  "prism:settings:read",
  "prism:settings:write",
];
function harness(
  options: {
    permissions?: ReadonlyArray<string>;
    response?: () => Response;
    mutate?: () => void;
  } = {},
) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let current = true;
  const http = remoteHttpClientLayer(((url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith("/v1/identity"))
      return Promise.resolve(
        Response.json({
          contractVersion: 1,
          subject: "user",
          role: "member",
          permissions: options.permissions ?? permissions,
          authorizationRevision: "auth-1",
          authorizationExpiresAt: 4_070_908_800_000,
        }),
      );
    if (String(url).endsWith("/v1/prism/discovery"))
      return Promise.resolve(
        Response.json({
          contractVersion: 1,
          selectionRevision: 1,
          service: {
            ...binding,
            displayName: "PC Prism",
            apiOrigin: "https://prism.example.test",
            inferenceOrigin: "https://prism.example.test",
            protocolVersion: 1,
            publicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            status: "paired",
          },
        }),
      );
    options.mutate?.();
    return Promise.resolve(options.response?.() ?? Response.json({ ...state, settings }));
  }) satisfies typeof fetch);
  const layer = Layer.merge(
    http,
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: () => Effect.die("unused"),
      }),
    ),
  );
  const input = {
    baseUrl: "https://identity.example.test",
    getToken: () => Effect.succeed("fixture-token"),
    isCurrent: () => current,
    expectedService: { id: "prism-pc", pairingRevision: 1, apiUrl: "https://prism.example.test" },
    expectedSettingsRevision: state.settingsRevision,
    operationId,
  };
  return {
    layer,
    input,
    requests,
    revoke: () => {
      current = false;
    },
  };
}
const body = (request: { init: RequestInit } | undefined) => {
  const value = request?.init.body;
  return JSON.parse(
    typeof value === "string" ? value : new TextDecoder().decode(value as Uint8Array),
  );
};

describe("Prism independent management", () => {
  it.effect("binds a single settings change to the observed host and revision", () =>
    Effect.gen(function* () {
      const receipt = {
        ...state,
        settingsRevision: "revision-b",
        operationId,
        status: "applied",
        settings,
      };
      const h = harness({ response: () => Response.json(receipt) });
      expect(
        yield* setMicPrismSettings({ ...h.input, settings }).pipe(Effect.provide(h.layer)),
      ).toEqual(receipt);
      expect(body(h.requests.at(-1))).toEqual({
        ...binding,
        operationId,
        expectedSettingsRevision: "revision-a",
        settings,
      });
      expect(h.requests.at(-1)?.init).toMatchObject({
        method: "PUT",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      expect(h.requests).toHaveLength(3);
    }),
  );

  it.effect("never promotes inference or account grants to settings administration", () =>
    Effect.gen(function* () {
      for (const grant of ["prism:inference", "prism:accounts:write", "prism:settings:read"]) {
        const h = harness({ permissions: [grant] });
        expect(
          yield* setMicPrismSettings({ ...h.input, settings }).pipe(
            Effect.provide(h.layer),
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "MicIdentityForbiddenError", capability: "prism:settings:write" });
        expect(h.requests).toHaveLength(1);
      }
    }),
  );

  it.effect("surfaces a revision conflict without replay or shared management fallback", () =>
    Effect.gen(function* () {
      const h = harness({
        response: () =>
          Response.json(
            { error: { code: "prism_settings_conflict", secret: "must-not-appear" } },
            { status: 409 },
          ),
      });
      const failure = yield* setMicPrismSettings({ ...h.input, settings }).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(failure).toMatchObject({ _tag: "MicPrismManagementError", reason: "conflict" });
      expect(failure.message).not.toContain("must-not-appear");
      expect(h.requests.filter((r) => r.init.method === "PUT")).toHaveLength(1);
    }),
  );

  it.effect("rejects wrong-target, wrong-operation and mismatched applied-value receipts", () =>
    Effect.gen(function* () {
      for (const patch of [
        { serviceInstanceId: "spark" },
        { pairingRevision: 2 },
        { operationId: "09bcb456-2254-46a0-a820-0e19cecd27c3" },
        { settings: { ...settings, requestRetry: 1 } },
      ]) {
        const h = harness({
          response: () =>
            Response.json({ ...state, operationId, status: "applied", settings, ...patch }),
        });
        expect(
          yield* setMicPrismSettings({ ...h.input, settings }).pipe(
            Effect.provide(h.layer),
            Effect.flip,
          ),
        ).toHaveProperty("_tag");
        expect(h.requests.filter((r) => r.init.method === "PUT")).toHaveLength(1);
      }
    }),
  );

  it.effect("retains reserve-off and verifies account removal readback", () =>
    Effect.gen(function* () {
      const h = harness({
        response: () =>
          Response.json({
            ...state,
            operationId,
            status: "applied",
            accounts: [{ ...account, reservePercent: null }],
          }),
      });
      yield* patchMicPrismAccount({
        ...h.input,
        id: account.id,
        patch: { reservePercent: null },
      }).pipe(Effect.provide(h.layer));
      expect(body(h.requests.at(-1)).patch).toEqual({ reservePercent: null });
      expect(
        yield* deleteMicPrismAccount({ ...h.input, id: account.id }).pipe(
          Effect.provide(h.layer),
          Effect.flip,
        ),
      ).toMatchObject({ reason: "unconfirmed" });
    }),
  );

  it.effect("validates finite settings, reserves and account paths before networking", () =>
    Effect.gen(function* () {
      const h = harness();
      for (const effect of [
        setMicPrismSettings({ ...h.input, settings: { ...settings, maxRetryInterval: 301 } }),
        patchMicPrismAccount({ ...h.input, id: "../credential.json", patch: { disabled: true } }),
        patchMicPrismAccount({ ...h.input, id: account.id, patch: { reservePercent: 101 } }),
      ])
        expect(yield* effect.pipe(Effect.provide(h.layer), Effect.flip)).toMatchObject({
          reason: "invalid-input",
        });
      expect(h.requests).toHaveLength(0);
    }),
  );

  it.effect("discards responses after the initiating identity changes", () =>
    Effect.gen(function* () {
      const h = harness({ mutate: () => h.revoke() });
      expect(
        yield* getMicPrismSettings(h.input).pipe(Effect.provide(h.layer), Effect.flip),
      ).toMatchObject({ _tag: "MicIdentityUnauthorizedError", reason: "revoked-session" });
    }),
  );

  it.effect(
    "keeps model availability separate from account identities and checks read permissions",
    () =>
      Effect.gen(function* () {
        const aggregate = {
          ...binding,
          observedAt: account.updatedAt,
          models: [
            {
              id: "gpt-fixture",
              provider: "codex",
              available: false,
              usableAccounts: 0,
              warnings: ["prism_soft_reserve"],
            },
          ],
        };
        const h = harness({
          permissions: ["prism:inference"],
          response: () => Response.json(aggregate),
        });
        expect(yield* getMicPrismAvailability(h.input).pipe(Effect.provide(h.layer))).toEqual(
          aggregate,
        );
        expect(
          yield* getMicPrismAccounts(h.input).pipe(Effect.provide(h.layer), Effect.flip),
        ).toMatchObject({ capability: "prism:accounts:read" });
      }),
  );

  it.effect("uses the central login/callback/cancel contract with a fresh revision", () =>
    Effect.gen(function* () {
      const started = {
        ...state,
        operationId,
        sessionId: "login-session",
        authUrl: "https://provider.example.test/login",
        flow: "device",
        userCode: "CODE",
      };
      const h = harness({ response: () => Response.json(started) });
      expect(
        yield* startMicPrismLogin({ ...h.input, provider: "codex" }).pipe(Effect.provide(h.layer)),
      ).toEqual(started);
      expect(body(h.requests.at(-1)).provider).toBe("codex");
      for (const [operation, status] of [
        [completeMicPrismLogin, "completed"],
        [cancelMicPrismLogin, "cancelled"],
      ] as const) {
        const login = harness({
          response: () =>
            Response.json({ ...state, operationId, sessionId: "login-session", status }),
        });
        yield* operation({
          ...login.input,
          expectedSettingsRevision: "revision-new",
          sessionId: "login-session",
          redirectUrl: "http://localhost/callback?code=fixture",
        }).pipe(Effect.provide(login.layer));
        expect(body(login.requests.at(-1)).expectedSettingsRevision).toBe("revision-new");
      }
    }),
  );
});
