import type { CliProxyStatus } from "@q1code/core/cliproxyApi";

import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";

import {
  CLIPROXY_MODE_LABELS,
  describeCliProxyMode,
  resolveCliProxyMode,
  summarizeCliProxyStatus,
} from "./cliproxyAccountsState";
import { CliProxyStateBadge, CopyValueButton, MonoValue } from "./cliproxyUi";

export function CliProxyStatusSection({
  status,
  receivedAt,
  statusError,
  canRestart,
  restarting,
  onRestart,
}: {
  readonly status: CliProxyStatus | null;
  /** When `status` arrived; the "for 3m" label counts from here, so it moves with each poll. */
  readonly receivedAt: number;
  readonly statusError: string | null;
  readonly canRestart: boolean;
  readonly restarting: boolean;
  readonly onRestart: () => void;
}) {
  const mode = status === null ? null : resolveCliProxyMode(status);
  return (
    <SettingsSection {...searchableSetting("cliproxy-status")}>
      <SettingsRow
        title="State"
        description="Prism is the CLIProxyAPI gateway on the primary environment. Claude and Codex instances that route through it share one pool of accounts."
        status={
          statusError ? (
            <span className="text-destructive">{statusError}</span>
          ) : status ? (
            summarizeCliProxyStatus(status, receivedAt)
          ) : (
            "Checking the proxy…"
          )
        }
        control={status ? <CliProxyStateBadge state={status.state} /> : null}
      />
      <SettingsRow
        title="Mode"
        description={mode === null ? undefined : describeCliProxyMode(mode)}
        control={<MonoValue>{mode === null ? "—" : CLIPROXY_MODE_LABELS[mode]}</MonoValue>}
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
        title="Version"
        description={
          mode === "external"
            ? "Reported by the external proxy's management API."
            : "The bundled sidecar release."
        }
        control={<MonoValue>{status?.version ? `v${status.version}` : "—"}</MonoValue>}
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
        {...searchableSetting("cliproxy-restart")}
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
