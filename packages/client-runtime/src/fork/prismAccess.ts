import type { PrismStatus } from "@q1code/core/prismApi";

export interface PrismHealth {
  readonly status: PrismStatus | null;
  readonly receivedAt: number;
  readonly error: string | null;
}

export const INITIAL_PRISM_HEALTH: PrismHealth = {
  status: null,
  receivedAt: 0,
  error: null,
};

/** A failed probe preserves the last observation without presenting it as live. */
export function reducePrismHealth(
  state: PrismHealth,
  event:
    | { readonly type: "received"; readonly status: PrismStatus; readonly receivedAt: number }
    | { readonly type: "failed"; readonly error: string },
): PrismHealth {
  return event.type === "received"
    ? { status: event.status, receivedAt: event.receivedAt, error: null }
    : { ...state, error: event.error };
}

/** Request capabilities are authoritative; local environment settings still require access:write. */
export function resolvePrismAccess(input: {
  readonly health: PrismHealth;
  readonly connected: boolean;
  readonly session: {
    readonly authenticated: boolean;
    readonly scopes?: ReadonlyArray<string>;
  } | null;
  readonly sessionError?: boolean;
}) {
  const { status, error } = input.health;
  const live = input.connected && status !== null && error === null;
  const scopes =
    input.session?.authenticated && !input.sessionError ? input.session.scopes : undefined;
  const write = scopes?.includes("access:write") === true;
  const capabilities = status?.capabilities;
  const manage = capabilities?.manage ?? write;
  const details = capabilities?.accountDetails ?? scopes?.includes("orchestration:read") === true;
  const ready = live && status.state === "ready";
  return {
    live,
    inference:
      ready && (capabilities?.inference ?? scopes?.includes("orchestration:read") === true),
    accountDetails: details,
    manage: live && manage,
    configure: live && manage && write,
    routing: ready && manage,
    accounts: ready && manage && details && status.role !== "replica",
  };
}
