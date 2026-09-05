import { useAuth, useClerk } from "@clerk/react";
import { useEffect, useSyncExternalStore } from "react";
import { LogInIcon, LogOutIcon } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import {
  bindMicIdentitySession,
  micIdentitySessionSnapshot,
  subscribeMicIdentity,
} from "./micIdentitySession";

export function MicIdentitySession() {
  const { getToken, isLoaded, isSignedIn, userId, sessionId } = useAuth();
  const clerk = useClerk();
  const session = useSyncExternalStore(subscribeMicIdentity, micIdentitySessionSnapshot);
  useEffect(
    () =>
      bindMicIdentitySession(
        isLoaded && isSignedIn && userId && sessionId
          ? () => getToken({ skipCache: true })
          : undefined,
        {
          loaded: Boolean(isLoaded),
          signIn: () => clerk.openSignIn(),
          signOut: () => clerk.signOut(),
        },
      ),
    [getToken, isLoaded, isSignedIn, userId, sessionId, clerk],
  );
  const action = session.signOut ?? session.signIn;
  const label =
    session.status === "signing-out"
      ? "Signing out of mic.sc…"
      : session.status === "signed-in" || (session.error && session.signOut)
        ? "Sign out of mic.sc"
        : "Sign in to mic.sc";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        disabled={!action}
        onClick={() => void action?.()}
        tooltip={session.error ?? label}
      >
        {session.status === "signed-in" ? <LogOutIcon /> : <LogInIcon />}
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
