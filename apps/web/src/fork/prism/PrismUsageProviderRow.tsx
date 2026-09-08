/**
 * Prism's row in Settings → Providers → Usage providers (the
 * `UsageProviderSettings.tsx` seam). With the environment's `prism` flag on
 * it is the first row of the list: the managed source, its origin, and
 * whether the pooled accounts reach Usage → Limits, linking to the Prism tab
 * where the toggle lives. It is not removable here. The empty-state row
 * yields to it and renders upstream's text otherwise, so with the flag off
 * the section reads exactly as upstream.
 */
import type { PrismStatus } from "@q1code/core/prismApi";
import {
  getMicIdentityOverview,
  getMicPrismStatus,
  readForkFlag,
} from "@t3tools/client-runtime/fork";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";

import * as Effect from "effect/Effect";
import { runtime } from "~/lib/runtime";
import { useMicIdentityConfig } from "../mic-identity/useMicIdentityConfig";
import {
  micIdentityGeneration,
  micIdentitySessionSnapshot,
  readMicIdentityToken,
  subscribeMicIdentity,
} from "../mic-identity/micIdentitySession";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { useServerConfigs } from "~/state/entities";

import { describePrismUsageProvider } from "./prismAccountsState";
import { useDocumentVisible } from "./prismUi";
import { describePrismCallError, usePrismApi } from "./usePrismApi";

const STATUS_POLL_MS = 10_000;

/** The `prism` flag as that environment's server reports it; off for servers that do not know the flag. */
function useEnvironmentPrismFlag(environmentId: EnvironmentId): boolean {
  const configs = useServerConfigs();
  return readForkFlag(configs.get(environmentId)?.environment.capabilities, "prism");
}

export function PrismUsageProviderRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const enabled = useEnvironmentPrismFlag(environmentId);
  return enabled ? <PrismUsageProviderRowBody environmentId={environmentId} /> : null;
}

function PrismUsageProviderRowBody({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const configs = useServerConfigs();
  return readForkFlag(configs.get(environmentId)?.environment.capabilities, "mic-identity") ? (
    <MicIdentityUsageProviderRow />
  ) : (
    <LegacyPrismUsageProviderRow environmentId={environmentId} />
  );
}

function MicIdentityUsageProviderRow() {
  const { config } = useMicIdentityConfig();
  const generation = useSyncExternalStore(subscribeMicIdentity, micIdentityGeneration);
  const session = useSyncExternalStore(subscribeMicIdentity, micIdentitySessionSnapshot);
  const visible = useDocumentVisible();
  const [view, setView] = useState<{
    generation: number;
    description: string;
    status: string;
  } | null>(null);
  const authority = config?.enabled ? config.authorityUrl : undefined;
  useEffect(() => {
    if (!visible || !authority || session.status !== "signed-in") return;
    const controller = new AbortController();
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const input = {
              baseUrl: authority,
              getToken: readMicIdentityToken,
              isCurrent: () => micIdentityGeneration() === generation,
            };
            const access = yield* getMicIdentityOverview(input);
            const host = access.discovery.service;
            if (!host)
              return { description: "mic.sc Prism", status: "Select a Prism host in settings." };
            if (!access.session.capabilities.inference)
              return {
                description: host.label,
                status: "Your mic.sc account does not have inference access.",
              };
            yield* getMicPrismStatus({ ...input, expectedService: host });
            return {
              description: host.label + " · " + host.apiUrl,
              status: "Prism access verified. Model availability is shown in Prism settings.",
            };
          }),
          { signal: controller.signal },
        );
        if (!controller.signal.aborted && micIdentityGeneration() === generation)
          setView({ generation, ...result });
      } catch {
        if (!controller.signal.aborted && micIdentityGeneration() === generation)
          setView({
            generation,
            description: "mic.sc Prism",
            status: "Prism is unavailable. Open settings to retry.",
          });
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), STATUS_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [authority, generation, session.status, visible]);
  const current = view?.generation === generation ? view : null;
  return (
    <SettingsRow
      title="Prism"
      description={current?.description ?? "mic.sc Prism"}
      status={
        session.status !== "signed-in"
          ? "Sign in to mic.sc to use Prism."
          : (current?.status ?? "Checking Prism access…")
      }
      control={
        <Button size="xs" variant="ghost" render={<Link to="/settings/prism" />}>
          Prism settings
        </Button>
      }
    />
  );
}

function LegacyPrismUsageProviderRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const api = usePrismApi(environmentId);
  const visible = useDocumentVisible();
  const [status, setStatus] = useState<PrismStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same cadence as the Prism tab, and only while the page is visible.
  useEffect(() => {
    if (!visible || api === null) return;
    let cancelled = false;
    const tick = async () => {
      const result = await api.status();
      if (cancelled) return;
      if (result._tag === "error") {
        setError(describePrismCallError(result.error));
        return;
      }
      setError(null);
      setStatus(result.value);
    };
    void tick();
    const interval = window.setInterval(() => void tick(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [visible, api]);

  const view = describePrismUsageProvider(status);
  return (
    <SettingsRow
      title="Prism"
      description={<span className="break-all">{view.description}</span>}
      status={error ? <span className="text-destructive">{error}</span> : view.status}
      control={
        <Button size="xs" variant="ghost" render={<Link to="/settings/prism" />}>
          Prism settings
        </Button>
      }
    />
  );
}

/** Upstream's "No usage providers configured." row, unless Prism fills the list. */
export function UsageProvidersEmptyRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const enabled = useEnvironmentPrismFlag(environmentId);
  return enabled ? null : <SettingsRow title="No usage providers configured." />;
}
