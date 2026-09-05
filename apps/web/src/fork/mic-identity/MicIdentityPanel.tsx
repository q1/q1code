import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as Effect from "effect/Effect";
import {
  getMicIdentityAccess,
  getMicPrismStatus,
  getMicPrismRouting,
  setMicPrismRouting,
} from "@t3tools/client-runtime/fork";
import type { MicIdentityAccess } from "@q1code/core/micIdentityApi";
import type { PrismRoutingStrategy } from "@q1code/core/config";
import { Button } from "~/components/ui/button";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { runtime } from "~/lib/runtime";
import { useMicIdentityConfig } from "./useMicIdentityConfig";
import { useDocumentVisible } from "../prism/prismUi";
import {
  micIdentityGeneration,
  readMicIdentityToken,
  subscribeMicIdentity,
} from "./micIdentitySession";

type View = {
  generation: number;
  access: MicIdentityAccess;
  routing: PrismRoutingStrategy | null;
  receivedAt: number;
};

/** Uses the signed-in service API directly; no environment session is issued by mic.sc identity. */
export function MicIdentityPanel() {
  const { config, error: configError, retry, revision } = useMicIdentityConfig();
  const generation = useSyncExternalStore(subscribeMicIdentity, micIdentityGeneration);
  const visible = useDocumentVisible();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  const mutating = useRef(false);
  const current = view?.generation === generation ? view : null;

  useEffect(() => {
    const authorityUrl = config?.authorityUrl;
    if (!visible || !authorityUrl) return;
    let cancelled = false;
    let loading = false;
    const tick = async () => {
      if (loading || mutating.current) return;
      loading = true;
      const ticket = ++operation.current;
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const input = {
            baseUrl: authorityUrl,
            getToken: readMicIdentityToken,
            isCurrent: () => micIdentityGeneration() === generation,
          };
          const access = yield* getMicIdentityAccess(input);
          yield* getMicPrismStatus(input);
          const routing = access.session.permissions.includes("prism:routing:read")
            ? (yield* getMicPrismRouting(input)).strategy
            : null;
          return { access, routing };
        }).pipe(Effect.result),
      );
      loading = false;
      if (cancelled || ticket !== operation.current) return;
      if (result._tag === "Failure") {
        setError(result.failure.message);
        if (
          result.failure._tag === "MicIdentityUnauthorizedError" ||
          result.failure._tag === "MicIdentityForbiddenError"
        )
          setView(null);
      } else {
        setError(null);
        setView({ ...result.success, generation, receivedAt: Date.now() });
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      operation.current++;
      window.clearInterval(timer);
    };
  }, [config, generation, visible, revision]);

  const changeRouting = async (strategy: PrismRoutingStrategy) => {
    if (
      !current ||
      error ||
      busy ||
      !config?.authorityUrl ||
      !current.access.session.permissions.includes("prism:routing:write")
    )
      return;
    const ticket = ++operation.current;
    const initiatingGeneration = generation;
    setBusy(true);
    mutating.current = true;
    const result = await runtime.runPromise(
      setMicPrismRouting({
        baseUrl: config.authorityUrl,
        getToken: readMicIdentityToken,
        isCurrent: () => micIdentityGeneration() === generation,
        strategy,
      }).pipe(Effect.result),
    );
    mutating.current = false;
    if (ticket !== operation.current || micIdentityGeneration() !== initiatingGeneration) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (result._tag === "Failure") setError(result.failure.message);
    else setView({ ...current, routing: result.success.strategy, receivedAt: Date.now() });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="mic.sc">
        <SettingsRow
          title={current ? "Signed in to mic.sc" : "Sign in to mic.sc"}
          description={
            error ??
            configError ??
            (current
              ? "Your account determines Prism access. Environment and workspace access remain separately authorized."
              : "Use Sign in to mic.sc in the sidebar to discover your Prism service.")
          }
        />
      </SettingsSection>
      {current ? (
        <>
          <SettingsSection title="Prism">
            <SettingsRow
              title={current.access.discovery.service?.label ?? "No paired service"}
              description={
                error
                  ? "Offline — showing the last verified service. Changes are disabled."
                  : "Service access verified. Model availability, usable account counts and provider warnings are not reported by this service yet."
              }
            />
            <SettingsRow
              title="Coding sessions"
              description="Prism routing with mic.sc sign-in is not available for coding sessions yet. Existing direct-provider connections remain available."
            />
            <SettingsRow
              title="Account access"
              description={
                current.access.session.capabilities.accountDetails
                  ? "Prism administrator"
                  : "Inference access"
              }
            />
          </SettingsSection>
          {current.routing !== null ? (
            <SettingsSection title="Routing">
              <SettingsRow
                title="Account selection"
                description="Applied by the paired Prism service. Changing this does not change a thread's selected model."
              >
                <select
                  aria-label="Prism routing strategy"
                  value={current.routing}
                  disabled={
                    busy ||
                    error !== null ||
                    !current.access.session.permissions.includes("prism:routing:write")
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value === "round-robin" ||
                      value === "weighted-round-robin" ||
                      value === "fill-first"
                    )
                      void changeRouting(value);
                  }}
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                >
                  <option value="round-robin">Round robin</option>
                  <option value="weighted-round-robin">Weighted round robin</option>
                  <option value="fill-first">Fill first</option>
                </select>
              </SettingsRow>
            </SettingsSection>
          ) : null}
          {current.access.session.capabilities.accountDetails ? (
            <SettingsSection title="Accounts and settings">
              <SettingsRow
                title="Account management unavailable"
                description="This Prism service does not provide remote account sign-in or advanced settings yet."
              />
            </SettingsSection>
          ) : null}
        </>
      ) : null}
      {error || configError ? (
        <Button variant="outline" onClick={retry}>
          Check again
        </Button>
      ) : null}
    </SettingsPageContainer>
  );
}
