import { useEffect, useSyncExternalStore } from "react";
import * as Option from "effect/Option";
import { LogInIcon, LogOutIcon } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";
import {
  bindMicIdentitySession,
  micIdentitySessionSnapshot,
  subscribeMicIdentity,
} from "./micIdentitySession";
import { bindBrowserIdentityRelay, browserIdentityRequest } from "./browserIdentityRelay";
import { useMicIdentityConfig } from "./useMicIdentityConfig";

/** Production Clerk sign-in runs on prism.mic.sc; this local browser never receives a native grant. */
export default function BrowserMicIdentity() {
  const { config } = useMicIdentityConfig();
  const preparedOption = usePreparedConnection(usePrimaryEnvironmentId());
  const prepared = Option.getOrNull(preparedOption);
  const authority = config?.enabled ? config.authorityUrl : undefined;
  const session = useSyncExternalStore(subscribeMicIdentity, micIdentitySessionSnapshot);
  useEffect(() => {
    if (
      !prepared ||
      !authority ||
      new URL(prepared.httpBaseUrl).origin !== location.origin ||
      prepared.httpAuthorization?._tag === "Dpop"
    )
      return bindMicIdentitySession();
    const unbindRelay = bindBrowserIdentityRelay({
      authority,
      authorization:
        prepared.httpAuthorization?._tag === "Bearer"
          ? `Bearer ${prepared.httpAuthorization.token}`
          : null,
    });
    let alive = true;
    let generation: string | null = null;
    let revision = 0;
    let loaded = false;
    let popup: Window | null = null;
    let dispose = () => {};
    const bind = (ready = true) => {
      loaded = ready;
      dispose();
      dispose = bindMicIdentitySession(
        generation
          ? async () => {
              const response = await browserIdentityRequest("status");
              if (!response.ok) {
                if (alive) {
                  generation = null;
                  bind();
                }
                throw new Error("Sign-in unavailable");
              }
              const value = await response.json();
              if (alive && value.generation !== generation) {
                generation = null;
                bind();
              }
              return alive ? generation : null;
            }
          : undefined,
        { loaded: ready, signIn, signOut },
      );
    };
    const refresh = async () => {
      const ticket = ++revision;
      const previous = generation;
      try {
        const response = await browserIdentityRequest("status");
        if (!response.ok) throw new Error("Sign-in unavailable");
        const value = await response.json();
        if (!alive || ticket !== revision) return;
        generation =
          typeof value.generation === "string" && value.generation.startsWith("q1br_")
            ? value.generation
            : null;
      } catch {
        if (!alive || ticket !== revision) return;
        generation = null;
      }
      if (!loaded || previous !== generation) bind();
    };
    async function signIn() {
      // Open synchronously within the user gesture before the authenticated start request.
      popup?.close();
      popup = window.open("about:blank", "q1code-prism-signin", "popup,width=520,height=740");
      if (!popup) throw new Error("Popup blocked");
      const response = await browserIdentityRequest("start");
      if (!response.ok) {
        popup.close();
        throw new Error("Sign-in unavailable");
      }
      const value = await response.json();
      if (!alive) {
        popup.close();
        return;
      }
      const target = new URL(value.loginUrl);
      if (target.origin !== "https://prism.mic.sc" || target.pathname !== "/browser-login")
        throw new Error("Invalid sign-in response");
      popup.location.href = target.href;
    }
    async function signOut() {
      ++revision;
      generation = null;
      popup?.close();
      const response = await browserIdentityRequest("revoke");
      if (!response.ok) throw new Error("Sign-out unavailable");
    }
    const onMessage = (event: MessageEvent) => {
      if (
        !alive ||
        event.origin !== location.origin ||
        event.source !== popup ||
        event.data?.type !== "q1code:prism-browser-callback"
      )
        return;
      const { code, state, requestId } = event.data;
      popup?.close();
      popup = null;
      void browserIdentityRequest("complete", { code, state, requestId })
        .then((response) => {
          if (!response.ok) throw new Error("Sign-in unavailable");
          return refresh();
        })
        .catch(() => {
          if (alive) {
            generation = null;
            bind();
          }
        });
    };
    const onOffline = () => {
      ++revision;
      generation = null;
      bind();
    };
    const onFocus = () => {
      if (!popup) void refresh();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onFocus);
    window.addEventListener("focus", onFocus);
    bind(false);
    void refresh();
    return () => {
      alive = false;
      ++revision;
      popup?.close();
      dispose();
      unbindRelay();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [prepared, authority]);
  const action = session.signOut ?? session.signIn;
  const label =
    session.status === "signing-out"
      ? "Signing out of mic.sc…"
      : session.signOut
        ? "Sign out of mic.sc"
        : "Sign in to mic.sc";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        disabled={!action}
        onClick={() => void action?.()}
        tooltip={session.error ?? label}
      >
        {session.signOut ? <LogOutIcon /> : <LogInIcon />}
        <span>{label}</span>
      </SidebarMenuButton>
      {session.error ? (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {session.error}
        </p>
      ) : null}
    </SidebarMenuItem>
  );
}
