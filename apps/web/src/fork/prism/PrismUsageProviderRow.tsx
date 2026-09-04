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
import { readForkFlag } from "@t3tools/client-runtime/fork";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

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
