import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CheckIcon, CloudOffIcon, LogInIcon, ShieldCheckIcon, ServerIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import {
  getMicIdentityAccess,
  getMicIdentityOverview,
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
  micIdentitySessionSnapshot,
  readMicIdentityToken,
  subscribeMicIdentity,
} from "./micIdentitySession";
import { MicPrismPairing } from "./MicPrismPairing";
import { MicPrismChat } from "./MicPrismChat";

type View = {
  authorityUrl: string;
  generation: number;
  access: MicIdentityAccess;
  routing: PrismRoutingStrategy | null;
  receivedAt: number;
};

export function MicIdentityPanel() {
  const { config, error: configError, retry, revision } = useMicIdentityConfig();
  const generation = useSyncExternalStore(subscribeMicIdentity, micIdentityGeneration);
  const session = useSyncExternalStore(subscribeMicIdentity, micIdentitySessionSnapshot);
  const visible = useDocumentVisible();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accessRevision, setAccessRevision] = useState(0);
  const [saved, setSaved] = useState<View | null>(null);
  const operation = useRef(0);
  const mutating = useRef(false);
  const current =
    session.status === "signed-in" &&
    view?.generation === generation &&
    view.authorityUrl === config?.authorityUrl
      ? view
      : null;
  const service = current?.access.discovery.service;

  useEffect(() => {
    const authorityUrl = config?.authorityUrl;
    if (!visible || !authorityUrl || session.status !== "signed-in") return;
    let cancelled = false;
    let loading = false;
    const controller = new AbortController();
    const tick = async () => {
      if (loading || mutating.current) return;
      loading = true;
      const ticket = ++operation.current;
      try {
        const result = await runtime.runPromise(
          Effect.gen(function* () {
            const input = {
              baseUrl: authorityUrl,
              getToken: readMicIdentityToken,
              isCurrent: () => micIdentityGeneration() === generation,
            };
            const access = yield* getMicIdentityOverview(input);
            if (!access.discovery.service) return { access, routing: null, gatewayError: null };
            const bound = { ...input, expectedService: access.discovery.service };
            const gateway = yield* Effect.gen(function* () {
              if (access.session.permissions.includes("prism:inference"))
                yield* getMicPrismStatus(bound);
              return access.session.permissions.includes("prism:routing:read")
                ? (yield* getMicPrismRouting(bound)).strategy
                : null;
            }).pipe(Effect.result);
            return {
              access,
              routing: gateway._tag === "Success" ? gateway.success : null,
              gatewayError: gateway._tag === "Failure" ? gateway.failure.message : null,
            };
          }).pipe(Effect.result),
          { signal: controller.signal },
        );
        if (cancelled || ticket !== operation.current) return;
        if (result._tag === "Failure") {
          setError(result.failure.message);
          if (
            result.failure._tag === "MicIdentityUnauthorizedError" ||
            result.failure._tag === "MicIdentityForbiddenError"
          )
            setView(null);
        } else {
          setError(result.success.gatewayError);
          setView({ ...result.success, authorityUrl, generation, receivedAt: Date.now() });
        }
      } catch {
        if (!cancelled) setError("Prism could not be reached. Try again.");
      } finally {
        loading = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      operation.current++;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [config?.authorityUrl, generation, session.status, visible, revision, accessRevision]);

  const changeRouting = async (strategy: PrismRoutingStrategy) => {
    if (
      !current ||
      !service ||
      error ||
      mutating.current ||
      !config?.authorityUrl ||
      !current.access.session.permissions.includes("prism:routing:write")
    )
      return;
    const ticket = ++operation.current;
    const target = service;
    setBusy(true);
    setSaved(null);
    mutating.current = true;
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const input = {
            baseUrl: config.authorityUrl!,
            expectedService: target,
            getToken: readMicIdentityToken,
            isCurrent: () => micIdentityGeneration() === generation,
          };
          const access = yield* getMicIdentityAccess({
            ...input,
            permission: "prism:routing:write",
          });
          if (
            access.discovery.service?.id !== target.id ||
            access.discovery.service.pairingRevision !== target.pairingRevision
          )
            return { changedHost: true as const };
          yield* setMicPrismRouting({ ...input, strategy });
          return {
            changedHost: false as const,
            routing: (yield* getMicPrismRouting(input)).strategy,
          };
        }).pipe(Effect.result),
      );
      if (ticket !== operation.current || micIdentityGeneration() !== generation) return;
      if (result._tag === "Failure") {
        setError(result.failure.message);
        if (
          result.failure._tag === "MicIdentityUnauthorizedError" ||
          result.failure._tag === "MicIdentityForbiddenError"
        )
          setView(null);
      } else if (result.success.changedHost) {
        setError("Your paired host changed. Refresh before changing routing.");
      } else {
        const confirmed = { ...current, routing: result.success.routing, receivedAt: Date.now() };
        setView(confirmed);
        setSaved(confirmed);
      }
    } catch {
      if (micIdentityGeneration() === generation)
        setError("The routing change could not be confirmed. Refresh to check its current value.");
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };

  const signedIn = session.status === "signed-in";
  const message = session.error ?? configError ?? (signedIn ? error : null);
  return (
    <SettingsPageContainer>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <ShieldCheckIcon className="size-4" />
              mic.sc
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Your Prism connection</h1>
            <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
              Use the shared model pool with your mic.sc account. Your environments and workspaces
              keep their own access controls.
            </p>
          </div>
          {signedIn && session.signOut ? (
            <Button variant="ghost" onClick={() => void session.signOut?.()}>
              Sign out
            </Button>
          ) : null}
        </div>
        {!signedIn ? (
          <div className="rounded-xl border border-border bg-card px-6 py-8">
            <LogInIcon className="mb-4 size-6 text-muted-foreground" />
            <h2 className="text-base font-medium">Sign in to mic.sc</h2>
            <p className="mb-5 mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Find your paired host and use Prism. You can get started without connecting a coding
              environment.
            </p>
            <Button
              disabled={
                !session.signIn || session.status === "loading" || session.status === "signing-out"
              }
              onClick={() => void session.signIn?.()}
            >
              {session.status === "loading"
                ? "Loading sign-in…"
                : session.status === "signing-out"
                  ? "Signing out…"
                  : "Sign in to mic.sc"}
            </Button>
            {session.error && session.signOut ? (
              <Button variant="outline" className="ml-2" onClick={() => void session.signOut?.()}>
                Retry sign-out
              </Button>
            ) : null}
          </div>
        ) : current ? (
          <>
            <div className="flex flex-wrap items-start gap-4 rounded-xl border border-border bg-card p-5">
              <div className="rounded-lg bg-muted p-2.5">
                {error ? (
                  <CloudOffIcon className="size-5 text-muted-foreground" />
                ) : (
                  <ServerIcon className="size-5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-medium">{service?.label ?? "No paired host yet"}</h2>
                  {service ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {error ? "Offline" : "Access verified"}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {error
                    ? "Showing the last verified host. Inference and routing are paused; administrators can recover the host."
                    : service
                      ? "Your mic.sc session is authorized for this host."
                      : "You're signed in. A Prism administrator needs to pair and select a host before you can send requests."}
                </p>
              </div>
              <span className="basis-full pl-14 text-xs text-muted-foreground sm:basis-auto sm:pl-0">
                {current.access.session.globalAdmin || current.access.session.capabilities.manage
                  ? "Administrator"
                  : current.access.session.permissions.some(
                        (permission) => permission !== "prism:inference",
                      )
                    ? "Scoped access"
                    : current.access.session.permissions.includes("prism:inference")
                      ? "Inference access"
                      : "No service permissions"}
              </span>
            </div>
            {service &&
            config?.authorityUrl &&
            current.access.session.permissions.includes("prism:inference") ? (
              <MicPrismChat
                key={`${config.authorityUrl}:${generation}:${service.id}:${service.pairingRevision}:${service.inferenceUrl}`}
                authorityUrl={config.authorityUrl}
                service={service}
                generation={generation}
                disabled={error !== null}
              />
            ) : null}
            {current.routing !== null ? (
              <SettingsSection title="Routing">
                <SettingsRow
                  title="Account selection"
                  description="Choose how Prism distributes requests across the pool. The selected model stays the same."
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
                    className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  >
                    <option value="round-robin">Round robin</option>
                    <option value="weighted-round-robin">Weighted round robin</option>
                    <option value="fill-first">Fill first</option>
                  </select>
                </SettingsRow>
                {saved &&
                saved.generation === generation &&
                saved.authorityUrl === current.authorityUrl &&
                saved.access.discovery.service?.id === service?.id &&
                saved.access.discovery.service?.pairingRevision === service?.pairingRevision &&
                saved.routing === current.routing ? (
                  <p
                    role="status"
                    className="flex items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground"
                  >
                    <CheckIcon className="size-3.5" />
                    Confirmed by Prism
                  </p>
                ) : null}
              </SettingsSection>
            ) : null}
            {config?.authorityUrl ? (
              <MicPrismPairing
                authorityUrl={config.authorityUrl}
                generation={generation}
                access={current.access}
                onChanged={() => setAccessRevision((value) => value + 1)}
              />
            ) : null}
            {current.access.session.capabilities.accountDetails ? (
              <SettingsSection title="Management">
                <SettingsRow
                  title="Accounts and advanced settings"
                  description="Remote account sign-in, reserves and advanced settings are not available from this service yet."
                />
              </SettingsSection>
            ) : null}
          </>
        ) : (
          <div
            role="status"
            className="rounded-xl border border-border p-6 text-sm text-muted-foreground"
          >
            {error ? "Prism access could not be verified." : "Finding your Prism host…"}
          </div>
        )}
        {message ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-sm"
          >
            <p>{message}</p>
            <Button variant="outline" className="mt-3" onClick={retry}>
              Check again
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsPageContainer>
  );
}
