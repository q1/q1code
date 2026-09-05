/**
 * The "Prism" section of the Settings root: one "Accounts" row into the Prism
 * screen, shown only while a connected environment has the `prism` flag
 * on. With the flag off everywhere this renders nothing, so Settings matches
 * upstream row for row.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SettingsRow } from "../../features/settings/components/SettingsRow";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  type PrismOverview,
  selectPrismEnvironments,
  summarizePrismOverviews,
} from "./prismSettings.logic";
import { usePrismApi } from "./usePrismApi";

export function PrismSettingsRow() {
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  const targets = useMemo(
    () =>
      selectPrismEnvironments(
        environments,
        (environmentId) => configs.get(environmentId)?.environment.capabilities,
      ),
    [configs, environments],
  );
  const [overviews, setOverviews] = useState<ReadonlyMap<EnvironmentId, PrismOverview>>(
    () => new Map(),
  );
  const handleOverview = useCallback((environmentId: EnvironmentId, overview: PrismOverview) => {
    setOverviews((previous) => new Map(previous).set(environmentId, overview));
  }, []);

  if (targets.length === 0) return null;

  const value = summarizePrismOverviews(
    targets.map((target) => overviews.get(target.environmentId) ?? { _tag: "loading" }),
  );
  return (
    <SettingsSection title="Prism">
      <SettingsRow
        icon="server.rack"
        label="Accounts"
        target="SettingsPrism"
        {...(value ? { value } : {})}
      />
      {targets.map((target) => (
        <OverviewLoader
          key={target.environmentId}
          environmentId={target.environmentId}
          onOverview={handleOverview}
        />
      ))}
    </SettingsSection>
  );
}

/** One status + list fetch per environment on mount; renders nothing. */
function OverviewLoader(props: {
  readonly environmentId: EnvironmentId;
  readonly onOverview: (environmentId: EnvironmentId, overview: PrismOverview) => void;
}) {
  const api = usePrismApi(props.environmentId);
  const { environmentId, onOverview } = props;

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      const status = await api.status();
      const accounts =
        status._tag === "ok" &&
        status.value.state === "ready" &&
        status.value.capabilities?.accountDetails !== false
          ? await api.listAccounts()
          : null;
      if (cancelled) return;
      onOverview(
        environmentId,
        status._tag === "ok"
          ? {
              _tag: "loaded",
              state: status.value.state,
              accountCount: accounts?._tag === "ok" ? accounts.value.length : null,
            }
          : { _tag: "error" },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [api, environmentId, onOverview]);

  return null;
}
