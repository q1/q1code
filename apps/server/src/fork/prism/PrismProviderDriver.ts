import { expandHomePath } from "../../pathExpansion.ts";
import type { ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import type { ProviderDriver } from "../../provider/ProviderDriver.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { ServerConfig } from "../../config.ts";
import { materializeCodexProxyHome } from "./CodexProxyHome.ts";
import { currentPrismEndpoint, isPrismEnabled, prismEndpointChanges } from "./PrismEnvironment.ts";
import { withPrismRouteOption } from "./PrismRouting.ts";
import { makePrismRoutedAdapter } from "./PrismRoutedAdapter.ts";

/** Decorate existing Claude/Codex drivers; retain their native auth and maintenance paths. */
export const withPrismProvider = <Config extends { readonly homePath: string }, R>(
  driver: ProviderDriver<Config, R>,
): ProviderDriver<
  Config,
  R | Path.Path | FileSystem.FileSystem | ServerConfig | Crypto.Crypto
> => ({
  ...driver,
  create: (input) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<
        R | Path.Path | FileSystem.FileSystem | ServerConfig | Scope.Scope
      >();
      const path = yield* Path.Path;
      const { baseDir } = yield* ServerConfig;
      const direct = yield* driver.create(input);
      const lock = yield* Semaphore.make(1);
      let cached: { baseUrl: string; apiKey: string; instance: typeof direct } | undefined;
      const proxy = () =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const endpoint = currentPrismEndpoint();
            if (!endpoint) return undefined;
            if (cached?.baseUrl === endpoint.baseUrl && cached.apiKey === endpoint.apiKey)
              return cached.instance.adapter;
            let config = input.config;
            const environment = [...input.environment];
            if (driver.driverKind === "claudeAgent") {
              // Environment values are process-local and never persisted in provider settings.
              environment.push(
                { name: "ANTHROPIC_BASE_URL", value: endpoint.baseUrl, sensitive: false },
                { name: "ANTHROPIC_AUTH_TOKEN", value: endpoint.apiKey, sensitive: true },
                { name: "ANTHROPIC_API_KEY", value: "", sensitive: true },
                { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: true },
              );
            } else {
              // A separate home per instance preserves its selected direct account and native history.
              const homeDir = path.join(
                baseDir,
                "prism",
                "providers",
                encodeURIComponent(input.instanceId),
                "codex-home",
              );
              yield* materializeCodexProxyHome({
                homeDir,
                endpoint,
                ...(input.config.homePath
                  ? { sharedHomeDir: path.resolve(expandHomePath(input.config.homePath)) }
                  : {}),
              });
              config = { ...config, homePath: homeDir, shadowHomePath: "" };
            }
            const instance = yield* driver.create({ ...input, config, environment });
            cached = { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, instance };
            return instance.adapter;
          }).pipe(
            Effect.provide(context),
            Effect.mapError(
              () =>
                new ProviderAdapterRequestError({
                  provider: driver.driverKind,
                  method: "prism.setup",
                  detail: "Could not prepare the Prism provider connection.",
                }),
            ),
          ),
        );
      const adapter = yield* makePrismRoutedAdapter({
        direct: direct.adapter,
        enabled: isPrismEnabled,
        proxy,
      });
      const decorate = (snapshot: ServerProvider) =>
        withPrismRouteOption(
          isPrismEnabled() && currentPrismEndpoint() && snapshot.enabled && snapshot.installed
            ? {
                ...snapshot,
                status: "ready",
                auth: { status: "authenticated", type: "prism", label: "Prism pool" },
                message: "Prism pool with local direct-provider fallback",
              }
            : snapshot,
          isPrismEnabled(),
        );
      return {
        ...direct,
        adapter,
        snapshot: {
          ...direct.snapshot,
          getSnapshot: direct.snapshot.getSnapshot.pipe(Effect.map(decorate)),
          refresh: direct.snapshot.refresh.pipe(Effect.map(decorate)),
          streamChanges: Stream.merge(
            direct.snapshot.streamChanges,
            prismEndpointChanges.pipe(Stream.mapEffect(() => direct.snapshot.getSnapshot)),
          ).pipe(Stream.map(decorate)),
        },
        ...(direct.snapshotForCwd
          ? {
              snapshotForCwd: (cwd: string) =>
                direct.snapshotForCwd!(cwd).pipe(Effect.map(decorate)),
            }
          : {}),
      };
    }),
});
