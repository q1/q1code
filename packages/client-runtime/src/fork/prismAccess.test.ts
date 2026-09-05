import { describe, expect, it } from "@effect/vitest";
import type { PrismStatus } from "@q1code/core/prismApi";

import { INITIAL_PRISM_HEALTH, reducePrismHealth, resolvePrismAccess } from "./prismAccess.ts";

const status: PrismStatus = { state: "ready", role: "primary", port: 8317 };
const admin = { authenticated: true, scopes: ["orchestration:read", "access:write"] };
const received = (value = status) =>
  reducePrismHealth(INITIAL_PRISM_HEALTH, { type: "received", status: value, receivedAt: 100 });

describe("Prism client access", () => {
  it("preserves the last known state after a failed probe but disables every mutation until recovery", () => {
    const live = received();
    const failed = reducePrismHealth(live, { type: "failed", error: "Connection refused" });
    expect(failed.status).toBe(status);
    expect(failed.receivedAt).toBe(100);
    const offline = resolvePrismAccess({ health: failed, connected: true, session: admin });
    expect(offline).toMatchObject({
      live: false,
      inference: false,
      manage: false,
      configure: false,
      routing: false,
      accounts: false,
    });
    const recovered = reducePrismHealth(failed, { type: "received", status, receivedAt: 200 });
    expect(recovered.error).toBeNull();
    expect(
      resolvePrismAccess({ health: recovered, connected: true, session: admin }),
    ).toMatchObject({ configure: true, routing: true, accounts: true });
  });

  it("never treats a successful read as permission to write on a legacy server", () => {
    const access = resolvePrismAccess({
      health: received(),
      connected: true,
      session: { authenticated: true, scopes: ["orchestration:read"] },
    });
    expect(access).toMatchObject({
      accountDetails: true,
      manage: false,
      configure: false,
      routing: false,
      accounts: false,
    });
  });

  it.each([null, { authenticated: false, scopes: admin.scopes }, { authenticated: true }])(
    "keeps legacy management disabled before write scopes are known: %j",
    (session) => {
      expect(resolvePrismAccess({ health: received(), connected: true, session }).manage).toBe(
        false,
      );
    },
  );

  it("uses identity capabilities for Prism management while keeping local configuration behind access:write", () => {
    const access = resolvePrismAccess({
      health: received({
        ...status,
        capabilities: { inference: true, manage: true, accountDetails: true },
      }),
      connected: true,
      session: { authenticated: true, scopes: ["orchestration:read"] },
    });
    expect(access).toMatchObject({
      inference: true,
      manage: true,
      routing: true,
      accounts: true,
      configure: false,
    });
  });

  it("removes account details and management immediately after the server changes identity permissions", () => {
    const before = received({
      ...status,
      capabilities: { inference: true, manage: true, accountDetails: true },
    });
    const after = reducePrismHealth(before, {
      type: "received",
      status: {
        ...status,
        capabilities: { inference: true, manage: false, accountDetails: false },
      },
      receivedAt: 200,
    });
    expect(resolvePrismAccess({ health: after, connected: true, session: admin })).toMatchObject({
      inference: true,
      accountDetails: false,
      manage: false,
      configure: false,
      accounts: false,
      routing: false,
    });
  });

  it("does not reuse permissions while the environment is disconnected", () => {
    expect(
      resolvePrismAccess({ health: received(), connected: false, session: admin }),
    ).toMatchObject({ live: false, configure: false, accounts: false, routing: false });
  });

  it("allows reconnecting a failed gateway only after a successful authenticated status read", () => {
    expect(
      resolvePrismAccess({
        health: received({ ...status, state: "failed" }),
        connected: true,
        session: admin,
      }),
    ).toMatchObject({ live: true, configure: true, accounts: false, routing: false });
  });

  it("does not allow replica account mutations or sign-in even for an administrator", () => {
    expect(
      resolvePrismAccess({
        health: received({ ...status, role: "replica" }),
        connected: true,
        session: admin,
      }),
    ).toMatchObject({ configure: true, routing: true, accounts: false });
  });

  it("removes local write access when environment authentication refresh fails", () => {
    expect(
      resolvePrismAccess({
        health: received(),
        connected: true,
        session: admin,
        sessionError: true,
      }).configure,
    ).toBe(false);
  });
});
