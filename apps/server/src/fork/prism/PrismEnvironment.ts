/**
 * Process-wide handoff between the proxy service and the provider seams. There
 * is exactly one proxy per server process (the sidecar or the configured
 * external one), and the seams run in fibers whose context predates it
 * (provider adapters are built before it is ready), so the endpoint is
 * published here instead of through the Effect context. Set only while the
 * proxy is ready; cleared on every other state.
 *
 * The same handoff feeds upstream's usage-limit sources: while the proxy is
 * ready and `prism.usageSource` is on, `withPrismUsageLimitSource` adds one
 * `cliproxy` entry pointing at the proxy with its management secret, so the
 * pooled accounts show on the Limits view like a hub the user added by hand.
 */
import { PRISM_USAGE_SOURCE_ID, PRISM_USAGE_SOURCE_LABEL } from "@q1code/core/prismApi";
import { type UsageLimitSourceConfig, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface PrismEndpoint {
  /** The proxy origin: `http://127.0.0.1:<port>` for the sidecar, `prism.external.baseUrl` otherwise. No trailing slash. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Server-only: the usage-limit source reads quota with it. Never crosses the wire. */
  readonly managementSecret: string;
  /** `prism.usageSource`: whether the pooled accounts are published to the Limits view. */
  readonly usageSource: boolean;
}

export type PrismUsageLimitSourceEntry = readonly [UsageLimitSourceId, UsageLimitSourceConfig];

let published: PrismEndpoint | undefined;

/** Emits the usage-limit source entry (or its absence) each time it changes with the published endpoint. */
const usageSourcePubSub = Effect.runSync(
  PubSub.unbounded<PrismUsageLimitSourceEntry | undefined>(),
);

const sameEntry = (
  left: PrismUsageLimitSourceEntry | undefined,
  right: PrismUsageLimitSourceEntry | undefined,
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left[1].url === right[1].url &&
    left[1].managementKey === right[1].managementKey);

export const publishPrismEndpoint = (endpoint: PrismEndpoint | undefined): void => {
  const before = prismUsageLimitSource();
  published = endpoint;
  const after = prismUsageLimitSource();
  if (!sameEntry(before, after)) PubSub.publishUnsafe(usageSourcePubSub, after);
};

export const currentPrismEndpoint = (): PrismEndpoint | undefined => published;

/**
 * Fires whenever the Prism usage-limit source appears, disappears, or points
 * somewhere else (a republished endpoint or the `prism.usageSource` toggle).
 * `UsageLimitSources` re-reads its sources on each emission.
 */
export const prismUsageSourceChanges: Stream.Stream<PrismUsageLimitSourceEntry | undefined> =
  Stream.fromPubSub(usageSourcePubSub);

/** The `UsageLimitSources.ts` seam: run `refresh` on every emission of `prismUsageSourceChanges` for the life of the scope. */
export const refreshOnPrismUsageSourceChange = (
  refresh: Effect.Effect<void>,
): Effect.Effect<void, never, Scope.Scope> =>
  Stream.runForEach(prismUsageSourceChanges, () => refresh).pipe(Effect.forkScoped, Effect.asVoid);

/** The `usageLimitSources` entry for the proxy; defined only while it is ready and `prism.usageSource` is on. */
export const prismUsageLimitSource = (): PrismUsageLimitSourceEntry | undefined => {
  const endpoint = published;
  if (endpoint === undefined || !endpoint.usageSource) return undefined;
  return [
    UsageLimitSourceId.make(PRISM_USAGE_SOURCE_ID),
    {
      kind: "cliproxy",
      label: PRISM_USAGE_SOURCE_LABEL,
      url: endpoint.baseUrl,
      managementKey: endpoint.managementSecret,
      enabled: true,
    },
  ];
};

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * The `UsageLimitSources.ts` seam. Appends the Prism entry to the user's
 * configured sources, unless one of them already targets the same origin (the
 * user added the proxy as a hub by hand) or reuses the Prism id. Returns
 * `entries` itself (same array) whenever nothing is added, so with the flag
 * off upstream's refresh sees exactly what it computed.
 */
export const withPrismUsageLimitSource = <E extends readonly [string, UsageLimitSourceConfig]>(
  entries: ReadonlyArray<E>,
): ReadonlyArray<E | PrismUsageLimitSourceEntry> => {
  const prism = prismUsageLimitSource();
  if (prism === undefined) return entries;
  const origin = originOf(prism[1].url);
  const duplicate = entries.some(
    ([id, config]) => id === prism[0] || (origin !== undefined && originOf(config.url) === origin),
  );
  return duplicate ? entries : [...entries, prism];
};

/**
 * The `ClaudeHome.ts` seam. Returns `env` itself (same object) when the proxy is
 * not ready so flags-off behaviour is byte-identical, otherwise a copy that
 * points Claude Code at the proxy. `ANTHROPIC_AUTH_TOKEN` is the bearer form
 * Claude Code sends as `Authorization`, which is what CLIProxyAPI expects.
 */
export const withPrismClaudeEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const endpoint = published;
  if (endpoint === undefined) return env;
  return {
    ...env,
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ANTHROPIC_AUTH_TOKEN: endpoint.apiKey,
  };
};
