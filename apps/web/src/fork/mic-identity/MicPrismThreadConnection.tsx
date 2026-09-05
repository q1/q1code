import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useParams } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { PlugIcon, UnplugIcon } from "lucide-react";
import * as Option from "effect/Option";
import { usePreparedConnection } from "~/state/session";
import { useAtomValue } from "@effect/atom-react";
import { readForkFlag } from "@t3tools/client-runtime/fork";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { usePrismApi, describePrismCallError } from "../prism/usePrismApi";
import {
  micIdentityGeneration,
  micIdentitySessionSnapshot,
  subscribeMicIdentity,
} from "./micIdentitySession";
import { useMicIdentityConfig } from "./useMicIdentityConfig";
import { createMicPrismThreadConnections, micPrismThreadKey } from "./micPrismThreadConnections";

type Connections = ReturnType<typeof createMicPrismThreadConnections>;
/** Each connected thread retains its own environment and initiating human session. */
export function MicPrismThreadConnection() {
  const params = useParams({ strict: false });
  const environmentId = params.environmentId ? EnvironmentId.make(params.environmentId) : null;
  const threadId = params.threadId;
  const api = usePrismApi(environmentId);
  const source = Option.getOrNull(usePreparedConnection(environmentId));
  const { config } = useMicIdentityConfig();
  const { environments } = useEnvironments();
  const generation = useSyncExternalStore(subscribeMicIdentity, micIdentityGeneration);
  const session = useSyncExternalStore(subscribeMicIdentity, micIdentitySessionSnapshot);
  const connections = useMemo(
    () =>
      createMicPrismThreadConnections(
        () => micIdentityGeneration() === generation,
        describePrismCallError,
      ),
    [generation],
  );
  const states = useSyncExternalStore(connections.subscribe, connections.snapshot);
  const key = environmentId && threadId ? micPrismThreadKey(environmentId, threadId) : null;
  const state = key ? states.get(key) : undefined;
  const connected = state?.status === "connected";
  const pending = state?.status === "connecting" || state?.status === "disconnecting";

  useEffect(() => {
    connections.activate();
    const timer = window.setInterval(() => void connections.renew(), 45_000);
    return () => {
      window.clearInterval(timer);
      void connections.dispose();
    };
  }, [connections]);
  const known = new Set(environments.map((environment) => String(environment.environmentId)));
  const ownedEnvironments = connections.environments();
  useEffect(() => {
    for (const owned of connections.environments())
      if (!environments.some((environment) => String(environment.environmentId) === owned))
        connections.updateEnvironment(owned, null, null);
  }, [connections, environments]);

  return (
    <>
      {ownedEnvironments
        .filter((id) => known.has(id))
        .map((id) => (
          <ThreadEnvironmentObserver
            key={id}
            environmentId={EnvironmentId.make(id)}
            connections={connections}
            config={config}
          />
        ))}
      {key && api && threadId && environmentId && session.status === "signed-in" ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            disabled={pending || !config}
            onClick={() => {
              if (connected || state?.status === "error")
                void connections.disconnect(environmentId, threadId);
              else if (config)
                void connections.connect(environmentId, threadId, api, config, source);
            }}
            tooltip={
              state?.error ??
              (connected
                ? "Disconnect Prism from this thread"
                : "Use your mic.sc Prism access for this coding thread")
            }
          >
            {connected ? <UnplugIcon /> : <PlugIcon />}
            <span>
              {state?.status === "disconnecting"
                ? "Disconnecting Prism…"
                : pending
                  ? "Connecting Prism…"
                  : connected
                    ? "Prism connected"
                    : state?.status === "error"
                      ? "Clear Prism connection"
                      : "Connect thread to Prism"}
            </span>
          </SidebarMenuButton>
          {state?.error ? (
            <p role="alert" className="px-2 py-1 text-xs text-destructive">
              {state.error}
            </p>
          ) : null}
        </SidebarMenuItem>
      ) : null}
    </>
  );
}

function ThreadEnvironmentObserver({
  environmentId,
  connections,
  config,
}: {
  environmentId: EnvironmentId;
  connections: Connections;
  config: ReturnType<typeof useMicIdentityConfig>["config"];
}) {
  const api = usePrismApi(environmentId);
  const source = Option.getOrNull(usePreparedConnection(environmentId));
  const server = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const enabled = readForkFlag(server?.environment.capabilities, "mic-identity");
  useEffect(() => {
    connections.updateEnvironment(environmentId, enabled ? api : null, config, source);
  }, [api, config, connections, enabled, environmentId, source]);
  return null;
}
