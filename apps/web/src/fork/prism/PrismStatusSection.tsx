import type { PrismStatus } from "@q1code/core/prismApi";

import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";

import {
  PRISM_MODE_LABELS,
  describePrismEngine,
  describePrismMode,
  resolvePrismMode,
  summarizePrismStatus,
} from "./prismAccountsState";
import { PrismStateBadge, CopyValueButton, MonoValue } from "./prismUi";

export function PrismStatusSection({
  status,
  receivedAt,
  statusError,
  canRestart,
  restarting,
  onRestart,
}: {
  readonly status: PrismStatus | null;
  /** When `status` arrived; the "for 3m" label counts from here, so it moves with each poll. */
  readonly receivedAt: number;
  readonly statusError: string | null;
  readonly canRestart: boolean;
  readonly restarting: boolean;
  readonly onRestart: () => void;
}) {
  const mode = status === null ? null : resolvePrismMode(status);
  return (
    <SettingsSection {...searchableSetting("prism-status")}>
      <SettingsRow
        title="State"
        description="Prism is the account proxy on the primary environment. Claude and Codex instances that route through it share one pool of accounts."
        status={
          statusError ? (
            <span className="text-destructive">{statusError}</span>
          ) : status ? (
            summarizePrismStatus(status, receivedAt)
          ) : (
            "Checking the proxy…"
          )
        }
        control={status ? <PrismStateBadge state={status.state} /> : null}
      />
      <SettingsRow
        title="Mode"
        description={mode === null ? undefined : describePrismMode(mode)}
        control={<MonoValue>{mode === null ? "—" : PRISM_MODE_LABELS[mode]}</MonoValue>}
      />
      <SettingsRow
        title="Base URL"
        description="The origin provider CLIs are pointed at while the proxy is ready."
        control={
          status?.baseUrl ? (
            <>
              <MonoValue className="max-w-72">{status.baseUrl}</MonoValue>
              <CopyValueButton value={status.baseUrl} label="Copy base URL" />
            </>
          ) : (
            <MonoValue muted>Not published until ready</MonoValue>
          )
        }
      />
      <SettingsRow
        title="Engine"
        description={
          mode === "external"
            ? "The CLIProxyAPI release the external proxy reports through its management API."
            : "The CLIProxyAPI release bundled with q1code."
        }
        control={<MonoValue>{status ? describePrismEngine(status) : "—"}</MonoValue>}
      />
      {status?.lastError ? (
        <SettingsRow
          title="Last error"
          description={
            <span className="font-mono whitespace-pre-wrap break-all text-destructive">
              {status.lastError}
            </span>
          }
        />
      ) : null}
      <SettingsRow
        {...searchableSetting("prism-restart")}
        description={
          mode === "external"
            ? "Probes the external proxy again and reloads accounts once it answers."
            : "Stops the sidecar and starts it again. Requests routed through Prism fail until it is ready."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!canRestart || restarting || status === null}
            onClick={onRestart}
          >
            {restarting ? "Restarting…" : "Restart"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
