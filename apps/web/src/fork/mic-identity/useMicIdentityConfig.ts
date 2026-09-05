import type { MicIdentityPublicConfig } from "@q1code/core/micIdentityApi";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useForkFlag } from "../useForkFlag";
import { type PrismApi, usePrismApi } from "../prism/usePrismApi";
import { readMicIdentityBuildConfig } from "./publicConfig";

/** Hosted builds can bootstrap identity before pairing. Server bootstrap retains environment auth. */
export function useMicIdentityConfig() {
  const build = useMemo(() => readMicIdentityBuildConfig(), []);
  const serverEnabled = useForkFlag("mic-identity");
  const api = usePrismApi(undefined, true);
  const [revision, setRevision] = useState(0);
  const [server, setServer] = useState<{
    readonly api: PrismApi;
    readonly revision: number;
    readonly config: MicIdentityPublicConfig | null;
    readonly error: string | null;
  } | null>(null);

  useEffect(() => {
    if (build._tag !== "disabled" || !serverEnabled || !api) return;
    let cancelled = false;
    void api.identityConfig().then((result) => {
      if (cancelled) return;
      setServer({
        api,
        revision,
        config: result._tag === "ok" ? result.value : null,
        error: result._tag === "ok" ? null : "mic.sc sign-in is unavailable on this environment.",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, build, serverEnabled, revision]);

  const source =
    build._tag === "configured"
      ? build.config
      : build._tag === "disabled" &&
          serverEnabled &&
          server?.api === api &&
          server.revision === revision
        ? server.config
        : null;
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return {
    enabled: build._tag !== "disabled" || serverEnabled,
    config: source,
    revision,
    error:
      build._tag === "invalid"
        ? build.error
        : build._tag === "disabled" && serverEnabled && server?.api === api
          ? server.error
          : null,
    retry,
  };
}
